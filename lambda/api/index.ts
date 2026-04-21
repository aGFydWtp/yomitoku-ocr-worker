import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { handle } from "hono/aws-lambda";
import { handleError } from "./lib/errors";
import { batchesRoutes } from "./routes/batches";
import { statusRoutes } from "./routes/status";
import { upRoutes } from "./routes/up";

const app = new OpenAPIHono();

app.route("/batches", batchesRoutes);
app.route("/status", statusRoutes);
app.route("/up", upRoutes);

app.doc("/doc", {
  openapi: "3.0.3",
  info: {
    title: "YomiToku OCR Worker Batch API",
    version: "2.0.0",
    description: [
      "YomiToku-Pro (SageMaker) を使ったバッチ OCR API です。",
      "",
      "## 利用フロー",
      "1. `GET /status` でエンドポイント状態を確認",
      "2. `IDLE` / `DELETING` の場合は `POST /up` で起動を要求（起動まで 5〜10 分）",
      "3. `IN_SERVICE` になったら `POST /batches` でバッチを作成し、返却された `uploads[].uploadUrl` に PDF を PUT",
      "4. アップロード完了後 `POST /batches/{batchJobId}/start` でバッチ実行をキック",
      "5. `GET /batches/{batchJobId}` で進捗、`GET /batches/{batchJobId}/files` で結果、`GET /batches/{batchJobId}/process-log` で `process_log.jsonl` を取得",
      "",
      "## 主な制約",
      "- **エンドポイント未起動時は `POST /batches/{id}/start` が 503 を返します**（裏で自動起動を試みます）",
      "- `uploadUrl` の有効期限は **15 分**、結果取得の署名付き URL は **60 分**",
      "- 1 バッチあたり最大 **100 ファイル / 500 MB**（`MAX_FILES_PER_BATCH` / `MAX_TOTAL_BYTES`）",
      "- キャンセルできるのは `PENDING` 状態のバッチのみ。再解析は終端状態 (`COMPLETED`/`PARTIAL`/`FAILED`) のみ",
    ].join("\n"),
  },
});

app.get("/ui", swaggerUI({ url: "/doc" }));

app.onError(handleError);

export const handler = handle(app);
