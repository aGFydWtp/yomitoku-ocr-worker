import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { handle } from "hono/aws-lambda";
import { handleError } from "./lib/errors";
import { jobsRoutes } from "./routes/jobs";
import { statusRoutes } from "./routes/status";
import { upRoutes } from "./routes/up";

const app = new OpenAPIHono();

app.route("/jobs", jobsRoutes);
app.route("/status", statusRoutes);
app.route("/up", upRoutes);

app.doc("/doc", {
  openapi: "3.0.3",
  info: {
    title: "YomiToku OCR Worker API",
    version: "1.0.0",
    description: [
      "YomiToku-Pro (SageMaker) を使った PDF OCR のサーバーレス API です。",
      "",
      "## 利用フロー",
      "1. `GET /status` でエンドポイント状態を確認",
      "2. `IDLE` / `DELETING` の場合は `POST /up` で起動を要求（起動まで 5〜10 分）",
      "3. `IN_SERVICE` になったら `POST /jobs` でジョブを作成し、返却された `uploadUrl` に PDF を PUT",
      "4. アップロード完了で OCR が自動開始。`GET /jobs/{jobId}` でステータスをポーリング",
      "5. `COMPLETED` になったら `resultUrl` から結果 JSON をダウンロード",
      "",
      "## 主な制約",
      "- **エンドポイント未起動時は `POST /jobs` が 503 を返します**（裏で自動起動を試みます）",
      "- `uploadUrl` の有効期限は **15 分**、`resultUrl` は **60 分**",
      "- `filepath` は `basePath/filename` 形式で、最低1つの `/` が必要です",
      "- キャンセルできるのは `PENDING` 状態のジョブのみです",
    ].join("\n"),
  },
});

app.get("/ui", swaggerUI({ url: "/doc" }));

app.onError(handleError);

export const handler = handle(app);
