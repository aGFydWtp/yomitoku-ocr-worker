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

- [x] 0.1. AWS MarketplaceでYomiToku-Proをサブスクライブ（P0）
- [x] 0.2. Model Package ARN を確認し記録する（ap-northeast-1）（P0）
  - `cdk.context.json` に記録済み（リポジトリ公開のため ARN はコミットしない）
- [x] 0.3. yomitoku-client のバージョンを確認し requirements.txt に固定する（P1）
  - 最新バージョン: **0.2.0** (2026-03-02)
  - Python 対応: 3.10, 3.11, 3.12 (< 3.13)
  - Lambda ベースイメージ: `public.ecr.aws/lambda/python:3.12`
  - requirements.txt は 0.4 の CDK プロジェクト初期化後に `lambda/processor/requirements.txt` として作成する
- [x] 0.4. CDK プロジェクトを初期化する（P0）
  - [x] 0.4.1. `npx cdk init app --language typescript`（pnpm 使用）
  - [x] 0.4.2. cdk.json に Model Package ARN、リージョン等のコンテキスト値を設定
  - [x] 0.4.3. ディレクトリ構成を作成（lib/, lambda/processor/, lambda/endpoint-control/）
  - requirements.txt を `lambda/processor/requirements.txt` に作成済み（yomitoku-client==0.2.0）
- [x] 0.5. Biome をセットアップする（P0、0.4 完了後）
  - [x] 0.5.1. `pnpm add -D @biomejs/biome && npx biome init`（Biome 2.4.4）
  - [x] 0.5.2. biome.json を設定（indent: space/2、linter: recommended、quoteStyle: double）
  - [x] 0.5.3. package.json に lint / lint:fix / format スクリプトを追加
- [x] 0.6. CDK Nag をセットアップする（P0、0.4 完了後）
  - [x] 0.6.1. `pnpm add -D cdk-nag`（cdk-nag 2.37.55）
  - [x] 0.6.2. bin/app.ts に AwsSolutionsChecks を追加
- [x] 0.7. Lambda テスト環境をセットアップする（P1）
  - [x] 0.7.1. lambda/processor/tests/ ディレクトリを作成（`__init__.py` 含む）
  - [x] 0.7.2. requirements-test.txt を作成（pytest>=8, moto[s3,sqs,dynamodb]>=5, pytest-asyncio>=0.24）

_設計書参照: セクション 1, 8, 11, 12, 15_

---

## フェーズ 1: SageMaker スタック

- [x] 1.1. SageMaker 実行用 IAM ロールを定義する（P0）
  - [x] 1.1.1. SageMaker サービスプリンシパルの信頼ポリシー
  - [x] 1.1.2. ECR イメージ取得、S3 アクセス等の必要権限

- [x] 1.2. CfnModel を定義する（P0）
  - [x] 1.2.1. modelPackageName に Marketplace の ARN を設定
  - [x] 1.2.2. executionRoleArn に 1.1 のロールを設定

- [x] 1.3. CfnEndpointConfig を定義する（P0）
  - [x] 1.3.1. endpointConfigName を `yomitoku-pro-config` に設定
  - [x] 1.3.2. productionVariants に ml.g5.xlarge / initialInstanceCount: 1 を設定

- [x] 1.4. CDK Nag の指摘を確認し対応する（P0）
- [x] 1.5. Biome で lint / format を実行し修正する（P0）
- [x] 1.6. sagemaker-stack.ts として実装しデプロイ確認する（P0）

_設計書参照: セクション 8, 12_

---

## フェーズ 2: データストア・キュー（processing-stack）

- [x] 2.1. S3 バケットを定義する（P1）
  - [x] 2.1.1. バケット作成（パブリックアクセスブロック有効化）
  - [x] 2.1.2. input/ プレフィックスへの ObjectCreated イベント通知を SQS に設定

- [x] 2.2. SQS キューを定義する（P1）
  - [x] 2.2.1. メインキュー（visibilityTimeout: 3600秒、messageRetentionPeriod: 14日、receiveMessageWaitTimeSeconds: 20秒）
  - [x] 2.2.2. DLQ（maxReceiveCount: 3、messageRetentionPeriod: 14日）
  - [x] 2.2.3. メインキューの deadLetterQueue に DLQ を設定

- [x] 2.3. DynamoDB ステータステーブルを定義する（P1）
  - [x] 2.3.1. テーブル作成（PK: file_key）
  - [x] 2.3.2. GSI: status-created_at-index を追加

- [x] 2.4. DynamoDB エンドポイント制御テーブルを定義する（P1）
  - [x] 2.4.1. テーブル作成（PK: lock_key）

- [x] 2.5. CDK Nag の指摘を確認し対応する（P0）
- [x] 2.6. Biome で lint / format を実行し修正する（P0）
- [x] 2.7. processing-stack.ts としてまとめ、デプロイ確認する（P0）

_設計書参照: セクション 3, 5, 6, 12_

---

## フェーズ 3: 処理ワーカー Lambda

- [x] 3.1. Lambda コンテナイメージを作成する（P0）
  - [x] 3.1.1. Dockerfile を作成（ベース: public.ecr.aws/lambda/python:3.12、uv でインストール）
  - [x] 3.1.2. requirements.txt を作成（yomitoku-client のバージョン固定）
  - [x] 3.1.3. ローカルで docker build が成功することを確認
  - [x] 3.1.4. uv + venv でテスト用 Python 環境を構築

- [x] 3.2. 処理ワーカー Lambda のテストを作成する（TDD: テストを先に書く）（P0）
  - [x] 3.2.1. test_handler.py: SQS メッセージパースのテスト（直接 / SNS経由の各形式）
  - [x] 3.2.2. test_process_file.py: DynamoDB 条件付き更新のテスト（冪等性: 成功ケース + 重複スキップ）
  - [x] 3.2.3. test_process_file.py: S3 ダウンロード/アップロードのテスト（moto）
  - [x] 3.2.4. test_process_file.py: yomitoku-client 呼び出しのテスト（モック: 正常系 + 異常系）
  - [x] 3.2.5. test_process_file.py: 例外時の FAILED 更新と例外再送出のテスト
  - [x] 3.2.6. test_process_file.py: /tmp ファイルの後始末テスト（正常系/異常系）

- [x] 3.3. テストを通す処理ワーカー Lambda のコードを実装する（TDD: テストが通る最小限の実装）（P0）
  - [x] 3.3.1. SQS メッセージから S3 オブジェクトキーを取得する処理
  - [x] 3.3.2. DynamoDB 条件付き更新による冪等性確保（PENDING → PROCESSING）
  - [x] 3.3.3. S3 から PDF を /tmp にダウンロード
  - [x] 3.3.4. YomitokuClient.analyze_async() による OCR 処理
  - [x] 3.3.5. parse_pydantic_model() + to_json() で結果を S3 output/ に保存
  - [x] 3.3.6. DynamoDB ステータスを COMPLETED に更新
  - [x] 3.3.7. 例外時に FAILED 更新と例外再送出（SQS リトライのため）
  - [x] 3.3.8. /tmp ファイルの後始末（finally）
  - [x] 3.3.9. 全テストが通ることを確認（pytest tests/ -v）

- [x] 3.4. CDK で DockerImageFunction を定義する（P0）
  - [x] 3.4.1. memorySize: 2048、timeout: 10分、reservedConcurrentExecutions: 4
  - [x] 3.4.2. 環境変数（ENDPOINT_NAME, BUCKET_NAME, STATUS_TABLE_NAME）
  - [x] 3.4.3. SQS Event Source Mapping（batchSize: 1, reportBatchItemFailures: true）

- [x] 3.5. IAM 権限を付与する（P0）
  - [x] 3.5.1. S3 input/ の読み取り権限
  - [x] 3.5.2. S3 output/ の書き込み権限
  - [x] 3.5.3. DynamoDB ステータステーブルの読み書き権限
  - [x] 3.5.4. SQS メインキューの消費権限（SqsEventSource により自動付与）
  - [x] 3.5.5. sagemaker:InvokeEndpoint + DescribeEndpoint 権限（エンドポイント ARN 指定）

- [x] 3.6. CDK Nag の指摘を確認し対応する（P0）
  - [x] 3.6.1. `npx cdk synth` で CDK Nag の指摘を確認
  - [x] 3.6.2. 対応が必要な指摘を修正
  - [x] 3.6.3. 対応しない指摘は NagSuppressions で抑制し理由を記録

- [x] 3.7. Biome で lint / format を実行し修正する（P0）

- [x] 3.8. processing-stack.ts に Lambda 定義を追加し、デプロイ確認する（P0）

_設計書参照: セクション 4.3, 7, 9, 10, 12_

---

## フェーズ 4: エンドポイント制御（orchestration-stack）

- [x] 4.1. エンドポイント制御用 Lambda を実装する（P0）
  - [x] 4.1.1. create_endpoint: CreateEndpoint API 呼び出し
  - [x] 4.1.2. delete_endpoint: DeleteEndpoint API 呼び出し
  - [x] 4.1.3. check_endpoint_status: DescribeEndpoint API 呼び出し（NotFound 対応含む）
  - [x] 4.1.4. check_queue_status: SQS GetQueueAttributes（Messages + MessagesNotVisible）
  - [x] 4.1.5. acquire_lock / release_lock: DynamoDB 条件付き更新による排他制御

- [x] 4.2. Step Functions ステートマシンを定義する（P0）
  - [x] 4.2.1. ロック取得ステップ（失敗時は終了）
  - [x] 4.2.2. DescribeEndpoint による状態分岐（InService / Creating / NotFound）
  - [x] 4.2.3. CreateEndpoint ステップ
  - [x] 4.2.4. Wait + DescribeEndpoint の待機ループ（最大20回）
  - [x] 4.2.5. SQS キュー空判定ループ（Messages + MessagesNotVisible）
  - [x] 4.2.6. クールダウン Wait（15分）
  - [x] 4.2.7. 再確認後の DeleteEndpoint ステップ
  - [x] 4.2.8. ロック解放ステップ
  - [x] 4.2.9. エラーハンドリング（失敗時もロック解放する）

- [x] 4.3. EventBridge Pipes を定義する（P0）
  - [x] 4.3.1. ソース: SQS メインキュー
  - [x] 4.3.2. ターゲット: Step Functions ステートマシン
  - [x] 4.3.3. Pipes 用 IAM ロール（SQS 読み取り + Step Functions 起動）

- [x] 4.4. エンドポイント制御用 IAM 権限を付与する（P0）
  - [x] 4.4.1. sagemaker:CreateEndpoint / DeleteEndpoint / DescribeEndpoint
  - [x] 4.4.2. DynamoDB エンドポイント制御テーブルの読み書き権限
  - [x] 4.4.3. SQS GetQueueAttributes 権限

- [x] 4.5. CDK Nag の指摘を確認し対応する（P0）
- [x] 4.6. Biome で lint / format を実行し修正する（P0）
- [x] 4.7. orchestration-stack.ts として実装しデプロイ確認する（P0）

_設計書参照: セクション 4.2, 5.2, 12_

---

## フェーズ 5: 監視（monitoring-stack）

- [x] 5.1. CloudWatch Alarm を定義する（P1）
  - [x] 5.1.1. SQS ApproximateAgeOfOldestMessage > 30分
  - [x] 5.1.2. SQS ApproximateNumberOfMessagesVisible > 100
  - [x] 5.1.3. DLQ ApproximateNumberOfMessagesVisible > 0
  - [x] 5.1.4. Lambda Errors > 0
  - [x] 5.1.5. Lambda Duration > 480秒

- [x] 5.2. SNS トピックを作成しアラーム通知先を設定する（P1）

- [x] 5.3. CDK Nag の指摘を確認し対応する（P0）
- [x] 5.4. Biome で lint / format を実行し修正する（P0）
- [x] 5.5. monitoring-stack.ts として実装しデプロイ確認する（P0）

_設計書参照: セクション 13, 12_

---

## フェーズ 6: 結合テスト・動作確認

- [x] 6.1. エンドポイント単体の動作確認（P0）
  - [x] 6.1.1. AWS コンソールからエンドポイントを手動作成し InService になることを確認
    - us-east-1 / ml.g5.xlarge で作成（ap-northeast-1 はキャパシティ不足）
    - InService まで約4分30秒
  - [x] 6.1.2. boto3 で invoke_endpoint を直接呼び出し、OCR 結果が返ることを確認
    - 応答時間: 7.54秒、結果: 72,040文字の構造化JSON
  - [x] 6.1.3. エンドポイントを手動削除

- [x] 6.2. 処理ワーカー Lambda の単体確認（P0）
  - [x] 6.2.1. エンドポイントを手動起動した状態で S3 に PDF をアップロード
  - [x] 6.2.2. SQS にメッセージが投入されることを確認
  - [x] 6.2.3. Lambda が起動し DynamoDB が PROCESSING → COMPLETED に遷移することを確認
    - 処理時間: 7,278ms、結果: 72,103文字の構造化JSON
  - [x] 6.2.4. S3 output/ に JSON が保存されることを確認
  - [x] 6.2.5. 不正ファイルで FAILED を確認
    - エラー: `Failed to convert PDF to images: Failed to load document (PDFium: Data format error).`
  - 修正事項:
    - Dockerfile に `--platform=linux/amd64` を追加（Apple Silicon ビルド対応）
    - Dockerfile に OpenCV 用システムライブラリ（libxcb, mesa-libGL）を追加
    - Lambda ロールに `sagemaker:DescribeEndpoint` 権限を追加（yomitoku-client が使用）
    - cdk.context.json を us-east-1 に統一

- [x] 6.3. Step Functions によるエンドポイント制御の確認（P0）
  - [x] 6.3.1. エンドポイント未起動の状態で S3 に PDF をアップロード
  - [x] 6.3.2. Step Functions がエンドポイントを自動作成することを確認
  - [x] 6.3.3. 処理完了後、クールダウン経過後にエンドポイントが自動削除されることを確認
  - [x] 6.3.4. DynamoDB の endpoint_state が IDLE に戻ることを確認
  - 修正点:
    - EventBridge Pipe がSQSメッセージを配列で送る問題 → `UnwrapPipeInput` Pass ステート追加
    - Pipe target に `inputTemplate` を追加
    - CreateEndpoint IAM に `endpoint-config` リソースを追加
    - `Pass` ステートの `result` を `Result.fromObject()` で正しくラップ
    - `incrementCounter` から不要な `inputPath` を削除
  - 全ステート遷移の確認: UnwrapPipeInput → AcquireLock → CheckEndpointStatus(NOT_FOUND) → CreateEndpoint → WaitLoop(5回) → CheckQueueStatus → CooldownWait(15分) → RecheckQueueStatus → DeleteEndpoint → ReleaseLock → Done

- [x] 6.4. 冪等性・排他制御の確認（P0）
  - [x] 6.4.1. 同一ファイルの重複処理が発生しないことを確認（DynamoDB 条件付き更新）
    - COMPLETED/PROCESSING/FAILED いずれのステータスでも再処理されないことを確認
    - Lambda 直接呼び出しでの検証（batchItemFailures 空、DynamoDB レコード不変）
  - [x] 6.4.2. 複数の Step Functions 実行が同時にエンドポイントを操作しないことを確認
    - acquire_lock → lock_acquired=true、2回目 → lock_acquired=false を確認
    - ロック保持者の execution_id が正しいことを確認
    - release_lock 後の再取得が成功することを確認

- [x] 6.5. 複数ファイルの連続処理テスト（P0）
  - [x] 6.5.1. 5-10件の PDF を一括アップロード
    - fpdf2 で生成した 5 ファイル（英文テキスト入り PDF）を使用
  - [x] 6.5.2. 全件が COMPLETED になることを確認
    - 5/5 全件 COMPLETED（10秒以内に全件完了）
  - [x] 6.5.3. 処理時間、ページ数が DynamoDB に記録されていることを確認
    - processing_time_ms: 811〜2864ms
    - output_key が output/*.json として記録
    - OCR 結果 JSON にテキスト内容が正しく含まれていることを確認

_設計書参照: セクション 4, 14_

---

---

## フェーズ 7: DynamoDB スキーマ変更 & processor Lambda 対応

設計ドキュメント: [API実装検討.md](./API実装検討.md) > DynamoDB 設計変更

API 実装に先立ち、StatusTable の PK を `file_key` → `job_id` (UUID) に変更する。これにより API が `GetItem`（強整合性）で直接レコードを取得可能になる。processor Lambda の DynamoDB Key 指定も合わせて変更する。

> **注意**: DynamoDB は PK の変更ができないためテーブルを再作成する。開発環境のため既存データは破棄してよい。デプロイ前に `removalPolicy: DESTROY` に一時変更するか、手動でテーブルを削除してからデプロイする。

- [x] 7.1. StatusTable の PK を `job_id` に変更する（P0）
  - [x] 7.1.1. `lib/processing-stack.ts` の StatusTable 定義を変更
    - `partitionKey` を `{ name: "job_id", type: AttributeType.STRING }` に変更
    - 既存の GSI `status-created_at-index`（PK: `status`, SK: `created_at`）はそのまま維持
    - 新 GSI `file_key-index`（PK: `file_key`）を追加（processor が file_key から検索する場合の保険）
  - [x] 7.1.2. `test/processing-stack.test.ts` を更新し、PK が `job_id` であること・GSI 構成が正しいことを検証
  - [x] 7.1.3. `npx cdk synth` でテンプレート生成が成功することを確認

- [x] 7.2. processor Lambda を `job_id` ベースに更新する（P0、7.1 完了後）
  - [x] 7.2.1. `lambda/processor/tests/` のテストを先に更新する（TDD）
    - DynamoDB 操作の Key が `{"job_id": uuid}` であることを検証するテストに変更
    - `file_key.split("/")[1]` で UUID を抽出するロジックのテストを追加
    - S3 キー形式 `input/{uuid}/{filename}` を前提としたテストデータに変更
  - [x] 7.2.2. `lambda/processor/index.py` を更新
    - `extract_file_key()` の後に `job_id = file_key.split("/")[1]` で UUID を抽出
    - `table.update_item(Key={"file_key": file_key}, ...)` を全箇所 `Key={"job_id": job_id}` に変更（3箇所: PROCESSING 更新、COMPLETED 更新、FAILED 更新）
    - 冪等性チェック `ConditionExpression="#s = :pending"` のロジックは変更なし
  - [x] 7.2.3. `pytest lambda/processor/tests/ -v` で全テストが通ることを確認

- [x] 7.3. processor Lambda に PDF マジックナンバー検証を追加する（P1）
  - [x] 7.3.1. テストを先に作成する（TDD）
    - 正常 PDF（先頭 `%PDF-`）→ 処理続行
    - 不正ファイル（先頭が `%PDF-` でない）→ `ValueError` を送出し FAILED に遷移
  - [x] 7.3.2. `lambda/processor/index.py` の S3 ダウンロード後・OCR 処理前に検証を追加
    ```python
    with open(tmp_path, "rb") as f:
        header = f.read(5)
        if header != b"%PDF-":
            raise ValueError("Uploaded file is not a valid PDF")
    ```
  - [x] 7.3.3. `pytest lambda/processor/tests/ -v` で全テストが通ることを確認

- [x] 7.4. デプロイして既存パイプラインの動作を確認する（P0、7.2 完了後）
  - [x] 7.4.1. StatusTable の `removalPolicy` を一時的に `DESTROY` に変更してデプロイ（テーブル再作成）
  - [x] 7.4.2. デプロイ後に `removalPolicy` を `RETAIN` に戻してデプロイ
  - [x] 7.4.3. S3 キー `input/{uuid}/test.pdf` 形式で PDF をアップロードし、processor が `job_id` で DynamoDB を更新することを確認
    - PENDING → PROCESSING → FAILED（エンドポイント停止のため想定通り）
    - `job_id` が PK として正しく使用されていることを確認
  - [x] 7.4.4. 冪等性テスト（`scripts/test-idempotency.py`）を `job_id` 対応に更新して実行
    - COMPLETED/PROCESSING/FAILED いずれのステータスでも再処理されないことを確認（全3テスト PASS）
    - try/finally でクリーンアップを堅牢化、invoke_processor() ヘルパー関数を抽出

_設計書参照: [API実装検討.md](./API実装検討.md) > DynamoDB 設計変更、セキュリティ考慮事項 > 3. アップロードファイルの検証_

---

## フェーズ 8: API Lambda 実装（Hono + TypeScript）

設計ドキュメント: [API実装検討.md](./API実装検討.md) > API エンドポイント設計、Hono アプリ実装方針

Hono フレームワークで REST API を実装する。TDD で各エンドポイントのテストを先に書き、最小限の実装でテストを通す。テストは Hono の `app.request()` テストヘルパーを使用し、DynamoDB・S3 はモックする。

- [ ] 8.1. `lambda/api/` ディレクトリをセットアップする（P0）
  - [ ] 8.1.1. ディレクトリ構成を作成
    ```
    lambda/api/
      index.ts
      routes/
        jobs.ts
      lib/
        dynamodb.ts
        s3.ts
        errors.ts
        sanitize.ts
      __tests__/
        routes/
          jobs.test.ts
        lib/
          sanitize.test.ts
    ```
  - [ ] 8.1.2. `lambda/api/package.json` を作成
    - dependencies: `hono`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`
    - devDependencies: `@types/aws-lambda`, `typescript`, `vitest`, `@aws-sdk/client-dynamodb` (mock 用)
    - scripts: `"test": "vitest run"`, `"test:watch": "vitest"`
  - [ ] 8.1.3. `lambda/api/tsconfig.json` を作成（`target: ES2022`, `module: ESNext`, `moduleResolution: bundler`）
  - [ ] 8.1.4. `pnpm install` で依存関係をインストールし、`npx tsc --noEmit` がエラーなしで通ることを確認

- [ ] 8.2. 共通ライブラリを実装する（P0、8.1 完了後）
  - [ ] 8.2.1. ファイル名サニタイズのテストを作成する（TDD: `__tests__/lib/sanitize.test.ts`）
    - 正常系: `"請求書.pdf"` → `"請求書.pdf"`
    - パストラバーサル: `"../../etc/passwd.pdf"` → `"passwd.pdf"`
    - Windows パス: `"C:\\Users\\test.pdf"` → `"test.pdf"`
    - 制御文字除去: `"test\x00file.pdf"` → `"testfile.pdf"`
    - 大文字拡張子: `"TEST.PDF"` → `"TEST.PDF"`（許容）
    - 空文字: `""` → `"document.pdf"`
    - 非 PDF: `"test.txt"` → `ValidationError`
    - Windows禁止文字: `"test<>:\".pdf"` → `"test.pdf"`
  - [ ] 8.2.2. `lib/sanitize.ts` を実装してテストを通す
    - `sanitizeFilename(raw: string): string` — ディレクトリ除去、制御文字除去、`.pdf` 検証
  - [ ] 8.2.3. `lib/dynamodb.ts` を実装（`DynamoDBDocumentClient` をハンドラ外で初期化、export）
  - [ ] 8.2.4. `lib/s3.ts` を実装
    - `createUploadUrl(bucket, key): Promise<string>` — Presigned PUT URL 発行（有効期限 15 分、ContentType: `application/pdf`）
    - `createResultUrl(bucket, key): Promise<string>` — Presigned GET URL 発行（有効期限 1 時間）
  - [ ] 8.2.5. `lib/errors.ts` を実装（`ValidationError`, `NotFoundError`, `ConflictError` クラス + Hono `onError` ハンドラ）

- [ ] 8.3. `POST /jobs` のテストと実装（TDD）（P0、8.2 完了後）
  - [ ] 8.3.1. テストを作成する（`__tests__/routes/jobs.test.ts`）
    - 正常系: `{ filename: "test.pdf" }` → 201、レスポンスに `jobId`(UUID), `fileKey`, `uploadUrl`, `expiresIn` が含まれる
    - 正常系: DynamoDB に `job_id`, `file_key`, `status: "PENDING"`, `created_at`, `updated_at`, `original_filename` が保存される
    - バリデーション: `filename` 未指定 → 400
    - バリデーション: `filename` が `.pdf` でない → 400
    - バリデーション: `filename` が空文字 → `"document.pdf"` にフォールバックし 201
  - [ ] 8.3.2. `routes/jobs.ts` に `POST /` ルートを実装してテストを通す
    - UUID 生成（`crypto.randomUUID()`）
    - `sanitizeFilename()` でファイル名をサニタイズ
    - `fileKey = input/{uuid}/{sanitized_filename}` を組み立て
    - DynamoDB `PutItem`（`job_id`, `file_key`, `status: "PENDING"`, `created_at`, `updated_at`, `original_filename`）
    - S3 Presigned PUT URL を発行
    - 201 レスポンス返却

- [ ] 8.4. `GET /jobs/:jobId` のテストと実装（TDD）（P0、8.2 完了後）
  - [ ] 8.4.1. テストを作成する
    - 正常系（PENDING）: 200、`status: "PENDING"`、`resultUrl` なし
    - 正常系（PROCESSING）: 200、`status: "PROCESSING"`、`resultUrl` なし
    - 正常系（COMPLETED）: 200、`status: "COMPLETED"`、`resultUrl` と `resultExpiresIn` が含まれる、`processingTimeMs` が含まれる
    - 正常系（FAILED）: 200、`status: "FAILED"`、`errorMessage` が含まれる
    - 正常系（CANCELLED）: 200、`status: "CANCELLED"`
    - 異常系: 存在しない jobId → 404
    - 異常系: jobId が UUID 形式でない → 400
  - [ ] 8.4.2. `routes/jobs.ts` に `GET /:jobId` ルートを実装してテストを通す
    - `GetItem`（PK: `job_id`、強整合性で取得）
    - COMPLETED の場合は `createResultUrl()` で Presigned GET URL を発行
    - FAILED の場合は `error_message` を含める
    - 未検出は 404

- [ ] 8.5. `GET /jobs` のテストと実装（TDD）（P0、8.2 完了後）
  - [ ] 8.5.1. テストを作成する
    - 正常系: `?status=COMPLETED` → 200、`items` 配列、`count`、`cursor`
    - 正常系: `?status=PENDING&limit=5` → 最大 5 件
    - ページネーション: `cursor` を使って次ページ取得 → 正しい続きが返る
    - 最終ページ: `cursor: null`
    - 一覧に `resultUrl` が含まれないことを確認
    - 異常系: `status` 未指定 → 400
    - 異常系: `limit` が 0 以下または 100 超 → 400
    - 異常系: 不正な `cursor` → 400
  - [ ] 8.5.2. `routes/jobs.ts` に `GET /` ルートを実装してテストを通す
    - GSI `status-created_at-index` で `Query`
    - `cursor` は Base64url エンコードした `LastEvaluatedKey`
    - `limit` のデフォルトは 20、上限 100

- [ ] 8.6. `DELETE /jobs/:jobId` のテストと実装（TDD）（P0、8.2 完了後）
  - [ ] 8.6.1. テストを作成する
    - 正常系: PENDING ジョブ → 200、`status: "CANCELLED"` に遷移
    - 正常系: S3 input ファイルのベストエフォート削除が呼ばれる
    - 異常系: PROCESSING ジョブ → 409 Conflict
    - 異常系: COMPLETED ジョブ → 409 Conflict
    - 異常系: 存在しない jobId → 404
    - 競合安全性: S3 削除が失敗してもレスポンスは 200（ベストエフォート）
  - [ ] 8.6.2. `routes/jobs.ts` に `DELETE /:jobId` ルートを実装してテストを通す
    - `UpdateItem` で `ConditionExpression="#s = :pending"` 付きで `CANCELLED` に遷移
    - `ConditionalCheckFailedException` → まず `GetItem` でレコード存在確認、なければ 404、あれば 409
    - S3 `DeleteObject` をベストエフォートで実行（try-catch で失敗は無視）

- [ ] 8.7. エントリポイントとエラーハンドリングを統合する（P0、8.3-8.6 完了後）
  - [ ] 8.7.1. `index.ts` を実装
    - Hono app を作成し `/jobs` ルートをマウント
    - `handle(app)` で Lambda ハンドラをエクスポート
    - グローバルエラーハンドラ（`app.onError`）で `ValidationError` → 400、`NotFoundError` → 404、`ConflictError` → 409、その他 → 500
  - [ ] 8.7.2. 全テスト実行: `cd lambda/api && pnpm test` で全テストが通ることを確認

- [ ] 8.8. Biome で lint / format を実行し修正する（P0、8.7 完了後）
  - [ ] 8.8.1. `pnpm lint:fix` で自動修正
  - [ ] 8.8.2. `pnpm lint` でエラーゼロを確認

_設計書参照: [API実装検討.md](./API実装検討.md) > API エンドポイント設計、Hono アプリ実装方針、ディレクトリ構成_

---

## フェーズ 9: CDK ApiStack（API Gateway + CloudFront）

設計ドキュメント: [API実装検討.md](./API実装検討.md) > CDK スタック設計 (ApiStack)、CloudFront 設定詳細、API Key の発行・管理、セキュリティ考慮事項

CDK で API Lambda、API Gateway REST API、CloudFront Distribution、API Key + Usage Plan を定義する。CloudFront Origin Custom Header による API Gateway 直接アクセス拒否も設定する。

- [ ] 9.1. `lib/api-stack.ts` の基本構成を作成する（P0）
  - [ ] 9.1.1. CDK スナップショットテストを先に作成する（TDD: `test/api-stack.test.ts`）
    - `ApiStackProps` として `bucket: Bucket` と `statusTable: Table` を受け取ること
    - `NodejsFunction` が作成されること（ランタイム Node.js 22.x、タイムアウト 29s、メモリ 256MB）
    - Lambda 環境変数に `STATUS_TABLE_NAME`, `BUCKET_NAME` が設定されていること
    - `LambdaRestApi` が作成されること（`endpointTypes: REGIONAL`）
  - [ ] 9.1.2. `lib/api-stack.ts` を実装してテストを通す
    - `ApiStackProps` インターフェース定義（`bucket: Bucket`, `statusTable: Table`）
    - `NodejsFunction` を作成（`entry: lambda/api/index.ts`, `runtime: NODEJS_22_X`, `handler: handler`, `bundling: { minify: true }`, `memorySize: 256`, `timeout: 29s`）
    - 環境変数: `STATUS_TABLE_NAME`, `BUCKET_NAME`
    - `LambdaRestApi` を作成（`proxy: true`, `endpointTypes: [REGIONAL]`）

- [ ] 9.2. API Key + Usage Plan を設定する（P0、9.1 完了後）
  - [ ] 9.2.1. テストに追加: `ApiKey` リソースが作成されること、`UsagePlan` にレート制限が設定されていること
  - [ ] 9.2.2. `api-stack.ts` に追加
    - `apiKeySourceType: ApiKeySourceType.HEADER`、`defaultMethodOptions: { apiKeyRequired: true }`
    - `UsagePlan` を作成（`throttle: { rateLimit: 100, burstLimit: 200 }`、`quota: { limit: 10000, period: Period.DAY }`）
    - `ApiKey` を作成し `UsagePlan` に紐付け
    - `CfnOutput` で `ApiKeyId` を出力（デプロイ後に `aws apigateway get-api-key --api-key <ID> --include-value` で値を取得）

- [ ] 9.3. CloudFront Distribution を設定する（P0、9.1 完了後）
  - [ ] 9.3.1. テストに追加: `CloudFront::Distribution` が作成されること、Origin Custom Header `x-origin-verify` が設定されていること
  - [ ] 9.3.2. `api-stack.ts` に追加
    - `origins.RestApiOrigin` を使用（`customHeaders: { "x-origin-verify": originVerifySecret }`）
    - `CachePolicy.CACHING_DISABLED`
    - `OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER`
    - `AllowedMethods.ALLOW_ALL`
    - `ViewerProtocolPolicy.REDIRECT_TO_HTTPS`
    - `CfnOutput` で `DistributionDomainName` を出力

- [ ] 9.4. API Gateway リソースポリシーを設定する（P0、9.3 完了後）
  - [ ] 9.4.1. `api-stack.ts` に CloudFront 経由以外のアクセスを拒否するリソースポリシーを追加
    - CloudFront Origin Custom Header (`x-origin-verify`) の値と一致しないリクエストを DENY
    - 具体的な実装方法は CDK の `RestApi.policy` またはリソースポリシーで設定

- [ ] 9.5. IAM 権限を付与する（P0、9.1 完了後）
  - [ ] 9.5.1. テストに追加: Lambda ロールに必要な IAM ポリシーが付与されていること
  - [ ] 9.5.2. `api-stack.ts` に追加
    - `statusTable.grantReadWriteData(fn)` — DynamoDB の GetItem, PutItem, UpdateItem, Query
    - `bucket.grantPut(fn, "input/*")` — S3 Presigned PUT URL 発行用
    - `bucket.grantRead(fn, "output/*")` — S3 Presigned GET URL 発行用
    - `bucket.grantDelete(fn, "input/*")` — DELETE 時のベストエフォート削除用

- [ ] 9.6. `bin/app.ts` に ApiStack を追加する（P0、9.1 完了後）
  - [ ] 9.6.1. `ApiStack` をインポートし、`ProcessingStack` の後にインスタンス化
    ```typescript
    const apiStack = new ApiStack(app, "ApiStack", {
      env: { region, account },
      bucket: processingStack.bucket,
      statusTable: processingStack.statusTable,
    });
    ```

- [ ] 9.7. CDK Nag の指摘を確認し対応する（P0、9.1-9.6 完了後）
  - [ ] 9.7.1. `npx cdk synth` で CDK Nag の指摘を確認
  - [ ] 9.7.2. 対応が必要な指摘を修正（想定される指摘）:
    - `AwsSolutions-APIG1`: API Gateway アクセスログ → ログ設定を追加
    - `AwsSolutions-APIG2`: リクエストバリデーション → proxy モードのため Nag 抑制
    - `AwsSolutions-APIG3`: WAF 関連付け → 初期段階は Nag 抑制（将来追加）
    - `AwsSolutions-APIG4`: 認証方式 → API Key 使用のため Nag 抑制
    - `AwsSolutions-CFR1/CFR2`: CloudFront Geo restriction / WAF → 初期段階は Nag 抑制
    - `AwsSolutions-CFR4`: CloudFront TLS → ViewerProtocolPolicy で対応済み
    - `AwsSolutions-IAM4/IAM5`: Lambda 実行ロールの managed policy / wildcard → 理由を記録して Nag 抑制
    - `AwsSolutions-L1`: Lambda ランタイム最新確認 → Node.js 22.x で対応済み
  - [ ] 9.7.3. 対応しない指摘は `NagSuppressions` で抑制し理由を記録
  - [ ] 9.7.4. 全テスト実行: `pnpm test` で全スナップショットテストが通ることを確認

- [ ] 9.8. Biome で lint / format を実行し修正する（P0、9.7 完了後）
  - [ ] 9.8.1. `pnpm lint:fix` で自動修正
  - [ ] 9.8.2. `pnpm lint` でエラーゼロを確認

_設計書参照: [API実装検討.md](./API実装検討.md) > CDK スタック設計 (ApiStack)、CloudFront 設定詳細、API Key の発行・管理、セキュリティ考慮事項_

---

## フェーズ 10: API 結合テスト

設計ドキュメント: [API実装検討.md](./API実装検討.md) 全体

デプロイした API に対して結合テストを実行し、全エンドポイントの動作とエンドツーエンドの OCR フローを確認する。

- [ ] 10.1. デプロイする（P0、フェーズ 9 完了後）
  - [ ] 10.1.1. `npx cdk deploy --all` で全スタックをデプロイ
  - [ ] 10.1.2. CloudFormation Output から以下を記録:
    - `ApiStack.DistributionDomainName` — API のベース URL
    - `ApiStack.ApiKeyId` — API Key ID
  - [ ] 10.1.3. API Key の値を取得: `aws apigateway get-api-key --api-key <ApiKeyId> --include-value --query 'value' --output text`

- [ ] 10.2. 結合テストスクリプトを作成する（P0、10.1 完了後）
  - [ ] 10.2.1. `scripts/test-api.py` を作成。CloudFormation Output から自動で URL / API Key を取得する構成
  - [ ] 10.2.2. テスト A — POST /jobs: ジョブ作成
    - `POST /jobs` に `{ "filename": "test.pdf" }` を送信
    - 201 が返ること、`jobId`, `uploadUrl` が含まれること
    - `uploadUrl` に実際に PDF を PUT アップロードできること
  - [ ] 10.2.3. テスト B — GET /jobs/:jobId: ステータス確認
    - 作成直後に GET → `status: "PENDING"` であること
    - アップロード後しばらく待って GET → `status: "PROCESSING"` または `"COMPLETED"`
  - [ ] 10.2.4. テスト C — GET /jobs: 一覧取得
    - `?status=PENDING` で一覧取得 → 作成したジョブが含まれること
    - `?limit=1` → `cursor` が返ること、次ページ取得ができること
  - [ ] 10.2.5. テスト D — DELETE /jobs/:jobId: キャンセル
    - 新規ジョブを作成（アップロードしない）
    - `DELETE /jobs/:jobId` → 200、`status: "CANCELLED"`
    - 再度 `GET /jobs/:jobId` → `status: "CANCELLED"` であること
    - CANCELLED ジョブに再度 DELETE → 409
  - [ ] 10.2.6. テスト E — バリデーション
    - POST に `filename` なし → 400
    - POST に `.txt` ファイル名 → 400
    - GET 存在しない jobId → 404
    - DELETE PROCESSING 状態のジョブ → 409
  - [ ] 10.2.7. テスト F — API Key なしでアクセス → 403

- [ ] 10.3. E2E フローテスト（P0、10.2 完了後）
  - [ ] 10.3.1. テスト G — OCR 完了まで通しテスト（エンドポイント起動済みの場合）
    - POST /jobs → uploadUrl に PDF を PUT → ポーリングで COMPLETED まで待機 → `resultUrl` で結果 JSON を取得 → JSON の内容を検証
  - [ ] 10.3.2. テスト H — CloudFront 経由でない直接アクセスの拒否確認
    - API Gateway の URL に直接リクエスト → 403 Forbidden であること

- [ ] 10.4. テスト結果をまとめる（P0、10.3 完了後）
  - [ ] 10.4.1. 全テスト結果を確認し、問題があれば修正
  - [ ] 10.4.2. テスト結果のサマリをタスク一覧に記録

_設計書参照: [API実装検討.md](./API実装検討.md) 全体_

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
          |
          v
        フェーズ 7（DynamoDB スキーマ変更 & processor 対応）
          |
          v
        フェーズ 8（API Lambda 実装） --- P1、8.3-8.6 は 8.2 完了後に並行着手可
          |
          v
        フェーズ 9（CDK ApiStack） --- 9.2, 9.3, 9.5 は 9.1 完了後に並行着手可
          |
          v
        フェーズ 10（API 結合テスト）
```

- フェーズ 7 はフェーズ 6 完了後に着手（既存パイプラインの正常動作確認後にスキーマ変更）
- フェーズ 8 はフェーズ 7 完了後に着手（DynamoDB スキーマが確定してから API 実装）
- フェーズ 8 の各エンドポイント（8.3-8.6）は 8.2 完了後に並行着手可能
- フェーズ 9 はフェーズ 8 完了後に着手（API Lambda が完成してから CDK スタック構築）
- フェーズ 9 の 9.2, 9.3, 9.5 は 9.1 完了後に並行着手可能
- フェーズ 10 はフェーズ 9 完了後に着手（デプロイ後に結合テスト）

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
| Cognito 認証 | マルチテナント・一般公開時 |
| WAF 統合 | CloudFront に WAF を関連付け |
| マルチリージョン | DR要件時 |
