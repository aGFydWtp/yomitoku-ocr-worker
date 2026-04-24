# Implementation Gap Analysis — `sagemaker-async-inference-migration`

本ドキュメントは、承認済みの `requirements.md` (Req 1–11) と、既存コードベースとの
実装ギャップを棚卸しし、`design.md` 生成時の判断材料を提供する。

## 1. Current State Investigation

### 1.1 関連アセット一覧

| アセット | 役割 | 現行モード | 影響 |
|---|---|---|---|
| `lib/sagemaker-stack.ts` | `CfnModel` + `CfnEndpointConfig` + `CfnEndpoint` 定義 | Realtime (`ml.g5.xlarge` / `initialInstanceCount=1`) | **全面書換** (AsyncInferenceConfig + Application Auto Scaling) |
| `lambda/batch-runner/runner.py` | `YomitokuClient.analyze_batch_async` 経由で推論 | Realtime 同期 `invoke_endpoint` (client 内部) | **呼び出し様式の置換** (client 依存再設計) |
| `lambda/batch-runner/.venv/.../yomitoku_client/client.py:206` | 実際に `sagemaker_runtime.invoke_endpoint` を叩いている箇所 | Realtime 専用 | **決定的制約**: 上流ライブラリは Async 非対応 |
| `lib/batch-execution-stack.ts:367-380` | SFN `EnsureEndpointInService` / `WaitEndpoint` | `DescribeEndpoint` で `InService` 待ち | **意味変更** or 撤去 (Async では `InService` 固定で無意味) |
| `lib/batch-execution-stack.ts:215-224` | Fargate Task Role の `sagemaker:InvokeEndpoint` | Realtime 用 | **`InvokeEndpointAsync` に置換** |
| `lib/orchestration-stack.ts` | `endpoint-control` Lambda による `create_endpoint` / `delete_endpoint` + idle 判定 | 旧方式 (手動起動/停止) | **撤去候補** (Async + MinCapacity=0 で自動化されるため) |
| `lambda/endpoint-control/index.py` | `sagemaker.create_endpoint` / `delete_endpoint` | Realtime 前提 | 上記と連動 |
| `lib/monitoring-stack.ts` | `YomiToku/Batch` メトリクスのみ | `FilesFailedTotal` / `BatchDurationSeconds` | **Async メトリクス追加** (`ApproximateBacklogSize`, `HasBacklogWithoutCapacity`, `ApproximateAgeOfOldestRequest`) |
| `bin/app.ts:14` | デフォルトリージョン | `ap-northeast-1` | **既に要件と整合** (Req 8 AC1) |
| `YomiToku-Pro_AWS構築検討.md:747-813` | 方式 B (Async) の事前検討メモ | 概念 PoC 段階 | **設計判断の出発点として流用可** |

### 1.2 コーディング規約・パターン (現行)

- CDK v2 (TypeScript、`aws-cdk-lib`)、`cdk-nag` による synth 時チェック
- スタック間連携は typed prop 渡し (`BatchExecutionStackProps` など) ＋ `CfnOutput`
- テストは `test/*.test.ts` (jest) + `lambda/*/tests/` (pytest, batch-runner 側は venv 同梱)
- IAM は最小権限をコメント付きで明示、`NagSuppressions` に理由を記録
- context 駆動 (`app.node.tryGetContext("endpointName")` 等) で実値を inject
- `scripts/check-legacy-refs.sh` による禁止語 CI ガード (「`/jobs"`」「`StatusTable`」等)

### 1.3 現行 Invocation データフロー (推論 1 回分)

```
Fargate batch-runner (main.py → runner.py)
  └─ YomitokuClient.analyze_batch_async (yomitoku-client v0.2.0)
      └─ _invoke_one() [client.py:203]
          └─ sagemaker_runtime.invoke_endpoint(Body=..., ContentType=...)  ← Realtime 同期
              └─ SageMaker Realtime Endpoint (InService 待ち)
```

- タイムアウト: Realtime の 60 秒応答制限
- ペイロード上限: 6 MB (大容量 PDF は既に分割送信で回避中)
- サーキットブレーカー: `YomitokuClient` 内部 (`_circuit_config`) で実装済

## 2. Requirements Feasibility Analysis

### 2.1 Requirement-to-Asset Map (ギャップタグ付き)

| Req # | 要件概要 | 対応アセット | ギャップ |
|---|---|---|---|
| 1 | Realtime 廃止 / Async 一本化 | `sagemaker-stack.ts` | **Missing**: `AsyncInferenceConfig` / Auto Scaling 未実装 |
| 2 | `0 ↔ 1` Auto Scaling (Max デフォルト 1) | `sagemaker-stack.ts` | **Missing**: `ApplicationAutoScaling` リソース未導入 |
| 3 | `InvokeEndpointAsync` + SNS 通知完了検知 | `batch-runner/runner.py` + `yomitoku_client` | **Constraint**: 上流 `yomitoku-client` が Async 非対応 — 要 fork / wrapper / bypass |
| 4 | `AsyncInferenceConfig` 運用パラメータ (SNS 必須) | `sagemaker-stack.ts` | **Missing**: `NotificationConfig` / `MaxConcurrentInvocationsPerInstance` / `InvocationTimeoutSeconds` |
| 5 | IAM 最小権限・S3 prefix 整合 | `batch-execution-stack.ts:215-224` / `sagemaker-stack.ts` execution role | **Missing**: `InvokeEndpointAsync` への置換、SNS Publish 制約、`batches/_async/*` prefix 拡張 |
| 6 | Async メトリクス・アラーム | `monitoring-stack.ts` | **Missing**: `HasBacklogWithoutCapacity` / `ApproximateAgeOfOldestRequest` アラーム |
| 7 | カットオーバー戦略・旧 Endpoint 除去 | `docs/runbooks/` | **Missing**: `sagemaker-async-cutover.md` Runbook |
| 8 | ap-northeast-1 既定 | `bin/app.ts:14` | **Already aligned**: 既定値一致、README のみ明記必要 |
| 9 | コスト見積り・タグ戦略 | `monitoring-stack.ts` + `docs/` | **Missing**: コスト比較表・タグ戦略ドキュメント |
| 10 | 既存バッチ仕様との契約維持 | `lambda/api/routes/batches.ts` / `BatchTable` | **Constraint**: 公開 API とデータモデルは変更禁止 |
| 11 | 監査可能性・Runbook | `docs/runbooks/` | **Missing**: 判断根拠・トラブルシュート項目 |

### 2.2 複雑性シグナル

- **External integration (High)**: `yomitoku-client` が Realtime 前提で固定化されており、Async 化の最大のボトルネック
- **Architectural shift (Medium)**: Endpoint 起動/停止ライフサイクル (`endpoint-control` + `orchestration-stack`) が不要になる破壊的変更
- **Cross-stack changes (Medium)**: `SagemakerStack` / `BatchExecutionStack` / `MonitoringStack` / `OrchestrationStack` の 4 スタック同時変更
- **Research Needed**:
  - yomitoku-pro Marketplace モデルが `InvokeEndpointAsync` に対応しているか (コンテナ仕様 / ペイロード契約)
  - Async エンドポイントの cold-start 実測 (5 分前後と言われるが実地計測要)
  - `MinCapacity=0` を CDK レベルで表現する際の Application Auto Scaling と CloudFormation のライフサイクル整合 (SageMaker Endpoint 作成 → scalable target 登録 → policy → alarm の順序)
  - SNS `SuccessTopic` のメッセージ構造 (`InferenceId`, `responseParameters.outputLocation`) と batch-runner 側の subscriber 実装形態 (HTTPS / SQS / Lambda / polling)

## 3. Implementation Approach Options

### Option A: `yomitoku-client` を **拡張 / fork** し、`invoke_endpoint_async` 対応を上流に組み込む

- **変更範囲**:
  - `yomitoku-client/client.py:_invoke_one` を Async 経路追加でオーバーライド (monkey patch かサブクラス)
  - `lambda/batch-runner/runner.py` は最小変更
- **Trade-offs**:
  - ✅ 既存サーキットブレーカー・並列制御・リトライをそのまま活用
  - ✅ ページ並列モデル (`analyze_batch_async`) を崩さない
  - ❌ 上流依存のライフサイクルにロックされる (fork 継続メンテ or upstream PR 待ち)
  - ❌ 上流 API は「ページ 1 枚 → 同期応答」前提なので、Async 化しても内部で結果待ちが必要 → `batch-runner` プロセスの長時間 blocking 問題は解消されない可能性
- **複雑性**: yomitoku-client 内部構造への深い依存
- **該当 Req**: 主に Req 3

### Option B: `yomitoku-client` をバイパスし、**batch-runner 側に Async 呼び出し層を新設**

- **変更範囲**:
  - `lambda/batch-runner/async_invoker.py` (新設) — `boto3.client("sagemaker-runtime").invoke_endpoint_async(InputLocation=..., InferenceId=...)` + SNS subscriber
  - `lambda/batch-runner/runner.py` — `YomitokuClient.analyze_batch_async` への依存を廃し、独自の並列実行オーケストレーションに置換 (`parse_pydantic_model` 等の結果整形ユーティリティは流用可)
  - `lib/batch-execution-stack.ts` — SFN フローに SNS/SQS queue を挟むか、batch-runner 側で SQS から completion event を pull
- **Trade-offs**:
  - ✅ 上流ライブラリのライフサイクルから独立 (本リポジトリ内で完結)
  - ✅ `InvokeEndpointAsync` のネイティブ契約 (S3 InputLocation, InferenceId, NotificationConfig) を直接活用
  - ✅ ペイロード 6MB 上限 → 1GB 上限 (Async の S3 InputLocation 経由) への拡張を享受できる
  - ❌ サーキットブレーカー・ページ並列・エラーハンドリングの再実装コストが大きい
  - ❌ `yomitoku-client` 側の後続リリースで契約変更があった場合の互換性維持責務が本リポジトリに降る
- **複雑性**: 新規コード量が多い (推定 400-600 行 + テスト)
- **該当 Req**: 主に Req 3, 4, 5

### Option C (Hybrid, **推奨候補**): 入出力は独自 Async 層、結果処理は yomitoku-client ユーティリティ流用

- **変更範囲**:
  - Invocation 経路: **Option B** と同様に batch-runner 側で独自実装 (`boto3` 直叩き)
  - 結果パース・可視化: `yomitoku_client.parse_pydantic_model` / `correct_rotation_image` / `page_result.visualize` など「モデル出力を解釈するユーティリティ」は流用
  - SFN フロー: `EnsureEndpointInService` は撤去し、Async Endpoint は起動済みを前提とする単純化フローへ
  - SNS → SQS → batch-runner poll (batch-runner が同一タスク内で自身の投入分の SNS イベントを待つ) で completion 検知
- **Trade-offs**:
  - ✅ `yomitoku-client` の「下位層 (invoke)」と「上位層 (parser/visualizer)」を切り分け、変更範囲を invoke 層のみに限定
  - ✅ `analyze_batch_async` の並列制御ロジックは再実装するが、結果整形の深部は再発明を避けられる
  - ✅ 旧 `orchestration-stack` の endpoint-control を撤去しやすい (Async は常時待機でよい)
  - ❌ batch-runner の責務が「invoke + aggregate + visualize」と厚くなるため、サブモジュール分割が必須
  - ❌ SNS → SQS 購読 pattern のテスト容易性を確保する必要 (localstack / moto)
- **複雑性**: 中〜高。ただし責務分割が明確
- **該当 Req**: 主に Req 3, 4, 5, 6 を横断

## 4. Effort & Risk

| 項目 | Effort | Risk | 一行根拠 |
|---|---|---|---|
| `SagemakerStack` Async 化 (Req 1, 2, 4) | **M** (3-7 日) | Medium | `AsyncInferenceConfig` / `ApplicationAutoScaling` は AWS 公式パターン。新規だが既知 |
| batch-runner Async 呼び出し層 (Req 3, 5) | **L** (1-2 週) | **High** | `yomitoku-client` バイパス設計・SNS 購読方式・並列/retry 再実装が連動 |
| `BatchExecutionStack` SFN 改修 (Req 3, 5, 7) | **M** (3-7 日) | Medium | `EnsureEndpointInService` 撤去と Task Role 置換、IAM テスト更新 |
| `OrchestrationStack` 撤去判断 (Req 1, 7) | **S** (1-3 日) | Low | Realtime 前提の Lambda/SFN を削除するだけだが、既存監視との整合確認が必要 |
| `MonitoringStack` Async アラーム追加 (Req 6) | **S** (1-3 日) | Low | 新規メトリクス追加のみ、既存パターンを踏襲 |
| Runbook / README / 設計書 (Req 7, 8, 9, 11) | **S** (1-3 日) | Low | 定型作業。カットオーバー手順は既存 `status-table-cutover.md` パターン流用可 |
| **全体** | **XL** (2-3 週間) | **High** | Research Needed 項目が解消されないまま実装着手すると手戻り大。設計フェーズで PoC 必須 |

## 5. Recommendations for Design Phase

### 5.1 推奨アプローチ

**Option C (Hybrid)** を設計フェーズの出発点とする。根拠:

1. `yomitoku-client` の Async 非対応は決定的制約であり、Option A (上流 fork) は運用負債が大きい
2. Option B (完全自作) は結果パーサーまで再実装することになり、yomitoku-pro モデル出力の契約変更に脆弱
3. Option C は invoke 層のみ自作、結果整形層はライブラリ流用という責務分割が最もリスクを縮減する

### 5.2 設計フェーズで決定すべき事項

| # | 決定事項 | 候補 | 影響 |
|---|---|---|---|
| D1 | yomitoku-pro の Async 対応確認 | (a) AWS Marketplace ドキュメント確認 / (b) 実エンドポイントでの smoke invoke | Req 1 / 4 の可行性 |
| D2 | SNS subscriber 実装形態 | (a) SNS → SQS → batch-runner 内部 poll / (b) SNS → Lambda → DDB / (c) SNS → EventBridge → SFN callback | Req 3 / 5 の設計 |
| D3 | `OrchestrationStack` の扱い | (a) 完全撤去 / (b) `endpoint-control` Lambda のみ残して Async 管理向けに再利用 | Req 1 / 7 のスコープ |
| D4 | SFN `EnsureEndpointInService` 扱い | (a) 撤去 / (b) `DescribeEndpoint` + `EndpointStatus=InService` 確認を残して fail-fast | Req 1 / 3 |
| D5 | `MaxCapacity` デフォルト値確定 | `1` (要件で固定) を維持。ただし上限を `context` で上書き可能な上限値も併せて決定 | Req 2 |
| D6 | S3 `batches/_async/` prefix 配下の細分化 | `input/` / `output/` / `error/` 3 階層 or `batches/{batchJobId}/async/` 配下の per-batch 階層 | Req 1 / 5 |
| D7 | ビルド単位 (CDK デプロイ順序) | SagemakerStack → BatchExecutionStack → MonitoringStack の順に段階デプロイする Runbook | Req 7 |

### 5.3 Research Items (設計時 PoC 要)

- **R1**: yomitoku-pro Marketplace モデルに対する `InvokeEndpointAsync` の実地検証 (サンプル PDF で 1 回成功させる)
- **R2**: `MinCapacity=0` からの cold-start 実測時間と、batch の SLA (Req 9 の実測検証) への影響
- **R3**: `NotificationConfig.SuccessTopic` のメッセージ JSON スキーマ (AWS SDK ドキュメントと実メッセージの差異)
- **R4**: `yomitoku-client.parse_pydantic_model` が、yomitoku-pro Async 応答 (S3 に出力される JSON) をそのまま解釈できるか (Realtime 応答と同一フォーマットか)
- **R5**: Application Auto Scaling の CloudFormation ライフサイクル (Endpoint 作成完了 → scalable target 登録 → policy 登録 → alarm 登録の依存順序)

### 5.4 設計文書に載せるべき section

- **Async Invocation Sequence Diagram**: Fargate → S3 (input) → `InvokeEndpointAsync` → SNS → Fargate (completion detection) → S3 (output 取得)
- **Cutover Plan (4 フェーズ)**: (1) 新 Async EndpointConfig デプロイ → (2) batch-runner 新 invoke 層切替 → (3) 旧 Realtime Endpoint 削除 → (4) `endpoint-control` / `orchestration-stack` の撤去
- **Rollback 不能性**: Req 7 / 11 の要件どおり、Async への移行は一方向で旧 Realtime との併存運用は想定しない

## 6. Out of Scope (gap-analysis フェーズ)

- yomitoku-pro モデルの Async 動作実地 PoC (設計フェーズで実施)
- コスト見積りの具体数値 (Req 9) は設計フェーズで比較表として作成
- 既存 `MonitoringStack` の表示レイアウト変更 (ダッシュボード ConfigJSON) は詳細設計で扱う
