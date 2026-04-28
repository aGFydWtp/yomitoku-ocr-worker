# Gap Analysis: async-endpoint-scale-in-protection

## Analysis Summary

- **要件主軸**: batch-runner からの in-flight 数カスタムメトリクス発信 + SageMaker Async Endpoint の TargetTracking ポリシーを CloudWatch Math 式に置換することで、処理中ジョブの早期 scale-in を抑止する。
- **既存資産で再利用できる骨格**: `main.run()` の `try/finally` (heartbeat 登録/削除と同じ場所)、Task Role IAM パターン (`addToTaskRolePolicy`)、awslogs ドライバ経由のログ取り込み (EMF が自動でメトリクス化される)、CDK 単一ファイル内の `CfnScalingPolicy` 定義、既存の synth-property assertion テストパターン。
- **真にゼロから足す部分**: in-flight 数発信機構 (Python モジュール 1 個)、CloudWatch カスタムメトリクスへの IAM 権限 (`cloudwatch:PutMetricData` または awslogs 経由 EMF)、`CfnScalingPolicy.customizedMetricSpecification.metrics[]` (Math 式) への書き換え、`asyncMaxCapacity > 1` を禁ずるガードコメント、Runbook 追記。
- **実装上の主要分岐**: (a) 発信手段は EMF (stdout 経由) か `cloudwatch:PutMetricData` 同期 API か / (b) publisher は asyncio タスクとして `run_batch` に編み込むかバックグラウンドスレッドで分離するか / (c) ScalingPolicy 改修は既存ファイル内 in-place か新 construct 切り出しか。
- **推奨方向**: 全体は Option C (Hybrid): 新規 publisher モジュールを 1 個追加、ScalingPolicy は `lib/sagemaker-stack.ts` 内 in-place 書き換え。発信手段は EMF を第一候補 (steering の構造方針 + 既存 awslogs パイプラインに同居しやすい)。

## 1. Current State Investigation

### 1.1 既存の Auto Scaling 構成 (改修対象)

`lib/sagemaker-stack.ts:391-428`:
- `CfnScalableTarget` (`MinCapacity=0`, `MaxCapacity=asyncMaxCapacity`, `serviceNamespace=sagemaker`, `scalableDimension=sagemaker:variant:DesiredInstanceCount`)
- `CfnScalingPolicy` 名 `AsyncBacklogScalingPolicy`, `policyType=TargetTrackingScaling`, `customizedMetricSpecification` で単一メトリクス (`ApproximateBacklogSizePerInstance` / `AWS/SageMaker` / Average / 1 dimension `EndpointName`)
- `targetValue: 5`, `scaleInCooldown: 900`, `scaleOutCooldown: 60`
- 設計コメントに「per-instance 化されている前提」「flapping/待ち時間悪化のトレードオフ」が明記済

`lib/sagemaker-stack.ts:444-487` (本件で **触らない**):
- `CfnScalingPolicy` 名 `AsyncScaleOutOnBacklogPolicy` (StepScaling, +1 step adjustment)
- `CfnAlarm` 名 `AsyncHasBacklogWithoutCapacityAlarm` がトリガ
- `HasBacklogWithoutCapacity = 1` (backlog>0 かつ capacity=0) で scale-from-zero

`lib/async-runtime-context.ts:24`:
- `asyncMaxCapacity: 1` (default)、context 上書き可能。本 spec の前提が崩れる引き金

### 1.2 batch-runner エントリポイントと既存パターン

`lambda/batch-runner/main.py:134-354` の `run()` 関数:
- 冒頭で boto3 client 初期化 (l. 141-144)
- `register_heartbeat` を **non-fatal try/except + flag** で実行 (l. 164-173)
  - `# noqa: BLE001 — ObservabilityOnly` のマーカーで広い except を許容する慣習が確立済
- メイン処理は `try:` ブロック内 (l. 175-337)
- `finally:` で `delete_heartbeat` (`heartbeat_registered=True` の時のみ) を呼ぶ (l. 339-354)

→ in-flight publisher の起動 / 終了は **`register_heartbeat` / `delete_heartbeat` と同じ位置** に並べるのが構造上自然。

`lambda/batch-runner/async_invoker.py:359-411` の `run_batch`:
- `in_flight: dict[InferenceId, file_stem]` が in-flight 真値 (l. 360)
- メインループは Phase A (invoke) → Phase B (`_drain_queue` で SQS poll → in_flight から削除) を交互に
- ループ間隔は SQS long-poll の `WaitTimeSeconds=20` で律速 (実質 10-20 秒粒度)

→ in-flight 値はループ毎に変動するため、publisher は **`run_batch` のループ内に寄生** するか、**別 thread / asyncio タスク**で `len(in_flight)` を 60s 周期で観測するか、いずれか。

`lambda/batch-runner/control_table.py` の `register_heartbeat` / `delete_heartbeat`:
- `boto3.resource("dynamodb")` の `Table` を引数注入して使う関数群
- 失敗時の挙動 (count drift 許容、observability only) を明示的にコメント

→ publisher も同じ規約で、`boto3.client("cloudwatch")` または stdout 書き込みを引数化された方が良い。

### 1.3 IAM とログドライバの既存土台

`lib/batch-execution-stack.ts:225-228`:
- `LogDriver.awsLogs({ logGroup, streamPrefix: "batch-runner" })` で stdout/stderr を CloudWatch Logs に流す既存パイプ
- EMF (stdout に JSON で `_aws.CloudWatchMetrics` を書き出す) はこの awslogs 経路で **追加権限なしに** カスタムメトリクスとして取り込まれる

`lib/batch-execution-stack.ts:247-368`:
- `taskDefinition.addToTaskRolePolicy(new PolicyStatement({ sid: "...", actions: [...], resources: [...] }))` を Sid 付きで列挙する pattern
- `cloudwatch:PutMetricData` 経路を選ぶ場合、ここに 1 つ Statement を追加する

→ **EMF を選べば IAM 追加ゼロ、`PutMetricData` を選ぶと IAM 1 Statement 追加**。本件は 1 メトリクス × 60s 周期で発信頻度が低いのでどちらでも費用差は無視可能。EMF は「Logs 取り込みコスト ~$0.01/月 + メトリクス代 $0.30/月」、`PutMetricData` は「API 呼び出し $0.01/1000 calls × 1440 calls/day = ~$0.40/月 + メトリクス代 $0.30/月」のオーダー。

### 1.4 テストパターン

`test/sagemaker-stack.test.ts`:
- CDK synth → `Template.fromStack(stack)` → `hasResourceProperties` で property assertion
- Math 式書き換え後の `customizedMetricSpecification.metrics[]` のスナップショット assertion をここに足せる

`lambda/batch-runner/tests/test_async_invoker.py`:
- moto fixture (`s3_bucket`, `sqs_env`, `full_aws_env`) + boto3 Stubber で sagemaker-runtime を立てる完成度の高いハーネス
- publisher の単体テストは `CloudWatchClient` を Stubber でモック、または stdout キャプチャで EMF JSON を assert する方式が候補

`lambda/batch-runner/tests/test_main.py`:
- `main.run()` の orchestration を end-to-end で確認するテストが既存 → publisher 起動 / 終了 hook の組み込み確認をここに追加できる

### 1.5 Runbook 既存スタイル

`docs/runbooks/sagemaker-async-cutover.md`:
- 「目的 → 適用範囲 → 事前条件 → 手順 → ロールバック」の構造
- AWS CLI コマンドを heredoc で示し、CloudFormation Output から ARN を引いて手動置換ミスを防ぐパターン
- メトリクスは `aws cloudwatch get-metric-statistics` を使った確認手順が頻出

→ 本件用に新規 Runbook を起こすか、既存 cutover Runbook の「事前条件」「scale-in 観察」節に追記するかは設計で判断。Requirement 5 は「`docs/runbooks/` 配下の文書」と書いており新規 / 追記いずれも適合。

## 2. Requirement-to-Asset Map

| Req. ID | 要件のコア | 既存資産 | ギャップ | タグ |
|---|---|---|---|---|
| R1.1 | in-flight ≥ 1 で instance ≥ 1 維持 | `CfnScalingPolicy` | TargetTracking メトリクス入力を Math 式に置換、Stat=Sum | Missing |
| R1.2 | backlog+inflight=0 + cooldown 経過で 0 縮退 | `scaleInCooldown=900` | Math 式の値が 0 になる経路の整備 | Constraint (既存 cooldown を維持) |
| R1.3 | runner 異常終了時の値固着回避 | (なし) | publisher の起動時 0 publish + 過去値消化を Stat=Sum + 短期 period で吸収 | Missing |
| R2.1 | 1 分以内周期で in-flight 発信 | `run_batch` ループ + awslogs パイプ | 発信モジュール (EMF or PutMetricData) を新規追加 | Missing |
| R2.2 | 起動時 0 publish | `main.run()` 冒頭 | publisher start hook を `register_heartbeat` の隣に追加 | Missing |
| R2.3 | 終了時 0 publish | `main.run()` の `finally` | publisher stop hook を `delete_heartbeat` の隣に追加 | Missing |
| R2.4 | 複数 task 並走時の合算サポート | (なし) | Stat=Sum + dimension は EndpointName のみで合算前提に | Missing |
| R2.5 | EndpointName dimension | `settings.endpoint_name` | publisher が `endpoint_name` を Settings 経由で受ける | Missing |
| R3.1 | scale-from-zero 経路維持 | `HasBacklogWithoutCapacity` StepScaling | 触らない契約をテストで固定 | Constraint |
| R3.2 | scale-out 経路維持 | TargetTracking | Math 式置換後も target=5 維持 | Constraint |
| R3.3 | 既存パラメータ不変 | `scaleInCooldown=900`, `scaleOutCooldown=60`, `target=5`, `asyncMaxCapacity=1` | 不変契約をテストで固定 | Constraint |
| R3.4 | runner 既存挙動への副作用なし | `max_concurrent`, `run_batch` 制御フロー | publisher は read-only で `in_flight` を読むのみ | Constraint |
| R4.1 | CDK ガードコメント | (なし) | `CfnScalingPolicy` 近傍にコメント追加 | Missing |
| R4.2 | context 側のガード参照 | `lib/async-runtime-context.ts:24` | コメント追加 | Missing |
| R5.1 | Runbook へ判定フロー追記 | `docs/runbooks/` | 新規ファイル or 既存追記 | Missing |
| R5.2 | 切り分け手順 | 既存 cutover Runbook フォーマット | 手順文を新規執筆 | Missing |
| R5.3 | プロセス異常終了時の確認手順 | (なし) | 手順文を新規執筆 | Missing |

## 3. Implementation Approach Options

### Option A: Extend Existing Components

**核**: 既存 `async_invoker.py` の `run_batch` 内に EMF publish ロジックを直接埋め込み、`main.py` の `try/finally` に publisher 制御を入れる。新ファイルは作らない。

- **対象ファイル**:
  - `lambda/batch-runner/async_invoker.py`: `run_batch` ループに publish 呼び出し追加
  - `lambda/batch-runner/main.py`: `run()` 冒頭で 0 publish、`finally` で 0 publish
  - `lib/sagemaker-stack.ts`: `customizedMetricSpecification` を Math 式構成に書き換え + ガードコメント
  - `lib/async-runtime-context.ts`: コメント追加
- **互換性**: `AsyncInvoker` の `__init__` 引数増加 (settings 経由で `endpoint_name` は既に持っている、追加引数は publisher client のみ)。consumer は `main.py` のみで影響限定
- **トレードオフ**:
  - ✅ 新ファイルゼロ、PR が小さい
  - ✅ publisher のテストは既存 `test_async_invoker.py` の hood に追加
  - ❌ `async_invoker.run_batch` の責務が「invoke + 完了監視」から「invoke + 完了監視 + メトリクス発信」に拡張され、structure.md の「1 モジュール = 1 関心事」から逸脱
  - ❌ `register_heartbeat` のパターン (純関数 + table 注入) と非対称になり保守性が落ちる

### Option B: Create New Components

**核**: 新規 `lambda/batch-runner/inflight_publisher.py` を作り、publish は完全に分離。`run_batch` 自体は触らず、`main.py` orchestration からのみ起動 / 観測 / 停止する。

- **新規モジュール**: `lambda/batch-runner/inflight_publisher.py`
  - 関数: `start_publisher(*, endpoint_name, in_flight_provider, period_sec=60, cw_client=None)` がバックグラウンドタスク (asyncio or thread) を返す
  - 関数: `publish_zero(*, endpoint_name, cw_client=None)` を起動時/停止時に呼べる単独関数として用意
  - publish 手段は EMF (`print(json.dumps(emf_record))`) を第一候補。`cw_client` 引数は将来 `PutMetricData` に切り替える時のフック
- **対象ファイル**:
  - `lambda/batch-runner/inflight_publisher.py`: 新規
  - `lambda/batch-runner/main.py`: `start_publisher` / `publish_zero` 呼び出しを `register_heartbeat` / `delete_heartbeat` の隣に並べる
  - `lambda/batch-runner/async_invoker.py`: 触らないか、`AsyncInvoker` に `len_inflight() -> int` の getter を 1 行追加
  - `lib/sagemaker-stack.ts`: 同上
  - `lib/async-runtime-context.ts`: 同上
  - `lib/batch-execution-stack.ts`: PutMetricData 経路を選ぶなら 1 Statement 追加 (EMF なら不要)
- **新規テストファイル**: `lambda/batch-runner/tests/test_inflight_publisher.py`
- **責務境界**: publisher は「現在値を取得 → CloudWatch に出す」のみ。in_flight 数の取得は callback (provider) で疎結合
- **トレードオフ**:
  - ✅ structure.md の「1 関心事 = 1 モジュール」に整合
  - ✅ `register_heartbeat` パターンを踏襲して非対称性を消せる
  - ✅ 単体テストが既存の moto/Stubber パターンの上に素直に書ける
  - ❌ 新ファイル + 新テストファイル + Dockerfile 検査 (`test_dockerfile_completeness.py`) の更新で PR がやや大きい
  - ❌ asyncio タスク or thread の lifecycle 管理を 1 箇所にまとめる責務を負う

### Option C: Hybrid Approach (推奨)

**核**: publisher は **新モジュール (Option B)**、ScalingPolicy 改修は **既存ファイル内 in-place (Option A)**。新 Stack や新 Construct は切り出さない。

- **理由**:
  - publisher は「メトリクス発信」という独立した関心事 → モジュール分離が自然
  - ScalingPolicy 改修は `lib/sagemaker-stack.ts:407-428` の `customizedMetricSpecification` を `metrics: [...]` 配列に書き換える局所変更 → 新 Construct 化は過剰設計
  - structure.md の「1 AWS サービスドメイン = 1 Stack」が固定方針なので、SagemakerStack を分割しない
- **対象ファイル**:
  - `lambda/batch-runner/inflight_publisher.py`: 新規
  - `lambda/batch-runner/tests/test_inflight_publisher.py`: 新規
  - `lambda/batch-runner/main.py`: hook 追加
  - `lambda/batch-runner/async_invoker.py`: `in_flight` を getter 経由で公開 (read-only)
  - `lib/sagemaker-stack.ts`: ScalingPolicy 書き換え + ガードコメント
  - `lib/async-runtime-context.ts`: コメント追加
  - `test/sagemaker-stack.test.ts`: Math 式構成の synth assertion 追加
  - `lambda/batch-runner/tests/test_main.py`: publisher 起動/停止 hook の確認
  - `lambda/batch-runner/Dockerfile` + `lambda/batch-runner/tests/test_dockerfile_completeness.py`: 新モジュールを COPY 対象に追加
  - `docs/runbooks/`: 新規 Runbook (例 `async-endpoint-scale-in-debug.md`) または既存 `sagemaker-async-cutover.md` への追記
- **トレードオフ**:
  - ✅ コードの責務分離 (publisher) と CDK の局所変更 (ScalingPolicy) のバランスが取れる
  - ✅ R3.x の「既存挙動を変えない」契約を、テスト assertion 追加で固定しやすい
  - ❌ Option A よりは PR が大きい (2-3 ファイル新規 + 既存 4-5 ファイル変更)

## 4. Research Needed (Design 段階で確定)

- **EMF vs PutMetricData**: 第一候補は EMF (steering の構造方針に同居 + IAM 追加ゼロ)。ただし EMF は CloudWatch Logs 取り込み遅延 (経験則 10-60 秒) があり、`scaleOutCooldown=60s` の鮮度に対して影響が出るかは要確認。PutMetricData は同期 API でレイテンシ低いが API rate / Fargate egress を消費。本件は `scaleInCooldown=900s` がボトルネックなので EMF で十分という想定だが、Design で明示的に判断する。
- **publisher の実装形態**: (a) `threading.Thread` を daemon=True で立てる / (b) `asyncio.create_task` で `run_batch` の event loop に編み込む / (c) main.py の同期ループから時刻判定 — どれが Fargate 上で最も信頼性高いか。Design で決定。
- **複数 batch-runner 並走時の period 重複**: 各 task が period=60s 内で 1 回ずつ publish するなら Sum 集約は正確。複数 task が同 period に publish したときの合算は Sum で意図通りだが、period をまたぐ jitter があると一時的に過大評価される可能性。本件は `asyncMaxCapacity=1` 前提のため過大評価でも scale-in 抑止側に倒れて安全。Design で許容範囲を明文化。
- **Math 式の正確な記述**: `Expression: "FILL(m1, 0) + FILL(m2, 0)"`, `MetricStat[m1] = AWS/SageMaker:ApproximateBacklogSize:Average:[EndpointName=...]`, `MetricStat[m2] = Yomitoku/AsyncEndpoint:InflightInvocations:Sum:[EndpointName=...]`, `ReturnData=true` を 1 つだけ。CFN シンタックスでの `MetricStat.Stat` のケース表記と、Application Auto Scaling の `TargetTrackingMetricStat` では `Period` を出力しないことを Design で固定。
- **Runbook の置き先**: 新規ファイル `docs/runbooks/async-endpoint-scale-in-debug.md` を作るか、既存 `sagemaker-async-cutover.md` の「事前条件」セクションに追記するか。Design で決定。
- **`asyncMaxCapacity` 引き上げ時のガード強度**: コメントだけで十分か、`bin/app.ts` で `asyncMaxCapacity > 1` を検知して `Annotations.of(...).addWarning(...)` を出すか、unit test で `asyncMaxCapacity == 1` を assert するか。Design で強度を選ぶ。

## 5. Implementation Complexity & Risk

- **Effort**: **M (3-5 日)**
  - inflight_publisher.py + テスト: 1 日
  - main.py の hook 組み込み + 既存テスト更新: 0.5 日
  - sagemaker-stack.ts の Math 式書き換え + テスト: 1 日
  - IAM / Dockerfile / async-runtime-context.ts の細部: 0.5 日
  - Runbook 執筆: 0.5 日
  - 統合確認 (synth + pytest + Runbook 実機検証手順): 0.5-1 日
- **Risk**: **Medium**
  - Math 式の挙動は CDK synth assertion で固定できるが、本番で実際に scale-in が抑止されるかは E2E でしか観測できない (long-running 60 分以上の OCR ジョブで CloudWatch コンソールを目視)
  - フォールバックが「`FILL(m2, 0)` で旧来挙動と等価な scale-in が走る」= 安全側に倒れるため、blast radius は小さい
  - 新規コンポーネント (publisher) の障害モードが既存パスに伝播しないことは、`# noqa: BLE001 — ObservabilityOnly` パターンで担保 (既存 `register_heartbeat` と同じ非致命扱い)
  - `asyncMaxCapacity=1` 前提が将来ブレた瞬間に scale-in 保護が壊れる構造的リスクは Requirement 4 のガードで明示するが、コメントだけでは検知漏れの可能性。Design で強度判断

## 6. Recommendations for Design Phase

### 6.1 採用候補のアプローチ

**Option C (Hybrid)** を推奨。理由は §3 Option C の trade-off に記載済。

### 6.2 Design で必ず決めるべき設計判断

1. **発信手段**: EMF / PutMetricData の選択 (推奨: EMF。Steering の awslogs パイプに同居)
2. **publisher 実装形態**: thread / asyncio task / 同期ループ判定 (推奨: thread daemon。`run_batch` 自体に介入せず、`main.run()` の入口で start・出口で stop できる単純形)
3. **dimension 設計**: `EndpointName` のみで Sum 集約 (推奨)。複数 task 並走の period 重複は許容
4. **Math 式の Stat / 評価粒度**: `m1=Average` / `m2=Sum`。Application Auto Scaling の `TargetTrackingMetricStat` には `Period` を出力せず、publisher の 60 秒周期とサービス既定の評価粒度を前提にする
5. **Runbook 置き先**: 新規 `docs/runbooks/async-endpoint-scale-in-debug.md` を推奨 (既存 cutover Runbook は責務が違う)
6. **`asyncMaxCapacity` ガード強度**: コードコメント + `test/sagemaker-stack.test.ts` で `MaxCapacity == 1` を assert する 2 段階を推奨

### 6.3 Design で明文化が必要な契約

- `inflight_publisher.start_publisher` の起動失敗は **non-fatal** (publisher が動かなくても OCR バッチは完走する)。`# noqa: BLE001 — ObservabilityOnly` で吸収
- `publish_zero` の終了時呼び出しは `try/finally` で実行し、失敗時はログのみ。runner 終了は妨げない
- `AsyncInvoker` の `len_inflight()` getter は read-only。lock は不要 (Python の `len(dict)` は atomic + 読み取り精度に厳密性は要らない)
- ScalingPolicy 改修後も既存 `HasBacklogWithoutCapacity` 連動 StepScaling は **論理的に独立** (Math 式の入力にも結果にも依存しない)

### 6.4 Research 持ち越し項目 (Design 段階で外部確認)

- AWS の **EMF 取り込み遅延の公称値** (CloudWatch Logs Insights のドキュメント / re:Invent セッション参照)
- **TargetTracking + Math 式** の SageMaker Async での実例 (AWS Blog / GitHub samples) — viability check で確認済だが、Design で参照リンクを 1-2 本残しておくと将来の保守者の認知コストが下がる

---

## Synthesis Outcomes (added during /kiro-spec-design)

### Generalization
- Requirements R1〜R3 はすべて「ターゲット追跡入力に in-flight 観測値を加える」という単一の問題の facets。R4 は構造的ガード、R5 は文書化。Publisher の interface (`start_publisher` / `publish_zero` / 停止 hook) は最小に維持し、汎化のための余剰抽象 (例: 任意のメトリクス発信用 framework) は導入しない。

### Build vs Adopt
- **Adopt**: AWS Embedded Metric Format (EMF) を stdout 経由で発信するパターン (steering tech.md の awslogs ドライバとシームレスに連携)。CloudWatch metric math は AWS native 機能。
- **Build (minimal)**: EMF レコード生成と 60 秒周期スケジューリングの薄い layer のみ自前。`aws_embedded_metrics` Python ライブラリは依存を増やす割に value が低い (1 メトリクス × 1 dimension × 60s 周期)。`json.dumps + print` の最小実装で十分。
- **Reject**: `boto3.client("cloudwatch").put_metric_data` 同期発信。理由は (1) IAM 追加 (`cloudwatch:PutMetricData`) が要る、(2) Fargate egress を消費、(3) API 失敗時のリトライハンドリングを書き起こすコストが EMF stdout より大きい。EMF なら awslogs ドライバ側のリトライに乗る。

### Simplification
- 新 Stack / 新 Construct を作らず、`SagemakerStack` 内で `CfnScalingPolicy.customizedMetricSpecification` を in-place 書き換え (research.md §3 Option C)。
- Publisher の dimension は `EndpointName` 1 つのみ。`TaskId` 等の追加 dimension は将来の per-task デバッグに有用そうに見えるが、Sum 合算前提では不要。
- Publisher の period / namespace / metric name は CDK context や設定値にせず Python 定数としてハードコード。理由: Python 側と CDK 側の値ずれを防ぐ唯一の方法は「両方コードに直書き」(設定経由にすると 2 箇所の synchronization が必要になり、テストでも検証が複雑になる)。
- `inflight_publisher` は `threading.Thread(daemon=True)` を採用。`run_batch` の asyncio event loop に編み込むと非同期の例外伝播やキャンセルロジックが必要になり責務が肥大化する。daemon thread なら main プロセスの終了でクリーンに止まる。
