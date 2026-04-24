# Project Structure

## Organization Philosophy

マルチランタイム (TypeScript CDK + TypeScript Lambda + Python Fargate) を **「1 責務 = 1 ディレクトリ単位」** で分割。AWS の 1 サービスドメインにつき 1 CDK Stack (`lib/*-stack.ts`)、1 API エンティティにつき 1 ルート (`lambda/api/routes/*.routes.ts`)、Python バッチの 1 関心事につき 1 モジュール (`lambda/batch-runner/*.py`)。**クロスランタイム間の契約は bin/app.ts と DynamoDB スキーマの 2 箇所に集約** されており、新規コードは既存パターンをなぞれば他の層の変更なしに足せる。

## Directory Patterns

### CDK Stack (`lib/*-stack.ts`)
**Location**: `lib/`
**Purpose**: 1 AWS サービスドメイン = 1 Stack。横断的な context は `lib/*-context.ts` (例: `async-runtime-context.ts`, `region-context.ts`) で interface 化し StackProps 経由で受け取る。
**Example**:
- `processing-stack.ts` (S3 + DynamoDB)
- `sagemaker-stack.ts` (Async Endpoint + SNS/SQS + AutoScaling)
- `batch-execution-stack.ts` (ECS + Step Functions)
- `api-stack.ts` (Lambda + API Gateway + CloudFront)
- `monitoring-stack.ts` (CloudWatch Alarm)

### CDK App Entry (`bin/app.ts`)
**Location**: `bin/`
**Purpose**: context 解決とスタック間依存配線を **1 ファイルに集約**。stack が他 stack の Output を context 経由で取りに行くのではなく、bin/app.ts が construct したインスタンスを直接 prop で渡す。
**Example**: `new ApiStack(app, "ApiStack", { batchTable: processing.batchTable, batchExecutionStateMachine: batchExec.stateMachine, ... })`

### API Runtime (`lambda/api/`)
**Location**: `lambda/api/`
**Purpose**: Hono + Zod-OpenAPI の REST API。3 層構造 — `schemas.ts` (Zod スキーマ) / `routes/*.ts` (HTTP ハンドラ) / `lib/*.ts` (DDB / S3 等のデータアクセス)。route は lib の関数を呼ぶだけ、lib 同士は相互に呼び合わない。
**Example**:
- `routes/batches.ts` → `lib/batch-store.ts` + `lib/batch-query.ts` + `lib/s3.ts`
- 新 API は `routes/xxx.routes.ts` (スキーマ) + `routes/xxx.ts` (handler) を追加、共通操作は `lib/` に薄く切り出す

### Batch Runner (`lambda/batch-runner/`)
**Location**: `lambda/batch-runner/`
**Purpose**: Python モノリシックな Fargate エントリ。`main.py` がオーケストレータ、1 関心事ごとに並列モジュール:
- `settings.py` — `BatchRunnerSettings.from_env()` で env var を frozen dataclass に畳む
- `s3_sync.py` — download/upload + lifecycle タグ
- `async_invoker.py` — SageMaker invoke + SQS poll + process_log 追記
- `runner.py` — `run_async_batch` (async invoke) + `generate_all_visualizations` (cv2)
- `batch_store.py` / `control_table.py` — DynamoDB 更新 (TS 側と対称)
- `process_log_reader.py` — process_log.jsonl → `ProcessLogEntry`
**Rule**: main.py 以外のモジュールは副作用を持たない純粋関数か、`boto3` client を引数で注入するクラスで構成する。

### Stack Tests (`test/`)
**Location**: `test/`
**Purpose**: 各 Stack の synth 成功 + 期待 property の存在を assertion。クロススタックの legacy 参照禁止契約テスト (`check-legacy-refs.test.ts`, `async-migration-contract.test.ts`) もここに。
**Example**: `test/sagemaker-stack.test.ts` は InitialInstanceCount / MinCapacity / SNS Subscription / Scaling Policy を逐一 assert。

### API/Python Tests (`lambda/*/{__tests__,tests}/`)
**Location**: `lambda/api/__tests__/` (Vitest) / `lambda/batch-runner/tests/` (pytest)
**Purpose**: モジュール名と 1:1 対応のテストファイル (`test_batch_store.py` ↔ `batch_store.py`)。moto で S3/SQS/DDB、Stubber で sagemaker-runtime を立ててモジュール単位に完結。
**Example**: `test_run_async_batch_e2e.py` は AsyncInvoker → runner → BatchResult を通貫テスト。

### Specs & Steering (`.kiro/`)
**Location**: `.kiro/specs/{feature}/` (requirements → design → tasks の 3-phase Markdown) / `.kiro/steering/` (このファイル群)
**Purpose**: Kiro-style Spec-Driven Development のメタデータ。仕様を Markdown で先行記述 → レビュー承認 → 実装、というワークフローを前提。

### Docs & Scripts (`docs/`, `scripts/`)
**Location**: `docs/runbooks/` (本番運用 Runbook), `scripts/` (`check-legacy-refs.sh` 等のメンテナンス CLI)
**Purpose**: Runbook は日本語で本番オペレータ向け、scripts は CI / lint 段で呼ぶ自動化。

## Naming Conventions

| カテゴリ | 規則 | 例 |
|---|---|---|
| **TS ファイル** | kebab-case。CDK stack は `*-stack.ts`、context は `*-context.ts`、Hono route schema は `*.routes.ts` | `api-stack.ts`, `async-runtime-context.ts`, `batches.routes.ts` |
| **Python ファイル** | snake_case。テストは `test_<module>.py` | `async_invoker.py`, `tests/test_async_invoker.py` |
| **TS クラス / 型** | PascalCase。Stack は `Stack` を継承、契約は `interface` | `class ApiStack extends Stack`, `interface AsyncRuntimeContext` |
| **Python クラス** | 例外・dataclass・Invoker 系は PascalCase、モジュール内関数は snake_case | `class AsyncInvoker`, `class ConflictError`, `def update_file_result()` |
| **TS 関数 / 変数** | camelCase、定数は SCREAMING_SNAKE_CASE | `createBatchRoute`, `BATCH_TASK_TIMEOUT_SECONDS` |
| **Python 関数 / 変数** | snake_case、定数は SCREAMING_SNAKE_CASE | `apply_process_log`, `_INFERENCE_ID_MAX_LENGTH` |
| **DynamoDB キー** | `TYPE#値` 形式。GSI1PK は `STATUS#{status}#{YYYYMM}` | `BATCH#{jobId}` (PK), `FILE#batches/{jobId}/input/{name}` (SK) |
| **S3 プレフィックス** | `batches/{batchJobId}/{input,output,results,visualizations,logs}/` + Async 専用 `batches/_async/{inputs,outputs,errors}/{jobId}/` | `batches/abc123/input/sample.pdf` |
| **CDK リソースタグ** | `yomitoku:stack` + `yomitoku:component` (api / endpoint / sns / sqs / autoscaling / batch) | Cost Explorer 分類の前提 |

## Import Organization

### TypeScript
```typescript
// aws-cdk-lib 名前空間からの個別インポート (サブパス指定)
import { Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import { CfnEndpoint } from "aws-cdk-lib/aws-sagemaker";
// 3rd party (cdk-nag など)
import { NagSuppressions } from "cdk-nag";
// プロジェクト内相対
import type { AsyncRuntimeContext } from "./async-runtime-context";
```
- **path alias は未設定**。`tsconfig.json` の `moduleResolution: "NodeNext"` で運用。
- `lambda/api` は独立 `package.json` と自前 `tsconfig.json` を持つ。root からは `exclude` でビルド対象外。

### Python
```python
# 標準ライブラリ → 3rd party → 同ディレクトリ (相対) の順
from __future__ import annotations
import json
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

from settings import BatchRunnerSettings
from async_invoker import AsyncInvoker
```
- **相対 import は使わず**、Fargate image 内 `/app/` 直下にフラット配置されたモジュールを直接参照する。
- テストは `sys.path.insert(0, str(Path(__file__).parent.parent))` で `lambda/batch-runner/` を import path に足す。

## Cross-Stack / Cross-Runtime Contracts

### DynamoDB スキーマ契約 (TS ↔ Python)
- **PK/SK**: `BATCH#{batchJobId}` + `META` / `FILE#{fileKey}`。`lambda/api/lib/batch-store.ts` と `lambda/batch-runner/batch_store.py` は **同一の key builder** を実装 (`build_file_key(batchJobId, filename)`)。
- **GSI1**: `STATUS#{status}#{YYYYMM}` + `createdAt`。月パーティション化済なので「過去月の RUNNING をまたぐ」場合は Scan 必要 (Runbook の in-flight 確認が Scan を使う理由)。
- **楽観ロック**: META.status の遷移は `ConditionExpression: #status = :expected` 付き UpdateItem。同じパターンを TS `transitionBatchStatus` と Python `transition_batch_status` で踏襲。
- **タイムスタンプ**: `YYYY-MM-DDTHH:MM:SS.mmmZ` (ミリ秒 + Z)。TS/Python どちらの `_iso()` でも同一文字列が出る。

### Stack 間データ受け渡し (CDK)
- **CfnOutput は人間用**。CDK コード側ではコンパイル時に解決される **L2 construct の参照を bin/app.ts で直接 prop 注入** する (`batchTable: processing.batchTable`)。
- 例外: CloudFormation 経由で解決する必要があるケース (例えば他アカウントの consumer) は CfnOutput + ExportName。現状は 1 アカウント/1 リージョンで閉じている。

### API ↔ Fargate Runner (環境変数)
BatchExecutionStack の `containerOverrides` が `BATCH_JOB_ID` のみ動的に注入、それ以外 (`BUCKET_NAME` / `BATCH_TABLE_NAME` / `CONTROL_TABLE_NAME` / `ENDPOINT_NAME` / `SUCCESS_QUEUE_URL` / `FAILURE_QUEUE_URL` / `ASYNC_*_PREFIX` / `ASYNC_MAX_CONCURRENT`) は TaskDefinition 起動時固定。Python 側は `BatchRunnerSettings.from_env()` が欠落を `ValueError` で弾く。

### SageMaker Async の I/O 契約
- **InferenceId**: `{batchJobId}:{safe_stem}` (64 文字上限)。非 ASCII stem は SHA-1 16 文字に畳み込む (`_safe_ident`)。
- **InputLocation**: `s3://{bucket}/batches/_async/inputs/{batchJobId}/{safe_name}`。
- **OutputLocation** (成功): `s3://{bucket}/batches/_async/outputs/{uuid}.out` (UUID は SageMaker 生成)。
- **FailureLocation** (失敗): `s3://{bucket}/batches/_async/errors/{uuid}-error.out`。

---
_Patterns, not file trees. New code following these shouldn't require steering updates._
