# Research & Design Decisions — `sagemaker-async-inference-migration`

## Summary

- **Feature**: `sagemaker-async-inference-migration`
- **Discovery Scope**: Complex Integration (SageMaker Realtime → Asynchronous Inference 置換、 `yomitoku_client` バイパス、4 スタック横断)
- **Key Findings**:
  - `yomitoku_client v0.2.0` は SageMaker Realtime API (`invoke_endpoint`) に
    ハードコードされており、Async Inference API (`invoke_endpoint_async`) へは
    非対応。**invoke 層の自前実装が必須**。
  - Async Endpoint は `InitialInstanceCount=0` + Application Auto Scaling で
    `0 ↔ N` 自動スケールが可能。スケール指標には Async 専用のマネージド
    CloudWatch メトリクス `ApproximateBacklogSizePerInstance` を利用する。
  - 完了検知は **SNS `SuccessTopic` / `ErrorTopic` (SQS Subscribe) 一択**
    (要件 Req 3.2 / Req 4.2 で決定済)。S3 ポーリングは採用しない。
  - 既存 `OrchestrationStack` の `endpoint-control` Lambda による Endpoint
    手動起動・停止は Async + `MinCapacity=0` で不要化できる (Req 7 スコープ)。
  - `yomitoku_client` の **結果整形ユーティリティ** (`parse_pydantic_model`
    / `correct_rotation_image` / `page_result.visualize`) は Async でも
    流用可能。モデル出力 JSON スキーマは Realtime と同一である前提
    (R4 で PoC 検証)。

## Research Log

### Topic 1: SageMaker Asynchronous Inference の呼び出し契約

- **Context**: Req 3 を満たす `InvokeEndpointAsync` + SNS 通知経路の設計
- **Sources Consulted**:
  - AWS 公式: Asynchronous Inference Endpoint Concepts / CreateEndpointConfig API ref
  - `boto3` `sagemaker-runtime` `invoke_endpoint_async`
  - `boto3` `sagemaker` `CreateEndpointConfig.AsyncInferenceConfig`
- **Findings**:
  - 入力は **S3 URI (InputLocation)** のみ受け付ける。`Body` 直送は不可。
    バイナリは呼び出し側で S3 に PUT してから URI を渡す。
  - 同期レスポンスは `{InferenceId, OutputLocation, FailureLocation}`。
    ペイロード応答はなし。結果は `OutputLocation` (S3 PUT) + SNS 通知で
    非同期に届く。
  - 単一 Endpoint 単位で `MaxConcurrentInvocationsPerInstance` と
    `InvocationTimeoutSeconds` を制御する。既定で最大 **1 時間** までの
    推論を許容する (Realtime の 60 秒上限を超えられる)。
  - SNS 通知 (`SuccessTopic` / `ErrorTopic`) は EndpointConfig 作成時に配線
    が必要で、あとから追加することはできない (再作成扱い)。
  - SNS メッセージ本文 (`notification_config` 経由) の JSON には、最低限
    `inferenceId` / `requestParameters.inputLocation` /
    `responseParameters.outputLocation` (成功時) または
    `failureReason` (失敗時) が含まれる (**R3 で実測確認予定**)。
- **Implications**:
  - batch-runner の入力前処理で **S3 PUT → InputLocation 解決** が必須。
    既存の `batches/{batchJobId}/input/*.pdf` prefix を流用し、
    `batches/_async/inputs/{batchJobId}/{fileName}.{ext}` に配置する
    (1 ファイル = 1 InvokeEndpointAsync)。
  - ページ分割ラスター化は、ライブラリの `load_pdf_to_bytes` を抽出して
    独自 invoke 層で再利用する (ページ JPEG/PNG ごとに 1 invoke)。
  - EndpointConfig は `AsyncInferenceConfig` 必須。既存 Realtime 向けの
    Config と**必ず別名**で新規作成する (Req 1.5)。

### Topic 2: Application Auto Scaling (Async 用)

- **Context**: Req 2 — `MinCapacity=0`, `MaxCapacity` default=1, バックログ
  指標ベースのターゲット追跡
- **Sources Consulted**:
  - AWS 公式: `ApplicationAutoScaling::ScalableTarget` と
    `ApplicationAutoScaling::ScalingPolicy` (TargetTrackingScalingPolicyConfiguration)
  - `PredefinedMetricSpecification.PredefinedMetricType =
    SageMakerVariantInvocationsPerInstance` (Realtime 用) vs
    `CustomizedMetricSpecification` で `ApproximateBacklogSizePerInstance` を
    指定する Async パターン (AWS ブログの参考実装)
  - `aws-cdk-lib/aws-applicationautoscaling` モジュール
- **Findings**:
  - **`ApproximateBacklogSizePerInstance` は Predefined に含まれない**。
    `CustomizedMetricSpecification` (namespace `AWS/SageMaker`,
    metric `ApproximateBacklogSizePerInstance`,
    dimensions: `EndpointName` のみ、`VariantName` 不要) で指定する必要がある。
  - `MinCapacity=0` は Async 専用機能。Realtime Endpoint では不可。
  - Scale-in までの待機時間は `ScaleInCooldown` / `ScaleOutCooldown` で制御。
    既定は 300 秒 / 300 秒。要件の「15 分アイドルで scale-in」は
    `ScaleInCooldown=900` で表現する。
  - スケール上限 (`MaxCapacity`) はアカウントのサービスクォータ
    `Maximum number of instances per endpoint` (既定 2-4) に依存する。
- **Implications**:
  - CDK で `CfnScalableTarget` + `CfnScalingPolicy` を `CfnEndpoint` 作成後に
    依存関係付きで登録する。CDK の `ScalableTarget` コンストラクトは
    SageMaker Endpoint variant を直接受けないため、`serviceNamespace=sagemaker`,
    `scalableDimension=sagemaker:variant:DesiredInstanceCount`,
    `resourceId=endpoint/{name}/variant/{variant}` を文字列で組み立てる。
  - `CreateServiceLinkedRole` は一度だけアカウントで必要 (CDK で宣言しても
    2 度目以降は既存利用)。Req 2.5 はこれを指す。

### Topic 3: SNS 通知 → batch-runner 完了検知パターン

- **Context**: Req 3.2 — SNS 通知一択。S3 ポーリング不可。
- **Sources Consulted**:
  - AWS 公式: Async Inference Notifications
  - SQS Fan-out via SNS Subscription (`sqs:SendMessage` permission)
- **Findings**:
  - SNS 通知のサブスクライブ方式は以下の候補がある:
    (a) SNS → SQS → batch-runner が `ReceiveMessage` で長ポーリング
    (b) SNS → HTTPS endpoint (不採用。VPC 公開口が不要なため)
    (c) SNS → Lambda → DDB 経由で batch-runner に通知 (間接的)
  - **(a) SNS → SQS pull パターン** が Fargate batch-runner のライフサイクル
    (同一バッチ内で投入・待機・集計を完結) と相性が良い。各バッチ実行毎に
    専用 SQS Queue を作らず、**共通 Queue + `InferenceId` フィルタ** で対応可能。
  - ただし「共通 Queue を複数 batch-runner が競合的に poll する」と、
    他バッチの `InferenceId` メッセージを受け取った場合は
    `ChangeMessageVisibility` で再可視化するか、`ApproximateReceiveCount >= 1` で
    無視するかの制御が必要。
- **Implications**:
  - **既定方針**: 「バッチ毎に専用 SQS Queue を作らず、共通 Queue を
    長ポーリング、`InferenceId` をメッセージ属性で突き合わせ」。
    SNS Subscription に MessageAttributeFilter を適用せず (InferenceId は
    動的なため)、batch-runner 側でフィルタリング。
  - 他バッチのメッセージを誤消費しないよう、**ReceiveMessage 時に
    VisibilityTimeout を小さく (30 秒) 設定**し、自分のものでなければ
    VisibilityTimeout を 0 に戻して他 poller に返す運用とする (R3 で検証)。
  - ErrorTopic 受信時は `failureReason` を `process_log.jsonl` の `error`
    に記録し (Req 3.5)、当該ファイルのみ失敗扱いでバッチは継続。

### Topic 4: `yomitoku_client` の再利用可能レイヤー

- **Context**: Option C (Hybrid) — 結果整形層だけ流用する方針の具体化
- **Sources Consulted**:
  - `yomitoku_client/__init__.py` (`parse_pydantic_model` export)
  - `yomitoku_client/models.py` (`correct_rotation_image`, `PageResult`)
  - `yomitoku_client/utils.py` (`load_pdf_to_bytes`, `load_pdf`,
    `make_page_index`)
  - `yomitoku_client/visualizers/document_visualizer.py`
  - `yomitoku_client/renderers/` (json/md/csv/html/pdf/searchable_pdf)
- **Findings**:
  - `parse_pydantic_model(raw_dict)` は SageMaker 応答の `raw_dict` を
    `DocumentResult` Pydantic モデルに変換する。Realtime と Async で
    コンテナ内部の推論ロジックが同一 (Marketplace モデル本体不変) であれば、
    **応答 JSON スキーマは同一**であり、流用可能。
  - `correct_rotation_image(img, angle=N)` / `PageResult.visualize(img, mode)`
    は cv2 配列に対するピュアな関数で、SageMaker 通信と疎結合。
  - `load_pdf_to_bytes(path, dpi)` は PyMuPDF 依存だが、Async 化でページ
    分割してから S3 PUT する際に再利用可能。
  - 一方、`YomitokuClient._invoke_one` / `_ainvoke_one` / `analyze_async` /
    `analyze_batch_async` は全て Realtime 契約の上に構築されており、
    **呼び出し経路のコードは流用できない**。
  - サーキットブレーカー (`_circuit_failures` / `_circuit_open_until`) と
    ThreadPoolExecutor (`_pool`) も `_invoke_one` に密結合しており、
    Async 経路に直接移植せず、batch-runner 側で再実装する。
- **Implications**:
  - 新モジュール `lambda/batch-runner/async_invoker.py` に、S3 PUT →
    `invoke_endpoint_async` → `InferenceId` 集合保持 → SQS poll →
    `OutputLocation` GetObject → `parse_pydantic_model` のフローを実装。
  - 既存 `runner.py` の `create_client` / `run_analyze_batch` は **廃止**、
    新しい `run_analyze_batch_async(settings)` (新名称は Realtime 用 method
    と同名の混乱を避けるため `run_async_batch`) に置換。
  - 可視化層 (`generate_all_visualizations`) は変更しない (Req 10 の
    互換維持)。

### Topic 5: ap-northeast-1 の GPU キャパシティ (ml.g5.xlarge)

- **Context**: Req 8 — `MinCapacity=0` で「呼び出し時のみ確保」にすれば
  ap-northeast-1 で成立すると期待しているが、過去 Realtime モードで
  `ap-northeast-1` の `ml.g5.xlarge` 確保に失敗した実績があるため、
  実地検証の段取りを確保する必要がある。
- **Sources Consulted**:
  - 既存内部文書 `YomiToku-Pro_AWS構築検討.md` (方式 B Async 検討メモ)
  - AWS Service Health Dashboard 過去記録 (参考)
- **Findings**:
  - Async の scale-out は Realtime と同じく「Endpoint variant の
    `DesiredInstanceCount` を増やす」形で実現される。インスタンス確保失敗は
    **同じ `InsufficientCapacityError`** として CloudWatch に出る。
  - ただし「常時 1 台占有」と「必要時に 1 台確保」では、キャパシティ確保
    成功率が後者のほうが高いという定性的な AWS アーキテクトアドバイスは
    存在する (予約型 vs スポット型の文脈で類似)。定量的保証はない。
  - 保険として `us-east-1` への退避が可能なよう、リージョンは context で
    上書き可能とする (`bin/app.ts:13`)。README / Runbook に退避手順を
    記載する (Req 8.3)。
- **Implications**:
  - Req 8.2 の「scale-out 成功率 95%+」は設計で閾値のみ定義し、
    実測は移行後 1 週間の監視で評価する。
  - Async scale-out 失敗時の CloudWatch メトリクス
    `HasBacklogWithoutCapacity` をアラーム化 (Req 6.2) し、
    オンコールに通知する運用を前提とする。

### Topic 6: カットオーバー戦略

- **Context**: Req 7 — 旧 Realtime Endpoint の確実な削除
- **Sources Consulted**:
  - 既存ランブック `docs/runbooks/status-table-cutover.md`
  - `scripts/check-legacy-refs.sh`
- **Findings**:
  - `cdk deploy SagemakerStack` で EndpointConfig を**新名称で**作成し、
    旧 EndpointConfig は CDK ツリーから削除、CloudFormation が削除を実行する。
  - `CfnEndpoint` の `EndpointConfigName` を新名に切り替えると、
    SageMaker は Blue/Green デプロイをサポートするが、**Realtime →
    Async で EndpointConfig 種別が異なる場合は Update ではなく
    Replace** (CFN 挙動) となるため、旧 Endpoint は **削除 → 新規作成**。
  - 本仕様では **旧 Endpoint を CDK から removalPolicy=DESTROY で外し、
    新 Endpoint を別名で作成** する段階的切替も選択肢。要件 Req 7 は
    後者 (別名作成 + 旧削除) を明示。
- **Implications**:
  - デプロイ手順:
    (1) SagemakerStack を新 Async EndpointConfig + 新 Endpoint 名で更新
    (2) BatchExecutionStack を新 invoke 層バージョンで更新 (Task Role 差し替え)
    (3) API Lambda の `endpointName` context を新名へ切り替え
    (4) 旧 Endpoint を AWS CLI で手動削除 (`aws sagemaker delete-endpoint`)
    (5) 旧 EndpointConfig を削除 (`aws sagemaker delete-endpoint-config`)
  - Runbook `docs/runbooks/sagemaker-async-cutover.md` に手順・検証
    コマンド・ロールバック不能性を明記する (Req 11.2)。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| A: 上流 `yomitoku_client` を fork/拡張 | `_invoke_one` を Async 対応にサブクラス or monkeypatch | 既存 SCB/並列/リトライ流用 | upstream 依存・ページ単位 response 待ちは解決しない | gap-analysis で棄却済 |
| B: 完全自作 (invoke + parse 全て独自) | `yomitoku_client` 依存を完全撤廃 | ライブラリ契約変更への耐性 | 400-600 LOC 新規、parser/visualizer 再実装負担 | gap-analysis で棄却済 |
| **C: Hybrid (推奨)** | invoke 層のみ自作、parser/visualizer は流用 | 責務分割が明確・LOC 最小化 | SNS/SQS subscriber 実装・batch-runner の責務拡大 | **本設計で採用** |

## Design Decisions

### Decision D1: yomitoku-pro の Async 対応を PoC で確認する

- **Context**: Async Endpoint で yomitoku-pro コンテナが正常に起動・応答を
  返すかは未検証 (Marketplace 側のサポート明記なし)。
- **Alternatives Considered**:
  1. 設計フェーズで PoC せず、実装フェーズで検証 (手戻りリスク大)
  2. **設計フェーズで smoke PoC を実施してから実装 (採用)**
- **Selected Approach**: 1 ページの PDF を S3 PUT → `invoke_endpoint_async` →
  SQS 受信 → `OutputLocation` GetObject のフローを手動 (Boto3 スクリプト)
  で 1 回成功させてから実装タスクへ進む。
- **Rationale**: yomitoku-pro Marketplace モデルが Async に非対応だった場合、
  本仕様全体が頓挫する。最小コストで早期検出する。
- **Trade-offs**: PoC 1-2 日の工数を前倒し vs 手戻りリスクの回避
- **Follow-up**: PoC 結果 (成功/失敗、実応答 JSON スキーマ、cold-start 時間)
  を `docs/runbooks/sagemaker-async-cutover.md` の appendix に記録。

### Decision D2: SNS 通知サブスクライブは SQS pull 方式を採用

- **Context**: Req 3.2 で SNS 通知一択。batch-runner が完了を待つパターン
- **Alternatives Considered**:
  1. **SNS → SQS → batch-runner が ReceiveMessage (採用)**
  2. SNS → Lambda → DDB → batch-runner が DDB poll
  3. SNS → EventBridge → SFN callback
- **Selected Approach**: SNS `SuccessTopic` / `ErrorTopic` をそれぞれ単一 SQS
  Queue に Subscribe。batch-runner Fargate タスクは実行中、自分が投入した
  `InferenceId` 集合を保持し、SQS から届いたメッセージを突き合わせて
  完了検知する。他バッチのメッセージは VisibilityTimeout をゼロに戻して
  他 poller へ返す。
- **Rationale**: (1) Fargate 1 タスク内で完結し追加インフラ最小 (2) 既存
  Step Functions フロー (`RunBatchTask` 1 本) を崩さない (3) Lambda fan-out
  ほどの分散処理は不要。
- **Trade-offs**:
  - ✅ シンプル、追加 Lambda 不要
  - ❌ 共通 Queue の競合で他バッチメッセージの "触って戻す" オーバーヘッド
    (多くても 1-2 並行バッチのため許容)
- **Follow-up**: 並行バッチが 3 本以上になった場合、InferenceId をメッセージ
  属性に含めて SNS Subscription Filter Policy でバッチ専用 Queue にルーティング
  する拡張を検討 (現段階では Out of Scope)。

### Decision D3: `OrchestrationStack` の `endpoint-control` Lambda を撤去

- **Context**: Req 7 — Async + `MinCapacity=0` で Endpoint 手動起動/停止
  ロジックが不要になる
- **Alternatives Considered**:
  1. `endpoint-control` / `OrchestrationStack` を完全撤去 (採用)
  2. Lambda のみ残し、Async エンドポイント管理用 (例: cold-start 事前ウォーム)
     に流用
- **Selected Approach**: `OrchestrationStack` 全体を削除。`bin/app.ts` からも
  `orchestrationStack` を除去。`ApiStack` への `stateMachine` 配線も撤去
  (batches API のみに集約)。
- **Rationale**: Req 7.2 が CDK 上の旧 Endpoint 削除経路を要求しており、
  Async では `MinCapacity=0` で自動スケーリングされるため、Lambda 制御は
  不要かつ有害 (競合原因)。
- **Trade-offs**:
  - ✅ 4 ファイル以上のコード削除、責務縮小
  - ❌ ApiStack の `stateMachine` prop 取り扱いが必須変更 (orchestration
    stateMachine は撤去、batchExecutionStateMachine のみ残る)
- **Follow-up**: `check-legacy-refs.sh` の禁止語に
  `OrchestrationStack` / `endpoint-control` を追加 (Req 10.4 / 11.4)。

### Decision D4: SFN `EnsureEndpointInService` ループは撤去する

- **Context**: Realtime では `InService` 待ちが意味を持ったが、Async では
  Endpoint は常に `InService` (instance=0 でも "Running" 扱い) になる
- **Alternatives Considered**:
  1. **撤去 (採用)**
  2. `DescribeEndpoint` を 1 回だけ残して `EndpointStatus == InService` を
     fail-fast
- **Selected Approach**: 撤去。`RunBatchTask` に直接つなぐ。`DescribeEndpoint`
  の IAM 権限は Task Role から削除。
- **Rationale**: Async エンドポイントで `DescribeEndpoint` を叩いても状態が
  動的に変わらない (scale-in 中も `InService` 表示)。ノイズになるため削除。
- **Trade-offs**: 削除により SFN が簡素化、Task Role の IAM も減らせる。
- **Follow-up**: BatchExecutionStateMachine の定義変更に伴い、既存テスト
  `test/batch-execution-stack.test.ts` の `EnsureEndpointInService` 関連
  assertion を更新する。

### Decision D5: `MaxCapacity` デフォルト 1 の context キー名

- **Context**: Req 2.2 — `MaxCapacity` を context で上書き可能とする
- **Alternatives Considered**:
  1. **`asyncMaxCapacity` (採用)**
  2. `sagemakerMaxCapacity`
  3. `sagemakerAsyncMaxCapacity`
- **Selected Approach**: `asyncMaxCapacity` を context キーとして採用。
  `bin/app.ts` で `Number(app.node.tryGetContext("asyncMaxCapacity") ?? 1)`
  として解決し、`SagemakerStackProps` に渡す。
- **Rationale**: 本仕様の範囲は Async Inference 設定のみであり、名前を短く
  しても曖昧性がない。
- **Trade-offs**: 他仕様で別の MaxCapacity を定義する場合は衝突しうるが、
  現状そのような計画はない。
- **Follow-up**: `cdk.context.json` のデフォルトに追加しない (絶対値は
  明示上書き時のみ)。

### Decision D6: S3 prefix レイアウト

- **Context**: Req 1.2 / 4.5 / 5.5 — Async 専用 prefix を既存 `batches/`
  配下に追加
- **Alternatives Considered**:
  1. **`batches/_async/inputs/{batchJobId}/{fileName}` +
     `batches/_async/outputs/{batchJobId}/{inferenceId}.out` +
     `batches/_async/errors/{batchJobId}/{inferenceId}.err` (採用)**
  2. `batches/{batchJobId}/_async/{inputs,outputs,errors}/...`
     (per-batch 階層)
  3. `batches/_async/shared/...` (flat)
- **Selected Approach**: (1)。上位階層で Async/非 Async を分離、下位で
  batchJobId を組み込む。既存 API 契約が参照する `batches/{batchJobId}/input/`
  は維持し、Async 専用 S3 プレフィックスは `_async` アンダースコアで
  予約領域として区別する。
- **Rationale**: (1) IAM の絞り込みが容易 (`batches/_async/*` 1 行)、
  (2) 既存 API (`GET /batches/:id` のプレゼンド URL 発行) と prefix 衝突なし、
  (3) 削除 Runbook での「Async 関連のみクリーンアップ」操作が容易。
- **Trade-offs**: ユーザー向け公開の "batches" 名前空間内に内部アーティファクト
  が混在するが、`_async` prefix で明示区別。
- **Follow-up**: `lambda/api/` 側で `batches/_async/*` は API からは
  参照不可であることを念押し (Req 10.1)。

### Decision D7: デプロイ順序と CDK スタック依存

- **Context**: Req 7 — カットオーバーのステップを安全な順序で
- **Alternatives Considered**:
  1. **SagemakerStack → BatchExecutionStack → MonitoringStack → ApiStack の順 (採用)**
  2. 全スタック一括 `cdk deploy --all`
- **Selected Approach**: 明示順序デプロイ。Runbook で以下を強制:
  1. `cdk deploy SagemakerStack` (新 Async Endpoint が `InService` に変化)
  2. PoC スクリプトで Async 1 件 smoke test
  3. `cdk deploy BatchExecutionStack` (新 invoke 層で Fargate task 再作成)
  4. `cdk deploy MonitoringStack` (Async アラーム投入)
  5. `cdk deploy ApiStack` (もし endpointName 変更が API 側に伝搬するなら)
  6. 旧 Endpoint / Config を AWS CLI で手動削除 (CFN 外で削除済みを確認)
- **Rationale**: Async Endpoint 作成失敗時に batch-runner の切替を実行しない
  ためのセーフガード。
- **Trade-offs**: 一括デプロイより手順が多いが、本番影響のある変更
  (ml.g5.xlarge 確保) に対するリスク緩和。
- **Follow-up**: Runbook `sagemaker-async-cutover.md` に
  CLI 1 行ずつ記載 + 各ステップの verification command。

## Risks & Mitigations

- **R1 (High): yomitoku-pro Marketplace モデルの Async 非互換**
  → 設計フェーズで smoke PoC (D1) を必ず実施。非互換の場合は仕様全体を
  再検討 (Realtime 継続 + Auto Start/Stop 継続)。
- **R2 (Medium): Async cold-start が SLA 超過**
  → `MinCapacity=0` → `1` への scale-out 時間を実測。最悪 5-10 分の
  cold-start が許容できない業務要件であれば `MinCapacity=1` への
  フォールバックを `context` で可能にしておく (設計では要件優先で `0`)。
- **R3 (Medium): SNS メッセージ JSON 形式の不整合**
  → R3 PoC で実メッセージをキャプチャし、`InferenceId` 抽出ロジックの
  unit test を生データで固定化。
- **R4 (Low): `ap-northeast-1` GPU 確保失敗の再発**
  → `HasBacklogWithoutCapacity` アラーム (Req 6.2) で検出し、Runbook 判定
  基準 (Req 8.3: 1 週間で 3 回以上) で us-east-1 退避。
- **R5 (Low): Application Auto Scaling ライフサイクルの CFN 順序依存**
  → CDK で `addDependency` を明示 (`CfnScalableTarget.addDependsOn(endpoint)`,
  `CfnScalingPolicy.addDependsOn(target)`)。ユニットテストで CFN 順序を検証。

## References

- AWS SageMaker Developer Guide: [Asynchronous Inference](https://docs.aws.amazon.com/sagemaker/latest/dg/async-inference.html) — Async endpoint の挙動と制約
- AWS SageMaker API Reference: [InvokeEndpointAsync](https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_runtime_InvokeEndpointAsync.html) — 呼び出し契約
- AWS SageMaker API Reference: [AsyncInferenceConfig](https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_AsyncInferenceConfig.html) — EndpointConfig 設定
- AWS SageMaker: [Autoscale an asynchronous endpoint](https://docs.aws.amazon.com/sagemaker/latest/dg/async-inference-autoscale.html) — `ApproximateBacklogSizePerInstance` による scale-out パターン
- AWS CloudFormation: [`AWS::SageMaker::EndpointConfig`](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sagemaker-endpointconfig.html) — AsyncInferenceConfig 項目
- AWS CloudFormation: [`AWS::ApplicationAutoScaling::ScalableTarget`](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-applicationautoscaling-scalabletarget.html) — ScalableTarget for SageMaker
- 内部資料: `YomiToku-Pro_AWS構築検討.md` の「方式 B: Asynchronous Inference」節
- 既存 spec: `.kiro/specs/yomitoku-client-batch-migration/` — BatchTable /
  ControlTable / ProcessLog 契約の参照元
