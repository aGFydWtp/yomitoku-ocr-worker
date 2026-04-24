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
      "## 処理時間の目安",
      "SageMaker Async Endpoint は 0 台 ↔ N 台で伸縮するため、**直前のアイドル時間によって所要時間が大きく変わります**。",
      "",
      "| フェーズ | 目安 | 備考 |",
      "| --- | --- | --- |",
      "| Scale-from-Zero (0→1 台) | 約 **2〜3 分** | `HasBacklogWithoutCapacity` alarm 検知 + scale-up 発火 |",
      "| Cold start (model load) | 約 **3〜5 分** | 1 台目のコンテナ pull + モデルロード |",
      "| OCR 処理 (warm, 1 ファイル) | 数秒〜数十秒 / ページ数に応じて増加 | PDF 2 ページの smoke では約 4 秒 |",
      "| scale-in (N→0 台) | 約 **15 分**後にアイドル判定 | TargetTracking AlarmLow の datapoint 蓄積 |",
      "",
      "**直近にバッチを流した直後 (warm)**: 数秒〜数分で `COMPLETED` に到達します。",
      "**アイドル状態からの初回 (cold)**: 5〜10 分程度の Scale-from-Zero + cold start 時間を見込んでください。",
      "",
      "`GET /batches/{batchJobId}` のポーリングは **15〜30 秒間隔** を推奨します (短すぎると API 呼び出しだけ増えて GPU 処理の早さには影響しません)。",
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
