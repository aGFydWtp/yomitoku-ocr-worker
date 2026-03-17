import { StartExecutionCommand } from "@aws-sdk/client-sfn";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { z as zType } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { docClient } from "../lib/dynamodb";
import {
  ConflictError,
  handleError,
  NotFoundError,
  ServiceUnavailableError,
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
import {
  assertValidStateMachineArn,
  decodeCursor,
  validateBasePath,
} from "../lib/validate";
import type { JobDetailResponseSchema, JobStatus } from "../schemas";
import {
  cancelJobRoute,
  createJobRoute,
  getJobRoute,
  listJobsRoute,
} from "./jobs.routes";

export const jobsRoutes = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      return c.json({ error: firstIssue.message }, 400);
    }
    return undefined;
  },
});

jobsRoutes.onError(handleError);

// --- POST /jobs ---

jobsRoutes.openapi(createJobRoute, async (c) => {
  const tableName = process.env.STATUS_TABLE_NAME;
  const bucketName = process.env.BUCKET_NAME;
  const controlTableName = process.env.CONTROL_TABLE_NAME;
  const stateMachineArn = process.env.STATE_MACHINE_ARN;
  if (!tableName || !bucketName || !controlTableName || !stateMachineArn) {
    throw new Error(
      "STATUS_TABLE_NAME, BUCKET_NAME, CONTROL_TABLE_NAME, and STATE_MACHINE_ARN must be set",
    );
  }
  assertValidStateMachineArn(stateMachineArn);

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

  const { filename, basePath: rawBasePath } = c.req.valid("json");
  // Zod スキーマで必須・min(1) を保証済み。validateBasePath はトリム・文字種・パストラバーサルチェック。
  const basePath = validateBasePath(rawBasePath) as string;

  const sanitized = sanitizeFilename(filename);
  const jobId = crypto.randomUUID();
  const fileKey = `input/${basePath}/${jobId}/${sanitized}`;
  const now = new Date().toISOString();

  const uploadUrl = await createUploadUrl(bucketName, fileKey);

  const item: Record<string, string> = {
    job_id: jobId,
    file_key: fileKey,
    status: "PENDING",
    created_at: now,
    updated_at: now,
    original_filename: filename,
    base_path: basePath,
  };

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

// --- GET /jobs ---

jobsRoutes.openapi(listJobsRoute, async (c) => {
  const tableName = process.env.STATUS_TABLE_NAME;
  if (!tableName) {
    throw new Error("STATUS_TABLE_NAME must be set");
  }

  const {
    status,
    limit,
    cursor: cursorParam,
    basePath: rawBasePath,
  } = c.req.valid("query");
  const exclusiveStartKey = decodeCursor(cursorParam);
  const normalizedBasePath = rawBasePath
    ? validateBasePath(rawBasePath)
    : undefined;

  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "status-created_at-index",
      KeyConditionExpression: "#s = :status",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":status": status,
        ...(normalizedBasePath && { ":basePath": normalizedBasePath }),
      },
      Limit: limit,
      ScanIndexForward: false,
      ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
      ...(normalizedBasePath && {
        FilterExpression: "begins_with(base_path, :basePath)",
      }),
    }),
  );

  const items = (result.Items ?? []).map((item) => ({
    jobId: item.job_id as string,
    status: item.status as JobStatus,
    createdAt: item.created_at as string,
    updatedAt: item.updated_at as string,
    originalFilename: item.original_filename as string,
  }));

  const cursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url")
    : null;

  return c.json(
    {
      items,
      count: items.length,
      cursor,
    },
    200 as const,
  );
});

// --- GET /jobs/:jobId ---

jobsRoutes.openapi(getJobRoute, async (c) => {
  const tableName = process.env.STATUS_TABLE_NAME;
  const bucketName = process.env.BUCKET_NAME;
  if (!tableName || !bucketName) {
    throw new Error("STATUS_TABLE_NAME and BUCKET_NAME must be set");
  }

  const { jobId } = c.req.valid("param");

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

  const response: zType.infer<typeof JobDetailResponseSchema> = {
    jobId: item.job_id as string,
    status: item.status as JobStatus,
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

    // Visualization presigned URLs
    const MAX_VIZ_PAGES = 200;
    if (
      typeof item.visualization_prefix === "string" &&
      typeof item.num_pages === "number" &&
      item.num_pages > 0 &&
      item.num_pages <= MAX_VIZ_PAGES
    ) {
      const vizPrefix = item.visualization_prefix;
      const numPages = item.num_pages;
      const basename =
        (item.file_key as string)
          .split("/")
          .pop()
          ?.replace(/\.pdf$/i, "") ?? "";

      const layoutKeys = Array.from(
        { length: numPages },
        (_, i) => `${vizPrefix}${basename}_layout_page_${i}.jpg`,
      );
      const ocrKeys = Array.from(
        { length: numPages },
        (_, i) => `${vizPrefix}${basename}_ocr_page_${i}.jpg`,
      );

      const [layoutUrls, ocrUrls] = await Promise.all([
        Promise.all(layoutKeys.map((k) => createResultUrl(bucketName, k))),
        Promise.all(ocrKeys.map((k) => createResultUrl(bucketName, k))),
      ]);

      response.visualizations = {
        layoutUrls,
        ocrUrls,
        expiresIn: RESULT_URL_EXPIRES_IN,
      };
    }
  }

  if (item.status === "FAILED" && item.error_message) {
    response.errorMessage = item.error_message as string;
  }

  return c.json(response, 200 as const);
});

// --- DELETE /jobs/:jobId ---

jobsRoutes.openapi(cancelJobRoute, async (c) => {
  const tableName = process.env.STATUS_TABLE_NAME;
  const bucketName = process.env.BUCKET_NAME;
  if (!tableName || !bucketName) {
    throw new Error("STATUS_TABLE_NAME and BUCKET_NAME must be set");
  }

  const { jobId } = c.req.valid("param");

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

  return c.json({ status: updatedStatus as string }, 200 as const);
});
