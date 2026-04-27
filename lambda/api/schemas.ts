import path from "node:path";
import { z } from "@hono/zod-openapi";
import { sanitizeFilename } from "./lib/sanitize";

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

// ファイル単位の失敗カテゴリ。``status === "FAILED"`` の場合のみ意味を持ち、
// それ以外では未設定 (undefined) として扱う。
//
// - ``CONVERSION_FAILED``: Office (.pptx / .docx / .xlsx) → PDF 変換が失敗
//   (LibreOffice subprocess の timeout / non-zero exit / silent fail / 暗号化
//   検知 / 変換後 PDF サイズ超過のいずれか、R4.2 / R4.5 / R4.6 / R4.7 / R5.2)。
// - ``OCR_FAILED``: SageMaker Async Inference 経由の OCR 実行で失敗 (R4.3)。
//
// TS (`batch-store.ts:FileItem.errorCategory`) と Py (`batch_store.py:
// update_file_result(error_category=...)`) は同名 DDB 属性 ``errorCategory``
// (camelCase, ``errorMessage`` と対称) を共有する bit 互換契約。
export const ERROR_CATEGORIES = ["CONVERSION_FAILED", "OCR_FAILED"] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// 上限定数
// ---------------------------------------------------------------------------

// 1 バッチあたりのファイル上限。``BatchStore.putBatchWithFiles`` は
// ``TransactWriteItems`` で `1 META + N FILE` を 1 回にまとめて送るため、
// DynamoDB の TransactWriteItems 100 items/call 制約に抵触しないように
// ``MAX_FILES_PER_BATCH + 1 <= 100`` を守る必要がある。1000 ファイル対応は
// ``batch-scale-out`` spec で DDB 書き込みを再設計したうえで引き上げる。
export const MAX_FILES_PER_BATCH = 99;
// 1 バッチあたりの合計サイズ目安。Fargate の ephemeral storage 50 GiB
// (``lib/batch-execution-stack.ts::BatchTaskDef.ephemeralStorageGiB``) を
// 入力 + 出力 + visualization + ログで分け合う前提で 10 GB を上限値として
// OpenAPI description に表示する。API 層では強制していない
// (PUT 後の S3 サイズを API が知る手段がないため)。超過すると Fargate の
// ``No space left on device`` で task が落ちる。Office 形式 (.pptx /
// .docx / .xlsx) は Batch Runner 内で PDF へ変換されるため、変換用の
// 一時 PDF と LibreOffice 中間ファイルもこの ephemeral storage 内に収まる
// 必要がある (Office 形式を多数含むバッチでは実効上限が下がる点に注意)。
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
// SageMaker Async Inference の入力 payload ハードリミットに合わせて 1 GB。
// ``MAX_FILE_BYTES`` は本コード上は ``description`` 文字列の生成にのみ
// 使われており、API 層では強制していない (クライアントがアップロードする
// 前に byte size を API に伝えないため検証不能)。超過した場合は実行時に
// SageMaker 側が ``PayloadTooLargeException`` を返す。Office 形式
// (.pptx / .docx / .xlsx) を入力した場合、変換後 PDF も同じ 1 GB
// 上限で再検証される (変換後サイズ超過は per-file FAILED)。
export const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB
export const ALLOWED_EXTENSIONS = [".pdf", ".pptx", ".docx", ".xlsx"] as const;

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

// stem 重複検出用ヘルパ。サニタイズ後ベース名を case-insensitive な stem に
// 落として同一 stem を共有するファイル群を検出し、利用者がリクエストを
// 修正できるよう「重複していた元ファイル名」を平坦に並べて返す。
// `sanitizeFilename` 由来の throw (拡張子のみ / 空名 / 制御文字 only) は
// refine 側ですでに `false` 扱い (=400) に落ちる経路を通っているため、
// ここではメッセージ生成のみで try/catch する (該当ファイル名は元入力の
// `filename` をそのまま含めてユーザが識別できるようにする)。
function formatDuplicateStems(files: { filename: string }[]): string[] {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    let stem: string | null;
    try {
      stem = path.parse(sanitizeFilename(f.filename)).name.toLowerCase();
    } catch {
      stem = null;
    }
    if (!stem) continue;
    const list = groups.get(stem) ?? [];
    list.push(f.filename);
    groups.set(stem, list);
  }
  const conflicts: string[] = [];
  for (const [stem, names] of groups) {
    if (names.length >= 2) {
      // `report=[report.pdf, report.pptx]` 形式で重複 stem 値とファイル名を併記
      conflicts.push(`${stem}=[${names.join(", ")}]`);
    }
  }
  return conflicts;
}

export const CreateBatchBodySchema = z
  .object({
    batchLabel: z
      .string()
      .min(1, "batchLabel must not be empty")
      .optional()
      .openapi({
        description:
          "バッチの論理的なグルーピング名。**任意フィールド**。S3 key や DynamoDB PK/SK には含まれず、人間がバッチ一覧で識別するための表示用ラベル。省略時はレスポンスで `null` になる。",
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
              description: `拡張子は ${ALLOWED_EXTENSIONS.join(" / ")} のみ許可 (Office 形式は Batch Runner で PDF に自動変換される)。日本語ファイル名も可。Content-Type は拡張子別に決まる: \`.pdf\` → \`application/pdf\` / \`.pptx\` → \`application/vnd.openxmlformats-officedocument.presentationml.presentation\` / \`.docx\` → \`application/vnd.openxmlformats-officedocument.wordprocessingml.document\` / \`.xlsx\` → \`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\`。`,
              example: "document.pdf",
            }),
          contentType: z
            .enum([
              "application/pdf",
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "application/octet-stream",
            ])
            .optional()
            .openapi({
              description:
                "PUT 時に署名される Content-Type。省略時は拡張子から既定値を導出する (`.pdf` → `application/pdf` / `.pptx` → `application/vnd.openxmlformats-officedocument.presentationml.presentation` / `.docx` → `application/vnd.openxmlformats-officedocument.wordprocessingml.document` / `.xlsx` → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`)。ここで指定した値と PUT リクエストの Content-Type ヘッダは**完全一致している必要あり** (不一致だと S3 が `SignatureDoesNotMatch` で 403)。",
            }),
        }),
      )
      .min(1, "files must not be empty")
      .max(
        MAX_FILES_PER_BATCH,
        `files must not exceed ${MAX_FILES_PER_BATCH} items`,
      )
      // R3.4 / R3.5: 同一 stem (拡張子を除いたベース名、サニタイズ後、case-insensitive)
      // を持つファイルが 2 件以上含まれた場合は 400 で reject する。Office 形式追加で
      // `report.pdf` + `report.pptx` のような同 stem 異拡張子の組合せが現実的になった
      // ため、出力 JSON (`{stem}.json`) や可視化ファイル (`{basename}_..._page_*.jpg`)
      // のキー衝突を作成時点で防ぐ。`sanitizeFilename` は前段の `allowedExtensionRegex`
      // refine と Zod `.min(1)` で大半の入力が事前に弾かれている前提で、それでも
      // 想定外 throw が起きた場合は refine を `false` 扱い (=400) に落として 500 化を防ぐ。
      .refine(
        (files) => {
          try {
            const stems = files.map((f) =>
              path.parse(sanitizeFilename(f.filename)).name.toLowerCase(),
            );
            return new Set(stems).size === stems.length;
          } catch {
            return false;
          }
        },
        {
          error: (issue) => {
            const files = issue.input as { filename: string }[] | undefined;
            if (!files) return "Duplicate stem detected.";
            return `Duplicate stem detected. Conflicting files: [${formatDuplicateStems(files).join(", ")}]`;
          },
        },
      )
      .openapi({
        description: `1 バッチあたり最大 ${MAX_FILES_PER_BATCH} ファイル。合計 ${MAX_TOTAL_BYTES / 1024 / 1024} MB、1 ファイルあたり ${MAX_FILE_BYTES / 1024 / 1024} MB が上限。PDF と Office 形式 (.pptx / .docx / .xlsx) を 1 バッチ内で混在させることが可能 (Office 形式は Batch Runner 内で PDF へ自動変換)。Content-Type は拡張子別に既定値が決まり、各ファイルの \`contentType\` で明示することもできる。`,
      }),
    extraFormats: z.array(z.enum(EXTRA_FORMATS)).optional().openapi({
      description:
        "追加出力フォーマット。デフォルトは JSON のみ。指定した場合 `batches/{id}/results/*.{md|csv|html|pdf}` にも出力される。",
    }),
  })
  .openapi("CreateBatchBody", {
    example: {
      batchLabel: "project/2026/batch1",
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
        "S3 への PUT 用の署名付き URL (PDF / PPTX / DOCX / XLSX を直接アップロード可能)。以下の制約をすべて満たすこと:",
        "",
        "1. **メソッド**: `PUT` (POST ではない)",
        "2. **Content-Type ヘッダ**: リクエスト時に指定した `files[].contentType` と完全一致。省略時は拡張子別の既定値 (`.pdf` → `application/pdf` / `.pptx` → `application/vnd.openxmlformats-officedocument.presentationml.presentation` / `.docx` → `application/vnd.openxmlformats-officedocument.wordprocessingml.document` / `.xlsx` → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`)。不一致だと S3 が `SignatureDoesNotMatch` を返して 403。",
        "3. **有効期限**: 発行から **15 分**。超過した場合は `POST /batches` をやり直して新規 URL を取得してください。",
        "4. **ボディ**: ファイルバイナリをそのまま送信 (multipart/form-data ではない)。Office 形式は Batch Runner 内で PDF に変換される。",
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
    batchLabel: z.string().nullable().openapi({
      description:
        "作成時に指定された任意の表示用ラベル。未指定のバッチや `batchLabel` 導入前に作られた古いバッチでは `null`。",
    }),
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
    errorCategory: z
      .enum(ERROR_CATEGORIES)
      .optional()
      .openapi({
        description: [
          "`status=FAILED` のときに付与される失敗カテゴリ。",
          "- `CONVERSION_FAILED`: Office (`.pptx` / `.docx` / `.xlsx`) → PDF 変換段階での失敗 (LibreOffice timeout / non-zero exit / silent fail / 暗号化検知 / 変換後サイズ上限超過)。",
          "- `OCR_FAILED`: SageMaker Async Inference 経由の OCR 実行段階での失敗。",
          "",
          '本フィールド導入前に作成された旧 FILE アイテムでは未設定 (キーごと省略) となる。`status !== "FAILED"` の場合も常に省略される。',
        ].join("\n"),
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
