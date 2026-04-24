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
    "作成直後のバッチは `PENDING` 状態です。**24 時間以内に `POST /batches/{batchJobId}/start` を呼ばない**と DynamoDB TTL で自動削除されます (以降は 404)。",
    "",
    "## 次にやること",
    "1. 返却された `uploads[].uploadUrl` に対して PDF を `PUT` する。",
    "   - HTTP メソッドは `PUT` (POST ではない)",
    "   - `Content-Type: application/pdf` ヘッダ**必須** (リクエスト時に `contentType` を指定した場合はその値)",
    "   - body は PDF バイナリをそのまま (multipart/form-data ではない)",
    "   - 有効期限 15 分 — 超過したら本エンドポイントから作り直し",
    "2. 全ファイルのアップロード完了後、`POST /batches/{batchJobId}/start` でバッチ実行を開始",
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
  description: [
    "バッチ内の全ファイルのステータス、メタデータ、および完了ファイルの `resultUrl` を返します。",
    "",
    "## 成果物の受け取り方",
    "- `status=COMPLETED` のファイルにのみ `resultUrl` (署名付き GET URL、**有効 60 分**) が付与されます。",
    "- `resultUrl` は呼び出しごとに再発行されるため、**長期保存せず取得直後にダウンロード**してください。60 分を過ぎたら本エンドポイントを再度呼び出すと新しい URL が発行されます。",
    "- `status=FAILED` のファイルは `errorMessage` に失敗理由が入ります (再解析は `POST /batches/{id}/reanalyze` で可能)。",
    "- `status=PENDING` / `PROCESSING` の場合はバッチがまだ終端に到達していません。`GET /batches/{id}` を先にポーリングしてください。",
  ].join("\n"),
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
    "## 409 の原因と対応",
    "- 対象バッチが既に `PROCESSING` → すでに走行中。`GET /batches/{id}` でポーリング継続",
    "- 対象バッチが終端 (`COMPLETED` / `PARTIAL` / `FAILED` / `CANCELLED`) → 再実行はできないので `POST /batches/{id}/reanalyze` か新規 `POST /batches` を使用",
    "- いずれの場合も**同じ `batchJobId` で再試行しても解消しません**。状態を確認して別エンドポイントに進んでください。",
  ].join("\n"),
  request: {
    params: z.object({ batchJobId: z.string().uuid() }),
  },
  responses: {
    202: {
      description: "バッチ実行受理 (Step Functions 起動済)",
      content: { "application/json": { schema: StartBatchResponseSchema } },
    },
    404: {
      description: "バッチが存在しない (PENDING TTL 24h で自動削除済の可能性)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description:
        "PENDING 以外の状態。`error` メッセージで現在の status を確認できる",
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
  description: [
    "`PENDING` 状態のバッチを `CANCELLED` に遷移させます。",
    "",
    "- `PROCESSING` 中のバッチは**キャンセルできません** (409)。Step Functions 実行の強制停止は提供していません。進行中を止めたい場合は運用者に連絡してください。",
    "- 終端状態 (`COMPLETED` / `PARTIAL` / `FAILED` / `CANCELLED`) のバッチも 409 を返します。",
    "- キャンセル後のバッチは `/reanalyze` の対象にもなりません (CANCELLED は `reanalyze` 不可)。",
  ].join("\n"),
  request: {
    params: z.object({ batchJobId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "キャンセル成功 (`status=CANCELLED` に遷移)",
      content: { "application/json": { schema: CancelBatchResponseSchema } },
    },
    404: {
      description: "バッチが存在しない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description:
        "PENDING 以外の状態 (PROCESSING 中または既に終端)。同じ ID での再試行では解消しない",
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
  description: [
    "親バッチの `FAILED` ファイル (および `PARTIAL` バッチ内の失敗分) のみを対象とした**新しいバッチ**を作成します。",
    "",
    "- 戻り値は `POST /batches` と同形 (`batchJobId` + `uploads[]`)。返された新 `batchJobId` に対して通常通りアップロード → `/start` の流れを実行してください。",
    "- 作成されるバッチは `parentBatchJobId` に元バッチの ID が入ります。",
    "- 対象となるのは親バッチが `PARTIAL` / `FAILED` の場合のみ。`COMPLETED` (失敗ゼロ) / `CANCELLED` / `PENDING` / `PROCESSING` は 409。",
  ].join("\n"),
  request: {
    params: z.object({ batchJobId: z.string().uuid() }),
  },
  responses: {
    201: {
      description:
        "再解析バッチ作成成功。返却された `batchJobId` に対して通常の /start フローを行う",
      content: { "application/json": { schema: CreateBatchResponseSchema } },
    },
    404: {
      description:
        "親バッチが存在しない、または `process_log.jsonl` が未生成 (=OCR が走っていない)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description:
        "親バッチが終端ではない (PENDING/PROCESSING)、CANCELLED、COMPLETED (失敗 0 件)、またはすでに再解析中",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
