# Requirements Document

## Introduction

SageMaker Async Inference エンドポイントの Application Auto Scaling は現在、`ApproximateBacklogSizePerInstance` (Average 統計) 単一メトリクスをターゲット追跡しているため、長時間 OCR ジョブの処理中に backlog=0 となった状態が `scaleInCooldown` (現行 900 秒) を超えて続くと、処理中ジョブを抱えたままインスタンス数が 0 に縮退する事象が発生する。実害として、進捗 API のステータスが進まず、ユーザーには「バッチが止まったように見える」ケースが既に確認されている。

本機能は、batch-runner が現在抱えている in-flight 数 (= SageMaker からの success/failure 通知をまだ受信していない `invoke_endpoint_async` リクエスト数) を CloudWatch カスタムメトリクスとして発信し、Async Endpoint の自動スケーリングのターゲット追跡入力を「キュー上 backlog + 処理中 in-flight」の合算負荷を返す CloudWatch metric math 式に置き換えることで、処理中ジョブが残る間の早期 scale-in を抑止する。

ターゲット追跡は scale-in / scale-out の双方を共通メトリクスで判定する仕組みであり、本機能は scale-in 抑止が主目的だが scale-out 判定にも合算値が反映される。これは意図された副作用として許容する (旧来の per-instance backlog のみを scale-out に使う構成と比べ、in-flight が積み上がった時点で scale-out 判定が早まる方向に動くだけで、`asyncMaxCapacity = 1` 固定下では実質的なキャパ上昇はない)。

現運用は `asyncMaxCapacity = 1` 固定であるため、本 spec はこの前提でのみ正しさを保証し、`asyncMaxCapacity` 引き上げ時に再設計が必要な旨はコードコメント・テスト固定・synth 警告の組み合わせでガードする。なお自動スケーリングは CloudWatch メトリクスの取り込み・評価期間に依存するため、本機能の保証境界はメトリクスが period 内で publish され評価期間に反映された後の判定にのみ及び、メトリクス取り込み遅延中や既に開始済みの scale-in アクションは保証範囲外となる。

## Boundary Context

- **In scope**:
  - batch-runner プロセスからの in-flight 数の CloudWatch カスタムメトリクス発信 (起動時 / 定期 / 終了時)
  - Async Endpoint の自動スケーリングのターゲット追跡入力を「キュー上 backlog + 処理中 in-flight」の合算負荷へ変更すること (この変更は scale-in 抑止が主目的だが、ターゲット追跡の性質上 scale-out 判定にも影響する)
  - 本変更が `asyncMaxCapacity = 1` 前提でのみ正しいことの明示と、CDK synth テストでの固定
  - 障害切り分け手順を扱う Runbook の更新
- **Out of scope**:
  - `asyncMaxCapacity` を 2 以上に引き上げた状態での per-instance 化された scale-in 保護 (= `batch-scale-out` 等の別 spec で再設計)
  - 本機能で発信するメトリクスを使った CloudWatch ダッシュボード、アラーム追加 (`MonitoringStack` 改修の責務として別途)
  - 進捗 API (`GET /batches/:id/files`) がインスタンス停止に巻き込まれた際のフォールバック挙動改善
  - SageMaker Real-time (Sync) エンドポイントへの適用 (本リポジトリは Async のみ)
  - batch-runner の `max_concurrent` (現行 4) の値変更
  - メトリクス発信前に開始済みの scale-in アクション (= 本機能のメトリクスが CloudWatch で評価される前にトリガー済の scale-in) の取り消し / 中断
- **Adjacent expectations**:
  - `sagemaker-async-inference-migration` spec (完了済) で構築済の TargetTracking ポリシー定義を本機能が直接置き換える。当該 spec の Auto Scaling 章と矛盾しないこと
  - 既存の `HasBacklogWithoutCapacity` 連動 StepScaling (scale-from-zero 経路) は本機能で触らず、引き続きインスタンス数 0 → 1 の bootstrap を担う前提
  - `batch-scale-out` spec が `asyncMaxCapacity` を 2 以上に引き上げる際は、本 spec のガードを起点に scale-in 保護ロジックの再設計を行う前提
  - 自動スケーリングは CloudWatch メトリクスの評価期間に依存するため、本機能の保証はメトリクスが period 内で publish され評価期間に反映された後の判定にのみ及ぶ。publish 開始前 / 取り込み遅延中の判定は本機能の保証範囲外

## Requirements

### Requirement 1: 処理中ジョブが残る間の scale-in 抑止

**Objective:** As an OCR バッチ利用者, I want SageMaker Async Inference エンドポイントが処理中ジョブを抱えている間はインスタンス数を 0 に縮退しないこと, so that 投入したバッチが scale-in に巻き込まれて進捗が停止する事象が発生しなくなる。

#### Acceptance Criteria

1. While batch-runner が in-flight 数 ≥ 1 を保持しており、かつその値が CloudWatch のターゲット追跡の評価期間に反映されている, the SageMaker Async Endpoint shall その評価期間に基づく scale-in 判定でインスタンス数を 0 に縮退させない。
2. When backlog (`ApproximateBacklogSize`) と in-flight 数の合算が CloudWatch のターゲット追跡上で `scaleInCooldown` (現行 900 秒) 連続してゼロに評価される, the SageMaker Async Endpoint shall インスタンス数を 0 に縮退できる。
3. If batch-runner プロセスが OOM や強制終了で in-flight 数の追加発信を停止する, the SageMaker Async Endpoint shall 最後に publish された値が CloudWatch メトリクスの評価期間 (period) を経過した後にゼロ扱いとなり、通常の scale-in 経路で 0 に戻れる (= 過去値が永続的に評価され scale-in を恒久阻止する状態を許容しない)。
4. The 本機能 shall メトリクスの取り込み遅延 / 欠損 / 既に開始済みの scale-in アクションについては保証範囲外であることを Runbook で明示する (Requirement 5 と連動)。

### Requirement 2: in-flight 数の可観測化

**Objective:** As an オンコールオペレーター, I want batch-runner が現在抱えている in-flight 数を CloudWatch メトリクスとして観測できること, so that 進捗停滞時に「処理中ジョブが残っているのか / 真に作業ゼロなのか」を切り分けられる。

#### Acceptance Criteria

1. While batch-runner が in-flight 状態を保持する区間 (= 最初の `invoke_endpoint_async` 発行から最後の通知受信または異常終了まで) にいる, the batch-runner shall 自身が保持する in-flight 数を CloudWatch カスタムメトリクスとして CloudWatch period (60 秒) ごとに 1 回だけ publish する。
2. When batch-runner プロセスが起動した直後で、まだ `invoke_endpoint_async` を 1 件も発行していない, the batch-runner shall in-flight 数 = 0 の datapoint を 1 回 publish する (CloudWatch は過去 datapoint を上書きしないため、本 datapoint は「過去値の上書き」ではなく「現在値の宣言」として動作する)。
3. When batch-runner が `run_batch` を正常終了 / 例外終了 / deadline 切れで終了する, the batch-runner shall 終了処理 (try/finally 相当) で in-flight 数 = 0 の datapoint を 1 回 publish する。
4. While 同一の Async Endpoint を呼び出す複数の batch-runner タスクが並走している, the CloudWatch メトリクス shall それら全タスクが publish した値を `Sum` 統計で合算した値を取得できる。
5. The batch-runner shall メトリクスが対象 Async Endpoint を識別できる dimension (1 種類) のみを持つ形で発信し、タスク識別用の追加 dimension は付けない (Sum による合算前提)。
6. The batch-runner shall 単一プロセス内で同一 CloudWatch period (60 秒) に 2 回以上 publish しない (Sum 集約での二重計上を防ぐ)。
7. The batch-runner shall publish 失敗が発生しても OCR バッチ本体の処理を中断しない (publisher は observability-only)。

### Requirement 3: 自動スケーリング入力の置き換えと既存挙動の保護

**Objective:** As an インフラ運用者, I want 本変更による副作用を「ターゲット追跡入力の合算化」に閉じ、scale-from-zero 経路や既存パラメータ値、batch-runner の制御フローには影響を与えないこと, so that 「インスタンス 0 から起動できない」「runner の挙動が変わる」といった regression が発生しない。

#### Acceptance Criteria

1. The 本機能 shall ターゲット追跡ポリシーのカスタムメトリクスを「`AWS/SageMaker::ApproximateBacklogSize` (Average) と `Yomitoku/AsyncEndpoint::InflightInvocations` (Sum) から、in-flight が残る間は target 値以上へ floor saturation する CloudWatch metric math 式 (single time series, ReturnData=true 1 つ)」に置き換える。
2. The 本機能 shall 上記の合算値を「`asyncMaxCapacity = 1` の前提下で per-instance utilization 値と等価とみなす」ことを CDK ポリシー定義近傍に明記する (Requirement 4 と連動)。
3. While エンドポイントのインスタンス数が 0 で backlog が積み上がる, the SageMaker Async Endpoint shall 既存の `HasBacklogWithoutCapacity` 連動 StepScaling 経路でインスタンス数を 1 にスケールアウトする (本機能で StepScaling 構成・連動アラームを変更しない)。
4. When backlog と in-flight 数の合算が現行のターゲット値 (target=5) を超えて持続する, the SageMaker Async Endpoint shall 自動スケーリングの scale-out 判定で `asyncMaxCapacity` の上限内でインスタンス数を増加させる (本機能はターゲット追跡を維持し、`DisableScaleIn` 等の片側専用構成は採用しない)。
5. The 本機能 shall 既存の `scaleInCooldown` (現行 900 秒)、`scaleOutCooldown` (現行 60 秒)、ターゲット値 (現行 5)、`asyncMaxCapacity` (現行 1)、`HasBacklogWithoutCapacity` ベースの StepScaling 構成のいずれの値も変更しない。
6. The 本機能 shall batch-runner の `max_concurrent`、`run_batch` の制御フロー、SQS ポーリング順序、`process_log.jsonl` のレコード形式のいずれも変更しない (= 観測の追加と publisher 起動 / 停止以外の副作用を持たない)。

### Requirement 4: 将来拡張時のガード

**Objective:** As an 後続 spec 担当者, I want `asyncMaxCapacity` を 2 以上に引き上げる際に scale-in 抑止ロジックの再設計が必要であることが、コメントだけでなく自動検知可能な形で明示されていること, so that per-instance 化の見落としで本問題が再発しない。

#### Acceptance Criteria

1. The 本機能 shall `asyncMaxCapacity = 1` 固定前提で正しさが成立しており、2 以上に引き上げると合算メトリクスが per-instance utilization と等価でなくなり scale-in 抑止が正しく機能しないことを、CDK 上の自動スケーリングポリシー定義近傍にコードコメントとして明示する。
2. The 本機能 shall `asyncMaxCapacity` の参照箇所 (`lib/async-runtime-context.ts`) にも、引き上げ時に本 spec のポリシー再設計が必要であることへの参照を残す。
3. The 本機能 shall CDK synth テスト (`test/sagemaker-stack.test.ts` 相当) で `MaxCapacity == 1` を assertion し、`asyncMaxCapacity` が 2 以上に変更された際は本 spec の前提が崩れたことをテストレベルで検知できる状態を維持する。
4. If `asyncMaxCapacity` が 2 以上の値で synth される, the CDK アプリケーション shall 開発者が見落とさない形で warning または error を表面化する (`Annotations.of(...).addWarning(...)` 等の手段は Design で確定)。

### Requirement 5: 運用可視化と Runbook

**Objective:** As an オンコール担当, I want 「進捗が止まった」「インスタンス数が 0 になった」事象を観測したとき、CloudWatch メトリクスを用いた切り分け手順と本機能の保証境界が文書化されていること, so that 障害判定にかかる時間が短縮され、保証範囲外の事象を誤って「regression」と判定しない。

#### Acceptance Criteria

1. The 本機能 shall in-flight 数メトリクスの参照方法と、進捗停滞時の判定フローを `docs/runbooks/` 配下の文書に追記する。
2. When オペレーターが Async Endpoint のインスタンス数 0 と進捗停滞を同時に観測する, the Runbook shall in-flight 数メトリクス、`HasBacklogWithoutCapacity` アラーム、`ApproximateAgeOfOldestRequest` の組み合わせで原因切り分けの手順を提供する。
3. The Runbook shall batch-runner プロセス異常終了による「最後の publish 値が period 経過まで残る」事象を含めた、CloudWatch メトリクスの直近値と batch-runner の実行状態を突き合わせる確認手順を含む。
4. The Runbook shall 本機能の保証境界 (= メトリクスが評価期間に反映された後の判定にのみ及ぶ / publish 開始前または取り込み遅延中の判定 / 既に開始済みの scale-in アクションは保証範囲外) を明示する。
