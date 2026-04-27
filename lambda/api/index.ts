import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { handle } from "hono/aws-lambda";
import { handleError } from "./lib/errors";
import { batchesRoutes } from "./routes/batches";
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_BATCH,
  MAX_TOTAL_BYTES,
} from "./schemas";

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const formatSize = (bytes: number): string =>
  bytes >= GB ? `${bytes / GB} GB` : `${bytes / MB} MB`;

export const app = new OpenAPIHono();

app.route("/batches", batchesRoutes);

app.doc("/doc", {
  openapi: "3.0.3",
  info: {
    title: "YomiToku OCR Worker Batch API",
    version: "2.0.0",
    description: [
      "YomiToku-Pro (SageMaker Async Inference) を使ったバッチ OCR API です。",
      "",
      "## アクセス方式",
      "本 API は **CloudFront 経由でのみ**アクセス可能です。API Gateway のエンドポイントを直接叩くと `403 Forbidden` が返ります (API Gateway Resource Policy で `Referer` ヘッダのシークレット照合を行うため)。",
      "",
      "- **Base URL**: この OpenAPI ドキュメント (`/doc`) を配信しているホスト名をそのままご利用ください (通常は `https://<CloudFront distribution domain>`)。",
      "- **認証ヘッダ**: 呼び出し側が追加するヘッダはありません。CloudFront が自動的に内部シークレットヘッダを付与します。",
      "- `Authorization` / `X-API-Key` などは設定しないでください (設定しても無視されますが、混乱を避けるため)。",
      "",
      "## 利用フロー",
      "1. `POST /batches` でバッチを作成し、返却された `uploads[].uploadUrl` に PDF / PPTX / DOCX / XLSX を `PUT` (Content-Type は拡張子別の MIME を schema 仕様で確認、`application/pdf` または `application/vnd.openxmlformats-officedocument.*`、有効 15 分)",
      "2. 全ファイルのアップロード完了後に `POST /batches/{batchJobId}/start` でバッチ実行をキック",
      "3. `GET /batches/{batchJobId}` を 15〜30 秒間隔でポーリングし、`status` が終端 (`COMPLETED` / `PARTIAL` / `FAILED` / `CANCELLED`) になったら停止",
      "4. `GET /batches/{batchJobId}/files` で各ファイルの `resultUrl` (署名付き GET URL、有効 60 分) を取得してダウンロード",
      "5. 失敗が混在した場合 (`PARTIAL` / `FAILED`) は `POST /batches/{batchJobId}/reanalyze` で失敗ファイルのみを対象とした新バッチを作成可能",
      "",
      "### cURL 最小例 (warm 状態)",
      "```sh",
      "BASE=https://<cloudfront>",
      "# 1. バッチ作成",
      "RES=$(curl -sX POST $BASE/batches -H 'content-type: application/json' \\",
      '  -d \'{"batchLabel":"demo","files":[{"filename":"a.pdf"},{"filename":"slides.pptx"}]}\')',
      "BID=$(echo $RES | jq -r .batchJobId)",
      "URL=$(echo $RES | jq -r .uploads[0].uploadUrl)",
      "# 2. アップロード (Content-Type 必須)",
      "curl -X PUT -H 'content-type: application/pdf' --data-binary @a.pdf \"$URL\"",
      "URL=$(echo $RES | jq -r .uploads[1].uploadUrl)",
      "curl -X PUT -H 'content-type: application/vnd.openxmlformats-officedocument.presentationml.presentation' --data-binary @slides.pptx \"$URL\"",
      "# 3. 実行開始",
      "curl -X POST $BASE/batches/$BID/start",
      "# 4. ポーリング (15-30s 間隔)",
      'until [ "$(curl -s $BASE/batches/$BID | jq -r .status)" != PROCESSING ]; do sleep 20; done',
      "# 5. 結果取得",
      "curl -s $BASE/batches/$BID/files | jq .items[].resultUrl",
      "```",
      "",
      "## 状態遷移",
      "",
      "```",
      "PENDING ──(POST /start)──> PROCESSING ──> COMPLETED | PARTIAL | FAILED  (終端)",
      "   │                                                                     │",
      "   └──(DELETE /batches/{id})──> CANCELLED (終端)                         │",
      "                                                                         │",
      "               (POST /reanalyze: COMPLETED を除く終端から分岐、新 batchJobId を返す)",
      "```",
      "",
      "- **PENDING**: 作成済・アップロード待ち。**24 時間以内**に `/start` を呼ばないと DynamoDB TTL で自動削除されます (以後 404)。",
      "- **PROCESSING**: Step Functions 実行中。`GET /batches/{id}` の `totals.inProgress` で残件を確認可能。",
      "- **COMPLETED / PARTIAL / FAILED / CANCELLED**: すべて終端状態でポーリング停止対象。`/reanalyze` は `COMPLETED` と `CANCELLED` を除いた終端からのみ可能。",
      "",
      "## 処理時間の目安",
      "SageMaker Async Endpoint は 0 台 ↔ N 台で伸縮するため、**直前のアイドル時間によって所要時間が大きく変わります**。",
      "",
      "| フェーズ | 目安 | 備考 |",
      "| --- | --- | --- |",
      "| Scale-from-Zero (0→1 台) | 約 **2〜3 分** | 直前にバッチを処理していなかった場合に追加発生 |",
      "| Cold start (model load) | 約 **3〜5 分** | 1 台目のコンテナ pull + モデルロード |",
      "| OCR 処理 (warm, 1 ファイル) | 数秒〜数十秒 / ページ数に応じて増加 | PDF 2 ページの smoke では約 4 秒。Office 形式 (PPTX / DOCX / XLSX) は内部 PDF 変換で +1–3 秒/ファイル程度のオーバーヘッドが追加 |",
      "| scale-in (N→0 台) | 約 **15 分**後にアイドル判定 | 直近処理完了から 15 分無活動で 0 台へ |",
      "",
      "**直近にバッチを流した直後 (warm)**: 数秒〜数分で `COMPLETED` に到達します。",
      "**アイドル状態からの初回 (cold)**: 5〜10 分程度の Scale-from-Zero + cold start 時間を見込んでください。",
      "",
      "`GET /batches/{batchJobId}` のポーリングは **15〜30 秒間隔** を推奨します (短すぎても SageMaker 側の処理は速くなりません)。",
      "",
      "## エラーと再試行",
      "",
      "- **400 Bad Request**: リクエスト検証エラー。`error` メッセージを人間が読んで修正。自動リトライしない。",
      "- **404 Not Found**: `batchJobId` が存在しない or PENDING のまま 24h 経過で削除済。新規 `POST /batches` から再スタート。",
      "- **409 Conflict**: ステータス遷移不可。原因は各エンドポイントの description を参照。同じ `batchJobId` での再試行では解消しない (状態依存なので、別のバッチを作り直すか、ポーリングで終端を待つ)。",
      "- **500 Internal Server Error**: サーバ側の予期せぬ失敗。**最大 3 回まで指数バックオフで再試行**を推奨。",
      "",
      "## 上限値 (ハードリミット)",
      `- 1 バッチあたり最大 **${MAX_FILES_PER_BATCH} ファイル**`,
      `- 1 バッチあたり合計 **${formatSize(MAX_TOTAL_BYTES)}**`,
      `- 1 ファイルあたり最大 **${formatSize(MAX_FILE_BYTES)}**`,
      "- 拡張子は **`.pdf` / `.pptx` / `.docx` / `.xlsx`** (日本語ファイル名可)。Office 形式は内部で LibreOffice により PDF 化されてから OCR にかかる",
      "- `uploadUrl` 有効期限 **15 分** / `resultUrl` 有効期限 **60 分** (呼び出しごとに再発行)",
    ].join("\n"),
  },
  servers: [
    {
      url: "/",
      description:
        "このドキュメント (/doc) を配信しているホストと同一オリジン。CloudFront 配下で配信されている前提で、API Gateway の直接 URL を指定すると 403 になります。",
    },
  ],
});

app.get("/ui", swaggerUI({ url: "/doc" }));

app.onError(handleError);

export const handler = handle(app);
