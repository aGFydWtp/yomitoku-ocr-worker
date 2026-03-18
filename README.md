# YomiToku OCR Worker

S3 に PDF をアップロードすると、[YomiToku-Pro](https://aws.amazon.com/marketplace/pp/prodview-wjf2quasznrlm) (SageMaker Marketplace) で OCR を実行し、結果を JSON で返すサーバーレスパイプラインです。

## アーキテクチャ

```
Client ─→ CloudFront ─→ API Gateway (REST) ─→ Lambda (Hono)
                                                  ├→ POST /jobs      → DynamoDB + S3 presigned URL
                                                  ├→ GET  /jobs/:id  → DynamoDB (+ S3 presigned URL)
                                                  ├→ GET  /jobs      → DynamoDB (GSI)
                                                  ├→ DELETE /jobs/:id → DynamoDB + S3 削除
                                                  └→ GET  /status    → DynamoDB (エンドポイント状態)

S3 (input/) ─→ EventBridge Rule ─→ Step Functions (エンドポイント制御)
             ─→ SQS ─→ Lambda (処理ワーカー) ─→ SageMaker Endpoint ─→ S3 (output/)
```

**ポイント**: SageMaker エンドポイント (ml.g5.xlarge) はリクエスト時のみ Step Functions が自動作成し、キューが空になると自動削除します。アイドル時の課金はほぼゼロです。

## CDK スタック構成

| スタック | 内容 |
|---------|------|
| `SagemakerStack` | CfnModel, CfnEndpointConfig, IAM ロール |
| `ProcessingStack` | S3, SQS (+ DLQ), DynamoDB × 2, 処理ワーカー Lambda |
| `OrchestrationStack` | Step Functions, EventBridge Rule, エンドポイント制御 Lambda |
| `ApiStack` | API Gateway (REST), CloudFront (+ WAF), API Lambda (Hono) |
| `MonitoringStack` | CloudWatch Alarms, SNS 通知 |

## 前提条件

- Node.js 18+, pnpm (workspace 構成)
- AWS CLI (認証済み)
- Docker (Lambda コンテナビルド用)
- AWS Marketplace で YomiToku-Pro をサブスクライブ済み

## セットアップ

```bash
pnpm install

# cdk.context.json を作成（.gitignore 済み）
cp cdk.context.json.example cdk.context.json
# modelPackageArn と region を自分の値に書き換える
# WAF を使う場合は wafWebAclId も設定（オプショナル）
```

## デプロイ

```bash
npx cdk bootstrap   # 初回のみ
npx cdk deploy --all
```

デプロイ後、以下の出力値を確認してください:

| 出力キー | 内容 |
|---------|------|
| `ApiStack.ApiUrl` | API Gateway エンドポイント URL |
| `ApiStack.DistributionDomainName` | CloudFront ドメイン |

## API リファレンス

### アクセス制御

API Gateway への直接アクセスは CloudFront origin verify header + リソースポリシーでブロックされます。すべてのリクエストは CloudFront 経由で行ってください。

`cdk.context.json` に `wafWebAclId`（us-east-1 の WAFv2 Web ACL ARN）を指定すると、CloudFront に WAF を紐付けて IP 制限などを適用できます。IPv6 は無効化されているため、IPv4 IP Set のみで制御可能です。

```bash
curl https://<DistributionDomainName>/jobs
```

### POST /jobs — ジョブ作成

PDF の OCR ジョブを作成し、S3 アップロード用の署名付き URL を取得します。

```bash
curl -X POST https://<DistributionDomainName>/jobs \
  -H "Content-Type: application/json" \
  -d '{"filepath": "myProject/2026031701/sample.pdf"}'
```

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `filepath` | Yes | PDF ファイルパス（`basePath/filename` 形式）。最低1つの `/` が必要 |

API 側で最後の `/` を基準に basePath（ディレクトリ部分）と filename（ファイル名部分）に分割します。S3 上のファイルは `input/{basePath}/{jobId}/{filename}` に配置され、出力も `output/{basePath}/{jobId}/` 以下に生成されます。

**レスポンス (201)**:

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "fileKey": "input/myProject/2026031701/550e8400-.../sample.pdf",
  "uploadUrl": "https://s3.amazonaws.com/...?signed",
  "expiresIn": 900
}
```

- filename 部分は `.pdf` で終わる必要があります
- `uploadUrl` の有効期限は 15 分です
- basePath 部分は英数字・日本語・ハイフン・アンダースコア・ドット・スラッシュのみ使用可能（512 バイト以内）
- エンドポイントが起動していない場合は **503** を返し、裏でエンドポイントの起動を開始します

### ファイルアップロード

`uploadUrl` に対して PDF を PUT します。アップロード完了で OCR 処理が自動開始されます。

```bash
curl -X PUT "<uploadUrl>" \
  -H "Content-Type: application/pdf" \
  --data-binary @sample.pdf
```

### GET /jobs/:jobId — ジョブ状態取得

```bash
curl https://<DistributionDomainName>/jobs/<jobId>
```

**レスポンス (200)**:

```json
{
  "jobId": "550e8400-...",
  "status": "COMPLETED",
  "createdAt": "2026-03-04T12:00:00.000Z",
  "updatedAt": "2026-03-04T12:15:00.000Z",
  "resultUrl": "https://s3.amazonaws.com/...?signed",
  "resultExpiresIn": 3600,
  "processingTimeMs": 12345
}
```

| ステータス | 説明 |
|-----------|------|
| `PENDING` | アップロード待ち / 処理開始前 |
| `PROCESSING` | OCR 処理中 |
| `COMPLETED` | 完了 — `resultUrl` から結果をダウンロード可能（有効期限 60 分） |
| `FAILED` | 失敗 — `errorMessage` にエラー内容 |
| `CANCELLED` | キャンセル済み |

### GET /jobs/:jobId/visualizations — 可視化画像 URL 取得

COMPLETED ジョブのレイアウト/OCR 可視化画像の署名付き URL を返します。

```bash
# 全画像を取得
curl "https://<DistributionDomainName>/jobs/<jobId>/visualizations"

# layout のページ 0,1 のみ取得
curl "https://<DistributionDomainName>/jobs/<jobId>/visualizations?mode=layout&page=0,1"
```

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `mode` | No | `layout` \| `ocr`。省略時は両方 |
| `page` | No | カンマ区切りの 0-indexed ページ番号。省略時は全ページ |

**レスポンス (200)**:

```json
{
  "items": [
    { "mode": "layout", "page": 0, "url": "https://s3.amazonaws.com/...?signed" },
    { "mode": "ocr", "page": 0, "url": "https://s3.amazonaws.com/...?signed" }
  ],
  "numPages": 5,
  "expiresIn": 3600
}
```

> 可視化データが存在しない場合（未完了ジョブ、画像未生成）は 404 を返します。

### GET /jobs — ジョブ一覧取得

ステータスでフィルタし、ページネーション付きでジョブを取得します。

```bash
curl "https://<DistributionDomainName>/jobs?status=COMPLETED&limit=20"
```

| パラメータ | 必須 | デフォルト | 説明 |
|-----------|------|-----------|------|
| `status` | Yes | — | `PENDING` / `PROCESSING` / `COMPLETED` / `FAILED` / `CANCELLED` |
| `limit` | No | 20 | 取得件数 (1–100) |
| `cursor` | No | — | 前回レスポンスの `cursor` 値（次ページ取得用） |

**レスポンス (200)**:

```json
{
  "items": [
    {
      "jobId": "...",
      "status": "COMPLETED",
      "createdAt": "...",
      "updatedAt": "...",
      "originalFilename": "sample.pdf"
    }
  ],
  "count": 1,
  "cursor": "base64EncodedToken"
}
```

### DELETE /jobs/:jobId — ジョブキャンセル

`PENDING` 状態のジョブのみキャンセルできます。

```bash
curl -X DELETE https://<DistributionDomainName>/jobs/<jobId>
```

**レスポンス (200)**: `{"status": "CANCELLED"}`

**エラー**: 409 Conflict（PENDING 以外のステータスの場合）

### GET /status — エンドポイント状態取得

SageMaker エンドポイントの現在の状態を取得します。

```bash
curl https://<DistributionDomainName>/status
```

**レスポンス (200)**:

```json
{
  "endpointState": "IN_SERVICE",
  "updatedAt": "2026-03-17T09:18:06.668789+00:00"
}
```

| 状態 | 説明 |
|------|------|
| `IDLE` | エンドポイント未起動（初期状態または削除済み） |
| `CREATING` | エンドポイント起動中（通常 5–10 分） |
| `IN_SERVICE` | エンドポイント稼働中 — ジョブ登録可能 |
| `DELETING` | エンドポイント削除中 |

### エラーレスポンス

すべてのエラーは以下の形式で返されます:

```json
{
  "error": "エラーメッセージ"
}
```

| ステータスコード | 説明 |
|----------------|------|
| 400 | バリデーションエラー（不正なパラメータ、非 PDF ファイルなど） |
| 404 | ジョブが見つからない |
| 409 | 競合（キャンセル不可のステータス） |
| 500 | サーバーエラー |
| 503 | エンドポイント未起動（`endpointState` を含む。`GET /status` で状態を確認） |

## 使い方（完全なフロー例）

```bash
BASE_URL="https://<DistributionDomainName>"

# 0. エンドポイント状態を確認
STATE=$(curl -s "$BASE_URL/status" | jq -r '.endpointState')
echo "Endpoint state: $STATE"

# 1. IDLE / DELETING の場合は POST /up で起動を要求（IN_SERVICE なら不要）
if [ "$STATE" != "IN_SERVICE" ]; then
  curl -s -X POST "$BASE_URL/up" | jq .
  echo "Waiting for endpoint to start (5-10 min)..."
  while [ "$(curl -s "$BASE_URL/status" | jq -r '.endpointState')" != "IN_SERVICE" ]; do
    sleep 30
  done
  echo "Endpoint is ready."
fi

# 2. ジョブ作成 → 署名付き URL を取得
RESPONSE=$(curl -s -X POST "$BASE_URL/jobs" \
  -H "Content-Type: application/json" \
  -d '{"filepath": "myProject/run001/sample.pdf"}')

JOB_ID=$(echo $RESPONSE | jq -r '.jobId')
UPLOAD_URL=$(echo $RESPONSE | jq -r '.uploadUrl')

# 3. PDF をアップロード（自動で OCR が開始される）
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/pdf" \
  --data-binary @sample.pdf

# 4. ステータスをポーリング
curl -s "$BASE_URL/jobs/$JOB_ID" | jq .

# 5. 完了後、結果をダウンロード
RESULT_URL=$(curl -s "$BASE_URL/jobs/$JOB_ID" | jq -r '.resultUrl')

curl -o result.json "$RESULT_URL"
```

### Swagger UI

API Lambda には Swagger UI が組み込まれています。デプロイ後、以下の URL でインタラクティブに API を確認できます。

```
https://<DistributionDomainName>/ui
```

OpenAPI ドキュメント (JSON) は `/doc` で取得できます。

## 開発

pnpm workspace で管理しています。ルートで `pnpm install` を実行すると、`lambda/api` の依存も一括インストールされます。

```bash
pnpm install     # 全ワークスペースの依存をインストール
pnpm test        # CDK テスト (Jest)
pnpm test:api    # API テスト (Vitest, lambda/api)
pnpm lint        # Biome lint
pnpm lint:fix    # 自動修正
npx cdk synth    # CloudFormation テンプレート生成 + CDK Nag チェック
```

## ディレクトリ構成

```
bin/app.ts                    CDK エントリポイント
lib/
  sagemaker-stack.ts          SageMaker モデル・設定
  processing-stack.ts         S3 / SQS / DynamoDB / 処理 Lambda
  orchestration-stack.ts      Step Functions / EventBridge Rule
  api-stack.ts                API Gateway / CloudFront / API Lambda
  monitoring-stack.ts         CloudWatch / SNS
pnpm-workspace.yaml           ワークスペース定義
lambda/
  processor/                  OCR 処理ワーカー (Python, Docker)
  endpoint-control/           エンドポイント制御 (Python)
  api/                        REST API (Hono, TypeScript) ← pnpm workspace
    index.ts                  エントリポイント + Swagger UI
    schemas.ts                Zod スキーマ + OpenAPI 定義
    openapi.ts                OpenAPI ドキュメント設定
    routes/
      jobs.routes.ts          ルート定義 (OpenAPI メタデータ)
      jobs.ts                 ジョブ CRUD ハンドラ
      status.ts               エンドポイント状態取得
    lib/
      validate.ts             filepath 分割 / basePath / cursor バリデーション
      errors.ts               エラークラス + ハンドラ
      s3.ts                   S3 操作 (presigned URL, 削除)
      sanitize.ts             ファイル名サニタイズ
      dynamodb.ts             DynamoDB クライアント
      sfn.ts                  Step Functions クライアント
    biome.json                Biome 設定 (ルート継承)
test/                         CDK スナップショットテスト
scripts/                      結合テスト用スクリプト
```
