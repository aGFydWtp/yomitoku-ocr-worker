# Implementation Plan

- [ ] 1. Foundation: コンテキスト定義のガードコメント整備
- [x] 1.1 `asyncMaxCapacity` 引き上げ時の前提崩れを下流コードへ伝える誘導コメントを context 定義に追加する
  - `AsyncRuntimeContext` の `asyncMaxCapacity` フィールドに「2 以上に変更すると `async-endpoint-scale-in-protection` spec の math 式前提が崩れるため、本 spec のポリシー再設計が必要」を明記する
  - `DEFAULT_ASYNC_RUNTIME_CONTEXT.asyncMaxCapacity` の既定値 (1) 近傍にも同主旨の short コメントを残す
  - 当該ファイルを `pnpm tsc --noEmit` で型チェックが通ることをローカル確認できる状態にする
  - _Requirements: 4.2_
  - _Boundary: lib/async-runtime-context.ts_

- [ ] 2. Core 実装 (3 ファイル独立、並列実行可能)
- [x] 2.1 (P) `InflightPublisher` モジュールを新規作成し、in-flight 数を CloudWatch Embedded Metric Format で stdout に発信する仕組みを実装する
  - `Yomitoku/AsyncEndpoint::InflightInvocations` を `EndpointName` dimension のみで publish する EMF レコード生成を実装する
  - 起動時に `publish_zero` を 1 回呼び、`threading.Thread(daemon=True)` で 60 秒周期スレッドを起動する `start()`、`Event.set()` でループを抜けて `publish_zero` を 1 回呼ぶ `stop()` を持つ
  - publish 失敗 (`OSError` / `ValueError`) と provider 例外を try/except で吸収しログのみ残すことで、observability-only な振る舞いを保証する
  - 60 秒 (CloudWatch period) 内に同一プロセスから 2 回 publish しないインターバル制御を実装する
  - 完了時には Python REPL で `InflightPublisher(endpoint_name="x", provider=lambda: 0).publish_zero()` を実行すると stdout に EMF JSON が 1 行出力される
  - _Requirements: 1.3, 2.1, 2.2, 2.3, 2.5, 2.6, 2.7_
  - _Boundary: lambda/batch-runner/inflight_publisher.py_

- [x] 2.2 (P) `AsyncInvoker` の `in_flight` 状態を read-only で外部から観測可能にする
  - `run_batch` ローカル変数 `in_flight` をインスタンス属性 `self._in_flight: dict[str, str]` に昇格し、`__init__` で空 dict を初期化する
  - `inflight_count(self) -> int` getter (`return len(self._in_flight)`) を追加する。read-only で `_in_flight` の中身を改変しない
  - `Phase A` での `_in_flight[inference_id] = file_stem` と `_drain_queue` 経由の `del _in_flight[inference_id]` を新属性参照に書き換える (既存挙動と等価)
  - 完了時には既存 `pytest lambda/batch-runner/tests/test_async_invoker.py` がリグレッションなく通ることを確認する
  - _Requirements: 2.1, 3.6_
  - _Boundary: lambda/batch-runner/async_invoker.py_

- [x] 2.3 (P) `AsyncBacklogScalingPolicy` のターゲット追跡入力を floor saturation 形式の metric math 式に置き換え、`asyncMaxCapacity > 1` の synth 警告を組み込む
  - `customizedMetricSpecification` を `metrics: [...]` 配列構造に書き換え、`m1 = ApproximateBacklogSize (Average, 60s, EndpointName)`、`m2 = InflightInvocations (Sum, 60s, EndpointName)`、`e1 = FILL(m1, 0) + IF(FILL(m2, 0) > 0, 5, 0)` (label `BacklogPlusInflightFloor`, `ReturnData=true`) を定義する
  - `targetValue=5` / `scaleInCooldown=900` / `scaleOutCooldown=60` は不変で維持する。式中の閾値 `5` が `targetValue` と同期する旨を CDK コメントに明記する
  - `asyncRuntime.asyncMaxCapacity > 1` のときに `Annotations.of(this).addWarning("async-endpoint-scale-in-protection: ... 再設計が必要 ...")` を呼ぶガードロジックを Stack コンストラクタに追加する
  - 既存の `AsyncScaleOutOnBacklogPolicy` / `AsyncHasBacklogWithoutCapacityAlarm` / `CfnScalableTarget` は変更しない
  - 完了時には `pnpm cdk synth SagemakerStack` がエラーなく通り、生成 CFN テンプレに新 `Metrics` 配列が含まれていることを目視確認する
  - _Requirements: 1.1, 1.2, 2.4, 3.1, 3.2, 3.4, 3.5, 4.1, 4.4_
  - _Boundary: lib/sagemaker-stack.ts_

- [ ] 3. ECS 配布: Dockerfile に新モジュールを組み込む
- [ ] 3.1 Fargate Docker image に `inflight_publisher.py` を確実に同梱する
  - `lambda/batch-runner/Dockerfile` の `COPY` ターゲットに `inflight_publisher.py` を追加する
  - `lambda/batch-runner/tests/test_dockerfile_completeness.py` の対象モジュール一覧に `inflight_publisher.py` を加え、欠落時にテストが失敗する状態を作る
  - 完了時には `pytest lambda/batch-runner/tests/test_dockerfile_completeness.py` が green
  - _Depends: 2.1_
  - _Requirements: 2.1_
  - _Boundary: lambda/batch-runner/Dockerfile, lambda/batch-runner/tests/test_dockerfile_completeness.py_

- [ ] 4. Integration: runner orchestration に publisher のライフサイクルを組み込む
- [ ] 4.1 `runner.run_async_batch` で `AsyncInvoker` のライフサイクルに合わせて publisher を起動 / 停止する
  - `AsyncInvoker` 構築直後に `InflightPublisher(endpoint_name=settings.endpoint_name, provider=invoker.inflight_count)` を生成し `publisher.start()` を呼ぶ
  - `await invoker.run_batch(...)` 呼び出しを `try/finally` で囲み、成功 / 例外 / deadline 切れのいずれでも `finally` 句で `publisher.stop()` を呼ぶ
  - publisher 起動失敗 (`Thread.start()` 等の例外) を `try/except` (`# noqa: BLE001 — ObservabilityOnly`) で吸収し、OCR バッチ本体の継続を妨げない
  - `main.py` の `run()` は本タスクで一切変更しない (publisher 責務は `runner.run_async_batch` に閉じる)
  - 完了時には既存 `pytest lambda/batch-runner/tests/test_runner.py` 全 green、`pytest lambda/batch-runner/tests/test_main.py` も既存挙動でリグレッションなし
  - _Depends: 2.1, 2.2_
  - _Requirements: 2.2, 2.3, 2.7, 3.6_
  - _Boundary: lambda/batch-runner/runner.py_

- [ ] 5. Validation: テスト網羅 (4 ファイル独立、並列実行可能)
- [ ] 5.1 (P) `InflightPublisher` の単体テストを新規作成する
  - `start()` 直後に stdout に書かれた EMF JSON の `_aws.CloudWatchMetrics[0]` の Namespace / Dimensions / Metrics、および `EndpointName` / `InflightInvocations` フィールドが想定通りであることを `capsys` キャプチャで assert する (R2.2, R2.5)
  - `time.sleep` を monkeypatch し provider が `1, 3, 0` を返す状況で 3 周期分の datapoint が publish されることを assert する (R2.1, R2.6)
  - `stop()` 後に最後の datapoint が 0 で thread が `is_alive() == False` になることを assert する (R2.3)
  - provider が `RuntimeError` を投げてもループが止まらず次周期に復旧することを assert する (R2.7)
  - 完了時には `pytest lambda/batch-runner/tests/test_inflight_publisher.py` が 4 ケース green
  - _Depends: 2.1_
  - _Requirements: 1.3, 2.1, 2.2, 2.3, 2.5, 2.6, 2.7_
  - _Boundary: lambda/batch-runner/tests/test_inflight_publisher.py_

- [ ] 5.2 (P) `AsyncInvoker.inflight_count` の振る舞いテストを既存テストファイルに追加する
  - invoke 直後に `inflight_count()` が増え、`_drain_queue` で通知受信した分だけ減ることを既存 fixture (`full_aws_env`) を使って assert する
  - deadline 切れで残った in-flight 件数も `inflight_count()` で読めることを assert する (timeout reaper の前後)
  - getter が `_in_flight` の中身を改変しないことを副次的に assert する (呼び出し前後で dict id が変わらない)
  - 完了時には `pytest lambda/batch-runner/tests/test_async_invoker.py` 全 green
  - _Depends: 2.2_
  - _Requirements: 2.1, 3.6_
  - _Boundary: lambda/batch-runner/tests/test_async_invoker.py_

- [ ] 5.3 (P) `runner.run_async_batch` の publisher 統合テストを既存テストファイルに追加する
  - `InflightPublisher` を monkeypatch (spy/recorder) し、`AsyncInvoker` 構築後に `start()` が呼ばれ、`run_batch` 成功 / 例外いずれの場合も `finally` 句で `stop()` が呼ばれる順序を assert する (R2.2, R2.3)
  - publisher に渡される `provider` callable が構築済 `invoker` インスタンスの `inflight_count` メソッド (bound method) であることを assert する (R3.6)
  - `InflightPublisher.start` が `RuntimeError` を投げても `run_async_batch` が `BatchResult` を返し正常終了することを assert する (R2.7)
  - 完了時には `pytest lambda/batch-runner/tests/test_runner.py` が 3 ケース追加で green
  - _Depends: 4.1_
  - _Requirements: 2.2, 2.3, 2.7, 3.6_
  - _Boundary: lambda/batch-runner/tests/test_runner.py_

- [ ] 5.4 (P) `SagemakerStack` の ScalingPolicy / synth 警告 / 既存パラメータ不変を CDK synth テストで固定する
  - `AWS::ApplicationAutoScaling::ScalingPolicy` の `Metrics` 配列に `m1` (Stat=Average, Period=60, MetricName=ApproximateBacklogSize), `m2` (Stat=Sum, Period=60, MetricName=InflightInvocations), `e1` (Expression="FILL(m1, 0) + IF(FILL(m2, 0) > 0, 5, 0)", Label=BacklogPlusInflightFloor, ReturnData=true) が含まれることを assert する (R3.1, R2.4)
  - `e1.Expression` の中に `targetValue` (5) と同じ閾値が現れることを assert し、将来 target 変更時の式更新忘れを catch する
  - `asyncMaxCapacity` を `1` で synth したとき `MaxCapacity == 1` で警告なし、`2` で synth したときに `Annotations.fromStack(stack).hasWarning("*async-endpoint-scale-in-protection*")` が成立することを assert する (R4.3, R4.4)
  - `targetValue=5` / `scaleInCooldown=900` / `scaleOutCooldown=60` / `AsyncScaleOutOnBacklogPolicy` / `AsyncHasBacklogWithoutCapacityAlarm` の存在と構造が変更されていないことを assert する (R3.3, R3.5)
  - 完了時には `pnpm test test/sagemaker-stack.test.ts` 全 green
  - _Depends: 2.3_
  - _Requirements: 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.3, 4.4_
  - _Boundary: test/sagemaker-stack.test.ts_

- [ ] 6. Operations: 障害切り分け Runbook を新規追加
- [ ] 6.1 進捗停滞時の切り分け手順と本機能の保証境界を `docs/runbooks/async-endpoint-scale-in-debug.md` に記載する
  - 既存 `docs/runbooks/sagemaker-async-cutover.md` の構造 (目的 → 適用範囲 → 事前条件 → 手順 → 補足) を踏襲する
  - CloudWatch コンソールで `Yomitoku/AsyncEndpoint::InflightInvocations` を確認する手順、`HasBacklogWithoutCapacity` アラーム / `ApproximateAgeOfOldestRequest` を組み合わせた切り分けフロー、`aws application-autoscaling describe-scaling-activities` を使った scale-in 履歴確認手順を含む
  - batch-runner プロセス異常終了 (OOM / SIGKILL) 時に「最後の publish 値が period 経過まで残る」事象の確認手順 (CloudWatch メトリクス直近値と ECS タスクの実行状態の突き合わせ) を含む
  - 本機能の保証境界 (= メトリクス評価期間反映後の判定にのみ及ぶ / publish 開始前または取り込み遅延中の判定 / 既に開始済みの scale-in アクションは保証範囲外) を明示する
  - 完了時には Markdown ファイルが repository に追加され、既存 Runbook 群と相互リンクされている状態
  - _Depends: 2.3, 4.1_
  - _Requirements: 1.4, 5.1, 5.2, 5.3, 5.4_
  - _Boundary: docs/runbooks/async-endpoint-scale-in-debug.md_

## Implementation Notes

- **Task 2.1 で発生した境界例外 (Dockerfile 1 行追加)**: `tests/test_dockerfile_completeness.py::test_every_source_module_is_copied` が top-level `*.py` を全スキャンして Dockerfile の `COPY` 列と突き合わせる動的検査を行うため、新規モジュール (`inflight_publisher.py`) 追加時は同一 commit で `COPY inflight_publisher.py .` を Dockerfile に追加しないと既存 pytest baseline が即 red になる。Task 3.1 の Dockerfile COPY 追加は 2.1 で完了済み。Task 3.1 は `tests/test_dockerfile_completeness.py` の `test_known_modules_are_present` parametrize list へのアンカー追加のみが残作業。
- **Reviewer/Implementer subagent への指示**: 散文形式の status / verdict は parent の strict parser を通らない。`## Status Report` / `## Review Verdict` の見出し直下に `- STATUS: ...` / `- VERDICT: ...` の structured field block を必ず明示すること。
- **Task 2.3 で発見した CDK 型定義の遅延**: `aws-cdk-lib` 2.240.0 (本リポジトリ使用バージョン) の `CfnScalingPolicy.TargetTrackingMetricStatProperty` 型が CFN spec の `Period` プロパティを未だ宣言していない。対処として `as CfnScalingPolicy.TargetTrackingMetricStatProperty` 型キャスト + `addPropertyOverride("...MetricStat.Period", 60)` の escape hatch を採用。`pnpm cdk synth` で `MetricStat.Period: 60` が CFN テンプレに正しく注入されることを目視確認済。CDK 型定義が CFN spec に追いついた段階で props 直接指定に戻すコメントを残してある。
