# Brief: async-endpoint-scale-in-protection

## Problem

SageMaker Async Inference エンドポイントの Application Auto Scaling が、**処理中ジョブが残っている状態でインスタンス数を 0 に縮退させる**ケースが発生している。実害として、長時間 OCR 処理中のバッチが scale-in でインスタンス停止に巻き込まれ、進捗 API のステータスが進まなくなる(プログレスが止まる / `IN_PROGRESS` のまま停滞)。

根本原因:
- 現行 TargetTracking は `ApproximateBacklogSizePerInstance` (target=5) のみを参照
- AWS の `ApproximateBacklogSize` は **「キューに溜まっていてまだモデルに取り込まれていない」リクエスト数** で、モデルが処理を開始した瞬間にカウントから消える
- batch-runner の背圧設計 (`max_concurrent`=4 で in-flight 上限制御) により、長尺ジョブ実行中は backlog=0 が普通に発生
- `scaleInCooldown=900s` 経過後、TargetTracking は「backlog=0 ≪ target=5」と判断して MinCapacity=0 へ縮退 → 処理中ジョブごとインスタンス停止

## Current State

- `lib/sagemaker-stack.ts:391-428`: `AsyncBacklogScalingPolicy` (TargetTracking) が `ApproximateBacklogSizePerInstance` 単一メトリクスを参照
- `lib/sagemaker-stack.ts:444-487`: `HasBacklogWithoutCapacity` を使った StepScaling (scale-from-zero) は別途存在 (これは正しく機能している)
- `lib/async-runtime-context.ts:24`: `asyncMaxCapacity = 1` 固定 (現運用は単一インスタンスのみ)
- `lambda/batch-runner/async_invoker.py:359-411`: `run_batch` ループ内で `in_flight: dict[InferenceId, file_stem]` を保持。これが in-flight 数の真値
- カスタムメトリクスの発信機構は未実装

ギャップ: scale-in を「処理中ジョブの有無」に応じて抑止する仕組みが存在しない。

## Desired Outcome

以下を満たした状態:

- batch-runner が in-flight 数を CloudWatch カスタムメトリクスとして発信している
- TargetTracking が「backlog + in-flight」の合算値をターゲットにしており、処理中は scale-in が発火しない
- 単一 batch-runner / 複数 batch-runner 並走のいずれでも正しく集計される
- batch-runner の異常終了 (OOM/SIGKILL) 時にメトリクス値が固着して scale-in を永久阻止しない (安全側に倒れる)
- 既存の `HasBacklogWithoutCapacity` ベースの scale-from-zero は維持され、scale-out 経路に regression が出ない
- `asyncMaxCapacity > 1` への将来拡張時に必ず再レビューされるよう、CDK に明示的なガードコメントが残っている

## Approach

### β-1: TargetTracking のメトリクスを Math 式に置き換える

1. **batch-runner からカスタムメトリクスを発信**:
   - `async_invoker.py` の `run_batch` ループで `len(in_flight)` を CloudWatch Embedded Metric Format (EMF) で stdout に書く
   - メトリクス名: `InflightInvocations`
   - Namespace: `Yomitoku/AsyncEndpoint`
   - Dimensions: `EndpointName` のみ (複数 task 並走時に Sum 集約させるため、TaskId 等は付けない)
   - 発信周期: **60 秒** (CloudWatch period と揃え、period 内の二重計上を回避)
   - **runner 起動直後と graceful shutdown 時 (try/finally) に `InflightInvocations=0` を必ず publish** (プロセス死による値固着の緩和)

2. **TargetTracking ポリシーを CloudWatch Math 式に変更** (`lib/sagemaker-stack.ts:407-428`):
   - 既存 `customizedMetricSpecification` の単一メトリクスを `Metrics` 配列 + Math 式に置き換える
   - 式 (CDK で `CfnScalingPolicy.TargetTrackingMetricDataQuery` 配列として表現):
     ```
     m1 = ApproximateBacklogSize  (Sum, 60s, AWS/SageMaker, dim: EndpointName)
     m2 = InflightInvocations     (Sum, 60s, Yomitoku/AsyncEndpoint, dim: EndpointName)
     e1 = FILL(m1, 0) + FILL(m2, 0)   // ReturnData=true
     ```
   - target=5 維持、`scaleInCooldown=900s` 維持、`scaleOutCooldown=60s` 維持

3. **`asyncMaxCapacity=1` 固定前提の割り切り**:
   - 本来 TargetTracking は per-instance 化された値が前提だが、`asyncMaxCapacity=1` ならば絶対値 `(backlog + inflight)` は per-instance 値と等価 (除算が `/1`)
   - 将来 `asyncMaxCapacity > 1` に変更する瞬間にこの前提が崩れるため、CDK 上に **「本ポリシーは asyncMaxCapacity=1 前提。引き上げ時は per-instance 化のため `/ capacity` 化が必須」と明示的なコメントを残す**
   - per-instance 化の汎用設計 (capacity を runner が `DescribeScalableTargets` で取得して自己 publish) は本 spec の Out

4. **既存 scale-from-zero (`HasBacklogWithoutCapacity` StepScaling) は維持**:
   - 触らない。TargetTracking は instances=0 では機能しないという制約は変わらないため、StepScaling での bootstrap は引き続き必要

5. **メトリクス欠損時のフォールバック**:
   - `FILL(m2, 0)` で「runner からの publish が止まったら inflight=0 とみなす」= 旧来挙動と等価な scale-in が走る (安全側)
   - ただし最後の publish 値が CloudWatch 側に period 残存するリスクがあるため、shutdown hook での明示 0 publish が重要

## Scope

- **In**:
  - `lambda/batch-runner/async_invoker.py` への EMF publish 機構の追加 (起動時 0、60 秒周期、shutdown hook 0)
  - `lib/sagemaker-stack.ts:407-428` の `AsyncBacklogScalingPolicy` を Math 式構成に書き換え
  - CDK 上に「`asyncMaxCapacity > 1` 時は再設計必須」のガードコメント追加
  - batch-runner ECS タスク定義に CloudWatch Logs 経由の EMF が流せる権限・ロガー設定の確認 (既存の awslogs ドライバで通る想定)
  - 単体テスト: EMF publish の起動/停止挙動、ScalingPolicy の Math 式 synth スナップショット
  - 統合テスト戦略: localstack での再現は困難なので、CDK synth 差分 + runbook での検証手順記載
  - Runbook 更新: 「処理中なのに instances=0 になった」事象の判定手順 (CloudWatch コンソール上で `InflightInvocations` メトリクスの直近値を見る)

- **Out**:
  - `asyncMaxCapacity > 1` 対応の per-instance 化汎用設計 (= `m3 = capacity` を runner が publish する設計): batch-scale-out spec で必要になった時に別 spec で対応
  - 複数エンドポイント横断の集約 (現状エンドポイントは 1 個前提)
  - SageMaker Sync (Real-time) エンドポイントへの適用 (本リポジトリは Async のみ)
  - SQS DLQ や invocation 失敗の扱い (`failure_queue` 経路は本件と独立)
  - メトリクスダッシュボード・アラームの追加 (本 spec は scale-in 抑止のみが責務、可視化は monitoring-stack の改修で別途)

## Boundary Candidates

- **batch-runner 層**: `async_invoker.run_batch` の EMF publish 注入 (60s 周期スレッド or asyncio タスク + try/finally の 0 publish)
- **インフラ層**: `lib/sagemaker-stack.ts::AsyncBacklogScalingPolicy` の `customizedMetricSpecification` を Math 式へ書き換え
- **設定 / ガード層**: `lib/async-runtime-context.ts::asyncMaxCapacity` の引き上げ時に必ず ScalingPolicy 設計を見直す旨を明示 (コードコメント + steering 反映を検討)
- **運用 / Runbook 層**: 進捗が止まった時の調査フロー (CloudWatch メトリクス確認手順)

## Out of Boundary

- **`asyncMaxCapacity > 1` 時の per-instance 正規化**: 別 spec (batch-scale-out が触るタイミングで再設計)
- **batch-runner の `max_concurrent` 値の変更**: 本件は scale-in 保護のみで、並列度のチューニングは別議論
- **CloudWatch ダッシュボード / アラーム追加**: monitoring-stack 改修の責務
- **進捗 API (`GET /batches/:id/files`) のフォールバック動作**: 仮にインスタンスが死んでも進捗 API がスタックしないようにする改修は本件の Out (が、Runbook で症状の見分け方は記載)
- **TaskId dimension での per-task 観測**: 集約のみが目的なので不要

## Upstream / Downstream

- **Upstream**:
  - `sagemaker-async-inference-migration` (Async 基盤、Auto Scaling 構成元): 完了済 / tasks-generated。本 spec はそこに乗っている `AsyncBacklogScalingPolicy` の置き換えが主体
  - `yomitoku-client-batch-migration` (batch-runner 基盤): 完了済。本 spec は `async_invoker.py` のループに EMF を足すだけで構造には触らない

- **Downstream**:
  - `batch-scale-out`: throughput 戦略で `asyncMaxCapacity` を 1 → N に引き上げる際、本 spec で残したガードコメントを起点に per-instance 化が再設計対象になる。**本 spec は batch-scale-out の前提条件にはならない (independent)** が、batch-scale-out 着手時に「scale-in 保護の per-instance 化」が必ず議題に上がる関係性

## Existing Spec Touchpoints

- **Extends**: なし (新規)
- **Adjacent**:
  - `sagemaker-async-inference-migration`: 既存 `AsyncBacklogScalingPolicy` を直接書き換えるため、当該 spec の design.md / requirements.md の Auto Scaling 節と矛盾しないことを実装時に確認 (が、当該 spec は `tasks-generated` で固まっており再 approval は不要)
  - `batch-scale-out`: throughput スケール戦略 (`MaxConcurrentInvocationsPerInstance` / `asyncMaxCapacity`) と境界が隣接。重複を避けるため本 spec は **scale-in 保護のみ** に限定し、`asyncMaxCapacity > 1` の話には踏み込まない

## Constraints

- **Application Auto Scaling**:
  - `CustomizedMetricSpecification.Metrics` は最大 50KB / リクエスト、`Expression` 1-2048 文字、`ReturnData=true` は最終 1 つのみ
  - TargetTracking は「メトリクス値が capacity に対して比例して増減する」前提が必要。`asyncMaxCapacity=1` 固定下では絶対値で OK だが将来拡張時に破綻
- **CloudWatch Metrics**:
  - カスタムメトリクスは `$0.30/月` (10,000 metrics 未満の段階料金)。1 メトリクス × 1 dimension で十分
  - EMF 取り込み: ~17 MB/月 で `$0.01/月` 程度。合計月額 `~$0.31`
  - period (60s) と publish 周期を揃えないと Sum 集約で二重計上の可能性
- **EMF パイプライン遅延**: 公式 SLA なし、経験則で 10-60 秒。`scaleInCooldown=900s` に対しては十分小さいが、`scaleOutCooldown=60s` よりは大きい可能性 → scale-out 鮮度が runner 状態より遅れる可能性は許容
- **batch-runner プロセス耐性**:
  - OOM/SIGKILL で stdout flush が間に合わないケース → shutdown hook の 0 publish が間に合わない可能性は残存
  - mitigation として「runner 起動時の明示 0 publish」と「ECS タスク監視でのプロセス死検知」は本 spec で扱うが、完全な保証はできない (CloudWatch 側で「直近 N 分の Sum」を見るので、ある程度時間が経てば過去値の影響は薄れる)
- **既存 API 契約**: 本件は内部のスケーリング挙動のみで API レスポンス形状には影響しない
- **テスト環境**: SageMaker Async + Application Auto Scaling の挙動は localstack で正確に再現できない。CDK synth テスト + Runbook での手動検証手順で品質担保
