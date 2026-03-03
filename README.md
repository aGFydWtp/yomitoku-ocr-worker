# YomiToku OCR Worker

S3 に PDF をアップロードすると、[YomiToku-Pro](https://aws.amazon.com/marketplace/pp/prodview-wjf2quasznrlm) (SageMaker Marketplace) で OCR を実行し、結果を JSON で返すサーバーレスパイプラインです。

## アーキテクチャ

```
S3 (input/) ─→ SQS ─┬→ Lambda (処理ワーカー) ─→ SageMaker Endpoint ─→ S3 (output/)
                     └→ EventBridge Pipe ─→ Step Functions (エンドポイント制御)
```

**ポイント**: SageMaker エンドポイント (ml.g5.xlarge) はリクエスト時のみ Step Functions が自動作成し、キューが空になると自動削除します。アイドル時の課金はほぼゼロです。

## CDK スタック構成

| スタック | 内容 |
|---------|------|
| `SagemakerStack` | CfnModel, CfnEndpointConfig, IAM ロール |
| `ProcessingStack` | S3, SQS (+ DLQ), DynamoDB × 2, 処理ワーカー Lambda |
| `OrchestrationStack` | Step Functions, EventBridge Pipe, エンドポイント制御 Lambda |
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

## 使い方

```bash
# 1. DynamoDB に PENDING レコードを作成
aws dynamodb put-item \
  --table-name <StatusTableName> \
  --item '{"file_key":{"S":"input/sample.pdf"},"status":{"S":"PENDING"},"created_at":{"S":"..."},"updated_at":{"S":"..."}}'

# 2. PDF を S3 にアップロード（自動で OCR が開始される）
aws s3 cp sample.pdf s3://<BucketName>/input/sample.pdf

# 3. 結果は s3://<BucketName>/output/sample.json に出力される
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
  orchestration-stack.ts      Step Functions / EventBridge Pipe
  monitoring-stack.ts         CloudWatch / SNS
lambda/
  processor/                  OCR 処理ワーカー (Python, Docker)
  endpoint-control/           エンドポイント制御 (Python)
test/                         CDK スナップショットテスト
scripts/                      結合テスト用スクリプト
```
