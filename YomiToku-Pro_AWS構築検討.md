# YomiToku-Pro AWS構築検討

## 1. 目的

YomiToku-Pro（AWS Marketplace提供のSageMakerモデル）をAWS上に構築し、S3上のファイルをバッチ的に処理するシステムをCDKで実装する。

---

## 2. YomiToku-Pro 基本仕様

### 提供形態

- AWS Marketplace上のAmazon SageMakerモデルパッケージ
- 提供元: MLism株式会社
- クライアントSDK: yomitoku-client（Apache License 2.0）

### Model Package ARN

リージョンごとに異なる。サブスクリプション後にAWSコンソールから確認可能。

- us-east-1の例: `arn:aws:sagemaker:us-east-1:865070037744:model-package/yomitoku-pro-document-analyzer-25381d523aeb39ef85cdbbc3551262be`
- ap-northeast-1（東京）: サブスクリプション後に確認

### 対応インスタンスタイプ

| インスタンス | GPU/CPU | 推奨用途 |
|---|---|---|
| ml.g4dn.xlarge | GPU | テスト・リアルタイム推論 |
| ml.g5.xlarge | GPU | 高性能推論（推奨） |
| ml.g6.xlarge | GPU | リアルタイム・バッチ |
| ml.c7i.xlarge | CPU | CPU推論 |
| ml.c7i.2xlarge | CPU | CPU推論 |

### 料金

- ソフトウェア: $10.00/ホスト/時間（全インスタンスタイプ共通）
- AWSインフラコスト: 別途
- 課金単位: デプロイ完了からアンデプロイまで、1秒単位

### 入出力仕様

| 項目 | 内容 |
|---|---|
| 入力形式 | PDF, JPEG, PNG, TIFF |
| API出力 | JSON（SageMakerエンドポイントからの直接レスポンス） |
| クライアント経由出力 | JSON, HTML, Markdown, CSV, Searchable PDF |
| 推奨画像解像度 | 短辺 720px 以上 |

### 推論モード

- リアルタイム推論: 対応（invoke_endpoint）
- バッチ変換: 現時点でyomitoku-clientでは未サポート

### パフォーマンス

- ml.g5.xlarge使用時: 約0.60秒/ページ（理論値）
- 実効値: 理論値の60-80%程度（I/O待ちや初期化のオーバーヘッドあり）

---

## 3. yomitoku-client 詳細調査

### 基本情報

| 項目 | 内容 |
|---|---|
| パッケージ名 | yomitoku-client |
| ライセンス | Apache License 2.0 |
| 対応Python | 3.10, 3.11, 3.12（3.13は未対応） |
| 提供元 | MLism株式会社 |
| サポート | support-aws-marketplace@mlism.com |

### 依存パッケージ

| パッケージ | バージョン | 用途 |
|---|---|---|
| boto3 | >= 1.26.0 | AWS SDK（SageMaker呼び出し） |
| pydantic | >= 2.9.2 | データバリデーション・モデル定義 |
| pandas | >= 2.1.0 | データ処理 |
| numpy | >= 1.26.0 | 数値計算 |
| opencv-python | >= 4.8.0 | 画像処理 |
| Pillow | >= 9.5.0 | 画像処理 |
| PyPDF2 | >= 3.0.0 | PDF処理 |
| pypdfium2 | == 4.30.0 | PDF処理（バージョン固定） |
| reportlab | >= 4.4.1 | Searchable PDF生成 |
| lxml | >= 5.3.0 | XML/HTML処理 |
| jaconv | >= 0.4.0 | 日本語文字変換 |
| click | >= 8.1.0 | CLIフレームワーク |
| requests | >= 2.28.0 | HTTP通信 |

注意: opencv-python, pandas, numpy など依存パッケージが多いため、Lambda Layerまたはコンテナイメージでの利用を検討する必要がある。

### インストール方法

```bash
# pip
pip install yomitoku-client

# uv（推奨）
uv add yomitoku-client

# 一時的な実行（インストール不要）
uvx yomitoku-client single image.pdf -e endpoint -f md
```

### API（Python）

#### クライアント初期化

```python
from yomitoku_client import YomitokuClient, parse_pydantic_model

# 同期
with YomitokuClient(
    endpoint="endpoint-name",
    region="ap-northeast-1",
    max_workers=4,                # 並列ワーカー数（デフォルト: 4）
    request_config=RequestConfig(
        read_timeout=60,          # レスポンス待ちタイムアウト（秒）
        connect_timeout=10,       # 接続タイムアウト（秒）
        max_retries=3,            # boto3リトライ回数
    ),
    circuit_config=CircuitConfig(
        threshold=5,              # サーキットブレーカー発動閾値
        cooldown_time=30,         # クールダウン時間（秒）
    ),
) as client:
    result = client.analyze("file.pdf")

# 非同期
async with YomitokuClient(endpoint="endpoint-name", region="ap-northeast-1") as client:
    result = await client.analyze_async("file.pdf")
```

#### 設定クラス

RequestConfig（データクラス）:

| フィールド | 型 | デフォルト | 説明 |
|---|---|---|---|
| read_timeout | int | 60 | レスポンス受信までの最大待ち時間（秒） |
| connect_timeout | int | 10 | 接続確立までの最大待ち時間（秒） |
| max_retries | int | 3 | boto3のリトライ回数（standardモード） |

CircuitConfig（データクラス）:

| フィールド | 型 | デフォルト | 説明 |
|---|---|---|---|
| threshold | int | 5 | 連続失敗回数がこの値を超えるとサーキットオープン |
| cooldown_time | int | 30 | サーキットオープン後の待機時間（秒） |

サーキットブレーカーはHTTP 429（レート制限）および5xxレスポンスのみカウントする。その他の例外はカウント対象外。

#### 主要メソッド

| メソッド | 種別 | 説明 |
|---|---|---|
| analyze(file_path) | 同期 | 単一ファイルの解析 |
| analyze_async(file_path) | 非同期 | 単一ファイルの非同期解析（ページ並列処理） |
| analyze_batch_async(input_dir, output_dir) | 非同期 | ディレクトリ内の一括処理 |

#### analyze_batch_async の全パラメータ

```python
await client.analyze_batch_async(
    input_dir="./input",           # 入力ディレクトリ（必須）
    output_dir="./output",         # 出力ディレクトリ（必須）
    dpi=200,                       # PDF→画像変換のDPI（デフォルト: 200）
    page_index=None,               # 処理対象ページ（None=全ページ, int or list）
    request_timeout=None,          # 1ページあたりのタイムアウト（秒）
    total_timeout=None,            # バッチ全体のタイムアウト（秒）
    overwrite=False,               # True: 既存結果も再処理 / False: 失敗分のみ再処理
    log_path=None,                 # ログ出力先（デフォルト: output_dir/process_log.jsonl）
)
```

#### process_log.jsonl の構造

バッチ処理時に出力されるログファイル。各行がJSON形式で1ファイルの処理結果を記録:

```json
{
  "timestamp": "2026-03-02T10:30:00+09:00",
  "file_path": "./input/doc001.pdf",
  "output_path": "./output/doc001.json",
  "dpi": 200,
  "executed": true,
  "success": true,
  "error": null
}
```

| フィールド | 説明 |
|---|---|
| timestamp | 処理日時（ISO 8601、JST） |
| file_path | 入力ファイルのパス |
| output_path | 出力ファイルのパス |
| dpi | 使用したDPI |
| executed | 実行されたか（overwrite=Falseで既存スキップ時はfalse） |
| success | 処理が成功したか |
| error | エラーメッセージ（成功時はnull） |

overwrite=False の場合、process_log.jsonl を参照して以前失敗したファイルのみ再処理する。

#### 出力変換メソッド

analyze の結果を `parse_pydantic_model(result)` で変換後、以下のメソッドで出力:

| メソッド | 説明 |
|---|---|
| to_markdown(output_path) | Markdown形式で出力（画像埋め込みオプションあり） |
| to_json(output_path) | JSON形式で出力（ページ統合/分割モード） |
| to_csv(output_path) | CSV形式で出力 |
| to_html(output_path) | HTML形式で出力（ページ指定可能） |
| to_pdf(output_path) | Searchable PDF形式で出力 |
| visualize() | OCR/レイアウト解析結果の可視化 |

### CLI

#### 単一ファイル処理

```bash
yomitoku-client single ${file_path} \
  -e ${endpoint_name} \
  -r ${region} \
  -f md \
  -o output_dir
```

#### バッチ処理

```bash
yomitoku-client batch \
  -i ${input_dir} \
  -o ${output_dir} \
  -e ${endpoint_name} \
  -f md
```

#### CLIオプション一覧

| オプション | 説明 | デフォルト |
|---|---|---|
| -e, --endpoint | SageMakerエンドポイント名 | （必須） |
| -r, --region | AWSリージョン | （必須） |
| -f, --format | 出力形式（json, csv, html, md, pdf） | - |
| -o, --outdir | 出力ディレクトリ | - |
| -p, --profile | AWS CLIプロファイル | - |
| --dpi | 画像解像度 | - |
| -v, --vis_mode | 可視化モード（both/ocr/layout/none） | - |
| -s, --split_mode | ファイル分割（combine/separate） | - |
| --pages | 処理対象ページ指定 | - |
| --workers | 並列処理ワーカー数 | 4 |
| --max_retries | HTTPリトライ回数 | 3 |
| --request_timeout | リクエストタイムアウト | - |
| --total_timeout | 全体タイムアウト | - |
| --overwrite | 既存結果の上書き | false |
| --intermediate_save | 中間RAW JSONの保存 | false |

### 実行時の制限・制約

#### SageMaker invoke_endpoint の制限

| 制限項目 | 値 |
|---|---|
| リクエストペイロード最大サイズ | 6MB (6,291,456 bytes) |
| レスポンスペイロード最大サイズ | 6MB (6,291,456 bytes) |
| モデル応答タイムアウト | 60秒 |
| ContentType ヘッダー最大長 | 1024文字 |

この6MB制限はSageMaker Runtime APIの仕様であり、yomitoku-clientの制限ではない。yomitoku-clientは内部でPDFをページ分割して送信するため、1ページあたり6MB以内であれば処理可能。

注意: AWSのHosting FAQには「リアルタイム推論のペイロードは最大25MB」という記述があるが、これはRuntime API（invoke_endpoint）の制限とは異なる。SDK/Runtime APIを使用する場合の実効制限は6,291,456 bytes（約6MB）であるため、実装上は6MBで制約設計するのが安全である。

#### yomitoku-client の内部動作（ソースコード確認済み）

エンドポイント呼び出し:

```python
self.sagemaker_runtime.invoke_endpoint(
    EndpointName=self.endpoint,
    ContentType=payload.content_type,  # PDF入力時は最終的に "image/png" になる
    Body=payload.body,                 # バイナリデータ（base64ではない）
)
```

PDF処理の流れ:
1. PDFを `load_pdf_to_bytes()` でページ分割
2. 各ページをPNG形式にラスタライズ（DPIパラメータで解像度指定、デフォルト200）
3. ContentTypeを `"image/png"` に設定（PDFバイナリをそのまま送るのではない）
4. ページごとにPNGバイナリとして invoke_endpoint に送信
5. asyncio.Semaphore（max_workers）で並列数を制御

重要: invoke_endpoint に送信されるのはPDFそのものではなく、ページごとのPNG画像である。したがってLambdaやECSでboto3を直接使う場合も、必ずPDF→PNG変換を行い `ContentType='image/png'` で送信する必要がある（`ContentType='application/pdf'` でPDFバイナリを直接送ると失敗する）。1ページのPNG画像サイズが6MB以内であれば問題ない（A4/200DPIでは通常1-3MB程度）。

タイムアウトの自動計算:
- analyze_async のtotal_timeoutは未指定時に自動計算される
- 計算式: (request_timeout + 5秒) x ceil(ページ数 / ワーカー数) x 1.5
- request_timeout 未指定時は read_timeout の値を使用

並列処理:
- ThreadPoolExecutor（max_workers）でブロッキングInvoke操作を並列化
- asyncio.Semaphore（max_workers）でバッチ処理の同時実行数を制御
- max_workers のデフォルト値は4

#### タイムアウト設定（3階層）

| 設定 | デフォルト | 説明 |
|---|---|---|
| connect_timeout | 10秒 | 接続確立までの最大待ち時間 |
| read_timeout | 60秒 | レスポンス受信までの最大待ち時間 |
| request_timeout | 設定可能 | 1ページあたりの処理制限時間 |
| total_timeout | 設定可能 | バッチ全体の処理制限時間（超過時は未完了タスクをキャンセル） |

#### リトライ・サーキットブレーカー

| 設定 | デフォルト | 説明 |
|---|---|---|
| max_retries | 3 | boto3レベルのリトライ回数（通信エラー・5xxレスポンス） |
| threshold_circuit | 5 | サーキットブレーカー発動までの連続失敗回数 |
| cooldown_time | 30秒 | サーキットブレーカー発動後の待機時間 |

サーキットブレーカー: 連続失敗がthreshold_circuitを超えると全リクエストを一時停止し、cooldown_time後に自動再開する。

#### バッチ処理のログ

バッチ処理時に `process_log.jsonl` が出力され、ファイルごとの処理結果（成功/失敗、処理時間、エラー詳細）が記録される。`--overwrite` フラグがない場合、失敗したファイルのみ再処理される。

### IAM権限要件

#### エンドポイント呼び出しのみ

```json
{
  "Effect": "Allow",
  "Action": [
    "sagemaker:DescribeEndpoint",
    "sagemaker:InvokeEndpoint"
  ],
  "Resource": "arn:aws:sagemaker:ap-northeast-1:*:endpoint/yomitoku-*"
}
```

#### エンドポイント管理（作成/更新/削除）も行う場合

```json
{
  "Effect": "Allow",
  "Action": [
    "cloudformation:*",
    "sagemaker:*",
    "iam:*Role",
    "iam:*RolePolicy"
  ],
  "Resource": "*"
}
```

#### 認証方式

| 方式 | 用途 | 説明 |
|---|---|---|
| IAMユーザー + アクセスキー | 個人利用・テスト | ~/.aws/credentials に保存 |
| IAMロール + AssumeRole | MFA環境 | 一時認証情報を使用 |
| EC2インスタンスプロファイル | AWS上のサービス | メタデータから自動取得 |

Lambda/ECSで利用する場合はIAMロール（実行ロール）にsagemaker:InvokeEndpointの権限を付与する。

### パフォーマンス（公式値）

| インスタンスタイプ | 理論スループット | ページ単価（USD） |
|---|---|---|
| ml.g5.xlarge | 約6,000ページ/時間 | 約$0.0017/ページ |
| ml.g6.xlarge | 約4,500ページ/時間 | 約$0.0022/ページ |
| ml.g4dn.xlarge | 約3,000ページ/時間 | 約$0.0033/ページ |

ページ単価の計算式: ソフトウェア料金 $10/h / 理論スループット（ページ/時間）。AWSインフラコスト（インスタンス料金）は別途加算。

注意: 上記は全てUSD建て。日本円換算する場合は為替レートの前提を明記すること（例: 1 USD = 150 JPY の場合、ml.g5.xlargeは約0.26円/ページ）。為替変動および実稼働率により大きく変動する。

実効値は理論値の60-80%程度（I/O待ち・初期化オーバーヘッドにより変動）。

### Lambda利用時の考慮事項

yomitoku-clientをLambda内で使用する場合の注意点:

1. 依存パッケージが多い（opencv-python, pandas, numpy等）ため、通常のzipデプロイでは250MBの制限に抵触する可能性が高い
2. コンテナイメージ（最大10GB）でのデプロイを推奨
3. /tmpにファイルをダウンロードしてyomitoku-clientで処理する方式も可能（/tmp最大10GB）
4. または、yomitoku-clientを使わずboto3のinvoke_endpointを直接呼び出し、結果のJSON変換を自前で実装する方式も選択肢

### yomitoku-clientを使わない場合の方式

Lambda内でboto3のみで処理する場合、yomitoku-clientの内部動作を再現する:

```python
import boto3
import json
from pypdfium2 import PdfDocument
from io import BytesIO

sagemaker_runtime = boto3.client('sagemaker-runtime')

def process_pdf(file_bytes, endpoint_name, dpi=200):
    """PDFをページごとにPNG化してSageMakerに送信"""
    pdf = PdfDocument(file_bytes)
    results = []

    for page_index in range(len(pdf)):
        # ページをPNG画像にラスタライズ（yomitoku-clientと同じ方式）
        page = pdf[page_index]
        bitmap = page.render(scale=dpi / 72)
        pil_image = bitmap.to_pil()

        buf = BytesIO()
        pil_image.save(buf, format='PNG')
        png_bytes = buf.getvalue()

        # SageMakerに送信（ContentType: image/png）
        response = sagemaker_runtime.invoke_endpoint(
            EndpointName=endpoint_name,
            ContentType='image/png',
            Body=png_bytes
        )
        result = json.loads(response['Body'].read())
        results.append(result)

    return results
```

この方式の依存パッケージ:
- boto3（Lambda標準搭載）
- pypdfium2（PDF→PNG変換用、約15MB）
- Pillow（画像処理用、約10MB）

yomitoku-client全体（opencv-python, pandas, numpy等含む）と比較して大幅に軽量。Lambda Layerで対応可能。ただし出力形式の変換（JSON → Markdown等）は自前で実装する必要がある。

---

## 4. CDKでの構築可否

### 結論: 構築可能

CDKのL1コンストラクト（CloudFormation直接マッピング）を使用してSageMakerリソースを定義できる。SageMaker以外のリソース（S3, Lambda, DynamoDB, SQS等）は全てL2コンストラクト（高レベルAPI）が利用可能。

### SageMaker関連のCDKコンストラクト

| CDKコンストラクト | CloudFormation | 役割 | レベル |
|---|---|---|---|
| CfnModel | AWS::SageMaker::Model | Marketplaceモデルパッケージの参照 | L1 |
| CfnEndpointConfig | AWS::SageMaker::EndpointConfig | インスタンスタイプ・台数の設定 | L1 |
| CfnEndpoint | AWS::SageMaker::Endpoint | エンドポイントのデプロイ | L1 |

### 注意点

- SageMakerのL2コンストラクトは未提供（CDK Issue #23158 でリクエスト中、p3優先度）
- L1コンストラクトのCfnModelのContainerDefinitionで`modelPackageName`プロパティを使用してMarketplaceモデルを参照
- CDKデプロイの前にAWSコンソールからYomiToku-Proのサブスクリプション完了が必要
- プロビジョンドエンドポイントのみ（サーバーレスはGPU非対応）

---

## 5. システムアーキテクチャ案

### 全体構成

```
S3 (input/)
  | ObjectCreated イベント通知
  v
SQS キュー (バッファリング・リトライ)
  | ポーリング
  v
Lambda (処理ワーカー)
  |-- DynamoDB: ステータスを PROCESSING に更新
  |-- S3からファイル取得
  |-- SageMaker Endpoint (invoke_endpoint) に送信
  |-- S3 (output/) に結果保存
  |-- DynamoDB: ステータスを COMPLETED or FAILED に更新
  v
S3 (output/) + DynamoDB (ステータス管理)
```

### 構成要素

| リソース | CDKコンストラクト | レベル | 用途 |
|---|---|---|---|
| S3バケット | s3.Bucket | L2 | 入出力ファイルの保存 |
| S3イベント通知 | s3_notifications.SqsDestination | L2 | ファイルアップロード検知 |
| SQSキュー | sqs.Queue | L2 | メッセージバッファリング |
| SQS DLQ | sqs.Queue | L2 | 処理失敗ファイルの隔離 |
| Lambda関数 | lambda.Function | L2 | 処理ワーカー |
| DynamoDBテーブル | dynamodb.Table | L2 | ステータス管理 |
| SageMaker Endpoint | CfnModel等 | L1 | OCR推論 |
| IAMロール | iam.Role | L2 | 各リソースの権限管理 |

### SQSを間に挟む理由

- リトライ制御: SageMakerのタイムアウトや一時的エラー時に自動再試行
- DLQ: 繰り返し失敗したファイルを隔離して後から確認可能
- 同時実行数制御: LambdaのReserved Concurrencyを制限してSageMakerエンドポイントへの負荷を調整
- バースト対応: 大量ファイルが一度にアップロードされても安定処理

### DynamoDB テーブル設計案

| 属性 | 型 | 説明 |
|---|---|---|
| file_key (PK) | String | S3オブジェクトキー（例: input/doc001.pdf） |
| status | String | PENDING / PROCESSING / COMPLETED / FAILED |
| created_at | String | アップロード検知日時（ISO 8601） |
| updated_at | String | 最終更新日時（ISO 8601） |
| output_key | String | 結果ファイルのS3キー（例: output/doc001.md） |
| output_format | String | 出力形式（json / md / html / csv / pdf） |
| error_message | String | エラー時のメッセージ |
| processing_time_ms | Number | 処理時間（ミリ秒） |
| page_count | Number | PDFのページ数 |
| retry_count | Number | リトライ回数 |

GSI: status-created_at-index（ステータス別のクエリ用）

### Lambda処理の概要

```python
import boto3
import json
import time
from datetime import datetime
from botocore.exceptions import ClientError

s3 = boto3.client('s3')
sagemaker_runtime = boto3.client('sagemaker-runtime')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('yomitoku-status')

ENDPOINT_NAME = 'yomitoku-pro-endpoint'
BUCKET_NAME = 'yomitoku-documents'

def handler(event, context):
    for record in event['Records']:
        body = json.loads(record['body'])
        s3_event = json.loads(body['Message']) if 'Message' in body else body
        file_key = s3_event['Records'][0]['s3']['object']['key']

        try:
            # 1. DynamoDB: PROCESSING に更新（条件付き更新で冪等性を確保）
            #    SQSはat-least-once配送のため、重複メッセージの可能性がある
            try:
                table.update_item(
                    Key={'file_key': file_key},
                    UpdateExpression='SET #s = :processing, updated_at = :t',
                    ConditionExpression='#s = :pending',
                    ExpressionAttributeNames={'#s': 'status'},
                    ExpressionAttributeValues={
                        ':processing': 'PROCESSING',
                        ':pending': 'PENDING',
                        ':t': datetime.now().isoformat()
                    }
                )
            except ClientError as e:
                if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                    return  # 既に処理中または完了済み → スキップ
                raise

            # 2. S3からファイルを取得
            response = s3.get_object(Bucket=BUCKET_NAME, Key=file_key)
            file_bytes = response['Body'].read()

            # 3. PDF→PNG変換してSageMaker Endpointに送信
            #    yomitoku-clientの内部動作と同様、PDFをページごとにPNG化して送信する。
            #    invoke_endpointのContentTypeは image/png（application/pdfではない）。
            from pypdfium2 import PdfDocument
            from io import BytesIO

            start = time.time()
            pdf = PdfDocument(file_bytes)
            page_results = []

            for page_index in range(len(pdf)):
                page = pdf[page_index]
                bitmap = page.render(scale=200 / 72)  # DPI=200
                pil_image = bitmap.to_pil()
                buf = BytesIO()
                pil_image.save(buf, format='PNG')
                png_bytes = buf.getvalue()

                sm_response = sagemaker_runtime.invoke_endpoint(
                    EndpointName=ENDPOINT_NAME,
                    ContentType='image/png',
                    Body=png_bytes
                )
                page_result = json.loads(sm_response['Body'].read())
                page_results.append(page_result)

            elapsed = int((time.time() - start) * 1000)

            # 4. 結果をS3 output/ に保存（JSON形式を一次成果物とする）
            output_key = file_key.replace('input/', 'output/').replace('.pdf', '.json')
            s3.put_object(
                Bucket=BUCKET_NAME,
                Key=output_key,
                Body=json.dumps(page_results, ensure_ascii=False),
                ContentType='application/json'
            )

            # 5. DynamoDB: COMPLETED に更新
            table.update_item(
                Key={'file_key': file_key},
                UpdateExpression='SET #s = :s, updated_at = :t, output_key = :o, processing_time_ms = :p',
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues={
                    ':s': 'COMPLETED', ':t': now(),
                    ':o': output_key, ':p': elapsed
                }
            )

        except Exception as e:
            # エラー時: FAILED に更新
            table.update_item(
                Key={'file_key': file_key},
                UpdateExpression='SET #s = :s, updated_at = :t, error_message = :e',
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues={
                    ':s': 'FAILED', ':t': now(), ':e': str(e)
                }
            )
            raise  # SQSリトライのために例外を再送出
```

---

## 6. 検討事項

### Lambda vs ECS

| 項目 | Lambda | ECS (Fargate) |
|---|---|---|
| 最大実行時間 | 15分 | 制限なし |
| メモリ上限 | 10GB | タスク定義で自由に設定 |
| ペイロード上限 | 6MB（同期invoke） | 制限なし |
| コスト | 実行時間課金 | タスク実行中課金 |
| スケーリング | 自動（concurrency制御可） | タスク数で制御 |
| 適するケース | 通常サイズのPDF（数MB） | 大容量ファイル、長時間処理 |

通常のビジネス文書（数MB、数十ページ以下）であればLambdaで十分対応可能。SageMakerの invoke_endpoint には6MBのペイロード上限があるため、大容量PDFの場合は分割送信やSageMaker非同期推論の検討が必要。

### エンドポイントのコスト最適化（起動停止制御）

エンドポイントは常時起動で課金される（$10/h + インフラコスト）ため、処理タスクに応じて起動停止する仕組みを検討する。3つの方式がある。

#### 方式比較

| 項目 | 方式A: プログラム的な作成/削除 | 方式B: 非同期推論 + ゼロスケール | 方式C: リアルタイム推論 + ゼロスケール |
|---|---|---|---|
| 概要 | 処理時にエンドポイントを作成し、完了後に削除 | 非同期エンドポイントをゼロインスタンスにスケール | Inference Componentを使いゼロにスケール |
| コールドスタート | 5-10分（エンドポイント作成） | 5分程度（インスタンス起動） | 5分程度（インスタンス起動） |
| アイドル時コスト | なし（エンドポイント自体が存在しない） | なし（0インスタンス時は課金なし） | なし（0インスタンス時は課金なし） |
| リクエストキューイング | SQSで自前管理 | SageMaker側で自動キューイング | 不可（ゼロインスタンス中はInvokeがエラー、SQSバッファが必須） |
| Marketplaceモデル互換性 | 確実に対応 | 要確認 | 要確認（Inference Component必須） |
| 実装の複雑さ | 中（Step Functions等で制御） | 低（設定のみ） | 高（Inference Component + CloudWatch Alarm） |
| CDK対応 | 全てL2/L1で対応可 | 対応可 | 対応可 |

#### 方式A: プログラム的なエンドポイント作成/削除（推奨）

Marketplaceモデルとの互換性が確実であり、今回のSQSバッファリングアーキテクチャとの相性が良い方式。

処理フロー:

```
S3 (input/) にファイルアップロード
  |
  v
SQS キュー（メッセージがバッファされる）
  |
  v
Step Functions（またはLambda）がキューの状態を監視
  |-- キューにメッセージあり & エンドポイント未起動
  |     → SageMaker Endpoint を作成（5-10分）
  |     → エンドポイントがInServiceになるまで待機
  |     → 処理Lambda を起動してキューを消化
  |
  |-- キューが空 & 一定時間経過（例: 15分アイドル）
  |     → SageMaker Endpoint を削除
  |
  v
処理完了 → エンドポイント削除 → 課金停止
```

エンドポイント制御用Lambda（概要）:

```python
import boto3

sagemaker = boto3.client('sagemaker')

def create_endpoint():
    """エンドポイントを作成（モデルとエンドポイント設定は事前にCDKで作成済み）"""
    sagemaker.create_endpoint(
        EndpointName='yomitoku-pro-endpoint',
        EndpointConfigName='yomitoku-pro-config'
    )

def delete_endpoint():
    """エンドポイントを削除（課金停止）"""
    sagemaker.delete_endpoint(
        EndpointName='yomitoku-pro-endpoint'
    )

def check_endpoint_status():
    """エンドポイントの状態を確認"""
    try:
        response = sagemaker.describe_endpoint(
            EndpointName='yomitoku-pro-endpoint'
        )
        return response['EndpointStatus']  # InService / Creating / Deleting / Failed
    except sagemaker.exceptions.ClientError:
        return 'NotFound'
```

ポイント:
- CfnModel と CfnEndpointConfig はCDKで事前に作成しておく（削除しない）
- エンドポイントのみを作成/削除することで起動停止を制御
- モデルとエンドポイント設定は残るため、再作成時にこれらの情報を再定義する必要はない（ただしエンドポイント作成自体に数分かかる点は変わらない）
- SQSがバッファとして機能するため、コールドスタート中（数分）もファイルは失われない

必要な追加IAM権限:

```json
{
  "Effect": "Allow",
  "Action": [
    "sagemaker:CreateEndpoint",
    "sagemaker:DeleteEndpoint",
    "sagemaker:DescribeEndpoint"
  ],
  "Resource": "arn:aws:sagemaker:ap-northeast-1:ACCOUNT_ID:endpoint/yomitoku-pro-*"
}
```

コスト試算例（月間1,000ファイル処理の場合）:

| シナリオ | 稼働時間/月 | SWコスト | 備考 |
|---|---|---|---|
| 常時起動 | 720時間 | $7,200 | 24時間365日 |
| 業務時間のみ（8h x 22日） | 176時間 | $1,760 | スケジュール起動停止 |
| オンデマンド（1回30分 x 50回） | 25時間 | $250 | タスク駆動型 |

#### 方式B: 非同期推論（Async Inference）+ ゼロスケール

SageMakerの非同期推論はゼロインスタンスへのスケールダウンをネイティブにサポートしている。リクエストは自動的にキューイングされ、スケールアップ後に処理される。

```python
# 非同期推論エンドポイントの設定
client = boto3.client('application-autoscaling')

# スケーラブルターゲットの登録（MinCapacity=0でゼロスケール有効化）
client.register_scalable_target(
    ServiceNamespace='sagemaker',
    ResourceId='endpoint/yomitoku-pro-endpoint/variant/AllTraffic',
    ScalableDimension='sagemaker:variant:DesiredInstanceCount',
    MinCapacity=0,
    MaxCapacity=1
)

# ターゲット追跡スケーリングポリシー
client.put_scaling_policy(
    PolicyName='scale-to-zero-policy',
    ServiceNamespace='sagemaker',
    ResourceId='endpoint/yomitoku-pro-endpoint/variant/AllTraffic',
    ScalableDimension='sagemaker:variant:DesiredInstanceCount',
    PolicyType='TargetTrackingScaling',
    TargetTrackingScalingPolicyConfiguration={
        'TargetValue': 5.0,
        'CustomizedMetricSpecification': {
            'MetricName': 'ApproximateBacklogSizePerInstance',
            'Namespace': 'AWS/SageMaker',
            'Dimensions': [
                {'Name': 'EndpointName', 'Value': 'yomitoku-pro-endpoint'}
            ],
            'Statistic': 'Average',
        },
        'ScaleInCooldown': 600,
        'ScaleOutCooldown': 300,
    }
)

# ゼロからのスケールアップ用ステップスケーリング
client.put_scaling_policy(
    PolicyName='scale-from-zero-policy',
    ServiceNamespace='sagemaker',
    ResourceId='endpoint/yomitoku-pro-endpoint/variant/AllTraffic',
    ScalableDimension='sagemaker:variant:DesiredInstanceCount',
    PolicyType='StepScaling',
    StepScalingPolicyConfiguration={
        'AdjustmentType': 'ChangeInCapacity',
        'MetricAggregationType': 'Average',
        'Cooldown': 300,
        'StepAdjustments': [
            {'MetricIntervalLowerBound': 0, 'ScalingAdjustment': 1}
        ]
    }
)
```

利点:
- SageMakerがリクエストキューイングを自動管理
- SQSを自前で管理する必要がない
- スケーリングポリシーのみで制御可能

懸念:
- YomiToku-Pro（Marketplaceモデル）が非同期推論に対応しているか要確認
- yomitoku-clientが非同期推論エンドポイントに対応しているか要確認
- 公式ドキュメントでは「現時点ではYomiToku-Clientでバッチ変換はサポートされていない」と記載あり
- 非同期推論はリクエストがSageMaker側でキューイングされるため、ゼロインスタンス時もリクエスト自体はエラーにならない。ただしスケールアップまでの待ち時間（約5分）が発生する

#### 方式C: リアルタイム推論 + Inference Component + ゼロスケール

re:Invent 2024で発表された新機能。Inference Componentを使用することでリアルタイムエンドポイントでもゼロスケールが可能。

前提条件:
- Inference Componentの使用が必須
- EndpointConfigの ManagedInstanceScaling で MinInstanceCount=0 を設定
- ステップスケーリングポリシーとCloudWatch Alarmの設定が必要

コールドスタートの内訳（公式ブログより）:
- スケーリングトリガー検知: 約1分
- インスタンスプロビジョニング: 約1.7分
- モデルコピーのスケールアウト: 約2.3分
- 合計: 約5分

懸念:
- Inference Componentの利用がMarketplaceモデル（YomiToku-Pro）で可能か未確認
- ゼロインスタンス中のInvokeリクエストはエラーになる（公式ドキュメントに明記）。そのためSQSによるバッファリングが必須であり、方式Aと同様のSQS設計が別途必要になる
- 設定が複雑（Inference Component + Auto Scaling + CloudWatch Alarm）
- スケールアウト完了までの約5分間はリクエストを受け付けられないため、その間のエラーハンドリングも必要

#### 推奨方式

現時点では方式Aを推奨する。理由:

1. Marketplaceモデルとの互換性が確実（標準的なエンドポイント作成/削除APIを使用）
2. 既存のSQSバッファリングアーキテクチャと自然に統合できる
3. 制御が明示的でデバッグしやすい
4. コスト削減効果が最も高い（使わない時間はエンドポイント自体が存在しない）

方式B/Cは、AWS Marketplace上でYomiToku-Proをサブスクライブした後、非同期推論やInference Componentとの互換性を実機で確認してから検討する価値がある。

#### 方式Aの実装パターン: Step Functions によるオーケストレーション

起動検知の方式:

SQSには「メッセージ到着」をEventBridge Ruleで直接拾う仕組みはない。以下のいずれかを使用する:

| 方式 | 概要 | 利点 |
|---|---|---|
| EventBridge Pipes（推奨） | SQSをソースとしてStep Functionsを起動 | フィルタ/変換/バッチ処理が可能、公式にSQSソースに対応 |
| SQS → Lambda | SQS Event Source MappingでLambdaを起動し、起動判定を行う | シンプルだが競合制御が必須 |

推奨構成: EventBridge Pipes + Step Functions

```
SQS キュー
  |  EventBridge Pipes（SQSをソースとして設定）
  v
Step Functions ワークフロー
  |
  |-- [1] DynamoDB "endpoint_state" を条件付き更新で排他ロック取得
  |     +-- ロック取得失敗 → 他の実行が制御中のため終了
  |     +-- ロック取得成功 → [2] へ
  |
  |-- [2] DescribeEndpoint → 状態確認
  |     |
  |     +-- InService → [5] へ
  |     +-- Creating → [4] 待機ループへ
  |     +-- NotFound → [3] へ
  |
  |-- [3] CreateEndpoint
  |
  |-- [4] Wait(60秒) → DescribeEndpoint → InService? → No → [4]へ戻る
  |                                                    → Yes → [5]へ
  |
  |-- [5] 処理Lambdaを起動（SQSのメッセージを処理）
  |
  |-- [6] SQSキューが空か確認（ApproximateNumberOfMessages + ApproximateNumberOfMessagesNotVisible）
  |     +-- 処理中または未処理メッセージあり → [5]へ戻る
  |     +-- 全て空 → [7]へ
  |
  |-- [7] Wait(クールダウン: 15分)
  |
  |-- [8] SQSキューを再確認（処理中メッセージも含む）
  |     +-- メッセージあり → [5]へ戻る
  |     +-- 空 → [9]へ
  |
  |-- [9] DeleteEndpoint → DynamoDB ロック解放 → 完了
```

#### エンドポイント起動・削除の競合制御

「キューにメッセージあり→作成」「空→削除」を複数の実行主体が同時に行うと、二重作成、削除中のInvoke失敗、処理中なのに空判定で削除、といったレースコンディションが発生しうる。

対策:

| 対策 | 実装方法 |
|---|---|
| 排他制御 | DynamoDBに `endpoint_state` ロック行を作成し、条件付き更新（ConditionExpression）で排他する |
| 削除判定の正確化 | キューが空（ApproximateNumberOfMessages = 0）だけでなく、処理中メッセージ（ApproximateNumberOfMessagesNotVisible = 0）も確認する |
| クールダウン | 最後の処理完了からN分間（例: 15分）経過するまで削除しない |
| 状態遷移の明示化 | endpoint_state: IDLE → CREATING → IN_SERVICE → DELETING → IDLE の遷移を管理 |

DynamoDB ロック行の例:

```python
# エンドポイント作成前にロック取得（条件付き更新で排他）
table.update_item(
    Key={'lock_key': 'endpoint_control'},
    UpdateExpression='SET #state = :creating, updated_at = :t',
    ConditionExpression='#state = :idle OR attribute_not_exists(#state)',
    ExpressionAttributeNames={'#state': 'endpoint_state'},
    ExpressionAttributeValues={
        ':creating': 'CREATING',
        ':idle': 'IDLE',
        ':t': datetime.now().isoformat()
    }
)
```

### 出力形式と責務分離

ワーカーLambda（処理パイプライン）ではJSONのみを出力し、他の形式への変換は後段ジョブに分離することを推奨する。

理由:
- ワーカーの依存パッケージと実行時間を最小限に抑える
- 変換処理の失敗がOCR処理の成否に影響しない
- 必要な形式だけをオンデマンドで変換でき、無駄な処理を避けられる

| 段階 | 処理 | 出力 |
|---|---|---|
| 一次処理（ワーカーLambda） | OCR推論 | JSON（一次成果物、RAG用途） |
| 二次処理（変換Lambda、必要時のみ） | JSON → 各形式変換 | Markdown / HTML / CSV / Searchable PDF |

利用可能な出力形式:

| 形式 | 用途 |
|---|---|
| JSON | 後続のプログラム処理、RAG連携（一次成果物） |
| Markdown | ドキュメント管理、人間が読む用途 |
| HTML | Web表示、レイアウト保持 |
| CSV | 表データの抽出 |
| Searchable PDF | 元PDFにテキストレイヤーを追加 |

### SQS×Lambda の運用チューニング

#### Visibility Timeout

AWSの公式ガイダンスでは、SQSのvisibility timeoutはLambda関数のタイムアウトの6倍を推奨している。

| Lambda タイムアウト | 推奨 visibility timeout |
|---|---|
| 5分（300秒） | 30分（1800秒） |
| 10分（600秒） | 60分（3600秒） |
| 15分（900秒） | 90分（5400秒） |

visibility timeoutが短すぎると、処理中のメッセージが再び可視化され、同じPDFが複数回処理される事故が発生する。

#### バッチサイズと部分失敗レポート

```python
# CDK での SQS Event Source Mapping 設定
processor_lambda.add_event_source(
    lambda_event_sources.SqsEventSource(
        processing_queue,
        batch_size=1,                        # 1メッセージずつ処理（PDF処理は重いため）
        max_batching_window=Duration.seconds(0),
        report_batch_item_failures=True,     # 部分失敗レポートを有効化
    )
)
```

`report_batch_item_failures=True` を設定することで、バッチ内の一部メッセージのみ失敗した場合に、失敗分だけをSQSに戻すことができる。

#### 冪等性（重複実行対策）

SQSは「少なくとも1回配送（at-least-once delivery）」のため、同じメッセージが複数回配送される前提で設計する必要がある。

対策: DynamoDBの条件付き更新で「PROCESSINGにできた1回だけ処理する」パターン

```python
try:
    table.update_item(
        Key={'file_key': file_key},
        UpdateExpression='SET #s = :processing, updated_at = :t',
        ConditionExpression='#s = :pending',  # PENDING の場合のみ更新成功
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={
            ':processing': 'PROCESSING',
            ':pending': 'PENDING',
            ':t': datetime.now().isoformat()
        }
    )
except ClientError as e:
    if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
        # 既に他のワーカーが処理中 → スキップ
        return
    raise
```

#### DLQと再試行の設計

| 設定 | 推奨値 | 説明 |
|---|---|---|
| maxReceiveCount | 3 | 3回失敗したらDLQに移動 |
| DLQ保持期間 | 14日 | 調査・再処理のための保持 |
| DLQ redrive | 手動 | 原因調査後にメインキューへ戻す |

失敗理由の分類:

| 失敗種別 | 原因 | 対応 |
|---|---|---|
| サイズ超過 | 1ページのPNGが6MBを超えた | DPI下げて再試行 or 非同期推論 |
| タイムアウト | モデル応答が60秒を超過 | 重いページの特定、リトライ |
| モデルエラー | SageMaker側の5xx | 指数バックオフ+ジッターで再試行 |
| 一時的エラー | ネットワークエラー等 | 自動リトライ（boto3） |

### 60秒タイムアウトへの対策

SageMakerリアルタイム推論ではコンテナが60秒以内に応答する必要がある。1ページ0.6秒想定でも、重いページや負荷集中時に近づく可能性がある。

対策:

| 対策 | 詳細 |
|---|---|
| 429/5xx時のバックオフ | 指数バックオフ+ジッター（例: 1秒, 2秒, 4秒 + ランダム0-1秒） |
| ページ数上限 | 1PDFあたりの処理ページ数に上限を設ける（例: 100ページ。超過分は分割） |
| 並列ワーカー数の制御 | max_workersを上げすぎるとSageMaker側で429が増加。エンドポイントのインスタンス数に応じて調整 |
| タイムアウト監視 | 処理時間が閾値（例: 45秒/ページ）を超えたらCloudWatch Alarmで通知 |

### SageMaker invoke_endpoint のペイロード制限

- リアルタイム推論: リクエスト/レスポンスともに最大6MB
- 6MBを超えるPDFの場合の対処法:
  - ページ分割して送信
  - SageMaker非同期推論の利用（ペイロード最大1GB、ただしyomitoku-clientの対応要確認）
  - /tmpにダウンロードしてyomitoku-clientを直接利用（Lambdaの場合 /tmp は最大10GB）

### 認証・認可設計

#### 基本方針

SageMakerエンドポイントにはリソースベースポリシー（S3バケットポリシーのような仕組み）は存在しない。アクセス制御はIAMポリシーで行う。Lambda実行ロールにのみ `InvokeEndpoint` 権限を付与し、他のIAMユーザー/ロールには付与しないことで「Lambdaのみが実行可能」を実現する。

#### Lambda実行ロールに付与するIAMポリシー

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeSageMakerEndpoint",
      "Effect": "Allow",
      "Action": "sagemaker:InvokeEndpoint",
      "Resource": "arn:aws:sagemaker:ap-northeast-1:ACCOUNT_ID:endpoint/yomitoku-pro-*"
    },
    {
      "Sid": "ReadInputFromS3",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::BUCKET_NAME/input/*"
    },
    {
      "Sid": "WriteOutputToS3",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::BUCKET_NAME/output/*"
    },
    {
      "Sid": "UpdateDynamoDB",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query"
      ],
      "Resource": [
        "arn:aws:dynamodb:ap-northeast-1:ACCOUNT_ID:table/yomitoku-status",
        "arn:aws:dynamodb:ap-northeast-1:ACCOUNT_ID:table/yomitoku-status/index/*"
      ]
    },
    {
      "Sid": "ReceiveSQSMessages",
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:ap-northeast-1:ACCOUNT_ID:yomitoku-processing-queue"
    }
  ]
}
```

#### SageMaker InvokeEndpoint のIAM仕様

| 項目 | 内容 |
|---|---|
| アクション名 | sagemaker:InvokeEndpoint |
| リソースレベル制限 | 対応（エンドポイントARN単位で制御可能） |
| 条件キー | sagemaker:TargetModel（呼び出すモデルの制限） |
| アクセスレベル | Read |

エンドポイントARNの形式: `arn:aws:sagemaker:{region}:{account-id}:endpoint/{endpoint-name}`

#### CDKでの権限付与

S3, DynamoDB, SQSはL2コンストラクトの grant メソッドで簡潔に記述可能。SageMakerのみ PolicyStatement を直接追加する。

```typescript
// S3, DynamoDB, SQS はL2の grant メソッドで付与
inputBucket.grantRead(processorLambda, 'input/*');
outputBucket.grantWrite(processorLambda, 'output/*');
statusTable.grantReadWriteData(processorLambda);
processingQueue.grantConsumeMessages(processorLambda);

// SageMaker はL1のため PolicyStatement を直接追加
processorLambda.addToRolePolicy(new iam.PolicyStatement({
  actions: ['sagemaker:InvokeEndpoint'],
  resources: [`arn:aws:sagemaker:${region}:${account}:endpoint/yomitoku-pro-*`],
}));
```

#### リソースごとのアクセス制御まとめ

| リソース | 権限 | 付与先 | 制御方式 |
|---|---|---|---|
| SageMaker Endpoint | InvokeEndpoint | Lambda実行ロールのみ | IAMポリシー |
| S3 (input/) | GetObject | Lambda実行ロール | IAMポリシー + バケットポリシー |
| S3 (output/) | PutObject | Lambda実行ロール | IAMポリシー + バケットポリシー |
| DynamoDB | Read/Write | Lambda実行ロール | IAMポリシー |
| SQS | Consume | Lambda実行ロール | IAMポリシー |

#### ネットワーク層での追加制限（オプション）

IAM制御のみで十分だが、より厳格にする場合はVPCエンドポイント（PrivateLink）を使用できる。

```
Lambda (VPC内)
  → VPCエンドポイント (com.amazonaws.ap-northeast-1.sagemaker.runtime)
    → SageMaker Endpoint
```

利点:
- SageMakerへの通信がAWS内部ネットワークで完結（インターネットを経由しない）
- VPCエンドポイントポリシーで追加のアクセス制御が可能
- NAT Gatewayが不要になりコスト削減にもなる場合がある

注意点:
- Lambda をVPC内に配置する必要がある（コールドスタートがやや遅くなる）
- S3, DynamoDB, SQS用のVPCエンドポイントも別途必要
- 構成が複雑になるため、要件に応じて判断

#### セキュリティの追加対策

- DynamoDBの暗号化: デフォルトでAWSマネージドキーによる暗号化が有効
- Lambda環境変数の暗号化: エンドポイント名等はKMSで暗号化可能
- S3バケットのパブリックアクセスブロック: 全てのパブリックアクセスを無効化
- SageMakerエンドポイントのネットワーク分離: enableNetworkIsolation オプション
- CloudTrail: InvokeEndpoint の呼び出しログを記録して監査可能

---

## 7. CDKスタック構成案

```
yomitoku-pro-cdk/
  ├── bin/
  │   └── app.ts                  # CDKアプリケーションエントリポイント
  ├── lib/
  │   ├── sagemaker-stack.ts      # SageMakerエンドポイント定義
  │   ├── processing-stack.ts     # S3, SQS, Lambda, DynamoDB定義
  │   └── monitoring-stack.ts     # CloudWatch アラーム・ダッシュボード
  ├── lambda/
  │   └── processor/
  │       ├── index.py            # Lambda処理ロジック
  │       └── requirements.txt    # 依存パッケージ
  ├── cdk.json
  ├── package.json
  └── tsconfig.json
```

---

## 8. デプロイ手順（概要）

1. AWS MarketplaceでYomiToku-Proをサブスクライブ
2. Model Package ARNを確認（ap-northeast-1リージョン）
3. CDKプロジェクトを初期化
4. 各スタックを実装
5. `cdk deploy --all` でデプロイ
6. S3 input/ にファイルをアップロードして動作確認
7. DynamoDBでステータスを確認

---

## 9. 参考リンク

- AWS Marketplace: YomiToku-Pro - https://aws.amazon.com/marketplace/pp/prodview-64qkuwrqi4lhi
- yomitoku-client SDK - https://github.com/MLism-Inc/yomitoku-client
- YomiToku-Pro デプロイガイド - https://mlism-inc.github.io/yomitoku-client/deploy-yomitoku-pro/
- AWS CDK SageMaker モジュール - https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_sagemaker-readme.html
- CDK Issue: Marketplace対応 - https://github.com/aws/aws-cdk/issues/23158
- CDK CfnModel API - https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_sagemaker.CfnModel.html
- SageMaker非同期推論 - https://docs.aws.amazon.com/sagemaker/latest/dg/async-inference.html
- SageMaker + Lambda アーキテクチャ - https://aws.amazon.com/blogs/machine-learning/call-an-amazon-sagemaker-model-endpoint-using-amazon-api-gateway-and-aws-lambda/
