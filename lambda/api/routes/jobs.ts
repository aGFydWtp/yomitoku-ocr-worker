import { StartExecutionCommand } from "@aws-sdk/client-sfn";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { docClient } from "../lib/dynamodb";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
  handleError,
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
  CancelJobResponseSchema,
  CreateJobBodySchema,
  CreateJobResponseSchema,
  ErrorResponseSchema,
  JobDetailResponseSchema,
  JobListResponseSchema,
  ServiceUnavailableSchema,
} from "../schemas";

export const jobsRoutes = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      return c.json({ error: firstIssue.message }, 400);
    }
  },
});

jobsRoutes.onError(handleError);

// --- POST /jobs ---

const createJobRoute = createRoute({
  method: "post",
  path: "/",
  summary: "ジョブ作成",
  description:
    "PDF の OCR ジョブを作成し、S3 アップロード用の署名付き URL を取得します。エンドポイント未起動時は 503 を返し、裏で起動を開始します。",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateJobBodySchema } },
    },
  },
  responses: {
    201: {
      description: "ジョブ作成成功",
      content: { "application/json": { schema: CreateJobResponseSchema } },
    },
    400: {
      description: "バリデーションエラー",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    503: {
      description: "エンドポイント未起動",
      content: { "application/json": { schema: ServiceUnavailableSchema } },
    },
  },
});

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

  let basePath: string | undefined;
  if (rawBasePath != null) {
    const trimmed = rawBasePath.replace(/^\/+|\/+$/g, "");
    if (!trimmed) {
      throw new ValidationError("basePath must not be empty");
    }
    if (
      !/^[a-zA-Z0-9\u3000-\u9FFF\u{20000}-\u{2FA1F}\-_./]+$/u.test(trimmed)
    ) {
      throw new ValidationError("basePath contains invalid characters");
    }
    if (/(^|\/)\.\.($|\/)/.test(trimmed)) {
      throw new ValidationError(
        "basePath must not contain path traversal (..)",
      );
    }
    if (Buffer.byteLength(trimmed, "utf8") > 512) {
      throw new ValidationError("basePath is too long");
    }
    basePath = trimmed;
  }

  const sanitized = sanitizeFilename(filename);
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
    original_filename: filename,
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

// --- GET /jobs ---

const listJobsRoute = createRoute({
  method: "get",
  path: "/",
  summary: "ジョブ一覧取得",
  description:
    "ステータスでフィルタし、ページネーション付きでジョブを取得します。",
  request: {
    query: z.object({
      status: z.enum(
        ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED"],
        {
          required_error: "status query parameter is required",
          message: "status must be one of: PENDING, PROCESSING, COMPLETED, FAILED, CANCELLED",
        },
      ),
      limit: z.coerce
        .number({ invalid_type_error: "limit must be an integer between 1 and 100" })
        .int("limit must be an integer between 1 and 100")
        .min(1, "limit must be an integer between 1 and 100")
        .max(100, "limit must be an integer between 1 and 100")
        .default(20)
        .optional(),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "ジョブ一覧",
      content: { "application/json": { schema: JobListResponseSchema } },
    },
    400: {
      description: "バリデーションエラー",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

jobsRoutes.openapi(listJobsRoute, async (c) => {
  const tableName = process.env.STATUS_TABLE_NAME;
  if (!tableName) {
    throw new Error("STATUS_TABLE_NAME must be set");
  }

  const { status, limit, cursor: cursorParam } = c.req.valid("query");

  let exclusiveStartKey: Record<string, unknown> | undefined;
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

// --- GET /jobs/:jobId ---

const getJobRoute = createRoute({
  method: "get",
  path: "/{jobId}",
  summary: "ジョブ状態取得",
  request: {
    params: z.object({
      jobId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "ジョブ詳細",
      content: { "application/json": { schema: JobDetailResponseSchema } },
    },
    400: {
      description: "不正な jobId 形式",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "ジョブが見つからない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

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

// --- DELETE /jobs/:jobId ---

const cancelJobRoute = createRoute({
  method: "delete",
  path: "/{jobId}",
  summary: "ジョブキャンセル",
  description: "PENDING 状態のジョブのみキャンセルできます。",
  request: {
    params: z.object({
      jobId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "キャンセル成功",
      content: { "application/json": { schema: CancelJobResponseSchema } },
    },
    400: {
      description: "不正な jobId 形式",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "ジョブが見つからない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "PENDING 以外のステータスのためキャンセル不可",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

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

  return c.json({ status: updatedStatus });
});
