import { StartExecutionCommand } from "@aws-sdk/client-sfn";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { Hono } from "hono";
import { docClient } from "../lib/dynamodb";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "../lib/errors";
import {
  createResultUrl,
  createUploadUrl,
  deleteObject,
  RESULT_URL_EXPIRES_IN,
  UPLOAD_URL_EXPIRES_IN,
} from "../lib/s3";
import { sanitizeFilename } from "../lib/sanitize";
import { sfnClient } from "../lib/sfn";

const VALID_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export const jobsRoutes = new Hono();

jobsRoutes.post("/", async (c) => {
  const tableName = process.env.STATUS_TABLE_NAME;
  const bucketName = process.env.BUCKET_NAME;
  const controlTableName = process.env.CONTROL_TABLE_NAME;
  const stateMachineArn = process.env.STATE_MACHINE_ARN;
  if (!tableName || !bucketName || !controlTableName || !stateMachineArn) {
    throw new Error(
      "STATUS_TABLE_NAME, BUCKET_NAME, CONTROL_TABLE_NAME, and STATE_MACHINE_ARN must be set",
    );
  }
  if (
    !/^arn:aws[\w-]*:states:[a-z0-9-]+:\d{12}:stateMachine:.+$/.test(
      stateMachineArn,
    )
  ) {
    throw new Error(`Invalid STATE_MACHINE_ARN format: ${stateMachineArn}`);
  }

  // エンドポイント状態チェック
  // NOTE: TOCTOU リスク — チェックとジョブ書き込みの間にステートが変わる可能性があるが、
  // Step Functions の 15 分クールダウンにより実際のレース窓は極めて小さい。
  // 万一ジョブが残った場合は、エンドポイント再起動時に SQS 経由で処理される。
  const controlResult = await docClient.send(
    new GetCommand({
      TableName: controlTableName,
      Key: { lock_key: "endpoint_control" },
      ConsistentRead: true,
    }),
  );
  const endpointState =
    (controlResult.Item?.endpoint_state as string) ?? "IDLE";

  if (endpointState !== "IN_SERVICE") {
    // IDLE または DELETING の場合は Step Functions を起動
    if (endpointState === "IDLE" || endpointState === "DELETING") {
      try {
        await sfnClient.send(
          new StartExecutionCommand({
            stateMachineArn,
            input: JSON.stringify({ trigger: "api_request" }),
          }),
        );
      } catch {
        // best-effort: Step Functions 起動失敗は無視
      }
    }
    throw new ServiceUnavailableError(
      "Endpoint is not available. Please try again later.",
      { endpointState },
    );
  }

  let body: { filename?: unknown; basePath?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }

  if (body.filename === undefined || body.filename === null) {
    throw new ValidationError("filename is required");
  }
  if (typeof body.filename !== "string") {
    throw new ValidationError("filename must be a string");
  }

  let basePath: string | undefined;
  if (body.basePath !== undefined && body.basePath !== null) {
    if (typeof body.basePath !== "string") {
      throw new ValidationError("basePath must be a string");
    }
    const trimmed = body.basePath.replace(/^\/+|\/+$/g, "");
    if (!trimmed) {
      throw new ValidationError("basePath must not be empty");
    }
    if (!/^[a-zA-Z0-9\u3000-\u9FFF\u{20000}-\u{2FA1F}\-_./]+$/u.test(trimmed)) {
      throw new ValidationError(
        "basePath contains invalid characters",
      );
    }
    if (/(^|\/)\.\.($|\/)/.test(trimmed)) {
      throw new ValidationError("basePath must not contain path traversal (..)");
    }
    if (Buffer.byteLength(trimmed, "utf8") > 512) {
      throw new ValidationError("basePath is too long");
    }
    basePath = trimmed;
  }

  const sanitized = sanitizeFilename(body.filename);
  const jobId = crypto.randomUUID();
  const fileKey = basePath
    ? `input/${basePath}/${jobId}/${sanitized}`
    : `input/${jobId}/${sanitized}`;
  const now = new Date().toISOString();

  const uploadUrl = await createUploadUrl(bucketName, fileKey);

  const item: Record<string, string> = {
    job_id: jobId,
    file_key: fileKey,
    status: "PENDING",
    created_at: now,
    updated_at: now,
    original_filename: body.filename,
  };
  if (basePath) {
    item.base_path = basePath;
  }

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    }),
  );

  return c.json(
    {
      jobId,
      fileKey,
      uploadUrl,
      expiresIn: UPLOAD_URL_EXPIRES_IN,
    },
    201,
  );
});

jobsRoutes.get("/", async (c) => {
  const tableName = process.env.STATUS_TABLE_NAME;
  if (!tableName) {
    throw new Error("STATUS_TABLE_NAME must be set");
  }

  const status = c.req.query("status");
  if (!status) {
    throw new ValidationError("status query parameter is required");
  }
  if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
    throw new ValidationError(
      `status must be one of: ${VALID_STATUSES.join(", ")}`,
    );
  }

  const limitParam = c.req.query("limit");
  const limit = limitParam ? Number(limitParam) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError("limit must be an integer between 1 and 100");
  }

  let exclusiveStartKey: Record<string, unknown> | undefined;
  const cursorParam = c.req.query("cursor");
  if (cursorParam) {
    try {
      const decoded: unknown = JSON.parse(
        Buffer.from(cursorParam, "base64url").toString("utf8"),
      );
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        Array.isArray(decoded)
      ) {
        throw new Error("not an object");
      }
      exclusiveStartKey = decoded as Record<string, unknown>;
    } catch {
      throw new ValidationError("cursor is invalid");
    }
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "status-created_at-index",
      KeyConditionExpression: "#s = :status",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":status": status },
      Limit: limit,
      ScanIndexForward: false,
      ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
    }),
  );

  const items = (result.Items ?? []).map((item) => ({
    jobId: item.job_id as string,
    status: item.status as string,
    createdAt: item.created_at as string,
    updatedAt: item.updated_at as string,
    originalFilename: item.original_filename as string,
  }));

  const cursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url")
    : null;

  return c.json({
    items,
    count: items.length,
    cursor,
  });
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

jobsRoutes.get("/:jobId", async (c) => {
  const tableName = process.env.STATUS_TABLE_NAME;
  const bucketName = process.env.BUCKET_NAME;
  if (!tableName || !bucketName) {
    throw new Error("STATUS_TABLE_NAME and BUCKET_NAME must be set");
  }

  const jobId = c.req.param("jobId");
  if (!UUID_RE.test(jobId)) {
    throw new ValidationError("jobId must be a valid UUID");
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { job_id: jobId },
      ConsistentRead: true,
    }),
  );

  if (!result.Item) {
    throw new NotFoundError("Job not found");
  }

  const item = result.Item;

  interface JobResponse {
    jobId: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    resultUrl?: string;
    resultExpiresIn?: number;
    processingTimeMs?: number;
    errorMessage?: string;
  }

  const response: JobResponse = {
    jobId: item.job_id as string,
    status: item.status as string,
    createdAt: item.created_at as string,
    updatedAt: item.updated_at as string,
  };

  if (item.status === "COMPLETED" && item.output_key) {
    response.resultUrl = await createResultUrl(
      bucketName,
      item.output_key as string,
    );
    response.resultExpiresIn = RESULT_URL_EXPIRES_IN;
    if (item.processing_time_ms !== undefined) {
      response.processingTimeMs = item.processing_time_ms as number;
    }
  }

  if (item.status === "FAILED" && item.error_message) {
    response.errorMessage = item.error_message as string;
  }

  return c.json(response);
});

jobsRoutes.delete("/:jobId", async (c) => {
  const tableName = process.env.STATUS_TABLE_NAME;
  const bucketName = process.env.BUCKET_NAME;
  if (!tableName || !bucketName) {
    throw new Error("STATUS_TABLE_NAME and BUCKET_NAME must be set");
  }

  const jobId = c.req.param("jobId");
  if (!UUID_RE.test(jobId)) {
    throw new ValidationError("jobId must be a valid UUID");
  }

  let fileKey: string | undefined;
  let updatedStatus: string | undefined;
  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { job_id: jobId },
        UpdateExpression: "SET #s = :cancelled, updated_at = :now",
        ConditionExpression: "#s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":cancelled": "CANCELLED",
          ":pending": "PENDING",
          ":now": new Date().toISOString(),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    fileKey = result.Attributes?.file_key as string | undefined;
    updatedStatus = result.Attributes?.status as string | undefined;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      const existing = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { job_id: jobId },
          ConsistentRead: true,
        }),
      );
      if (!existing.Item) {
        throw new NotFoundError("Job not found");
      }
      throw new ConflictError(
        `Job cannot be cancelled: current status is ${existing.Item.status}`,
      );
    }
    throw err;
  }

  if (fileKey) {
    try {
      await deleteObject(bucketName, fileKey);
    } catch {
      // best-effort: ignore S3 delete failure
    }
  }

  return c.json({ status: updatedStatus });
});
