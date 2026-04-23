# Implementation Plan

> Scope: Realtime SageMaker Endpoint → Asynchronous Inference Endpoint への全面置換。
> 4 スタック (`SagemakerStack` / `BatchExecutionStack` / `MonitoringStack` / `ApiStack`)、
> 1 モジュール新設 (`lambda/batch-runner/async_invoker.py`)、
> `OrchestrationStack` と `lambda/endpoint-control/` を撤去する。
> `(P)` マーカーは、同一親配下で並列実行可能 (boundary 非衝突) なサブタスクに付与。

## 1. Foundation — context keys, legacy guards, test scaffolding

- [x] 1.1 CDK context の Async 運用パラメータを追加し bin 層で解決する
  - 既定値を定める: `asyncMaxCapacity=1`, `maxConcurrentInvocationsPerInstance=4`, `invocationTimeoutSeconds=3600`, `scaleInCooldownSeconds=900`
  - `bin/app.ts` で context を解決し、型付き props として `SagemakerStack` / `BatchExecutionStack` / `MonitoringStack` に伝搬する
  - 既存 `region` 既定値 (`ap-northeast-1`) を維持し、override 経路 (`-c region=...`) の挙動を保つ
  - 観測可能条件: `pnpm cdk synth` が新しい context 既定値で成功し、override を `--context` で受け取る
  - _Requirements: 2.2, 4.1, 4.3, 8.1_

- [x] 1.2 `scripts/check-legacy-refs.sh` の禁止語リストに Async 移行で除去すべき識別子を追加する
  - 追加候補: `sagemaker:InvokeEndpoint` (Realtime), `OrchestrationStack`, `endpoint-control`, `EnsureEndpointInService`, `DescribeEndpoint` (Realtime 用)
  - `StatusTable` / `/jobs` 系の既存禁止パターンは維持
  - 観測可能条件: `pnpm test -- check-legacy-refs` が新禁止語込みで green
  - _Requirements: 10.4, 11.4_

- [x] 1.3 Python async 試験用依存 (moto SNS/SQS/S3, boto3-stubs 等) を整備する
  - `lambda/batch-runner` の dev 依存に moto[sqs,sns,s3] を追加
  - 既存 pytest 設定で新フィクスチャが discovery 可能
  - 観測可能条件: `pytest lambda/batch-runner/tests -k dummy_fixture` がフィクスチャ読み込み OK で collection 成功
  - _Requirements: 3.1_

## 2. SagemakerStack — Async Endpoint / SNS / SQS / AutoScaling

- [x] 2.1 (P) `AsyncInferenceConfig` 付き `CfnEndpointConfig` を再定義する
  - 旧 `ProductionVariant.InitialInstanceCount=1` を撤去し、`InitialInstanceCount=0`・`InstanceType=ml.g5.xlarge` に置換
  - `AsyncInferenceConfig.OutputConfig.S3OutputPath` を `batches/_async/outputs/` prefix に配線
  - `AsyncInferenceConfig.OutputConfig.S3FailurePath` を `batches/_async/errors/` prefix に配線
  - `ClientConfig.MaxConcurrentInvocationsPerInstance` / `InvocationTimeoutSeconds` を context から注入
  - 新 `EndpointConfig` 名は旧名と異なる命名スキームを採用し、CFN 上書きによるダウンタイムを避ける
  - 観測可能条件: `cdk synth` 出力に Realtime `ProductionVariant` が存在せず、1 本の Async `ProductionVariant` と `AsyncInferenceConfig` が生成される
  - _Requirements: 1.1, 1.2, 1.5, 4.1, 4.3, 4.4_
  - _Boundary: SagemakerStack_

- [x] 2.2 (P) Async 通知用 SNS `SuccessTopic` / `ErrorTopic` を新設する
  - AWS 管理 KMS (`alias/aws/sns`) で SSE 暗号化
  - Topic Policy で `Publish` を `sagemaker.amazonaws.com` かつ `SourceArn=<endpoint arn>` に限定
  - `EndpointConfig` の `NotificationConfig.SuccessTopic` / `ErrorTopic` として参照を配線
  - 観測可能条件: `cdk synth` で 2 本の `AWS::SNS::Topic` と対応する TopicPolicy が生成される
  - _Requirements: 4.2, 5.3_
  - _Boundary: SagemakerStack_

- [x] 2.3 (P) SNS サブスクリプション用 SQS `AsyncCompletionQueue` / `AsyncFailureQueue` を作成する
  - AWS 管理 KMS (`alias/aws/sqs`) で SSE 暗号化
  - Queue Policy で `SendMessage` を対応する SNS Topic ARN に限定
  - `ReceiveMessageWaitTimeSeconds` を long-poll 前提 (20 秒) で構成
  - 各 Topic → Queue の `SnsSubscription` を 1:1 で配線
  - 観測可能条件: `cdk synth` で 2 本の `AWS::SQS::Queue` と `AWS::SNS::Subscription` が Topic に紐付く
  - _Requirements: 4.2, 5.3_
  - _Boundary: SagemakerStack_

- [x] 2.4 (P) Application Auto Scaling `ScalableTarget` + `ScalingPolicy` を配線する
  - `MinCapacity=0` / `MaxCapacity={asyncMaxCapacity}` (既定 1)
  - TargetTracking の `CustomizedMetricSpecification` として `AWS/SageMaker` `ApproximateBacklogSizePerInstance` を指定
  - `ScaleInCooldown={scaleInCooldownSeconds}` (既定 900 秒)、`ScaleOutCooldown` は短め (60 秒)
  - `CfnScalableTarget.addDependsOn(endpoint)` で Endpoint の `InService` 後に登録されることを保証
  - サービスリンクロール `AWSServiceRoleForApplicationAutoScaling_SageMakerEndpoint` 依存を CDK 上で明示化
  - 観測可能条件: `cdk synth` で `MinCapacity=0`、CustomizedMetricSpecification が `ApproximateBacklogSizePerInstance` を参照している
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - _Boundary: SagemakerStack_

- [x] 2.5 `CfnEndpoint` を `SagemakerStack` 所有に昇格し、旧 `EndpointConfig` を CFN ツリーから除去する
  - 旧 `OrchestrationStack` が `endpoint-control` Lambda で create/delete していた動的制御モデルを廃止
  - `CfnEndpoint` は 2.1 の新 `EndpointConfig` を参照するよう同スタック内で宣言
  - `successTopic` / `errorTopic` / `successQueue` / `failureQueue` / `endpointName` / `endpointConfigName` を `public readonly` で公開し `BatchExecutionStack` / `MonitoringStack` が props で受け取れるようにする
  - 観測可能条件: `cdk synth` で `SagemakerStack` が `AWS::SageMaker::Endpoint` を所有し、スタック外部の Endpoint 定義が消失している
  - _Requirements: 1.4, 1.5, 7.1, 7.2_
  - _Depends: 2.1, 2.2, 2.3, 2.4_

- [x] 2.6 SageMaker 実行ロールの S3 権限を `batches/_async/*` prefix に最小化する
  - `s3:GetObject` を `batches/_async/inputs/*`
  - `s3:PutObject` を `batches/_async/outputs/*` および `batches/_async/errors/*`
  - バケット全域 (`s3:*`) への付与は禁止
  - 観測可能条件: unit test が IAM ポリシーの Resource が `_async` prefix に限定されていることを検証
  - _Requirements: 5.1_

- [x] 2.7 `SagemakerStack` のユニットテストを拡充する
  - 検証項目:
    - `AsyncInferenceConfig.OutputConfig.S3OutputPath` / `S3FailurePath` が `batches/_async/` prefix
    - `NotificationConfig` に `SuccessTopic` / `ErrorTopic` が参照で配線済
    - `ProductionVariant.InitialInstanceCount=0` かつ Realtime `InitialInstanceCount=1` が残存しない
    - `CfnScalableTarget.MinCapacity=0`、`MaxCapacity` が context 値
    - TargetTracking の CustomizedMetric が `ApproximateBacklogSizePerInstance`
    - SageMaker 実行ロールに `s3:*` (bucket-wide) が付与されていない
    - `AsyncInferenceConfig` 必須パラメータ欠落時に `cdk synth` が失敗 (Req 4.4)
    - S3 prefix が `batches/` 配下以外を指した場合にテストが失敗する検証 (Req 4.5)
  - 観測可能条件: `pnpm test -- sagemaker-stack` が上記全検証で green
  - _Requirements: 1.3, 2.1, 4.4, 4.5, 5.4_

## 3. AsyncInvoker — Fargate runtime module

- [x] 3.1 `invoke_endpoint_async` 送信と S3 入力ステージングを実装する
  - `InferenceId` を `{batch_job_id}:{file_stem}` 形式で生成
  - 入力ファイルを `batches/_async/inputs/{batch_job_id}/{file}` に `PutObject`
  - `sagemaker-runtime.invoke_endpoint_async(InputLocation, InferenceId, ContentType=...)` を発行
  - 同期 4xx (`ValidationException` 等) を即時失敗扱いとし、`process_log.jsonl` の `error` に記録、リトライしない
  - 観測可能条件: moto ベースのテストで 1 ファイル当たり 1 回の `PutObject` + 1 回の `invoke_endpoint_async` が発行され、4xx ケースがリトライなしで即失敗する
  - _Requirements: 3.1, 3.4, 3.6_
  - _Boundary: async_invoker.py_

- [x] 3.2 SQS long-poll と `InferenceId` フィルタリングを実装する
  - `AsyncCompletionQueue` / `AsyncFailureQueue` を 20 秒 long-poll で交互受信
  - メッセージ内 `inferenceId` を in-flight セットと照合
  - 自分宛て成功: `OutputLocation` を `GetObject` し、`parse_pydantic_model` で JSON 整形し `DeleteMessage`
  - 自分宛て失敗: `FailureLocation` または `failureReason` を取得し `error` に記録、`DeleteMessage`
  - 他バッチ宛て: `ChangeMessageVisibility=0` で即座に返却し他ランナーに渡す
  - 観測可能条件: ユニットテストで (a) 他バッチメッセージが誤消費されない、(b) 自バッチの成功/失敗が正しく処理される、を確認
  - _Requirements: 3.2, 3.5_
  - _Boundary: async_invoker.py_

- [x] 3.3 `max_concurrent` 背圧制御と BatchResult 集計を実装する
  - in-flight `InferenceId` 上限 (既定 16、context 可変) を Semaphore 相当で維持
  - 上限到達時は新規 invoke を停止し、SQS pull で空くのを待つ
  - `BATCH_TASK_TIMEOUT_SECONDS=7200` までに未完了の InferenceId を `in_flight_timeout` として集計し、Fargate タスクは失敗終了 (SFN `MarkFailedForced` 経路)
  - `BatchResult` (succeeded / failed / in_flight_timeout) を返却
  - 観測可能条件: `max_concurrent=2` のテストで同時 invoke 呼び出しが 2 を超えないことを assert し、タイムアウト集計が機能する
  - _Requirements: 3.3_
  - _Boundary: async_invoker.py_

- [x] 3.4 AsyncInvoker のユニットテスト一式を整備する
  - 4xx ValidationException の即時失敗パス
  - Async タイムアウト (ErrorTopic 経由) の `failureReason` 記録パス
  - SQS at-least-once 重複配信の idempotent 処理
  - 共通 Queue に 2 バッチ分のメッセージが混在するシナリオ
  - 観測可能条件: `pytest lambda/batch-runner/tests/test_async_invoker.py` が上記 4 シナリオで green
  - _Requirements: 3.4, 3.5_

## 4. BatchExecutionStack — Task Role / SFN / env vars

- [x] 4.1 (P) Task Role の SageMaker 権限を `InvokeEndpointAsync` に切替える
  - `sagemaker:InvokeEndpoint` (Realtime) と `sagemaker:DescribeEndpoint` を削除
  - `sagemaker:InvokeEndpointAsync` を Endpoint ARN (`arn:aws:sagemaker:{region}:{account}:endpoint/{endpointName}`) 限定で付与
  - 観測可能条件: `cdk synth` の Task Role Policy が `sagemaker:InvokeEndpointAsync` 1 件のみを持ち、Realtime 系 action が 0 件
  - _Requirements: 5.2, 5.4_
  - _Boundary: BatchExecutionStack_

- [x] 4.2 (P) Task Role に SQS / S3 `_async` 権限を追加する
  - SQS: `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `GetQueueAttributes` を SuccessQueue / FailureQueue ARN 限定で付与
  - S3: `batches/_async/inputs/*` (Put/Get), `batches/_async/outputs/*` (Get), `batches/_async/errors/*` (Get) を追加、既存 `batches/*` 権限と穴なく重ねる
  - 観測可能条件: IAM ポリシー差分レビューが可能な形で synth 出力が得られ、test で Resource が対象 ARN / prefix に限定される
  - _Requirements: 5.2, 5.5_
  - _Boundary: BatchExecutionStack_

- [x] 4.3 (P) Fargate TaskDefinition の環境変数を追加する
  - `SUCCESS_QUEUE_URL`, `FAILURE_QUEUE_URL`, `ASYNC_INPUT_PREFIX`, `ASYNC_OUTPUT_PREFIX`, `ASYNC_ERROR_PREFIX`, `ASYNC_MAX_CONCURRENT` を ContainerDefinition に注入
  - 既存 Public subnet + `assignPublicIp=true` 構成は維持
  - 観測可能条件: synth の ContainerDefinitions に新環境変数が 5 本以上存在
  - _Requirements: 3.1, 3.2_
  - _Boundary: BatchExecutionStack_

- [x] 4.4 Step Functions 定義から Endpoint lifecycle 管理ステップを削除する
  - `EnsureEndpointInService`, `WaitEndpoint`, `EndpointReady?`, `DescribeEndpoint` (CallAwsService) を撤去
  - `AcquireBatchLock` → `RunBatchTask` → `AppendProcessLog` → `ReleaseBatchLock` の直結フローに整理
  - `States.Timeout` キャッチで `MarkFailedForced` → `ReleaseBatchLockOnError` → `Failed` の既存エラーパスは維持
  - 観測可能条件: state machine の JSON 表現から `EnsureEndpointInService` / `WaitEndpoint` / `DescribeEndpoint` の文字列が消失
  - _Requirements: 1.4, 3.6_

- [ ] 4.5 BatchExecutionStack のユニットテストを更新する
  - Task Role の Realtime action 不在と Async action の存在
  - SQS / S3 `_async` 権限が対象 ARN / prefix 限定
  - SFN 定義から Endpoint lifecycle ステップが消滅
  - 環境変数 `SUCCESS_QUEUE_URL` / `FAILURE_QUEUE_URL` が ContainerDefinition に存在
  - Public subnet + `assignPublicIp` 維持
  - 観測可能条件: `pnpm test -- batch-execution-stack` が全検証で green
  - _Requirements: 3.6, 5.2, 5.4, 5.5_

## 5. Fargate runner 統合

- [ ] 5.1 `runner.py` を Async 経路へ刷新する
  - 旧 `create_client` / `run_analyze_batch` (Realtime `YomitokuClient.analyze_batch_async` 経由) を完全撤去
  - 新 `run_async_batch(settings)` を実装し、内部で `AsyncInvoker(settings).run_batch(...)` を `await` 呼び出し
  - 既存の `generate_all_visualizations` (`parse_pydantic_model`, `correct_rotation_image`, `page_result.visualize`) を後段で流用
  - 既存 `process_log.jsonl` 書式と `BatchTable` ファイル単位 status 更新契約を維持 (yomitoku-client-batch-migration 仕様)
  - 観測可能条件: `pytest lambda/batch-runner/tests/test_runner.py` で `run_async_batch` 経路のみが起動し Realtime API 呼び出しが発生しない
  - _Requirements: 3.1, 3.6, 10.2_

- [ ] 5.2 `settings.py` に Async フィールドを追加しバリデーションを整える
  - `success_queue_url`, `failure_queue_url`, `async_input_prefix`, `async_output_prefix`, `async_error_prefix`, `async_max_concurrent`
  - 既存 `endpoint_name` の用途を Async 用に置換
  - Pydantic Settings で missing 時に fail-fast
  - 観測可能条件: settings スキーマテストで必須/任意フィールドを検証、不足時 ValidationError
  - _Requirements: 3.1, 10.2_

- [ ] 5.3 `run_async_batch` の E2E smoke を localstack + moto で実装する
  - 1 成功 + 1 失敗混在バッチで `process_log.jsonl` の per-file status を検証
  - 別バッチの SQS メッセージを共通 Queue に投入し、誤消費しないことを確認
  - Fargate 7200 秒タイムアウト相当の早期切り上げで `in_flight_timeout` が出現するパス
  - 観測可能条件: `pytest lambda/batch-runner/tests/test_run_async_batch_e2e.py` green
  - _Requirements: 3.2, 3.5, 10.2_

## 6. MonitoringStack — Async 用 CloudWatch アラーム

- [ ] 6.1 (P) `HasBacklogWithoutCapacity` アラームを追加する
  - Namespace `AWS/SageMaker`, Dimension `EndpointName`, 閾値 `>= 1`, 5 分連続
  - Action は既存 `AlarmTopic` に配線
  - 観測可能条件: `cdk synth` で 1 本の `AWS::CloudWatch::Alarm` が `EndpointName` dim 付きで生成され、AlarmActions に AlarmTopic ARN が入る
  - _Requirements: 6.1, 6.2_
  - _Boundary: MonitoringStack_

- [ ] 6.2 (P) `ApproximateAgeOfOldestRequest` アラームを追加する
  - Namespace `AWS/SageMaker`, Dimension `EndpointName`, 閾値 `> 1800` 秒, 1 datapoint で発報
  - Action は `AlarmTopic`
  - 観測可能条件: `cdk synth` で閾値 1800・EvaluationPeriods=1 のアラームが生成
  - _Requirements: 6.3_
  - _Boundary: MonitoringStack_

- [ ] 6.3 MonitoringStack のユニットテストを更新する
  - 新 2 アラームの存在と AlarmTopic 接続
  - Realtime 専用 (`Invocations`, `ModelLatency`, `OverheadLatency`) アラームが追加されていない
  - 既存 `FilesFailedTotal` / `BatchDurationSeconds` アラームが維持
  - `endpointName` prop 未指定時のフォールバック (アラーム 2 本スキップ)
  - 観測可能条件: `pnpm test -- monitoring-stack` green
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

## 7. OrchestrationStack / endpoint-control / ApiStack 解体

- [ ] 7.1 `OrchestrationStack` と `bin/app.ts` の関連宣言を撤去する
  - `lib/orchestration-stack.ts` 削除
  - `bin/app.ts` から `OrchestrationStack` import・インスタンス化・依存注入を除去
  - `SagemakerStack` の outputs を直接 `BatchExecutionStack` / `MonitoringStack` の props として接続
  - 観測可能条件: `cdk synth --all` の出力に `OrchestrationStack` 名のスタックが存在しない
  - _Requirements: 1.4, 7.1_

- [ ] 7.2 `lambda/endpoint-control/` ディレクトリを完全削除する
  - ソース、テスト、バンドル設定、cdk-nag suppression を漏れなく除去
  - 観測可能条件: リポジトリツリーに `lambda/endpoint-control/` が存在せず、`cdk synth` 出力にも対応 Lambda 関数が無い
  - _Requirements: 1.4_

- [ ] 7.3 `ApiStack` から orchestration state machine 依存を剥がす
  - props から `stateMachine` (OrchestrationStack 由来) を削除し `batchExecutionStateMachine` のみを残す
  - endpoint-control 呼び出し経路が存在した場合は API Lambda 側のコードも削除
  - 既存 `/batches` API 契約 (パス / スキーマ / HTTP ステータス) を一切変更しない
  - 観測可能条件: `pnpm test -- api-stack` が新 props で green、`lambda/api` ユニットテストの公開レスポンスが不変
  - _Requirements: 10.1, 10.3_

- [ ] 7.4 Cost Explorer 用タグ戦略を `Tags.of(this)` で適用する
  - `yomitoku:stack=sagemaker-async` / `yomitoku:component=<endpoint|autoscaling|sns|sqs|monitoring|batch>` を Sagemaker / BatchExecution / Monitoring の各スタックに付与
  - 観測可能条件: `cdk synth` の新リソース Tags にキー/値が再帰的に伝搬
  - _Requirements: 9.2_

## 8. Region 既定値の整合

- [ ] 8.1 `bin/app.ts` の region デフォルト (`ap-northeast-1`) と README/コメントを整合させる
  - 選定理由コメントを最新化 (us-east-1 は退避用オプションの位置付け)
  - README のデプロイ手順節で `-c region=ap-northeast-1` を既定として明記
  - 周辺リソース (S3 / DynamoDB) がリージョン間で分離されないよう、context override 時の注意を記載
  - 観測可能条件: region 既定値テストが `ap-northeast-1` を期待し、READMEの該当節が更新されている
  - _Requirements: 8.1, 8.4_

## 9. Runbook / PR テンプレ (運用成果物)

- [ ] 9.1 `docs/runbooks/sagemaker-async-cutover.md` を新設する
  - Pre-flight: in-flight バッチ 0 確認 / smoke PoC 成功確認手順
  - 7 ステップ cutover のコマンド列 (`cdk deploy SagemakerStack` → smoke PoC → `cdk deploy BatchExecutionStack` → `MonitoringStack` → `ApiStack` → `aws sagemaker delete-endpoint` → `delete-endpoint-config`)
  - 旧 Endpoint/EndpointConfig 削除後の検証コマンド (`describe-endpoint` が `ResourceNotFound`)
  - カットオーバー中の `/batches` 503 返却運用手順 (Req 7.5)
  - `ap-northeast-1` で scale-out が成立する条件 (例: 1 日 scale-out 成功率 95%+) と `-c region=us-east-1` 退避判定基準 (1 週間 3 回超)
  - 月次コスト実測記録テンプレ (事前見積り乖離 20% 超過時の是正手順 ─ `MaxCapacity` 低減 / `InvocationTimeoutSeconds` 短縮 / バッチ集約)
  - トラブルシュート 3 項目: S3 出力が来ない / `HasBacklogWithoutCapacity` が解消しない / scale-out が遅延する
  - Realtime → Async 選定理由・Auto Scaling パラメータ根拠・呼び出し契約変更点を design.md から参照
  - ロールバック不能性 (Step 3 以降) を明記
  - 観測可能条件: Runbook ファイルが作成され、上記全セクションが存在する
  - _Requirements: 7.3, 7.4, 7.5, 8.2, 8.3, 9.1, 9.3, 9.4, 11.1, 11.2, 11.3_

- [ ] 9.2 PR テンプレートに Async 移行のエビデンス要求を追加する
  - `pnpm test` / `pnpm lint` / `pnpm cdk synth --all` / `pnpm cdk deploy --all` のグリーン確認欄を新設
  - `docs/runbooks/sagemaker-async-cutover.md` の該当セクション参照チェックボックスを配置
  - 観測可能条件: `.github/PULL_REQUEST_TEMPLATE.md` (または `.github/pull_request_template.md`) が更新され、新チェック項目が存在
  - _Requirements: 11.5_

## 10. Validation — 全体整合

- [ ] 10.1 `check-legacy-refs` を repository 全体に対して実行し 0 ヒットを確認する
  - 1.2 で追加した禁止語が本番 / テスト / CDK コードのどこにも残らない
  - 観測可能条件: `pnpm test -- check-legacy-refs` が green
  - _Requirements: 10.4, 11.4_

- [ ] 10.2 `cdk synth --all` 整合テストを実装する
  - `OrchestrationStack` が存在しない
  - `SagemakerStack` に `AsyncInferenceConfig`・`CfnScalableTarget`・SNS Topic×2・SQS Queue×2 が含まれる
  - Realtime `ProductionVariant` (`InitialInstanceCount=1`) が全スタック横断で不在
  - MonitoringStack に Async アラーム 2 本が追加、Realtime 系アラームが追加されていない
  - `yomitoku:stack=sagemaker-async` タグが新リソースに伝搬
  - `BatchTable` / `ControlTable` / `ProcessLog` 契約 (yomitoku-client-batch-migration 仕様 owner) が不変
  - 観測可能条件: `test/app-synth.test.ts` (新設) が上記全条件で green
  - _Requirements: 1.3, 6.4, 9.2, 10.3, 10.5_
