import { z } from "@hono/zod-openapi";

// --- Common ---

export const JOB_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const ENDPOINT_STATES = [
  "IDLE",
  "CREATING",
  "IN_SERVICE",
  "DELETING",
] as const;

export type EndpointState = (typeof ENDPOINT_STATES)[number];

export const ErrorResponseSchema = z
  .object({
    error: z.string(),
  })
  .openapi("ErrorResponse");

// --- POST /jobs ---

export const CreateJobBodySchema = z
  .object({
    filename: z.string().openapi({
      example: "sample.pdf",
      description: "PDF ファイル名（.pdf で終わる必要あり）",
    }),
    basePath: z.string().min(1, "basePath must not be empty").openapi({
      example: "myProject/2026031701",
      description:
        "処理単位のパスプレフィックス。input/{basePath}/{jobId}/{filename} に配置される",
    }),
  })
  .openapi("CreateJobBody");

export const CreateJobResponseSchema = z
  .object({
    jobId: z
      .string()
      .uuid()
      .openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
    fileKey: z.string().openapi({
      example: "input/myProject/2026031701/550e8400-.../sample.pdf",
    }),
    uploadUrl: z
      .string()
      .url()
      .openapi({ description: "S3 署名付き PUT URL（有効期限 15 分）" }),
    expiresIn: z
      .number()
      .int()
      .openapi({ example: 900, description: "uploadUrl の有効秒数" }),
  })
  .openapi("CreateJobResponse");

export const ServiceUnavailableSchema = z
  .object({
    error: z.string(),
    endpointState: z.string().openapi({
      description: "現在のエンドポイント状態（IN_SERVICE 以外）",
    }),
  })
  .openapi("ServiceUnavailableResponse");

// --- GET /jobs ---

export const JobListItemSchema = z
  .object({
    jobId: z.string(),
    status: z.enum(JOB_STATUSES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    originalFilename: z.string(),
  })
  .openapi("JobListItem");

export const JobListResponseSchema = z
  .object({
    items: z.array(JobListItemSchema),
    count: z.number().int(),
    cursor: z.string().nullable(),
  })
  .openapi("JobListResponse");

// --- GET /jobs/:jobId ---

export const JobDetailResponseSchema = z
  .object({
    jobId: z.string().uuid(),
    status: z.enum(JOB_STATUSES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    resultUrl: z
      .string()
      .url()
      .optional()
      .openapi({ description: "COMPLETED 時のみ。有効期限 60 分" }),
    resultExpiresIn: z.number().int().optional().openapi({ example: 3600 }),
    processingTimeMs: z.number().int().optional(),
    errorMessage: z
      .string()
      .optional()
      .openapi({ description: "FAILED 時のみ" }),
    visualizations: z
      .object({
        layoutUrls: z.array(z.string().url()),
        ocrUrls: z.array(z.string().url()),
        expiresIn: z.number().int(),
      })
      .optional()
      .openapi({ description: "COMPLETED 時、可視化画像がある場合のみ" }),
  })
  .openapi("JobDetailResponse");

// --- DELETE /jobs/:jobId ---

export const CancelJobResponseSchema = z
  .object({
    status: z.string().openapi({ example: "CANCELLED" }),
  })
  .openapi("CancelJobResponse");

// --- POST /up ---

export const StartEndpointResponseSchema = z
  .object({
    message: z.string(),
    endpointState: z.enum(ENDPOINT_STATES).openapi({
      description: "現在のエンドポイント状態",
    }),
  })
  .openapi("StartEndpointResponse");

// --- GET /status ---

export const EndpointStatusResponseSchema = z
  .object({
    endpointState: z
      .enum(ENDPOINT_STATES)
      .openapi({ description: "SageMaker エンドポイントの状態" }),
    updatedAt: z.string().datetime().nullable(),
  })
  .openapi("EndpointStatusResponse");
