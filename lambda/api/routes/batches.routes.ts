import { createRoute, z } from "@hono/zod-openapi";
import {
  BATCH_STATUSES,
  BatchDetailSchema,
  BatchFilesPageSchema,
  BatchListPageSchema,
  CancelBatchResponseSchema,
  CreateBatchBodySchema,
  CreateBatchResponseSchema,
  ErrorResponseSchema,
  ProcessLogLinkSchema,
  StartBatchResponseSchema,
} from "../schemas";

// ---------------------------------------------------------------------------
// POST / — バッチ作成
// ---------------------------------------------------------------------------
export const createBatchRoute = createRoute({
  method: "post",
  path: "/",
  summary: "バッチ作成",
  description: [
    "複数 PDF ファイルのバッチ OCR ジョブを作成し、S3 アップロード用の署名付き URL 群を返します。",
    "",
    "## 利用フロー",
    "1. `POST /batches` でバッチを作成し `batchJobId` と `uploadUrls` を取得",
    "2. 各 `uploadUrl` に PDF を PUT（有効期限 15 分）",
    "3. `POST /batches/:batchJobId/start` でバッチ実行を開始",
  ].join("\n"),
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateBatchBodySchema } },
    },
  },
  responses: {
    201: {
      description: "バッチ作成成功",
      content: { "application/json": { schema: CreateBatchResponseSchema } },
    },
    400: {
      description: "バリデーションエラー",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// GET / — バッチ一覧
// ---------------------------------------------------------------------------
export const listBatchesRoute = createRoute({
  method: "get",
  path: "/",
  summary: "バッチ一覧",
  description:
    "status + yyyymm でフィルタしカーソルページングでバッチ一覧を返します。",
  request: {
    query: z.object({
      status: z.enum(BATCH_STATUSES, {
        error: `status must be one of: ${BATCH_STATUSES.join(", ")}`,
      }),
      month: z
        .string()
        .regex(/^\d{6}$/, "month must be yyyymm format")
        .optional()
        .openapi({ example: "202604" }),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "バッチ一覧",
      content: { "application/json": { schema: BatchListPageSchema } },
    },
    400: {
      description: "バリデーションエラー",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// GET /:batchJobId — バッチ詳細
// ---------------------------------------------------------------------------
export const getBatchRoute = createRoute({
  method: "get",
  path: "/:batchJobId",
  summary: "バッチ詳細",
  description: [
    "バッチの現在のステータスと totals (total / succeeded / failed / inProgress) を返します。",
    "",
    "## ポーリング推奨",
    "- 間隔: **15〜30 秒**。より短く叩いても SageMaker の処理は早くなりません。",
    "- 終端状態: `COMPLETED` / `PARTIAL` / `FAILED` / `CANCELLED`。これらを検知したらポーリングを停止してください。",
    "- cold start 初回は合計 5〜10 分 `PROCESSING` のまま推移することがあります (Scale-from-Zero + モデルロード時間)。",
  ].join("\n"),
  request: {
    params: z.object({ batchJobId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "バッチ詳細",
      content: { "application/json": { schema: BatchDetailSchema } },
    },
    404: {
      description: "バッチが存在しない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// GET /:batchJobId/files — ファイル一覧
// ---------------------------------------------------------------------------
export const listBatchFilesRoute = createRoute({
  method: "get",
  path: "/:batchJobId/files",
  summary: "バッチファイル一覧",
  description: "完了ファイルには署名付き GET URL（60 分）を付与します。",
  request: {
    params: z.object({ batchJobId: z.string().uuid() }),
    query: z.object({ cursor: z.string().optional() }),
  },
  responses: {
    200: {
      description: "ファイル一覧",
      content: { "application/json": { schema: BatchFilesPageSchema } },
    },
    404: {
      description: "バッチが存在しない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// GET /:batchJobId/process-log — process_log.jsonl 署名付き URL
// ---------------------------------------------------------------------------
export const getProcessLogRoute = createRoute({
  method: "get",
  path: "/:batchJobId/process-log",
  summary: "process_log.jsonl 取得 URL",
  description:
    "終端状態（COMPLETED/PARTIAL/FAILED/CANCELLED）のバッチのみ利用可能。",
  request: {
    params: z.object({ batchJobId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "署名付き URL",
      content: { "application/json": { schema: ProcessLogLinkSchema } },
    },
    404: {
      description: "バッチが存在しない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "バッチが終端状態でない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// POST /:batchJobId/start — バッチ実行開始 (Task 2.5)
// ---------------------------------------------------------------------------
export const startBatchRoute = createRoute({
  method: "post",
  path: "/:batchJobId/start",
  summary: "バッチ実行開始",
  description: [
    "PENDING 状態のバッチを PROCESSING へ遷移させ、BatchExecutionStateMachine を起動します。",
    "",
    "## 処理時間の目安",
    "- **直前にバッチが流れた warm 状態**: 本エンドポイント応答 (202) から数秒〜数分で `COMPLETED` に到達",
    "- **アイドル状態からの cold start**: Scale-from-Zero (〜3 分) + モデルロード (〜5 分) + OCR 処理、合計 **5〜10 分** を目安に",
    "- 本エンドポイントは Step Functions の起動のみで応答するため常に数秒で返ります。以降の進捗は `GET /batches/{batchJobId}` をポーリングしてください (15〜30 秒間隔推奨)",
    "",
    "## 制約",
    "- PENDING 以外のステータスでは `409` を返します。",
    "- 同一バッチに対して複数回呼び出すと、2 回目以降は `409` を返します。",
  ].join("\n"),
  request: {
    params: z.object({ batchJobId: z.string().uuid() }),
  },
  responses: {
    202: {
      description: "バッチ実行受理（Step Functions 起動済）",
      content: { "application/json": { schema: StartBatchResponseSchema } },
    },
    404: {
      description: "バッチが存在しない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "PENDING 以外の状態、または遷移競合",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// DELETE /:batchJobId — バッチキャンセル
// ---------------------------------------------------------------------------
export const cancelBatchRoute = createRoute({
  method: "delete",
  path: "/:batchJobId",
  summary: "バッチキャンセル",
  description: "PENDING 状態のバッチのみキャンセル可能。",
  request: {
    params: z.object({ batchJobId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "キャンセル成功",
      content: { "application/json": { schema: CancelBatchResponseSchema } },
    },
    404: {
      description: "バッチが存在しない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "PENDING 以外の状態",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// POST /:batchJobId/reanalyze — 失敗ファイルの再解析
// ---------------------------------------------------------------------------
export const reanalyzeBatchRoute = createRoute({
  method: "post",
  path: "/:batchJobId/reanalyze",
  summary: "再解析バッチ作成",
  description:
    "終端状態バッチの失敗ファイルのみを対象とした新バッチを作成します。",
  request: {
    params: z.object({ batchJobId: z.string().uuid() }),
  },
  responses: {
    201: {
      description: "再解析バッチ作成成功",
      content: { "application/json": { schema: CreateBatchResponseSchema } },
    },
    404: {
      description: "バッチまたは process_log.jsonl が存在しない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "終端状態でない、または失敗ファイルがない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
