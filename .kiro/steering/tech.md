# Technology Stack

## Architecture

AWS サーバレス + マネージドコンテナのイベントドリブン構成。API (Lambda/Hono) → S3 ステージング → Step Functions → ECS Fargate batch-runner → **SageMaker Async Endpoint** → SNS → SQS → runner が notification を drain → DynamoDB finalize、という一方向フロー。**Async Inference が意図的な設計選択**で、Realtime Endpoint 運用時の `InsufficientCapacity` とアイドルコストを両方解消する。

スタック分割は「1 AWS サービスドメイン = 1 CDK Stack」で固定:
- **ProcessingStack**: S3 Bucket + DynamoDB (`BatchTable` / `ControlTable`)
- **SagemakerStack**: CfnModel + CfnEndpointConfig (AsyncInferenceConfig) + CfnEndpoint + SNS Success/Error Topic + SQS + Application Auto Scaling (TargetTracking + Scale-from-Zero StepScaling)
- **BatchExecutionStack**: ECS Cluster + Fargate TaskDef + Step Functions StateMachine
- **ApiStack**: Lambda (Hono) + API Gateway + CloudFront + WAF IP Set
- **MonitoringStack**: CloudWatch Alarm + SNS AlarmTopic

リージョン既定は `ap-northeast-1`。`us-east-1` は capacity 逼迫時の退避用オプションで、スタック側ではなく context / bin/app.ts で差し替える。

## Core Technologies

- **TypeScript 5.9.x** (strict mode, NodeNext, ES2022) — CDK IaC + API Lambda
- **Python 3.12** — Fargate batch-runner (yomitoku-client 経由の Async Inference 呼び出し)
- **AWS CDK 2.x** + **cdk-nag 2.x** (AwsSolutionsChecks を全スタック強制、抑止は `NagSuppressions` で理由付き allowlist)
- **Node.js** (Lambda runtime; ECR で Fargate runner)
- **Biome 2.x** — lint + format (eslint / prettier は未使用)

## Key Libraries

開発パターンに影響する主要なもののみ:

- **Hono 4.x** + **@hono/zod-openapi 1.x** — API schema-first (Zod) から OpenAPI 生成 + runtime 検証が単一ソース。routes は `createRoute` で `request` / `responses` をスキーマ定義し、handler は `c.req.valid("json")` で型付きアクセス。
- **AWS SDK v3** (`@aws-sdk/client-{dynamodb,s3,sfn}`, `@aws-sdk/s3-request-presigner`) — Lambda 側。
- **boto3 >=1.34,<2** — Fargate runner 側。
- **yomitoku-client 0.2.0** — SageMaker Async invoke の薄いラッパー (Marketplace モデル前提)。
- **opencv-python-headless** — 可視化画像生成。**非 headless 版が transitive に混入するため Dockerfile で明示 uninstall** が必要 (既知の踏み抜きポイント)。
- **Vitest** (TS) / **pytest + moto + botocore.Stubber** (Python) — テストは全面モック可能、E2E も moto で再現する。

## Development Standards

### Type Safety
- TypeScript: strict / noImplicitAny / strictNullChecks / noImplicitReturns 全部有効。`any` を足したくなったら Zod で contract を作る方向に倒す。
- Python: yomitoku-client の pydantic モデルで I/O 型を固定。バッチ内部の dict は minimal に、必要なら `@dataclass(frozen=True)` を使う (`BatchResult`, `BatchRunnerSettings`)。
- DynamoDB アイテム構造は **TS と Python で同一定義**。`lambda/api/lib/batch-store.ts` と `lambda/batch-runner/batch_store.py` の FILE/META キー/属性はビット互換。

### Code Quality
- **Biome recommended rules**。import 整列と double quote を強制。
- **cdk-nag AwsSolutionsChecks**。抑止は `NagSuppressions.addResourceSuppressions` で `reason` に「なぜ逸脱が妥当か」を明文化するのが必須。
- **空 `except Exception` は原則禁止**。observability/非致命に限り `# noqa: BLE001` と理由コメントを付ける。

### Testing
- **必ずテストを書く単位**: CDK stack 宣言 (`test/*-stack.test.ts`)、API route + schema (`lambda/api/__tests__/`)、Python helper + main (`lambda/batch-runner/tests/`)。
- **契約テスト**: `test/check-legacy-refs.test.ts` と `scripts/check-legacy-refs.sh` で、撤去済み Realtime API やレガシー endpoint 参照が復活しないか静的にガードする。
- **E2E モック**: `lambda/batch-runner/tests/test_run_async_batch_e2e.py` は moto + Stubber で SNS/SQS/S3/SageMaker を立て、混在バッチ (成功 + 失敗 + deadline 切れ) を一気通貫で検証する。本番 E2E は `sample-pdf/` (gitignore 済) で `POST /batches` → `PUT uploadUrl` → `POST :id/start` → poll。

## Development Environment

### Required Tools
- Node.js + pnpm (ワークスペース管理 `lambda/api` がサブパッケージ)
- Python 3.12 + venv (各 `lambda/*/` 配下に個別 `.venv/`)
- Docker Desktop (Fargate image の buildx ビルド; `Platform.LINUX_AMD64` 強制ビルドが必須 — host が Apple Silicon だと exec format error で落ちる)
- AWS CLI + `aws sso` などで configure 済の credential

### Common Commands
```bash
pnpm build            # tsc (root: CDK IaC)
pnpm test             # vitest (CDK stack + API)
pnpm lint             # biome check . + check-legacy-refs.sh
pnpm cdk synth --all  # 全スタック synth
pnpm cdk deploy <StackName> -c region=ap-northeast-1 --require-approval never
# Python
pytest                # lambda/batch-runner/.venv で実行
```

## Key Technical Decisions

- **Async Inference を採用**: Realtime Endpoint の毎ジョブ create/delete + capacity 競合を撤去。Endpoint は常設、0 ↔ N で伸縮。
- **Scale-from-Zero の 2 段構え**: `HasBacklogWithoutCapacity` alarm → StepScaling で 0→1 を bootstrap、以降は `ApproximateBacklogSizePerInstance` TargetTracking が N に伸縮。片方だけでは 0 からスケールしない。
- **単一テーブル DynamoDB**: `BatchTable` は META + FILE を同一 PK (`BATCH#{batchJobId}`) に共存。GSI1 (`STATUS#{status}#{YYYYMM}`) で月別ステータス検索、GSI2 で補助、TTL で PENDING の掃除。
- **Hono + Zod-OpenAPI の schema-first**: リクエスト検証 / レスポンス整形 / OpenAPI 生成を 1 ソースで賄う。レガシー Express ミドルウェア層を置かない。
- **`Platform.LINUX_AMD64` の明示**: Fargate が x86_64 なので `DockerImageAsset` に platform を明示しないと Apple Silicon 開発者の build で arm64 image が push されて起動時に `exec format error` になる。
- **SageMaker invoke の InferenceId は ASCII 限定**: 非 ASCII は SHA-1 16 文字へ畳み込み (`_safe_ident`)。SigV4 canonical string が HTTP header 上で client/server で乖離するため。
- **DynamoDB 楽観ロック**: `transitionBatchStatus` / `finalize_batch_status` は `expectedCurrent` 条件付き UpdateItem で並行遷移をブロック。
- **Cost Explorer タグ**: 全 AWS リソースに `yomitoku:stack` と `yomitoku:component` (api / endpoint / sns / sqs / autoscaling / batch) を付ける。
- **CloudFront 経由専用 API**: API Gateway Resource Policy で `aws:Referer` シークレット照合 → 直接アクセスを 403 で拒否。CloudFront が `x-origin-verify` と `Referer` カスタムヘッダで仲介。

---
_Standards and patterns, not every dependency._
