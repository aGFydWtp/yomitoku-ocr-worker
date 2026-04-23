import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { handle } from "hono/aws-lambda";
import { handleError } from "./lib/errors";
import { batchesRoutes } from "./routes/batches";

const app = new OpenAPIHono();

app.route("/batches", batchesRoutes);

app.doc("/doc", {
  openapi: "3.0.3",
  info: {
    title: "YomiToku OCR Worker Batch API",
    version: "2.0.0",
    description: [
      "YomiToku-Pro (SageMaker Async Inference) を使ったバッチ OCR API です。",
      "",
      "## 利用フロー",
      "1. `POST /batches` でバッチを作成し、返却された `uploads[].uploadUrl` に PDF を PUT",
      "2. アップロード完了後 `POST /batches/{batchJobId}/start` でバッチ実行をキック",
      "3. `GET /batches/{batchJobId}` で進捗、`GET /batches/{batchJobId}/files` で結果、`GET /batches/{batchJobId}/process-log` で `process_log.jsonl` を取得",
      "",
      "## 主な制約",
      "- SageMaker エンドポイントは常時稼働 (AutoScaling で需要に応じて 0〜N インスタンス)",
      "- `uploadUrl` の有効期限は **15 分**、結果取得の署名付き URL は **60 分**",
      "- 1 バッチあたり最大 **100 ファイル / 500 MB**（`MAX_FILES_PER_BATCH` / `MAX_TOTAL_BYTES`）",
      "- キャンセルできるのは `PENDING` 状態のバッチのみ。再解析は終端状態 (`COMPLETED`/`PARTIAL`/`FAILED`) のみ",
    ].join("\n"),
  },
});

app.get("/ui", swaggerUI({ url: "/doc" }));

app.onError(handleError);

export const handler = handle(app);
