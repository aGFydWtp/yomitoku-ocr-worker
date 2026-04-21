import { createRoute } from "@hono/zod-openapi";
import {
  CreateBatchBodySchema,
  CreateBatchResponseSchema,
  ErrorResponseSchema,
  ServiceUnavailableSchema,
} from "../schemas";

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
    "4. `GET /batches/:batchJobId` でステータスをポーリング",
    "",
    "## 制約",
    "- エンドポイント未起動時は `503` を返します（裏で自動起動を試みます）",
    "- `uploadUrl` の有効期限は **15 分**",
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
    503: {
      description: "エンドポイント未起動",
      content: { "application/json": { schema: ServiceUnavailableSchema } },
    },
  },
});
