# YomiToku-Pro AWS 最終構成

## 1. システム概要

S3にアップロードされたPDFファイルをYomiToku-Pro（SageMakerエンドポイント）でOCR処理し、結果をJSONとしてS3に保存するバッチ処理基盤。CDK（TypeScript）で構築する。

### 選定方針

| 項目 | 選定 | 理由 |
|---|---|---|
| 処理ワーカー | Lambda（yomitoku-client使用） | 公式SDKの機能（リトライ、サーキットブレーカー、出力変換等）をそのまま活用できる |
| コスト最適化 | 方式A: エンドポイント作成/削除 | Marketplaceモデルとの互換性が確実 |
| オーケストレーション | EventBridge Pipes + Step Functions | SQS起動検知の現実解、排他制御を組み込みやすい |
| 一次出力 | JSONのみ | 変換処理はOCRと分離し、後段で必要時にのみ実行 |
| インスタンス | ml.g5.xlarge | 性能/コストバランスが最良（約6,000ページ/時間） |
| リージョン | ap-northeast-1 | 東京リージョン |

### 初期実装に含めるもの

| 項目 | 内容 |
|---|---|
| 入力 | S3 input/ へのPDFアップロード |
| 処理 | yomitoku-client による OCR（PDF → ページPNG → SageMaker推論） |
| 出力 | JSON形式のみ（S3 output/ に保存） |
| ステータス管理 | DynamoDB による PENDING / PROCESSING / COMPLETED / FAILED の管理 |
| コスト制御 | Step Functions によるエンドポイント動的作成/削除（方式A） |
| 排他制御 | DynamoDB 条件付き更新によるエンドポイント制御ロックと冪等性確保 |
| SQS | メインキュー + DLQ、visibility timeout、部分失敗レポート |
| 認証 | IAMポリシーによるアクセス制御（Lambda実行ロールのみに InvokeEndpoint を付与） |
| 監視 | CloudWatch Alarm（基本メトリクス: SQS滞留、Lambda エラー、DLQ） |
| IaC | CDK（TypeScript）による全リソースの定義 |

### 初期実装に含めないもの

| 項目 | 理由 | 追加実装の目安 |
|---|---|---|
| 出力形式の変換（Markdown, HTML, CSV, Searchable PDF） | OCR処理と変換処理は責務を分離する。初期は一次成果物のJSONのみ出力し、変換は後段の別Lambdaとして必要になった時点で追加する | 利用者からJSON以外の形式要望が出た時点 |
| CloudWatch Dashboard | 初期はAlarmのみ。ダッシュボードは運用が始まり監視すべきメトリクスが確定してから整備する | 運用開始後1-2週間 |
| VPCエンドポイント（PrivateLink） | IAM制御のみで十分なセキュリティを確保できる。VPC内配置はLambdaコールドスタートの悪化や構成の複雑化を伴う | セキュリティ要件の追加があった場合 |
| 画像ファイル（JPEG/PNG/TIFF）の直接入力 | 初期はPDF入力のみに限定。画像ファイルはPDF→PNG変換のステップが不要になるだけで、対応自体は軽微 | PDF以外の入力要望が出た時点 |
| ページ数上限の制御 | 通常のビジネス文書（数十ページ）では問題にならない。大量ページPDFの入力が想定される場合に検討する | 100ページ超のPDFを扱う運用が発生した場合 |
| ECS Fargate ワーカー | Lambdaの実行時間上限（15分）やメモリ上限（10GB）を超えるケースが発生するまでは不要 | Lambda制限に抵触する大容量ファイルの処理が必要になった場合 |
| 方式B/C（非同期推論 / Inference Component + ゼロスケール） | Marketplaceモデルとの互換性が未確認。方式Aで十分にコスト削減できるため、実機検証は初期リリース後に行う | サブスクリプション後の実機検証タイミング |
| 処理結果の通知（SNS/メール等） | 初期はDynamoDBのステータス確認で運用する。通知が必要な場合はDynamoDB Streamsまたは処理完了後のSNS Publishで追加可能 | 運用者から通知要望が出た時点 |
| API Gateway / フロントエンド | 初期はS3への直接アップロードとDynamoDBの直接参照で運用する | ユーザー向けUIが必要になった場合 |
| マルチリージョン対応 | 初期は ap-northeast-1 のみ | DR要件やレイテンシ要件が出た場合 |

---

## 2. アーキテクチャ

```
S3 (input/)
  | ObjectCreated イベント通知
  v
SQS キュー (バッファリング)  ──── DLQ (3回失敗で移動)
  |
  |  EventBridge Pipes
  v
Step Functions (エンドポイント制御)
  |-- DynamoDB: endpoint_state ロック取得（排他制御）
  |-- SageMaker Endpoint 作成（未起動時、約5-10分）
  |-- 待機ループ（InServiceまで）
  |-- 処理Lambda 起動
  |-- キュー空判定 + クールダウン（15分）
  |-- SageMaker Endpoint 削除
  |-- DynamoDB: ロック解放
  v
処理Lambda (SQS Event Source Mapping, コンテナイメージ)
  |-- DynamoDB: 条件付き更新で PROCESSING（冪等性確保）
  |-- S3 からPDFを /tmp にダウンロード
  |-- yomitoku-client で解析（内部でPDF→PNG変換、invoke_endpoint呼び出し）
  |-- S3 (output/) にJSON保存
  |-- DynamoDB: COMPLETED or FAILED
  v
S3 (output/) + DynamoDB (ステータス管理)
  |
  v
[後段] 変換Lambda（初期実装には含めない、要望に応じて追加）
  |-- JSON → Markdown / HTML / CSV / Searchable PDF
```

---

## 3. AWSリソース一覧

| リソース | CDKコンストラクト | レベル | 用途 |
|---|---|---|---|
| S3バケット | s3.Bucket | L2 | 入出力ファイル保存 |
| S3イベント通知 | s3_notifications.SqsDestination | L2 | アップロード検知 |
| SQSキュー（メイン） | sqs.Queue | L2 | メッセージバッファリング |
| SQSキュー（DLQ） | sqs.Queue | L2 | 失敗ファイルの隔離 |
| EventBridge Pipes | pipes.CfnPipe | L1 | SQS → Step Functions 起動 |
| Step Functions | stepfunctions.StateMachine | L2 | エンドポイント ライフサイクル制御 |
| Lambda（処理ワーカー） | lambda.DockerImageFunction | L2 | OCR処理実行（コンテナイメージ） |
| Lambda（変換、任意） | lambda.Function | L2 | JSON → 他形式変換 |
| DynamoDBテーブル（ステータス） | dynamodb.Table | L2 | ファイル処理ステータス管理 |
| DynamoDBテーブル（ロック） | dynamodb.Table | L2 | エンドポイント制御の排他ロック |
| SageMaker CfnModel | sagemaker.CfnModel | L1 | Marketplaceモデル参照 |
| SageMaker CfnEndpointConfig | sagemaker.CfnEndpointConfig | L1 | インスタンス設定 |
| IAMロール | iam.Role | L2 | 各リソースの権限 |
| CloudWatch Alarm | cloudwatch.Alarm | L2 | 監視・通知 |

SageMaker CfnEndpoint はCDKでは作成しない（Step Functionsから動的に作成/削除する）。

---

## 4. データフロー詳細

### 4.1 ファイルアップロード → SQSキュー投入

```
1. ユーザーが S3 input/ にPDFをアップロード
2. S3 ObjectCreated イベントが SQS に通知
3. DynamoDB ステータステーブルに PENDING レコードを作成
   （S3イベント通知 → SQSの間にLambdaを挟んでPENDING登録、またはワーカーLambda内で初回登録）
```

### 4.2 エンドポイント起動制御（Step Functions）

```
EventBridge Pipes が SQS のメッセージ到着を検知し Step Functions を起動

[1] DynamoDB endpoint_state を条件付き更新でロック取得
    ConditionExpression: endpoint_state = "IDLE" OR attribute_not_exists(endpoint_state)
    → 失敗: 他の実行が制御中のため終了
    → 成功: 次へ

[2] DescribeEndpoint で状態確認
    → InService: [5] へ
    → Creating: [4] へ
    → NotFound: [3] へ

[3] CreateEndpoint
    EndpointName: yomitoku-pro-endpoint
    EndpointConfigName: yomitoku-pro-config（CDKで事前作成）

[4] Wait(60秒) → DescribeEndpoint
    → InService でなければ [4] に戻る（最大20回 = 20分でタイムアウト）

[5] 処理Lambdaが SQS Event Source Mapping 経由でメッセージを処理

[6] SQS キュー状態を確認
    GetQueueAttributes:
      - ApproximateNumberOfMessages（未処理）
      - ApproximateNumberOfMessagesNotVisible（処理中）
    → いずれか > 0: Wait(60秒) → [6] に戻る
    → 両方 0: [7] へ

[7] Wait(15分) ← クールダウン

[8] SQS キューを再確認
    → メッセージあり: [5] に戻る
    → 空: [9] へ

[9] DeleteEndpoint → endpoint_state を "IDLE" に更新 → 完了
```

### 4.3 OCR処理（処理ワーカーLambda）

```
SQS Event Source Mapping でメッセージ受信（batch_size=1）

[1] SQS メッセージから S3 オブジェクトキーを取得

[2] DynamoDB 条件付き更新: status を PENDING → PROCESSING
    → ConditionalCheckFailedException: 既に処理中/完了 → スキップ（冪等性）

[3] S3 から PDF ファイルを /tmp にダウンロード

[4] yomitoku-client の YomitokuClient.analyze_async() で解析
    - 内部動作: PDF → ページごとにPNG変換（pypdfium2, DPI=200）
    - 内部動作: ページごとに invoke_endpoint（ContentType: image/png）
    - 内部動作: max_workers で並列数制御、サーキットブレーカー内蔵
    - ペイロード制限: 6MB/リクエスト（A4/200DPIは通常1-3MB）
    - モデル応答タイムアウト: 60秒

[5] 結果を parse_pydantic_model() で変換

[6] to_json() で JSON として S3 output/ に保存

[7] DynamoDB: status を COMPLETED に更新（output_key, processing_time_ms, page_count）

[例外] 失敗時: DynamoDB を FAILED に更新 → 例外を再送出 → SQS リトライ
```

---

## 5. DynamoDB テーブル設計

### 5.1 ステータステーブル（yomitoku-status）

| 属性 | 型 | 説明 |
|---|---|---|
| file_key (PK) | String | S3オブジェクトキー（例: input/doc001.pdf） |
| status | String | PENDING / PROCESSING / COMPLETED / FAILED |
| created_at | String | 検知日時（ISO 8601） |
| updated_at | String | 最終更新日時（ISO 8601） |
| output_key | String | 結果のS3キー（例: output/doc001.json） |
| error_message | String | エラー詳細（成功時は空） |
| processing_time_ms | Number | 処理時間（ミリ秒） |
| page_count | Number | PDFのページ数 |
| retry_count | Number | リトライ回数 |

GSI: status-created_at-index（PKがstatus、SKがcreated_at）

status の遷移: PENDING → PROCESSING → COMPLETED / FAILED

冪等性: PENDING → PROCESSING の更新は条件付き（ConditionExpression）。重複メッセージによる二重処理を防止する。

### 5.2 エンドポイント制御テーブル（yomitoku-endpoint-control）

| 属性 | 型 | 説明 |
|---|---|---|
| lock_key (PK) | String | 固定値 "endpoint_control" |
| endpoint_state | String | IDLE / CREATING / IN_SERVICE / DELETING |
| updated_at | String | 最終更新日時 |
| execution_id | String | Step Functions 実行ID（デバッグ用） |

状態遷移: IDLE → CREATING → IN_SERVICE → DELETING → IDLE

排他制御: 条件付き更新で「IDLEの場合のみCREATINGに遷移」を保証。複数のStep Functions実行が同時にエンドポイントを操作するレースコンディションを防止する。

---

## 6. SQS 設定

### メインキュー

| 設定 | 値 | 根拠 |
|---|---|---|
| visibilityTimeout | 3600秒（60分） | Lambda タイムアウト10分の6倍（AWS公式推奨） |
| messageRetentionPeriod | 14日 | 長時間のエンドポイント未起動に対応 |
| receiveMessageWaitTimeSeconds | 20秒 | ロングポーリング有効化 |

### DLQ

| 設定 | 値 | 根拠 |
|---|---|---|
| maxReceiveCount | 3 | 3回失敗で移動 |
| messageRetentionPeriod | 14日 | 原因調査・再処理の猶予 |

### SQS Event Source Mapping（処理Lambda）

| 設定 | 値 | 根拠 |
|---|---|---|
| batchSize | 1 | PDF処理は重いため1件ずつ |
| maxBatchingWindow | 0秒 | 遅延なく処理開始 |
| reportBatchItemFailures | true | 部分失敗レポート有効 |

SQS は at-least-once delivery のため、同じメッセージが複数回配送される前提で設計する。DynamoDBの条件付き更新で冪等性を確保する。

---

## 7. Lambda 設定

### 処理ワーカーLambda

| 設定 | 値 |
|---|---|
| ランタイム | Python 3.12（コンテナイメージ） |
| メモリ | 2048MB |
| タイムアウト | 10分（600秒） |
| 同時実行数（Reserved Concurrency） | 4（SageMakerエンドポイントの処理能力に応じて調整） |
| デプロイ方式 | コンテナイメージ（ECR） |
| 環境変数 | ENDPOINT_NAME, BUCKET_NAME, STATUS_TABLE_NAME, AWS_DEFAULT_REGION |
| /tmp サイズ | 512MB（デフォルト。大容量PDF対応時は最大10GBまで拡張可能） |

### コンテナイメージ

yomitoku-client の依存パッケージ（opencv-python, pandas, numpy, pypdfium2等）は合計サイズが大きく、通常のzipデプロイ（250MB制限）では収まらない。コンテナイメージ（最大10GB）でデプロイする。

Dockerfile:

```dockerfile
FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY index.py ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]
```

requirements.txt:

```
yomitoku-client
```

yomitoku-client をインストールすると以下の依存が自動的に含まれる:
- boto3, pydantic, pandas, numpy, opencv-python, Pillow, PyPDF2, pypdfium2, reportlab, lxml, jaconv, click, requests

yomitoku-client を使用する利点:
- PDF→PNG変換、invoke_endpoint呼び出し、並列制御を自前で実装する必要がない
- サーキットブレーカー（429/5xx時の自動停止・再開）が内蔵されている
- リトライ、タイムアウト計算が自動で行われる
- 出力変換メソッド（to_json, to_markdown等）がそのまま使える

---

## 8. SageMaker エンドポイント設定

### CDKで事前に作成するリソース

CfnModel と CfnEndpointConfig はCDKデプロイ時に作成し、常時存在させる。エンドポイント自体はStep Functionsで動的に作成/削除する。

#### CfnModel

```typescript
const model = new sagemaker.CfnModel(this, 'YomitokuModel', {
  executionRoleArn: sagemakerRole.roleArn,
  primaryContainer: {
    modelPackageName: 'arn:aws:sagemaker:ap-northeast-1:ACCOUNT_ID:model-package/yomitoku-pro-...',
  },
});
```

#### CfnEndpointConfig

```typescript
const endpointConfig = new sagemaker.CfnEndpointConfig(this, 'YomitokuEndpointConfig', {
  endpointConfigName: 'yomitoku-pro-config',
  productionVariants: [{
    variantName: 'AllTraffic',
    modelName: model.attrModelName,
    instanceType: 'ml.g5.xlarge',
    initialInstanceCount: 1,
  }],
});
```

### エンドポイント制約

| 項目 | 値 |
|---|---|
| インスタンスタイプ | ml.g5.xlarge |
| インスタンス数 | 1 |
| ペイロード上限（Runtime API） | 6MB (6,291,456 bytes) |
| モデル応答タイムアウト | 60秒 |
| ContentType | image/png（PDFはPNGに変換してから送信） |
| コールドスタート | 5-10分（エンドポイント作成から InService まで） |

注意: AWSのHosting FAQには「ペイロード最大25MB」の記述があるが、Runtime API（invoke_endpoint）の実効制限は6MBである。6MBで制約設計する。

---

## 9. 処理ワーカー Lambda コード

```python
import asyncio
import boto3
import json
import os
import time
from datetime import datetime
from botocore.exceptions import ClientError
from yomitoku_client import YomitokuClient, RequestConfig, CircuitConfig, parse_pydantic_model

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

ENDPOINT_NAME = os.environ['ENDPOINT_NAME']
BUCKET_NAME = os.environ['BUCKET_NAME']
STATUS_TABLE = os.environ['STATUS_TABLE_NAME']
REGION = os.environ.get('AWS_DEFAULT_REGION', 'ap-northeast-1')
table = dynamodb.Table(STATUS_TABLE)


def handler(event, context):
    for record in event['Records']:
        body = json.loads(record['body'])
        s3_event = json.loads(body['Message']) if 'Message' in body else body
        file_key = s3_event['Records'][0]['s3']['object']['key']

        asyncio.get_event_loop().run_until_complete(process_file(file_key))


async def process_file(file_key):
    now = datetime.now().isoformat()

    # 1. 冪等性確保: PENDING → PROCESSING の条件付き更新
    try:
        table.update_item(
            Key={'file_key': file_key},
            UpdateExpression='SET #s = :processing, updated_at = :t',
            ConditionExpression='#s = :pending',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={
                ':processing': 'PROCESSING',
                ':pending': 'PENDING',
                ':t': now,
            }
        )
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return  # 既に処理中または完了済み
        raise

    try:
        # 2. S3からPDFを /tmp にダウンロード
        tmp_path = f'/tmp/{os.path.basename(file_key)}'
        s3.download_file(BUCKET_NAME, file_key, tmp_path)

        # 3. yomitoku-client で解析
        start = time.time()

        async with YomitokuClient(
            endpoint=ENDPOINT_NAME,
            region=REGION,
            max_workers=2,  # Lambda内の並列数（メモリに応じて調整）
            request_config=RequestConfig(
                read_timeout=60,
                connect_timeout=10,
                max_retries=3,
            ),
            circuit_config=CircuitConfig(
                threshold=5,
                cooldown_time=30,
            ),
        ) as client:
            result = await client.analyze_async(tmp_path)

        elapsed = int((time.time() - start) * 1000)

        # 4. 結果を変換してS3に保存（JSON、一次成果物）
        parsed = parse_pydantic_model(result)
        output_key = file_key.replace('input/', 'output/').replace('.pdf', '.json')

        # /tmp に一時保存してからS3にアップロード
        tmp_output = f'/tmp/{os.path.basename(output_key)}'
        parsed.to_json(tmp_output)

        with open(tmp_output, 'r') as f:
            json_content = f.read()

        s3.put_object(
            Bucket=BUCKET_NAME,
            Key=output_key,
            Body=json_content,
            ContentType='application/json',
        )

        # 5. DynamoDB: COMPLETED
        table.update_item(
            Key={'file_key': file_key},
            UpdateExpression='SET #s = :s, updated_at = :t, output_key = :o, processing_time_ms = :p',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={
                ':s': 'COMPLETED',
                ':t': datetime.now().isoformat(),
                ':o': output_key,
                ':p': elapsed,
            }
        )

    except Exception as e:
        table.update_item(
            Key={'file_key': file_key},
            UpdateExpression='SET #s = :s, updated_at = :t, error_message = :e',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={
                ':s': 'FAILED',
                ':t': datetime.now().isoformat(),
                ':e': str(e),
            }
        )
        raise  # SQSリトライのため例外を再送出

    finally:
        # /tmp のファイルを削除
        for path in [tmp_path, tmp_output]:
            if os.path.exists(path):
                os.remove(path)
```

---

## 10. IAM 権限設計

### 処理ワーカーLambda 実行ロール

```typescript
// CDK での権限付与
inputBucket.grantRead(processorLambda, 'input/*');
outputBucket.grantWrite(processorLambda, 'output/*');
statusTable.grantReadWriteData(processorLambda);
processingQueue.grantConsumeMessages(processorLambda);

processorLambda.addToRolePolicy(new iam.PolicyStatement({
  actions: ['sagemaker:InvokeEndpoint'],
  resources: [`arn:aws:sagemaker:${region}:${account}:endpoint/yomitoku-pro-*`],
}));
```

### エンドポイント制御用ロール（Step Functions / Lambda）

```typescript
endpointControlRole.addToRolePolicy(new iam.PolicyStatement({
  actions: [
    'sagemaker:CreateEndpoint',
    'sagemaker:DeleteEndpoint',
    'sagemaker:DescribeEndpoint',
  ],
  resources: [`arn:aws:sagemaker:${region}:${account}:endpoint/yomitoku-pro-*`],
}));

controlTable.grantReadWriteData(endpointControlRole);
```

### アクセス制御の原則

SageMakerエンドポイントにはリソースベースポリシーが存在しない。「Lambdaのみが実行可能」は、Lambda実行ロールにのみ InvokeEndpoint 権限を付与し、他のIAMエンティティには付与しないことで実現する。

---

## 11. CDK プロジェクト構成

```
yomitoku-pro-cdk/
  bin/
    app.ts                          CDKエントリポイント
  lib/
    sagemaker-stack.ts              CfnModel, CfnEndpointConfig, IAMロール
    processing-stack.ts             S3, SQS, Lambda, DynamoDB, EventBridge Pipes
    orchestration-stack.ts          Step Functions（エンドポイント制御）
    monitoring-stack.ts             CloudWatch Alarm, Dashboard
  lambda/
    processor/
      index.py                     処理ワーカー
      requirements.txt             yomitoku-client
      Dockerfile                   コンテナイメージ定義
    endpoint-control/
      index.py                     エンドポイント制御ヘルパー（Step Functionsから呼び出し）
  cdk.json
  package.json
  tsconfig.json
```

CDKでのコンテナイメージLambda定義:

```typescript
const processorLambda = new lambda.DockerImageFunction(this, 'ProcessorLambda', {
  code: lambda.DockerImageCode.fromImageAsset('lambda/processor'),
  memorySize: 2048,
  timeout: Duration.minutes(10),
  environment: {
    ENDPOINT_NAME: 'yomitoku-pro-endpoint',
    BUCKET_NAME: bucket.bucketName,
    STATUS_TABLE_NAME: statusTable.tableName,
  },
  reservedConcurrentExecutions: 4,
});
```

---

## 12. 開発方針

### パッケージマネージャ

Node.js のパッケージマネージャには pnpm を使用する。npm / yarn は使用しない。

```bash
# 依存のインストール
pnpm install

# パッケージの追加
pnpm add <package>
pnpm add -D <package>  # devDependencies
```

CDK CLI の実行は `npx cdk` 経由で行う（pnpm が node_modules/.bin を解決する）。

### Lint / Format

CDK プロジェクト（TypeScript）の Lint および Format には Biome を使用する。ESLint / Prettier は使用しない。

```bash
# セットアップ
pnpm install --save-dev @biomejs/biome
npx biome init
```

biome.json の設定例:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  }
}
```

package.json にスクリプトを追加:

```json
{
  "scripts": {
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write ."
  }
}
```

### CDK Nag

全スタックに cdk-nag を適用し、セキュリティ・コンプライアンスの状況を把握する。全ての警告を解消する必要はないが、各指摘を確認し、対応/抑制の判断を記録する。

```bash
pnpm install --save-dev cdk-nag
```

bin/app.ts での適用:

```typescript
import { App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

const app = new App();
// 各スタックの定義...

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
```

抑制が必要な場合は理由を明記する:

```typescript
import { NagSuppressions } from 'cdk-nag';

NagSuppressions.addStackSuppressions(stack, [
  {
    id: 'AwsSolutions-SQS3',
    reason: 'このキュー自体がDLQであるため、さらにDLQを設定する必要はない',
  },
]);
```

cdk-nag の運用方針:
- cdk synth 時に全ての指摘が出力される
- 指摘を確認し、対応が必要なものは修正する
- 対応しないものは NagSuppressions で抑制し、理由を必ず記録する
- 全指摘への対応/抑制を完了した状態でデプロイする（未確認の指摘を残さない）

### Lambda コードのテスト（TDD）

処理ワーカー Lambda のコードは TDD（テスト駆動開発）で実装する。テストを先に書き、テストが通る最小限のコードを実装する。

テストフレームワーク: pytest + moto（AWS サービスのモック）

```
lambda/
  processor/
    index.py
    requirements.txt
    Dockerfile
    tests/
      __init__.py
      requirements-test.txt    # pytest, moto, pytest-asyncio
      test_handler.py          # handler のテスト
      test_process_file.py     # process_file のテスト
```

テスト対象と方針:

| テスト対象 | 方針 |
|---|---|
| SQS メッセージのパース | S3イベント通知の各形式（直接 / SNS経由）に対応するか |
| DynamoDB 条件付き更新（冪等性） | PENDING → PROCESSING が成功すること、二重実行がスキップされること |
| S3 ダウンロード / アップロード | moto でモック化し、正しいキーに対して読み書きするか |
| yomitoku-client 呼び出し | unittest.mock で YomitokuClient をモック化し、正常系/異常系を検証 |
| 例外時の DynamoDB FAILED 更新 | 処理失敗時にステータスが FAILED に更新され、例外が再送出されるか |
| /tmp ファイルの後始末 | 正常系/異常系いずれでも /tmp のファイルが削除されること |

実行:

```bash
cd lambda/processor
pip install -r tests/requirements-test.txt
pytest tests/ -v
```

---

## 13. コスト試算

前提: ml.g5.xlarge、ソフトウェア料金 $10/h、月間1,000ファイル処理

| 項目 | 常時起動 | オンデマンド（方式A） |
|---|---|---|
| 稼働時間/月 | 720時間 | 約25時間（1回30分 x 50回） |
| SWコスト（USD） | $7,200 | $250 |
| インフラコスト概算（USD） | 別途 | 別途 |
| 削減率 | - | 約96.5% |

ページ単価（USD、ソフトウェア料金のみ）:
- ml.g5.xlarge: 約$0.0017/ページ（理論値 6,000ページ/時間）
- 実効値: 理論値の60-80%程度

注意: 全てUSD建て。日本円換算時は為替レート前提を明記すること（例: 1 USD = 150 JPYの場合、ml.g5.xlargeは約0.26円/ページ）。

---

## 14. 運用設計

### 失敗時の対応フロー

```
処理失敗
  |-- boto3 自動リトライ（max_retries=3、通信エラー/5xx）
  |-- SQS リトライ（visibility timeout 後に再処理、最大3回）
  |-- DLQ 移動（3回失敗後）
  v
運用者が DLQ を確認
  |-- 失敗原因を分類
  |     |-- サイズ超過: DPI を下げて再処理
  |     |-- タイムアウト: 重いページの特定、リトライ
  |     |-- モデルエラー (5xx): SageMaker側の状態確認
  |     |-- 一時的エラー: DLQ redrive でメインキューに戻す
  v
DLQ redrive or 手動再処理
```

### 429/5xx 対策

並列ワーカー数（Lambda Reserved Concurrency）はSageMakerエンドポイントの処理能力に応じて調整する。ワーカー数を上げすぎるとSageMaker側で429が増加する。

サーキットブレーカーの代替として、Lambda側で連続失敗を検知した場合に処理を一時停止する仕組みを検討する（SQSのvisibility timeout延長、またはCloudWatch Alarmで通知）。

### 監視項目

| メトリクス | 閾値 | アクション |
|---|---|---|
| SQS ApproximateAgeOfOldestMessage | > 30分 | エンドポイント起動遅延の調査 |
| SQS ApproximateNumberOfMessagesVisible | > 100 | バースト対応確認 |
| DLQ ApproximateNumberOfMessagesVisible | > 0 | 失敗原因調査 |
| Lambda Errors | > 0 | ログ確認 |
| Lambda Duration | > 480秒（タイムアウト10分の80%） | 処理時間の調査 |
| SageMaker InvocationErrors | > 0 | エンドポイント状態確認 |
| SageMaker ModelLatency | > 45秒/リクエスト | 重いページの調査 |

---

## 15. デプロイ手順

1. AWS MarketplaceでYomiToku-Proをサブスクライブ
2. サブスクリプション後にModel Package ARN を確認（ap-northeast-1）
3. CDKプロジェクトを初期化
   ```bash
   mkdir yomitoku-pro-cdk && cd yomitoku-pro-cdk
   npx cdk init app --language typescript
   ```
4. cdk.json にModel Package ARNを設定
5. コンテナイメージのローカルビルド確認（任意）
   ```bash
   cd lambda/processor
   docker build -t yomitoku-processor .
   ```
6. 各スタックを実装（sagemaker → processing → orchestration → monitoring の順）
7. デプロイ（CDKがコンテナイメージのビルドとECRへのプッシュを自動実行）
   ```bash
   npx cdk deploy --all
   ```
8. S3 input/ にPDFをアップロードして動作確認
9. DynamoDBステータステーブルで処理結果を確認
10. CloudWatchダッシュボードで監視を確認

### デプロイ前の確認事項

- Model Package ARN が正しいか
- SageMaker実行ロールにMarketplaceモデルへのアクセス権があるか
- Docker が動作する環境であること（CDKがコンテナイメージをビルドする）
- SQS visibility timeout が Lambda タイムアウトの6倍以上か（10分 x 6 = 60分）

---

## 16. 今後の追加実装ロードマップ

初期実装に含めないもの（セクション1参照）のうち、追加時期の目安を整理する。

### 初回デプロイ時に対応

| 項目 | 内容 |
|---|---|
| yomitoku-client バージョン固定 | requirements.txt でバージョンをピン留めして再現性を確保する |

### 運用開始後に対応（1-2週間目安）

| 項目 | 内容 |
|---|---|
| CloudWatch Dashboard | 運用で判明した重要メトリクスをダッシュボード化 |
| 処理結果の通知 | DynamoDB Streams → Lambda → SNS/メール等 |

### 要望・要件に応じて対応

| 項目 | トリガー | 実装規模 |
|---|---|---|
| 出力形式変換Lambda | JSON以外の形式要望 | 中（変換Lambda + S3トリガー or API） |
| 画像ファイル対応 | PDF以外の入力要望 | 小（入力判定の分岐追加） |
| ページ数上限 | 100ページ超のPDF運用 | 小（バリデーション追加） |
| API Gateway / フロントエンド | ユーザー向けUI要望 | 大（新規スタック） |

### 技術的な検証が必要

| 項目 | 前提条件 | 実装規模 |
|---|---|---|
| 方式B/C の実機検証 | Marketplaceサブスクリプション完了後 | 中（エンドポイント設定変更） |
| VPCエンドポイント | セキュリティ要件の追加 | 中（VPC設計 + 各種エンドポイント） |
| ECS Fargate ワーカー | Lambda制限に抵触するケースの発生 | 大（ECSタスク定義 + 新規ワーカー） |
| コンテナイメージサイズ最適化 | デプロイ時間が問題になった場合 | 小（Dockerfileマルチステージ化） |
| マルチリージョン | DR/レイテンシ要件 | 大（全リソースの複製） |
