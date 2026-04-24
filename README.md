# YomiToku OCR Worker

PDF のバッチ OCR を [YomiToku-Pro](https://aws.amazon.com/marketplace/pp/prodview-wjf2quasznrlm) (SageMaker Marketplace) で実行するサーバーレスパイプラインです。1 バッチあたり最大 **100 ファイル / 500 MB** の PDF をまとめて解析し、結果（JSON／Markdown／CSV／HTML／PDF）を S3 に出力します。

## アーキテクチャ

```
Client ─→ CloudFront ─→ API Gateway (REST) ─→ Lambda (Hono)
                                                  ├→ POST   /batches                    → DynamoDB + S3 presigned PUT × N
                                                  ├→ POST   /batches/:id/start          → Step Functions (BatchExecution)
                                                  ├→ GET    /batches                    → DynamoDB (GSI1)
                                                  ├→ GET    /batches/:id                → DynamoDB
                                                  ├→ GET    /batches/:id/files          → DynamoDB
                                                  ├→ GET    /batches/:id/process-log    → S3 presigned GET (process_log.jsonl)
                                                  ├→ DELETE /batches/:id                → DynamoDB (PENDING のみ CANCEL)
                                                  ├→ POST   /batches/:id/reanalyze      → DynamoDB + Step Functions
                                                  ├→ POST   /up                         → Step Functions (EndpointControl)
                                                  └→ GET    /status                     → DynamoDB (endpoint state)

Step Functions (BatchExecution) ─→ ECS Fargate (BatchRunnerTask)
                                    └→ yomitoku-client.analyze_batch_async
                                       ├→ SageMaker Endpoint (ml.g5.xlarge)
                                       ├→ S3 (batches/{id}/input,output,visualizations,logs)
                                       └→ DynamoDB BatchTable (META / FILE アイテム)

Step Functions (EndpointControl) ─→ SageMaker Endpoint CRUD + ControlTable heartbeat
```

**ポイント**:

- SageMaker エンドポイント (ml.g5.xlarge) は API リクエスト時に Step Functions が自動作成し、実行中バッチが 0 になれば自動削除します。アイドル時の課金はほぼゼロです。
- バッチ実行は ECS Fargate (4 vCPU / 16 GB) 上の BatchRunnerTask が `yomitoku-client.analyze_batch_async` を呼び出し、ファイル単位の成果物とサーキットブレーカー付きログを S3 に書き出します。
- 状態保持は Single-table DynamoDB (`BatchTable`) で `BATCH#{id}` PK + `META` / `FILE#{key}` SK を採用。GSI1 (ステータス別一覧) と GSI2 (再解析親子参照) を備えます。

## CDK スタック構成

| スタック | 内容 |
|---------|------|
| `SagemakerStack` | CfnModel, CfnEndpointConfig, IAM ロール |
| `ProcessingStack` | S3 (batches/* プレフィックス), DynamoDB `ControlTable` / `BatchTable` (+ GSI1/GSI2) |
| `OrchestrationStack` | Step Functions (EndpointControl), EventBridge Rule, エンドポイント制御 Lambda |
| `BatchExecutionStack` | Step Functions (BatchExecution), ECS Fargate Task (`BatchRunnerTask`), VPC / タスクロール |
| `ApiStack` | API Gateway (REST), CloudFront (+ WAF 任意), API Lambda (Hono) |
| `MonitoringStack` | CloudWatch Alarms (`FilesFailedAlarm`, `BatchDurationAlarm`), SNS 通知 |

## 前提条件

- Node.js 18+, pnpm (workspace 構成)
- AWS CLI (認証済み)
- Docker (BatchRunnerTask コンテナビルド用)
- AWS Marketplace で YomiToku-Pro をサブスクライブ済み

## セットアップ

```bash
pnpm install

# cdk.context.json を作成（.gitignore 済み）
cp cdk.context.json.example cdk.context.json
# modelPackageArn / region / endpointName / endpointConfigName を自分の値に書き換える
# WAF を使う場合は wafWebAclId も設定（オプショナル、us-east-1 の WAFv2 Web ACL ARN）
```

## デプロイ

既定の AWS リージョンは `ap-northeast-1` (東京) です。Async Endpoint 用 `ml.g5.xlarge` と周辺リソース (S3 / DynamoDB / CloudFront オリジン) を同一リージョンに揃え、国内運用を想定しています。

```bash
npx cdk bootstrap   # 初回のみ
npx cdk deploy --all -c region=ap-northeast-1
```

> **退避用リージョンの注意点**
>
> `ap-northeast-1` で `ml.g5.xlarge` の capacity が逼迫した場合は `-c region=us-east-1` で退避用スタックをデプロイできます。ただし S3 / DynamoDB / Step Functions / CloudFront オリジンはすべて別リージョンに新設され、既存 `ap-northeast-1` スタックとはデータを共有しません。退避判断と切り替え手順は `docs/runbooks/sagemaker-async-cutover.md` を参照してください。

デプロイ後、以下の出力値を確認してください:

| 出力キー | 内容 |
|---------|------|
| `ApiStack.ApiUrl` | API Gateway エンドポイント URL |
| `ApiStack.DistributionDomainName` | CloudFront ドメイン |
| `ProcessingStack.BucketName` | バッチ入出力用 S3 バケット |
| `ProcessingStack.BatchTableName` | Single-table DynamoDB 名 |
| `BatchExecutionStack.BatchExecutionStateMachineArn` | バッチ実行用 Step Functions ARN |

## API リファレンス

### アクセス制御

API Gateway への直接アクセスは CloudFront origin verify header + リソースポリシーでブロックされます。すべてのリクエストは CloudFront 経由で行ってください。

`cdk.context.json` の `wafWebAclId`（us-east-1 の WAFv2 Web ACL ARN）を設定すると、CloudFront に WAF を紐付けて IP 制限などを適用できます。IPv6 は無効化されているため、IPv4 IP Set のみで制御可能です。

```bash
curl https://<DistributionDomainName>/batches
```

### POST /batches — バッチ作成

PDF をまとめて解析するためのバッチを作成し、ファイル数ぶんの署名付き PUT URL を取得します。

```bash
curl -X POST https://<DistributionDomainName>/batches \
  -H "Content-Type: application/json" \
  -d '{
    "basePath": "project/2026/batch1",
    "files": [
      { "filename": "doc-a.pdf" },
      { "filename": "doc-b.pdf" }
    ],
    "extraFormats": ["markdown", "csv"]
  }'
```

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `basePath` | Yes | 成果物の出力先プレフィックス（`batches/{batchJobId}/{basePath}/...` の配下に整列）。英数字・日本語・ハイフン・アンダースコア・ドット・スラッシュのみ、512 バイト以内 |
| `files[].filename` | Yes | アップロード予定の PDF ファイル名。`.pdf` 拡張子必須。1 バッチ最大 **100 ファイル** |
| `files[].contentType` | No | `application/pdf` / `application/octet-stream`（省略時 `application/pdf`） |
| `extraFormats` | No | 追加出力フォーマット。`markdown` / `csv` / `html` / `pdf` の配列 |

**レスポンス (201)**:

```json
{
  "batchJobId": "550e8400-e29b-41d4-a716-446655440000",
  "uploads": [
    {
      "filename": "doc-a.pdf",
      "fileKey": "batches/550e8400-.../input/doc-a.pdf",
      "uploadUrl": "https://s3.amazonaws.com/...?signed",
      "expiresIn": 900
    }
  ]
}
```

- `uploadUrl` の有効期限は **15 分**
- エンドポイントが未起動 (`IDLE` / `DELETING`) の場合、バッチ作成リクエスト自体は成功し、裏で `POST /up` 相当の自動起動が走ります
- 1 バッチの合計サイズ上限は **500 MB**（`MAX_TOTAL_BYTES`）、1 ファイルあたり **50 MB**（`MAX_FILE_BYTES`）

### ファイルアップロード

各 `uploadUrl` に対して PDF を PUT します。全ファイルアップロード後、`POST /batches/:id/start` でバッチを起動します。

```bash
for item in $(echo "$RESPONSE" | jq -c '.uploads[]'); do
  URL=$(echo "$item" | jq -r '.uploadUrl')
  NAME=$(echo "$item" | jq -r '.filename')
  curl -X PUT "$URL" \
    -H "Content-Type: application/pdf" \
    --data-binary "@$NAME"
done
```

### POST /batches/:batchJobId/start — バッチ実行開始

`PENDING` 状態のバッチを BatchExecutionStateMachine でキックします。エンドポイントが `IN_SERVICE` でないときは **503** を返し、裏で自動起動を試みます。

```bash
curl -X POST https://<DistributionDomainName>/batches/<batchJobId>/start
```

**レスポンス (200)**: `{"batchJobId": "...", "status": "PROCESSING", "executionArn": "arn:aws:states:..."}`

### GET /batches/:batchJobId — バッチ詳細

```bash
curl https://<DistributionDomainName>/batches/<batchJobId>
```

**レスポンス (200)**:

```json
{
  "batchJobId": "550e8400-...",
  "status": "PROCESSING",
  "totals": { "total": 2, "succeeded": 1, "failed": 0, "inProgress": 1 },
  "basePath": "project/2026/batch1",
  "createdAt": "2026-04-22T00:00:00.000Z",
  "startedAt": "2026-04-22T00:01:00.000Z",
  "updatedAt": "2026-04-22T00:03:00.000Z",
  "parentBatchJobId": null
}
```

| ステータス | 説明 |
|-----------|------|
| `PENDING` | 作成直後・起動待ち |
| `PROCESSING` | BatchRunnerTask 実行中 |
| `COMPLETED` | 全ファイル成功 |
| `PARTIAL` | 一部ファイル失敗 |
| `FAILED` | バッチ全体が失敗（サーキットブレーカー含む） |
| `CANCELLED` | `PENDING` 状態でキャンセル済み |

### GET /batches/:batchJobId/files — ファイル一覧

```bash
curl "https://<DistributionDomainName>/batches/<batchJobId>/files?cursor=<cursor>"
```

**レスポンス (200)**:

```json
{
  "items": [
    {
      "fileKey": "batches/.../input/doc-a.pdf",
      "filename": "doc-a.pdf",
      "status": "COMPLETED",
      "dpi": 200,
      "processingTimeMs": 12345,
      "resultKey": "batches/.../output/doc-a.json",
      "updatedAt": "2026-04-22T00:03:00.000Z"
    }
  ],
  "cursor": null
}
```

### GET /batches/:batchJobId/process-log — 実行ログ URL

BatchRunnerTask が `batches/{batchJobId}/logs/process_log.jsonl` に追記する統合ログの署名付き URL を返します（有効期限 60 分）。

```bash
curl https://<DistributionDomainName>/batches/<batchJobId>/process-log
```

**レスポンス (200)**: `{"url": "https://s3.amazonaws.com/...?signed", "expiresIn": 3600}`

### GET /batches — バッチ一覧

`status` でフィルタし、GSI1 経由でページネーション取得します。

```bash
curl "https://<DistributionDomainName>/batches?status=COMPLETED&month=202604&cursor=<cursor>"
```

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `status` | Yes | `PENDING` / `PROCESSING` / `COMPLETED` / `PARTIAL` / `FAILED` / `CANCELLED` |
| `month` | No | `YYYYMM`（GSI1 シャーディングキー）。省略時は当月 |
| `cursor` | No | 前回レスポンスの `cursor` 値 |

### DELETE /batches/:batchJobId — バッチキャンセル

`PENDING` 状態のバッチのみキャンセルできます。`PROCESSING` 以降は実行中リソースの整合性上、キャンセル不可です。

```bash
curl -X DELETE https://<DistributionDomainName>/batches/<batchJobId>
```

**レスポンス (200)**: `{"batchJobId": "...", "status": "CANCELLED"}`

### POST /batches/:batchJobId/reanalyze — 失敗ファイルのみ再解析

終端状態 (`COMPLETED` / `PARTIAL` / `FAILED`) のバッチから、失敗したファイルだけを新しい子バッチに複製して再実行します。元バッチの `basePath` と入力 S3 オブジェクトをそのまま継承し、`parentBatchJobId` で追跡できます。

```bash
curl -X POST https://<DistributionDomainName>/batches/<batchJobId>/reanalyze
```

**レスポンス (201)**: `{"batchJobId": "<newBatchJobId>", "uploads": []}`

### POST /up / GET /status — エンドポイント制御

```bash
curl -X POST https://<DistributionDomainName>/up
curl https://<DistributionDomainName>/status
```

| 状態 | 説明 |
|------|------|
| `IDLE` | エンドポイント未起動（初期状態または削除済み） |
| `CREATING` | エンドポイント起動中（通常 5–10 分） |
| `IN_SERVICE` | 稼働中 — バッチ実行可能 |
| `DELETING` | 削除中（実行中バッチが 0 に到達） |

### エラーレスポンス

```json
{ "error": "エラーメッセージ" }
```

| ステータスコード | 説明 |
|----------------|------|
| 400 | バリデーションエラー（不正な basePath、100 ファイル超過、非 PDF など） |
| 404 | バッチまたはファイルが見つからない |
| 409 | 競合（PENDING 以外のキャンセル、終端状態以外の reanalyze、reanalyze 失敗ファイル 0 件） |
| 500 | サーバーエラー |
| 503 | エンドポイント未起動（`endpointState` を含む。`GET /status` で状態を確認） |

## 使い方（完全なフロー例）

```bash
BASE_URL="https://<DistributionDomainName>"

# 0. エンドポイント状態を確認
STATE=$(curl -s "$BASE_URL/status" | jq -r '.endpointState')
echo "Endpoint state: $STATE"

# 1. IDLE / DELETING の場合は POST /up で起動を要求
if [ "$STATE" != "IN_SERVICE" ]; then
  curl -s -X POST "$BASE_URL/up" | jq .
  echo "Waiting for endpoint (5–10 min)..."
  while [ "$(curl -s "$BASE_URL/status" | jq -r '.endpointState')" != "IN_SERVICE" ]; do
    sleep 30
  done
fi

# 2. バッチ作成 → アップロード URL を取得
RESPONSE=$(curl -s -X POST "$BASE_URL/batches" \
  -H "Content-Type: application/json" \
  -d '{
    "basePath": "project/2026/batch1",
    "files": [{ "filename": "doc-a.pdf" }, { "filename": "doc-b.pdf" }],
    "extraFormats": ["markdown"]
  }')

BATCH_ID=$(echo "$RESPONSE" | jq -r '.batchJobId')

# 3. PDF をアップロード
echo "$RESPONSE" | jq -c '.uploads[]' | while read -r item; do
  URL=$(echo "$item" | jq -r '.uploadUrl')
  NAME=$(echo "$item" | jq -r '.filename')
  curl -X PUT "$URL" \
    -H "Content-Type: application/pdf" \
    --data-binary "@$NAME"
done

# 4. バッチ実行開始
curl -s -X POST "$BASE_URL/batches/$BATCH_ID/start" | jq .

# 5. 進捗ポーリング
while true; do
  STATUS=$(curl -s "$BASE_URL/batches/$BATCH_ID" | jq -r '.status')
  echo "batch status: $STATUS"
  case "$STATUS" in
    COMPLETED|PARTIAL|FAILED|CANCELLED) break;;
  esac
  sleep 15
done

# 6. ファイル別結果とログを取得
curl -s "$BASE_URL/batches/$BATCH_ID/files" | jq .
LOG_URL=$(curl -s "$BASE_URL/batches/$BATCH_ID/process-log" | jq -r '.url')
curl -o process_log.jsonl "$LOG_URL"
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
pnpm install           # 全ワークスペースの依存をインストール
pnpm test              # CDK テスト (Vitest)
pnpm test:watch        # CDK テストを watch モードで実行
pnpm test:api          # API テスト (Vitest, lambda/api)
pnpm typecheck:test    # tsc --noEmit で test/ を型検査 (tsconfig.test.json)
pnpm lint              # Biome lint + check-legacy-refs.sh + typecheck:test
pnpm lint:fix          # Biome 自動修正
pnpm lint:legacy       # 旧 API 参照が残っていないか検査 (CI ガード)
pnpm build             # tsc (IaC の型検査)
pnpm cdk synth         # CloudFormation テンプレート生成 + CDK Nag チェック
```

ルートと `lambda/api` は共に **Vitest 3** を使用します (以前は
ルートのみ Jest 29 + ts-jest だったが 2026-04 に統一)。`test/` 配下の
CDK スタックテストは `vitest.config.ts` の `globals: true` で Jest 互換
グローバル (`describe` / `it` / `expect` / `beforeAll`) を有効化している
ため、既存テストはコード変更なしで動作します。

## ディレクトリ構成

```
bin/app.ts                    CDK エントリポイント (全スタックの構築 + 相互 prop 配線)
lib/
  processing-stack.ts         S3 (batches/*) + DynamoDB (BatchTable + GSI1/GSI2 / ControlTable)
  sagemaker-stack.ts          Async Endpoint (CfnModel / CfnEndpointConfig / CfnEndpoint)
                              + SNS Success/Error Topic + SQS + Application Auto Scaling
                              (TargetTracking + HasBacklogWithoutCapacity StepScaling)
  batch-execution-stack.ts    Step Functions StateMachine + ECS Fargate TaskDefinition
  api-stack.ts                API Gateway + CloudFront (Referer シークレット照合) + API Lambda
  monitoring-stack.ts         CloudWatch Alarm 4 本 (FilesFailed / BatchDuration /
                              HasBacklogWithoutCapacity / ApproximateAgeOfOldestRequest) + SNS
  async-runtime-context.ts    Auto Scaling / ClientConfig パラメータの typed prop
  region-context.ts           リージョン既定値 (ap-northeast-1) の typed prop
pnpm-workspace.yaml           ワークスペース定義
lambda/
  batch-runner/               Fargate ECS Task (Python 3.12, Async Invoke 経路)
    main.py                   オーケストレータ: download → invoke → poll → finalize
    runner.py                 run_async_batch + generate_all_visualizations (cv2)
    async_invoker.py          SageMaker invoke + SQS poll + process_log 追記
    s3_sync.py                S3 download/upload + lifecycle タグ付与
    batch_store.py            BatchTable FILE/META 更新 (TS 側と対称実装)
    control_table.py          ControlTable heartbeat (register/delete)
    process_log_reader.py     process_log.jsonl → ProcessLogEntry
    settings.py               BatchRunnerSettings.from_env (frozen dataclass)
    Dockerfile                linux/amd64 image (opencv-python-headless に収束)
  api/                        REST API (Hono + Zod-OpenAPI, TypeScript) ← pnpm workspace
    index.ts                  /batches ルート + Swagger UI
    schemas.ts                Zod スキーマ + OpenAPI 定義
    routes/
      batches.routes.ts       /batches 系ルート定義 (OpenAPI メタデータ)
      batches.ts              /batches 系ハンドラ
    lib/
      batch-store.ts          BatchTable 単一テーブル CRUD
      batch-query.ts          BatchTable GSI1/GSI2 クエリ
      batch-presign.ts        S3 presigned URL 発行 (upload / result / process_log)
      validate.ts             basePath / SFN ARN バリデーション
      errors.ts               エラークラス + ハンドラ
      s3.ts                   headObject / listObjectKeys
      sanitize.ts             ファイル名サニタイズ
      dynamodb.ts             DynamoDB クライアント
      sfn.ts                  Step Functions クライアント
test/                         CDK スタックテスト (Vitest)
scripts/
  check-legacy-refs.sh        旧 API 参照が残っていないか検査する CI ガード
  test-endpoint.py            SageMaker エンドポイント単体の動作確認
docs/
  runbooks/
    sagemaker-async-cutover.md  Realtime → Async 移行 Runbook
  archive/                      旧設計資料 (`/jobs` ベース) のアーカイブ
.kiro/
  steering/                   プロジェクト memory (product / tech / structure)
  specs/                      Kiro-style Spec-Driven Development (要件→設計→タスク)
```
