# YomiToku-Pro AWS 実装タスク一覧

設計ドキュメント: [YomiToku-Pro_最終構成.md](./YomiToku-Pro_最終構成.md)

## 凡例

- `[ ]` 未着手
- `[~]` 作業中
- `[x]` 完了
- `P0` 前のタスクが完了してから着手（順序依存）
- `P1` 他のタスクと並行して着手可能

---

## フェーズ 0: 事前準備

- [ ] 0.1. AWS MarketplaceでYomiToku-Proをサブスクライブ（P0）
- [ ] 0.2. Model Package ARN を確認し記録する（ap-northeast-1）（P0）
- [ ] 0.3. yomitoku-client のバージョンを確認し requirements.txt に固定する（P1）
- [ ] 0.4. CDK プロジェクトを初期化する（P0）
  - [ ] 0.4.1. `npx cdk init app --language typescript`
  - [ ] 0.4.2. cdk.json に Model Package ARN、リージョン等のコンテキスト値を設定
  - [ ] 0.4.3. ディレクトリ構成を作成（lib/, lambda/processor/, lambda/endpoint-control/）
- [ ] 0.5. Biome をセットアップする（P0、0.4 完了後）
  - [ ] 0.5.1. `npm install --save-dev @biomejs/biome && npx biome init`
  - [ ] 0.5.2. biome.json を設定（indent: space/2、linter: recommended）
  - [ ] 0.5.3. package.json に lint / format スクリプトを追加
- [ ] 0.6. CDK Nag をセットアップする（P0、0.4 完了後）
  - [ ] 0.6.1. `npm install --save-dev cdk-nag`
  - [ ] 0.6.2. bin/app.ts に AwsSolutionsChecks を追加
- [ ] 0.7. Lambda テスト環境をセットアップする（P1）
  - [ ] 0.7.1. lambda/processor/tests/ ディレクトリを作成
  - [ ] 0.7.2. requirements-test.txt を作成（pytest, moto, pytest-asyncio）

_設計書参照: セクション 1, 8, 11, 12, 15_

---

## フェーズ 1: SageMaker スタック

- [ ] 1.1. SageMaker 実行用 IAM ロールを定義する（P0）
  - [ ] 1.1.1. SageMaker サービスプリンシパルの信頼ポリシー
  - [ ] 1.1.2. ECR イメージ取得、S3 アクセス等の必要権限

- [ ] 1.2. CfnModel を定義する（P0）
  - [ ] 1.2.1. modelPackageName に Marketplace の ARN を設定
  - [ ] 1.2.2. executionRoleArn に 1.1 のロールを設定

- [ ] 1.3. CfnEndpointConfig を定義する（P0）
  - [ ] 1.3.1. endpointConfigName を `yomitoku-pro-config` に設定
  - [ ] 1.3.2. productionVariants に ml.g5.xlarge / initialInstanceCount: 1 を設定

- [ ] 1.4. CDK Nag の指摘を確認し対応する（P0）
- [ ] 1.5. Biome で lint / format を実行し修正する（P0）
- [ ] 1.6. sagemaker-stack.ts として実装しデプロイ確認する（P0）

_設計書参照: セクション 8, 12_

---

## フェーズ 2: データストア・キュー（processing-stack）

- [ ] 2.1. S3 バケットを定義する（P1）
  - [ ] 2.1.1. バケット作成（パブリックアクセスブロック有効化）
  - [ ] 2.1.2. input/ プレフィックスへの ObjectCreated イベント通知を SQS に設定

- [ ] 2.2. SQS キューを定義する（P1）
  - [ ] 2.2.1. メインキュー（visibilityTimeout: 3600秒、messageRetentionPeriod: 14日、receiveMessageWaitTimeSeconds: 20秒）
  - [ ] 2.2.2. DLQ（maxReceiveCount: 3、messageRetentionPeriod: 14日）
  - [ ] 2.2.3. メインキューの deadLetterQueue に DLQ を設定

- [ ] 2.3. DynamoDB ステータステーブルを定義する（P1）
  - [ ] 2.3.1. テーブル作成（PK: file_key）
  - [ ] 2.3.2. GSI: status-created_at-index を追加

- [ ] 2.4. DynamoDB エンドポイント制御テーブルを定義する（P1）
  - [ ] 2.4.1. テーブル作成（PK: lock_key）

- [ ] 2.5. CDK Nag の指摘を確認し対応する（P0）
- [ ] 2.6. Biome で lint / format を実行し修正する（P0）
- [ ] 2.7. processing-stack.ts としてまとめ、デプロイ確認する（P0）

_設計書参照: セクション 3, 5, 6, 12_

---

## フェーズ 3: 処理ワーカー Lambda

- [ ] 3.1. Lambda コンテナイメージを作成する（P0）
  - [ ] 3.1.1. Dockerfile を作成（ベース: public.ecr.aws/lambda/python:3.12）
  - [ ] 3.1.2. requirements.txt を作成（yomitoku-client のバージョン固定）
  - [ ] 3.1.3. ローカルで docker build が成功することを確認

- [ ] 3.2. 処理ワーカー Lambda のテストを作成する（TDD: テストを先に書く）（P0）
  - [ ] 3.2.1. test_handler.py: SQS メッセージパースのテスト（直接 / SNS経由の各形式）
  - [ ] 3.2.2. test_process_file.py: DynamoDB 条件付き更新のテスト（冪等性: 成功ケース + 重複スキップ）
  - [ ] 3.2.3. test_process_file.py: S3 ダウンロード/アップロードのテスト（moto）
  - [ ] 3.2.4. test_process_file.py: yomitoku-client 呼び出しのテスト（モック: 正常系 + 異常系）
  - [ ] 3.2.5. test_process_file.py: 例外時の FAILED 更新と例外再送出のテスト
  - [ ] 3.2.6. test_process_file.py: /tmp ファイルの後始末テスト（正常系/異常系）

- [ ] 3.3. テストを通す処理ワーカー Lambda のコードを実装する（TDD: テストが通る最小限の実装）（P0）
  - [ ] 3.3.1. SQS メッセージから S3 オブジェクトキーを取得する処理
  - [ ] 3.3.2. DynamoDB 条件付き更新による冪等性確保（PENDING → PROCESSING）
  - [ ] 3.3.3. S3 から PDF を /tmp にダウンロード
  - [ ] 3.3.4. YomitokuClient.analyze_async() による OCR 処理
  - [ ] 3.3.5. parse_pydantic_model() + to_json() で結果を S3 output/ に保存
  - [ ] 3.3.6. DynamoDB ステータスを COMPLETED に更新
  - [ ] 3.3.7. 例外時に FAILED 更新と例外再送出（SQS リトライのため）
  - [ ] 3.3.8. /tmp ファイルの後始末（finally）
  - [ ] 3.3.9. 全テストが通ることを確認（pytest tests/ -v）

- [ ] 3.4. CDK で DockerImageFunction を定義する（P0）
  - [ ] 3.4.1. memorySize: 2048、timeout: 10分、reservedConcurrentExecutions: 4
  - [ ] 3.4.2. 環境変数（ENDPOINT_NAME, BUCKET_NAME, STATUS_TABLE_NAME）
  - [ ] 3.4.3. SQS Event Source Mapping（batchSize: 1, reportBatchItemFailures: true）

- [ ] 3.5. IAM 権限を付与する（P0）
  - [ ] 3.5.1. S3 input/ の読み取り権限
  - [ ] 3.5.2. S3 output/ の書き込み権限
  - [ ] 3.5.3. DynamoDB ステータステーブルの読み書き権限
  - [ ] 3.5.4. SQS メインキューの消費権限
  - [ ] 3.5.5. sagemaker:InvokeEndpoint 権限（エンドポイント ARN 指定）

- [ ] 3.6. CDK Nag の指摘を確認し対応する（P0）
  - [ ] 3.6.1. `npx cdk synth` で CDK Nag の指摘を確認
  - [ ] 3.6.2. 対応が必要な指摘を修正
  - [ ] 3.6.3. 対応しない指摘は NagSuppressions で抑制し理由を記録

- [ ] 3.7. Biome で lint / format を実行し修正する（P0）

- [ ] 3.8. processing-stack.ts に Lambda 定義を追加し、デプロイ確認する（P0）

_設計書参照: セクション 4.3, 7, 9, 10, 12_

---

## フェーズ 4: エンドポイント制御（orchestration-stack）

- [ ] 4.1. エンドポイント制御用 Lambda を実装する（P0）
  - [ ] 4.1.1. create_endpoint: CreateEndpoint API 呼び出し
  - [ ] 4.1.2. delete_endpoint: DeleteEndpoint API 呼び出し
  - [ ] 4.1.3. check_endpoint_status: DescribeEndpoint API 呼び出し（NotFound 対応含む）
  - [ ] 4.1.4. check_queue_status: SQS GetQueueAttributes（Messages + MessagesNotVisible）
  - [ ] 4.1.5. acquire_lock / release_lock: DynamoDB 条件付き更新による排他制御

- [ ] 4.2. Step Functions ステートマシンを定義する（P0）
  - [ ] 4.2.1. ロック取得ステップ（失敗時は終了）
  - [ ] 4.2.2. DescribeEndpoint による状態分岐（InService / Creating / NotFound）
  - [ ] 4.2.3. CreateEndpoint ステップ
  - [ ] 4.2.4. Wait + DescribeEndpoint の待機ループ（最大20回）
  - [ ] 4.2.5. SQS キュー空判定ループ（Messages + MessagesNotVisible）
  - [ ] 4.2.6. クールダウン Wait（15分）
  - [ ] 4.2.7. 再確認後の DeleteEndpoint ステップ
  - [ ] 4.2.8. ロック解放ステップ
  - [ ] 4.2.9. エラーハンドリング（失敗時もロック解放する）

- [ ] 4.3. EventBridge Pipes を定義する（P0）
  - [ ] 4.3.1. ソース: SQS メインキュー
  - [ ] 4.3.2. ターゲット: Step Functions ステートマシン
  - [ ] 4.3.3. Pipes 用 IAM ロール（SQS 読み取り + Step Functions 起動）

- [ ] 4.4. エンドポイント制御用 IAM 権限を付与する（P0）
  - [ ] 4.4.1. sagemaker:CreateEndpoint / DeleteEndpoint / DescribeEndpoint
  - [ ] 4.4.2. DynamoDB エンドポイント制御テーブルの読み書き権限
  - [ ] 4.4.3. SQS GetQueueAttributes 権限

- [ ] 4.5. CDK Nag の指摘を確認し対応する（P0）
- [ ] 4.6. Biome で lint / format を実行し修正する（P0）
- [ ] 4.7. orchestration-stack.ts として実装しデプロイ確認する（P0）

_設計書参照: セクション 4.2, 5.2, 12_

---

## フェーズ 5: 監視（monitoring-stack）

- [ ] 5.1. CloudWatch Alarm を定義する（P1）
  - [ ] 5.1.1. SQS ApproximateAgeOfOldestMessage > 30分
  - [ ] 5.1.2. SQS ApproximateNumberOfMessagesVisible > 100
  - [ ] 5.1.3. DLQ ApproximateNumberOfMessagesVisible > 0
  - [ ] 5.1.4. Lambda Errors > 0
  - [ ] 5.1.5. Lambda Duration > 480秒

- [ ] 5.2. SNS トピックを作成しアラーム通知先を設定する（P1）

- [ ] 5.3. CDK Nag の指摘を確認し対応する（P0）
- [ ] 5.4. Biome で lint / format を実行し修正する（P0）
- [ ] 5.5. monitoring-stack.ts として実装しデプロイ確認する（P0）

_設計書参照: セクション 13, 12_

---

## フェーズ 6: 結合テスト・動作確認

- [ ] 6.1. エンドポイント単体の動作確認（P0）
  - [ ] 6.1.1. AWS コンソールからエンドポイントを手動作成し InService になることを確認
  - [ ] 6.1.2. boto3 で invoke_endpoint を直接呼び出し、OCR 結果が返ることを確認
  - [ ] 6.1.3. エンドポイントを手動削除

- [ ] 6.2. 処理ワーカー Lambda の単体確認（P0）
  - [ ] 6.2.1. エンドポイントを手動起動した状態で S3 に PDF をアップロード
  - [ ] 6.2.2. SQS にメッセージが投入されることを確認
  - [ ] 6.2.3. Lambda が起動し DynamoDB が PROCESSING → COMPLETED に遷移することを確認
  - [ ] 6.2.4. S3 output/ に JSON が保存されることを確認
  - [ ] 6.2.5. 不正ファイルで FAILED → DLQ 移動を確認

- [ ] 6.3. Step Functions によるエンドポイント制御の確認（P0）
  - [ ] 6.3.1. エンドポイント未起動の状態で S3 に PDF をアップロード
  - [ ] 6.3.2. Step Functions がエンドポイントを自動作成することを確認
  - [ ] 6.3.3. 処理完了後、クールダウン経過後にエンドポイントが自動削除されることを確認
  - [ ] 6.3.4. DynamoDB の endpoint_state が IDLE に戻ることを確認

- [ ] 6.4. 冪等性・排他制御の確認（P0）
  - [ ] 6.4.1. 同一ファイルの重複処理が発生しないことを確認（DynamoDB 条件付き更新）
  - [ ] 6.4.2. 複数の Step Functions 実行が同時にエンドポイントを操作しないことを確認

- [ ] 6.5. 複数ファイルの連続処理テスト（P0）
  - [ ] 6.5.1. 5-10件の PDF を一括アップロード
  - [ ] 6.5.2. 全件が COMPLETED になることを確認
  - [ ] 6.5.3. 処理時間、ページ数が DynamoDB に記録されていることを確認

_設計書参照: セクション 4, 14_

---

## 依存関係

```
フェーズ 0（事前準備）
  |
  +---> フェーズ 1（SageMaker スタック）
  |       |
  |       v
  +---> フェーズ 2（データストア・キュー） ---+
          |                                   |
          v                                   v
        フェーズ 3（処理ワーカー Lambda） --> フェーズ 4（エンドポイント制御）
          |                                   |
          +-----------------------------------+
          |
          v
        フェーズ 5（監視） --- P1、フェーズ 2 以降いつでも着手可
          |
          v
        フェーズ 6（結合テスト）
```

- フェーズ 1, 2 はフェーズ 0 完了後に並行着手可能
- フェーズ 3 はフェーズ 1, 2 の完了が必要（SageMaker リソース名、テーブル名等の参照）
- フェーズ 4 はフェーズ 2, 3 の完了が必要（SQS、Lambda、DynamoDB の参照）
- フェーズ 5 はフェーズ 2 以降であればいつでも着手可能（P1）
- フェーズ 6 は全フェーズの完了が必要

---

## 初期実装に含めないもの（参考）

以下は初期実装のスコープ外。詳細は [最終構成 セクション1](./YomiToku-Pro_最終構成.md) を参照。

| 項目 | 追加タイミング |
|---|---|
| 出力形式変換（MD/HTML/CSV/PDF） | JSON以外の要望時 |
| CloudWatch Dashboard | 運用開始後1-2週間 |
| VPC エンドポイント | セキュリティ要件追加時 |
| 画像ファイル直接入力 | PDF以外の要望時 |
| ページ数上限 | 大量ページPDF運用時 |
| ECS Fargate ワーカー | Lambda制限抵触時 |
| 方式B/C 実機検証 | サブスクリプション後 |
| 処理結果通知（SNS等） | 通知要望時 |
| API Gateway / フロントエンド | UI要望時 |
| マルチリージョン | DR要件時 |
