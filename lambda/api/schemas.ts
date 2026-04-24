import { z } from "@hono/zod-openapi";

// ---------------------------------------------------------------------------
// Batch ステータス
// ---------------------------------------------------------------------------

export const BATCH_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
] as const;

export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const FILE_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

// ---------------------------------------------------------------------------
// 上限定数
// ---------------------------------------------------------------------------

export const MAX_FILES_PER_BATCH = 100;
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
export const ALLOWED_EXTENSIONS = [".pdf"] as const;

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

export const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse");

// ---------------------------------------------------------------------------
// POST /batches
// ---------------------------------------------------------------------------

export const EXTRA_FORMATS = ["markdown", "csv", "html", "pdf"] as const;
export type ExtraFormat = (typeof EXTRA_FORMATS)[number];

const allowedExtensionRegex = new RegExp(
  `(${ALLOWED_EXTENSIONS.map((e) => e.replace(".", "\\.")).join("|")})$`,
  "i",
);

export const CreateBatchBodySchema = z
  .object({
    basePath: z
      .string()
      .min(1, "basePath must not be empty")
      .openapi({ example: "project/2026/batch1" }),
    files: z
      .array(
        z.object({
          filename: z
            .string()
            .min(1, "filename must not be empty")
            .refine(
              (name) => allowedExtensionRegex.test(name),
              (name) => ({
                message: `filename "${name}" has unsupported extension. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`,
              }),
            )
            .openapi({ example: "document.pdf" }),
          contentType: z
            .enum(["application/pdf", "application/octet-stream"])
            .optional()
            .openapi({
              description: "Content-Type（省略時は application/pdf）",
            }),
        }),
      )
      .min(1, "files must not be empty")
      .max(
        MAX_FILES_PER_BATCH,
        `files must not exceed ${MAX_FILES_PER_BATCH} items`,
      )
      .openapi({ description: `最大 ${MAX_FILES_PER_BATCH} ファイル` }),
    extraFormats: z.array(z.enum(EXTRA_FORMATS)).optional().openapi({
      description: "追加出力フォーマット (markdown / csv / html / pdf)",
    }),
  })
  .openapi("CreateBatchBody");

export const UploadItemSchema = z.object({
  filename: z.string(),
  fileKey: z.string().openapi({ example: "batches/uuid/input/document.pdf" }),
  uploadUrl: z
    .string()
    .url()
    .openapi({ description: "S3 署名付き PUT URL（有効期限 15 分）" }),
  expiresIn: z.number().int().openapi({ example: 900 }),
});

export const CreateBatchResponseSchema = z
  .object({
    batchJobId: z.string().uuid(),
    uploads: z.array(UploadItemSchema),
  })
  .openapi("CreateBatchResponse");

// ---------------------------------------------------------------------------
// バッチ詳細 / ファイル一覧
// ---------------------------------------------------------------------------

export const BatchTotalsSchema = z.object({
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  inProgress: z.number().int(),
});

export const BatchDetailSchema = z
  .object({
    batchJobId: z.string().uuid(),
    status: z.enum(BATCH_STATUSES),
    totals: BatchTotalsSchema,
    basePath: z.string(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
    parentBatchJobId: z.string().uuid().nullable(),
  })
  .openapi("BatchDetail");

export const BatchFileSchema = z
  .object({
    fileKey: z.string(),
    filename: z.string(),
    status: z.enum(FILE_STATUSES),
    dpi: z.number().int().optional(),
    processingTimeMs: z.number().int().optional(),
    resultKey: z.string().optional(),
    errorMessage: z.string().optional(),
    updatedAt: z.string().datetime(),
  })
  .openapi("BatchFile");

export const BatchWithFilesSchema = BatchDetailSchema.extend({
  files: z.array(BatchFileSchema),
}).openapi("BatchWithFiles");

export const BatchFilesPageSchema = z
  .object({
    items: z.array(BatchFileSchema),
    cursor: z.string().nullable(),
  })
  .openapi("BatchFilesPage");

export const BatchListPageSchema = z
  .object({
    items: z.array(BatchDetailSchema),
    cursor: z.string().nullable(),
  })
  .openapi("BatchListPage");

// ---------------------------------------------------------------------------
// POST /batches/:batchJobId/start
// ---------------------------------------------------------------------------

export const StartBatchResponseSchema = z
  .object({
    batchJobId: z.string().uuid(),
    status: z.enum(BATCH_STATUSES),
    executionArn: z.string(),
  })
  .openapi("StartBatchResponse");

// ---------------------------------------------------------------------------
// GET /batches/:batchJobId/process-log
// ---------------------------------------------------------------------------

export const ProcessLogLinkSchema = z
  .object({
    url: z.string().url(),
    expiresIn: z.number().int().openapi({ example: 3600 }),
  })
  .openapi("ProcessLogLink");

// ---------------------------------------------------------------------------
// DELETE /batches/:batchJobId
// ---------------------------------------------------------------------------

export const CancelBatchResponseSchema = z
  .object({
    batchJobId: z.string().uuid(),
    status: z.literal("CANCELLED"),
  })
  .openapi("CancelBatchResponse");
