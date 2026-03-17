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
| `ApiStack` | API Gateway (REST), CloudFront, API Lambda (Hono), API Key |
| `MonitoringStack` | CloudWatch Alarms, SNS 通知 |

## 前提条件

- Node.js 18+, pnpm
- AWS CLI (認証済み)
- Docker (Lambda コンテナビルド用)
- AWS Marketplace で YomiToku-Pro をサブスクライブ済み

## セットアップ

```bash
pnpm install

# cdk.context.json を作成（.gitignore 済み）
cp cdk.context.json.example cdk.context.json
# modelPackageArn と region を自分の値に書き換える
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
| `ApiStack.ApiKeyId` | API Key ID（下記コマンドで値を取得） |
| `ApiStack.DistributionDomainName` | CloudFront ドメイン |

```bash
# API Key の値を取得
aws apigateway get-api-key --api-key <ApiKeyId> --include-value \
  --query 'value' --output text
```

## API リファレンス

### 認証

すべてのエンドポイントに API Key が必要です。`x-api-key` ヘッダーで送信してください。

```bash
curl -H "x-api-key: YOUR_API_KEY" https://<DistributionDomainName>/jobs
```

**レート制限**: 100 req/s（バースト 200）、日次クォータ 10,000 リクエスト

### POST /jobs — ジョブ作成

PDF の OCR ジョブを作成し、S3 アップロード用の署名付き URL を取得します。

```bash
curl -X POST https://<DistributionDomainName>/jobs \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"filename": "sample.pdf", "basePath": "myProject/2026031701"}'
```

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `filename` | Yes | PDF ファイル名（`.pdf` で終わる必要あり） |
| `basePath` | No | 処理単位のパスプレフィックス（例: `myProject/2026031701`） |

`basePath` を指定すると、S3 上のファイルが `input/{basePath}/{jobId}/{filename}` に配置され、出力も `output/{basePath}/{jobId}/` 以下に生成されます。未指定時は従来通り `input/{jobId}/{filename}` です。

**レスポンス (201)**:

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "fileKey": "input/myProject/2026031701/550e8400-.../sample.pdf",
  "uploadUrl": "https://s3.amazonaws.com/...?signed",
  "expiresIn": 900
}
```

- `filename` は `.pdf` で終わる必要があります
- `uploadUrl` の有効期限は 15 分です
- `basePath` は英数字・日本語・ハイフン・アンダースコア・ドット・スラッシュのみ使用可能（512 バイト以内）
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
curl https://<DistributionDomainName>/jobs/<jobId> \
  -H "x-api-key: YOUR_API_KEY"
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

### GET /jobs — ジョブ一覧取得

ステータスでフィルタし、ページネーション付きでジョブを取得します。

```bash
curl "https://<DistributionDomainName>/jobs?status=COMPLETED&limit=20" \
  -H "x-api-key: YOUR_API_KEY"
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
curl -X DELETE https://<DistributionDomainName>/jobs/<jobId> \
  -H "x-api-key: YOUR_API_KEY"
```

**レスポンス (200)**: `{"status": "CANCELLED"}`

**エラー**: 409 Conflict（PENDING 以外のステータスの場合）

### GET /status — エンドポイント状態取得

SageMaker エンドポイントの現在の状態を取得します。

```bash
curl https://<DistributionDomainName>/status \
  -H "x-api-key: YOUR_API_KEY"
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
# 0. エンドポイント状態を確認（IDLE なら POST /jobs で自動起動される）
curl -s https://<DistributionDomainName>/status \
  -H "x-api-key: YOUR_API_KEY" | jq .

# 1. ジョブ作成 → 署名付き URL を取得（basePath はオプション）
RESPONSE=$(curl -s -X POST https://<DistributionDomainName>/jobs \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"filename": "sample.pdf", "basePath": "myProject/run001"}')

JOB_ID=$(echo $RESPONSE | jq -r '.jobId')
UPLOAD_URL=$(echo $RESPONSE | jq -r '.uploadUrl')

# 2. PDF をアップロード（自動で OCR が開始される）
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/pdf" \
  --data-binary @sample.pdf

# 3. ステータスをポーリング
curl -s https://<DistributionDomainName>/jobs/$JOB_ID \
  -H "x-api-key: YOUR_API_KEY" | jq .

# 4. 完了後、結果をダウンロード
RESULT_URL=$(curl -s https://<DistributionDomainName>/jobs/$JOB_ID \
  -H "x-api-key: YOUR_API_KEY" | jq -r '.resultUrl')

curl -o result.json "$RESULT_URL"
```

## 開発

```bash
pnpm test        # Jest テスト
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
lambda/
  processor/                  OCR 処理ワーカー (Python, Docker)
  endpoint-control/           エンドポイント制御 (Python)
  api/                        REST API (Hono, TypeScript)
    index.ts                  エントリポイント
    routes/jobs.ts            ジョブ CRUD ルート
    routes/status.ts          エンドポイント状態取得ルート
    lib/                      共通ユーティリティ
test/                         CDK スナップショットテスト
scripts/                      結合テスト用スクリプト
```
