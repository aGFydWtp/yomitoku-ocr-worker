# Requirements Document

## Project Description (Input)
c案のspecを立てたい

(背景: 現行アーキテクチャが常時稼働の SageMaker Realtime Endpoint を利用しており、
(1) ap-northeast-1 で過去に `ml.g5.xlarge` の GPU キャパシティを確保できず us-east-1
へ逃がした実績、(2) アイドル時間帯も GPU が課金される問題の 2 点が残存している。
これを SageMaker Asynchronous Inference へ置換して解消するための仕様化を C 案と呼ぶ。)

## Introduction

本仕様は、現行 `SagemakerStack` が提供する **SageMaker Realtime Endpoint**
(`ml.g5.xlarge` / `initialInstanceCount=1` 固定・常時稼働) を、
**SageMaker Asynchronous Inference Endpoint** へ全面的に置換することを目的とする。

Asynchronous Inference は、推論リクエストを SageMaker が内部キューに入れ、
バックエンドインスタンスを `0 → N → 0` へ自動スケールさせ、推論結果を S3 の
`OutputLocation` に書き戻すモデルであり、バッチ用途と親和性が高い。これにより:

- **アイドル時 GPU 課金ゼロ**: バックログが無い時に Auto Scaling で `0` 台へ縮退
- **GPU キャパシティ競合の緩和**: 必要な時だけ GPU を確保するため、常時専有に
  比べて確保失敗の頻度が下がる (完全回避ではない)
- **長時間推論のサポート**: Realtime の 60 秒応答制限から、Async の 1 時間までの
  推論時間に拡張される (yomitoku-pro の大規模 PDF 推論に有利)

呼び出し側 (`lambda/batch-runner` → `yomitoku-client.analyze_batch_async`) は
現行 Realtime 前提の `InvokeEndpoint` 同期呼び出しを行っているため、
`InvokeEndpointAsync` + S3 `OutputLocation` ポーリング (もしくは SNS 通知待ち)
モデルに適合させる必要がある。`BatchExecutionStack` の Step Functions
フロー、IAM、監視メトリクスも同様に置換する。

後方互換 (Realtime endpoint を同時に残す) は**維持しない**。本仕様のデプロイ後は
Asynchronous Inference Endpoint のみが唯一の推論経路となる。

## Boundary Context

- **In scope**:
  - `SagemakerStack` の `CfnEndpointConfig` に `AsyncInferenceConfig` を追加し、
    S3 出力先・失敗通知先・最大同時 invocation・最大実行時間を定義する
  - `ProductionVariant.initialInstanceCount` を `0` へ変更し、
    Application Auto Scaling で `0 ↔ N` のスケーリングを構成する
  - `lambda/batch-runner` (および依存する `yomitoku-client` の呼び出し様式) を、
    Async 呼び出し (`InvokeEndpointAsync` + S3 入力 + **SNS 通知による完了検知**)
    モデルに適合 (S3 ポーリング方式は採用しない)
  - `BatchExecutionStack` の Step Functions / IAM / CloudWatch メトリクスを、
    Async エンドポイント向けに置換 (`EnsureEndpointInService` の廃止 or 再定義、
    `DescribeEndpoint` の意味変更、`ApproximateBacklogSizePerInstance` ベースの
    監視追加)
  - S3 バケットの batches prefix 配下に Async 用の `input/` / `output/` / `error/`
    を配置し、IAM 権限を最小化する
  - `MonitoringStack` の CloudWatch アラームを Async 用メトリクスに更新する
  - OpenAPI / README / Runbook / 設計資料の Realtime 前提記述を Async 前提に更新する

- **Out of scope**:
  - SageMaker インスタンスタイプそのものの選定変更 (`ml.g5.xlarge` を維持)
  - yomitoku-pro モデルパッケージ本体の変更・バージョンアップ
  - API Lambda (Hono) 側の公開契約変更 (バッチ API のエンドポイント・レスポンス形
    は本仕様で変更しない)
  - リアルタイム推論 API の新規提供 (バッチ API のみが唯一の公開面であることは
    維持)
  - `yomitoku-client` 本体 (MLism-Inc/yomitoku-client) への機能追加 PR
    (必要ならサイドカー層・ラッパーを本リポジトリ内に実装する)
  - `yomitoku-client-batch-migration` 仕様が規定した外部 API の破壊的変更

- **Adjacent expectations**:
  - `yomitoku-client-batch-migration` 仕様が定義する `BatchTable` / `ControlTable`
    / `ProcessLog` の構造・ファイル単位ステータス契約は維持される
  - Fargate `batch-runner` の Step Functions 起動トリガ (`RunBatchTask`) とタスク
    タイムアウト (7200 秒) 方針は維持する
  - 旧 `StatusTable` / 旧 `/jobs` API は既に撤去済み (Task 1.1 / 6.4) であり、
    本仕様はその撤去状態を前提とする
  - 既存 `MonitoringStack` のダッシュボード構成・SNS 通知経路は維持し、
    表示メトリクスだけを置換する

## Requirements

### Requirement 1: Realtime Endpoint 廃止と Async Endpoint 一本化
**Objective:** As a 運用者, I want 現行の SageMaker Realtime Endpoint を廃止して
Asynchronous Inference Endpoint のみに一本化したい, so that アイドル時 GPU 課金
ゼロ方針を満たしつつ、推論経路の二重運用を防げる

#### Acceptance Criteria
1. The SagemakerStack shall 現行 `CfnEndpointConfig` の
   `ProductionVariant.initialInstanceCount=1` 構成を削除し、
   `initialInstanceCount=0` + Application Auto Scaling による
   `0 ↔ MaxCapacity` スケーリング構成を唯一の Endpoint 定義として提供する
2. The SagemakerStack shall `CfnEndpointConfig.AsyncInferenceConfig` を有効化し、
   `OutputConfig.S3OutputPath` と `OutputConfig.S3FailurePath` を
   `batches/` prefix 配下の専用 Async prefix (例: `batches/_async/output/`
   および `batches/_async/error/`) に配線する
3. If デプロイ後に Realtime モードの `ProductionVariant` が残存した場合,
   then CI / cdk-nag / ユニットテストのいずれかが失敗し、マージを阻止する
4. The SagemakerStack shall 旧 Realtime 専用の `EnsureEndpointInService` 型の
   事前起動シグナル・Auto Start トリガを廃止し、Async の内蔵キューに委ねる
5. The SagemakerStack shall Endpoint 名 (context `endpointName`) と
   `EndpointConfig` 名 (context `endpointConfigName`) の受け渡し契約は維持する
   一方で、新 EndpointConfig は旧名と**必ず別名**になるよう命名し、
   CloudFormation 更新時の同名上書きによるダウンタイム・衝突を回避する

### Requirement 2: Auto Scaling による `0 ↔ N` 運用
**Objective:** As a 運用者, I want アイドル時に GPU インスタンスが 0 台へ縮退し、
バックログ発生時に自動的にスケールアウトしてほしい, so that GPU コストを
最小化しつつ、バッチ投入時のレイテンシを許容範囲に抑えられる

#### Acceptance Criteria
1. The SagemakerStack shall Application Auto Scaling Target を
   `SageMakerVariantInvocationsPerInstance` ではなく
   `ApproximateBacklogSizePerInstance` (Async 専用のマネージドメトリクス) を
   指標とする Target Tracking Scaling Policy として構成する
2. The SagemakerStack shall `MinCapacity=0`, `MaxCapacity` を context 経由で
   設定可能な運用パラメータ (デフォルト `1`) として公開する
3. When バックログが一定時間 (デフォルト 15 分) ゼロである状態が継続した場合,
   the SagemakerStack shall scale-in alarm により ProductionVariant を 0 台へ
   縮退させる
4. When 新規 Async invocation が投入され、バックログが閾値を超過した場合,
   the SagemakerStack shall scale-out alarm により ProductionVariant を
   MinCapacity=0 から 1 台以上へ起動させる
5. The SagemakerStack shall Auto Scaling 用 IAM ロール (例:
   `AWSServiceRoleForApplicationAutoScaling_SageMakerEndpoint`) への依存関係を
   CDK 上で明示し、デプロイ手順として事前作成不要であることを保証する

### Requirement 3: 呼び出し様式を `InvokeEndpointAsync` + S3 出力待ちへ置換
**Objective:** As a 開発者, I want batch-runner が Async エンドポイント経由で
推論できるようにしたい, so that Realtime 前提の 60 秒タイムアウト制約と
同期レイテンシから解放され、大容量 PDF でも安定処理できる

#### Acceptance Criteria
1. The Batch Runner shall 各ファイルの推論リクエストを、S3 上の入力オブジェクト
   キーを `InputLocation` として `InvokeEndpointAsync` で送信し、`InferenceId`
   を取得する方式に変更する
2. The Batch Runner shall 推論完了の検知を、SageMaker Async の
   `NotificationConfig.SuccessTopic` / `ErrorTopic` への SNS 通知購読方式で実装し、
   S3 `OutputLocation` ポーリング方式は採用しない (SNS 通知一択)
3. The Batch Runner shall 1 ファイル 1 推論ではなく、yomitoku-client の
   `analyze_batch_async` が要求するページ単位並列を、Async invocation の複数
   同時発行と `ApproximateBacklogSize` を指標とした背圧制御で実現する
4. If `InvokeEndpointAsync` が同期時点で 4xx (`ValidationException` 等) を返した
   場合, then the Batch Runner shall 当該ファイルを即時失敗扱いとし、リトライ
   せずに ProcessLog へ記録する
5. If 推論結果 S3 オブジェクトが `MaxConcurrentInvocationsPerInstance` や
   `InvocationTimeoutSeconds` に由来するタイムアウトで失敗した場合, then
   the Batch Runner shall `S3FailurePath` 配下のエラーオブジェクトを取得し、
   理由を `process_log.jsonl` の `error` フィールドへ記録する
6. The Batch Runner shall 旧 Realtime 向けの `yomitoku-client` 呼び出し経路
   (同期 `InvokeEndpoint`) を**コードから削除**し、フォールバックとしても残さない

### Requirement 4: AsyncInferenceConfig の運用パラメータ
**Objective:** As a 運用者, I want Async 特有の運用パラメータ
(`MaxConcurrentInvocationsPerInstance` / `InvocationTimeoutSeconds` /
`NotificationConfig`) を明示的に制御したい, so that SLA とキャパシティ計画を
確実に満たせる

#### Acceptance Criteria
1. The SagemakerStack shall `AsyncInferenceConfig.ClientConfig
   .MaxConcurrentInvocationsPerInstance` を context 経由で設定可能とし、
   デフォルト値を yomitoku-pro の推奨値または実測に基づく安全値として文書化する
2. The SagemakerStack shall `AsyncInferenceConfig.OutputConfig.NotificationConfig`
   の `SuccessTopic` / `ErrorTopic` を **SNS Topic として必ず新設**し (再利用不可)、
   SuccessTopic は Batch Runner の完了検知経路として、ErrorTopic は
   Dead Letter 相当の失敗通知経路として 1 つずつ必ず配線する
   (通知経路の欠落は許容しない)
3. The SagemakerStack shall 推論 1 件あたりの最大実行時間を、yomitoku-pro
   バッチ処理の想定最大時間 (既定: 3600 秒) 以内で構成する
4. If `AsyncInferenceConfig` に必須パラメータが欠落した状態で CDK synth が
   実行された場合, then CDK は synth 時点でエラーとし、デプロイへ到達させない
5. The SagemakerStack shall `S3OutputPath` / `S3FailurePath` が処理バケット
   (`batches/` 配下) 以外を指した場合にユニットテストで検出できるよう、
   パス検証のテストを提供する

### Requirement 5: IAM 最小権限と S3 レイアウト整合
**Objective:** As a セキュリティ担当, I want Async 関連の IAM 権限を最小範囲に
限定したい, so that 運用中の権限拡張・誤アクセスのリスクを抑えられる

#### Acceptance Criteria
1. The SagemakerStack shall SageMaker 実行ロールに、`S3OutputPath` / `S3FailurePath`
   / `InputLocation` として利用する prefix への `s3:GetObject` /
   `s3:PutObject` のみを付与し、バケット全域への `s3:*` 付与を禁止する
2. The BatchExecutionStack (Fargate Task Role) shall `sagemaker:InvokeEndpointAsync`
   権限を対象 Endpoint ARN 限定で付与し、`sagemaker:InvokeEndpoint`
   (Realtime) の権限は削除する
3. The SagemakerStack shall SNS `SuccessTopic` / `ErrorTopic` の `Publish` 権限を
   SageMaker サービスプリンシパルに限定し、他アカウント・他サービスへの
   Subscribe は IAM で明示拒否可能な構成とする
4. If CDK synth で `sagemaker:InvokeEndpoint` (Realtime) 権限が Fargate Task
   Role 等に残存した場合, then ユニットテストが失敗する
5. The BatchExecutionStack shall S3 `batches/*` prefix への既存 Task Role 権限と、
   Async 用 `batches/_async/*` prefix 追加権限を重複なく・穴なく配線する
   (IAM ポリシー差分をレビュー可能な形で設計書に記録する)

### Requirement 6: 監視メトリクスとアラームの刷新
**Objective:** As a 運用者, I want Async 特有のメトリクスで可観測性を確保したい,
so that Realtime 前提のメトリクスに依存せず、Async エンドポイントの健全性・
スループット・失敗状況を把握できる

#### Acceptance Criteria
1. The MonitoringStack shall 以下の Async 専用 CloudWatch メトリクスを
   ダッシュボードに表示する: `ApproximateBacklogSize`,
   `ApproximateBacklogSizePerInstance`, `HasBacklogWithoutCapacity`,
   `ApproximateAgeOfOldestRequest`, `InvocationsProcesssedPerInstance`
2. The MonitoringStack shall `HasBacklogWithoutCapacity` が 1 を
   継続 (例: 5 分) 超過した場合に SNS アラート通知するアラームを持つ
3. The MonitoringStack shall `ApproximateAgeOfOldestRequest` が運用上限
   (例: 1800 秒) を超過した場合に SNS アラート通知するアラームを持つ
4. If MonitoringStack に Realtime 前提の `Invocations` / `ModelLatency` /
   `OverheadLatency` アラームが残存した場合, then マージ前テストで検出し
   マージを阻止する (更新または削除を強制する)
5. The BatchExecutionStack shall バッチ実行中の集計メトリクス
   (成功件数・失敗件数・累計ページ数) と、Async 特有メトリクス
   (バックログ待ち時間・エラー通知数) を、同一ダッシュボードで参照可能にする

### Requirement 7: カットオーバー戦略と旧 Endpoint の確実な除去
**Objective:** As a 運用者, I want 旧 Realtime Endpoint を確実に削除したい,
so that 常時稼働 GPU が AWS 側で残存し続けて課金される事故を防げる

#### Acceptance Criteria
1. The SagemakerStack shall CDK 上の旧 Realtime `EndpointConfig` 定義を
   撤去し、新 Async `EndpointConfig` のみを残す
2. The YomiToku OCR Worker shall 旧 Endpoint (`CfnEndpoint`) のリソースを
   CDK 上で新名称に切り替えることで、CloudFormation による旧 Endpoint 削除が
   デプロイの一環として実行される経路を提供する
3. If 旧 Endpoint が `RETAIN` 相当の removalPolicy でオーファン化した場合,
   then 手動削除 Runbook を `docs/runbooks/` 配下に提供し、`aws sagemaker
   delete-endpoint` / `delete-endpoint-config` の手順・確認コマンドを記載する
4. The YomiToku OCR Worker shall カットオーバー完了を、以下の 2 条件を満たすこと
   で定義する: (a) 新 Endpoint が `InService` になり Async invocation が成功する,
   (b) 旧 Endpoint と旧 EndpointConfig が AWS アカウントから削除されている
5. While カットオーバー中, the YomiToku OCR Worker shall バッチ API への新規
   投入を一時停止するための運用手順 (例: `/batches` への 503 返却) を
   Runbook で提供する

### Requirement 8: リージョン戦略 (ap-northeast-1 デフォルト)
**Objective:** As a 運用者, I want Async 化により GPU 常時確保から「呼び出し時のみ
確保」へ運用モデルを切り替えた上で、ap-northeast-1 をデフォルトリージョンとして
採用したい, so that データレジデンシ・レイテンシ面で国内ユーザーに最適化しつつ、
us-east-1 回避策からの復帰を果たせる

#### Acceptance Criteria
1. The YomiToku OCR Worker shall デプロイ時の `-c region` 既定値を
   `ap-northeast-1` とし、us-east-1 を含むその他リージョンは context 明示指定時
   のみ選択可能とする (既定値の変更は行わない)
2. The SagemakerStack shall Auto Scaling の `MinCapacity=0` により
   「呼び出し時のみ GPU 確保」運用を ap-northeast-1 で成立させることを前提と
   し、実測手順と成立条件 (例: 1 日あたりの scale-out 成功率 95%+) を設計書に
   記載する
3. If ap-northeast-1 で Async の scale-out (`0 → 1`) が `InsufficientCapacity`
   エラーを一定頻度 (例: 1 週間で 3 回) 以上で返す場合, then 運用者は
   `-c region=us-east-1` デプロイへ一時退避する判断を、Runbook の判定基準に
   基づき行うことができる (ただしこれは例外対応であり、既定構成はあくまで
   ap-northeast-1 に戻すことを前提とする)
4. The YomiToku OCR Worker shall リージョンデフォルトが ap-northeast-1 である
   ことを README / `bin/app.ts` のコメント / 設計書で整合的に明記し、過去
   us-east-1 で運用していた周辺リソース (S3 / DynamoDB 等) がリージョン間で
   分離されないよう Async 移行時の棚卸しを行う

### Requirement 9: コスト削減の事前見積りと実測検証
**Objective:** As a 運用者, I want Realtime → Async 置換のコスト削減効果を
数値で約束したい, so that 経営・予算観点のレビューを通せる

#### Acceptance Criteria
1. The YomiToku OCR Worker shall 設計書の中で、Realtime (`ml.g5.xlarge` × 24h ×
   30 日) の月次固定費と、Async 想定稼働率 (例: ジョブ集中 4h/日 × 20 日/月)
   ベースの月次推定コストの比較表を提供する
2. The MonitoringStack shall AWS Cost Explorer タグ (例:
   `yomitoku:stack=sagemaker-async`) を付与し、リソース単位のコスト按分が
   可能なタグ戦略を定義する
3. When 移行完了後 1 か月が経過した場合, the 運用者 shall 実測 GPU 時間数と
   月次コストを `docs/runbooks/` 配下の記録として残し、事前見積りとの乖離を
   記録する (本仕様は記録フォーマットの提供までを範囲とする)
4. If 実測コストが事前見積り上限を 20% 超過した場合, then the 運用者 shall
   `MaxCapacity` 低減・`InvocationTimeoutSeconds` 短縮・バッチ集約運用のいずれか
   で是正する手順を Runbook から参照できる

### Requirement 10: 既存 `yomitoku-client-batch-migration` 仕様との整合
**Objective:** As a 開発者, I want 既存バッチ仕様の公開契約・データモデルを
壊さずに Async 化したい, so that API 利用者・運用者のワークフローに影響を
与えない

#### Acceptance Criteria
1. The YomiToku OCR Worker shall 公開バッチ API (`/batches` 系) のパス・
   リクエスト/レスポンススキーマ・HTTP ステータスコードを、本仕様の実装前後で
   互換に保つ
2. The YomiToku OCR Worker shall `BatchTable` / `ControlTable` / `ProcessLog`
   の属性構造・PK/SK・GSI を本仕様で変更しない
3. The YomiToku OCR Worker shall `yomitoku-client-batch-migration` 仕様の
   Task 1.1 で撤去済みの `StatusTable` / `/jobs` 系リソースを、本仕様の
   過程で再導入しない
4. If 既存 `check-legacy-refs.sh` で禁止されている旧参照パターンを本仕様の
   実装が再導入した場合, then CI が失敗し、マージを阻止する
5. The YomiToku OCR Worker shall 本仕様の変更箇所を、既存仕様 (`requirements.md`
   / `design.md`) と diff が追える形 (仕様書の補章 or 相互参照) で記録する

### Requirement 11: 監査可能性と運用ドキュメント
**Objective:** As a 運用者, I want Async 化の判断根拠・運用手順を後から追える
ようにしたい, so that 次世代移行時のレビュー材料を揃えられる

#### Acceptance Criteria
1. The YomiToku OCR Worker shall 本仕様の design.md に、Realtime → Async 選定
   理由 (キャパシティ / コスト / レイテンシのトレードオフ)、Auto Scaling
   パラメータの決定根拠、呼び出し契約の変更ポイントを明記する
2. The YomiToku OCR Worker shall `docs/runbooks/sagemaker-async-cutover.md` を
   新設し、デプロイ順序・旧 Endpoint 削除手順・ロールバック不能性を記載する
3. The YomiToku OCR Worker shall Async 固有のトラブルシュート項目 (S3 出力が
   来ない / `HasBacklogWithoutCapacity` が解消しない / scale-out が遅延する) を
   Runbook に含める
4. If `scripts/check-legacy-refs.sh` の禁止語リストに Realtime 特有の API 名
   (`InvokeEndpoint` の Realtime 呼び出し箇所など) を追加する判断に至った場合,
   then 該当変更を本仕様のタスクとして明示する
5. The YomiToku OCR Worker shall 仕様実装完了のエビデンスとして、pnpm test /
   pnpm lint / cdk synth / cdk deploy --all のすべてがグリーンであることを
   PR テンプレートで要求する
