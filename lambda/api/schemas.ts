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
  .object({
    error: z.string().openapi({
      description:
        "人間可読なエラーメッセージ。機械処理で分岐する際は HTTP ステータスコードと、409 の場合は各エンドポイントの description に記載された原因候補 (PENDING 以外 / 終端状態でない 等) を使ってください。",
      example: "Batch abc-123 is not in status PENDING",
    }),
  })
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
    basePath: z.string().min(1, "basePath must not be empty").openapi({
      description:
        "バッチの論理的なグルーピング名。S3 key や DynamoDB には含まれず、人間がバッチ一覧で識別するためのラベル。",
      example: "project/2026/batch1",
    }),
    files: z
      .array(
        z.object({
          filename: z
            .string()
            .min(1, "filename must not be empty")
            .refine((name) => allowedExtensionRegex.test(name), {
              error: `filename has unsupported extension. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`,
            })
            .openapi({
              description: `拡張子は ${ALLOWED_EXTENSIONS.join(" / ")} のみ許可。日本語ファイル名も可。`,
              example: "document.pdf",
            }),
          contentType: z
            .enum(["application/pdf", "application/octet-stream"])
            .optional()
            .openapi({
              description:
                "PUT 時に署名される Content-Type。省略時は `application/pdf`。ここで指定した値と PUT リクエストの Content-Type ヘッダは**完全一致している必要あり** (不一致だと S3 が `SignatureDoesNotMatch` で 403)。",
            }),
        }),
      )
      .min(1, "files must not be empty")
      .max(
        MAX_FILES_PER_BATCH,
        `files must not exceed ${MAX_FILES_PER_BATCH} items`,
      )
      .openapi({
        description: `1 バッチあたり最大 ${MAX_FILES_PER_BATCH} ファイル。合計 ${MAX_TOTAL_BYTES / 1024 / 1024} MB、1 ファイルあたり ${MAX_FILE_BYTES / 1024 / 1024} MB が上限。`,
      }),
    extraFormats: z.array(z.enum(EXTRA_FORMATS)).optional().openapi({
      description:
        "追加出力フォーマット。デフォルトは JSON のみ。指定した場合 `batches/{id}/results/*.{md|csv|html|pdf}` にも出力される。",
    }),
  })
  .openapi("CreateBatchBody", {
    example: {
      basePath: "project/2026/batch1",
      files: [
        { filename: "invoice-001.pdf" },
        { filename: "invoice-002.pdf", contentType: "application/pdf" },
      ],
      extraFormats: ["markdown"],
    },
  });

export const UploadItemSchema = z.object({
  filename: z.string().openapi({
    description:
      "サニタイズ後のファイル名。リクエストで指定した `filename` と異なる場合があります (制御文字・パストラバーサル除去)。",
  }),
  fileKey: z.string().openapi({
    description:
      "S3 オブジェクトキー。ダウンロード時や `process_log.jsonl` 内のキー突合に使います。",
    example: "batches/abc-123/input/document.pdf",
  }),
  uploadUrl: z
    .string()
    .url()
    .openapi({
      description: [
        "S3 への PDF PUT 用の署名付き URL。以下の制約をすべて満たすこと:",
        "",
        "1. **メソッド**: `PUT` (POST ではない)",
        "2. **Content-Type ヘッダ**: リクエスト時に指定した `files[].contentType` と完全一致。省略時は `application/pdf`。不一致だと S3 が `SignatureDoesNotMatch` を返して 403。",
        "3. **有効期限**: 発行から **15 分**。超過した場合は `POST /batches` をやり直して新規 URL を取得してください。",
        "4. **ボディ**: PDF バイナリをそのまま送信 (multipart/form-data ではない)。",
      ].join("\n"),
      example:
        "https://<bucket>.s3.ap-northeast-1.amazonaws.com/batches/abc-123/input/document.pdf?X-Amz-Algorithm=...",
    }),
  expiresIn: z.number().int().openapi({
    description: "署名付き URL の残り有効秒数 (通常 900 = 15 分)",
    example: 900,
  }),
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
  total: z.number().int().openapi({ description: "バッチ内のファイル総数" }),
  succeeded: z
    .number()
    .int()
    .openapi({ description: "OCR が成功確定したファイル数" }),
  failed: z.number().int().openapi({
    description: "OCR が失敗確定したファイル数 (再解析は `/reanalyze` で可能)",
  }),
  inProgress: z.number().int().openapi({
    description:
      "まだ終端していないファイル数。バッチが PROCESSING の間のみ非 0 になる",
  }),
});

export const BatchDetailSchema = z
  .object({
    batchJobId: z.string().uuid(),
    status: z.enum(BATCH_STATUSES).openapi({
      description: [
        "バッチの現在ステータス:",
        "- `PENDING`: 作成済・アップロード待ち (24 時間以内に `/start` を呼ばないと自動削除)",
        "- `PROCESSING`: Step Functions 実行中",
        "- `COMPLETED`: 全ファイル成功 (**終端**、`/reanalyze` 不可)",
        "- `PARTIAL`: 成功と失敗が混在 (**終端**、失敗ファイルのみ `/reanalyze` 可)",
        "- `FAILED`: 全ファイル失敗 or infra 失敗 (**終端**、`/reanalyze` 可)",
        "- `CANCELLED`: ユーザーが `DELETE` で取り消し (**終端**、`/reanalyze` 不可)",
      ].join("\n"),
    }),
    totals: BatchTotalsSchema,
    basePath: z.string(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable().openapi({
      description:
        "`/start` を呼んで PROCESSING に遷移した時刻。未実行なら null",
    }),
    updatedAt: z.string().datetime(),
    parentBatchJobId: z.string().uuid().nullable().openapi({
      description:
        "`/reanalyze` で作られたバッチの場合、親バッチの batchJobId。通常作成なら null",
    }),
  })
  .openapi("BatchDetail");

export const BatchFileSchema = z
  .object({
    fileKey: z.string().openapi({
      description: "S3 オブジェクトキー (入力ファイル)",
      example: "batches/abc-123/input/document.pdf",
    }),
    filename: z.string().openapi({
      description: "サニタイズ後のファイル名",
    }),
    status: z.enum(FILE_STATUSES).openapi({
      description:
        "ファイル単位のステータス (`PENDING` / `PROCESSING` / `COMPLETED` / `FAILED`)",
    }),
    dpi: z.number().int().optional().openapi({
      description: "処理時の DPI (成功時のみ)",
    }),
    processingTimeMs: z.number().int().optional().openapi({
      description: "ミリ秒単位の処理時間 (成功時のみ)",
    }),
    resultKey: z.string().optional().openapi({
      description:
        "結果 JSON の S3 オブジェクトキー (`status=COMPLETED` のときのみ存在)。署名付き URL は `resultUrl` を使ってください。",
      example: "batches/abc-123/output/document.json",
    }),
    resultUrl: z
      .string()
      .url()
      .optional()
      .openapi({
        description: [
          "結果 JSON を取得するための署名付き GET URL。",
          "- `status=COMPLETED` のファイルにのみ付与される。",
          "- **有効期限 60 分** (`expiresIn=3600`)。期限切れ後は再度 `GET /batches/{id}/files` を呼ぶと新しい URL が発行される。",
          "- URL は呼び出しごとに再発行されるため、長期保存せず取得直後にダウンロードすること。",
        ].join("\n"),
      }),
    errorMessage: z.string().optional().openapi({
      description: "`status=FAILED` のときに付与される人間可読な失敗理由",
    }),
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
