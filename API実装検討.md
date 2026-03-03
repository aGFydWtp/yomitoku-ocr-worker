# API 実装検討

## 背景・目的

現在のワークフローでは、クライアントが DynamoDB に直接 PENDING レコードを作成し、S3 に直接アップロードする必要がある。これを REST API で抽象化し、安全かつ簡単に OCR ジョブを操作できるようにする。

## アーキテクチャ

```
クライアント → CloudFront → API Gateway (REST, REGIONAL) → Lambda (Hono)
                                                              ├→ DynamoDB (StatusTable)
                                                              └→ S3 (Presigned URL 発行)
```

### 選定理由

| コンポーネント | 選定 | 理由 |
|--------------|------|------|
| フレームワーク | Hono | 軽量、TypeScript ネイティブ、Lambda アダプタ公式サポート |
| API Gateway | REST API (REGIONAL) | API Key 認証が組み込み、CloudFront と組み合わせ可能 |
| CloudFront | Distribution | WAF 統合、キャッシュ、カスタムドメイン対応 |
| Lambda ランタイム | Node.js 22.x | Hono + esbuild バンドル、コールドスタート最小 |

### 代替案: CloudFront + Lambda Function URL

API Gateway を省略し Lambda Function URL を使う構成も可能。

| 構成 | 100万リクエストあたりコスト | タイムアウト | 認証 |
|------|------------------------|------------|------|
| CloudFront + REST API v1 | $3.50 (APIGW) + $1.00 (CF) | 29秒 | API Key, IAM, Cognito |
| CloudFront + HTTP API v2 | $1.00 (APIGW) + $1.00 (CF) | 29秒 | JWT, IAM |
| CloudFront + Lambda Function URL | $0 (FnURL) + $1.00 (CF) | 60秒 | IAM (OAC) のみ |

Function URL の方がコスト面で有利だが、API Key 認証が使えない（独自実装が必要）。また CloudFront OAC が `Authorization` ヘッダーを上書きするため、CloudFront Function でカスタムヘッダーにコピーする必要がある。将来的に Cognito 認証に移行する場合はこちらも検討に値する。

## S3 キー命名規則

元のファイル名を保持するため、UUID ディレクトリ配下に元ファイル名を格納する。

```
S3 キー形式:
  入力: input/{uuid}/{sanitized_filename}
  出力: output/{uuid}/{sanitized_filename}.json  (※ .pdf → .json に置換)

例:
  入力: input/550e8400-e29b-41d4-a716-446655440000/請求書_2026年3月.pdf
  出力: output/550e8400-e29b-41d4-a716-446655440000/請求書_2026年3月.json
```

### ファイル名サニタイズ

クライアントから受け取った `filename` に対して以下を適用:

1. `path.basename()` でディレクトリ成分を除去（パストラバーサル防止）
2. 先頭・末尾の空白をトリム
3. 空文字の場合は `document.pdf` にフォールバック
4. 拡張子が `.pdf` でなければ 400 エラー

```typescript
function sanitizeFilename(raw: string): string {
  // 1. ディレクトリ成分除去（パストラバーサル防止）
  const basename = raw.split("/").pop()?.split("\\").pop()?.trim() || "document.pdf";
  // 2. 制御文字・Windows禁止文字を除去
  const cleaned = basename.replace(/[\x00-\x1f<>:"|?*]/g, "");
  if (!cleaned || cleaned === ".pdf") {
    return "document.pdf";
  }
  // 3. 拡張子チェック（大文字 .PDF も許容）
  if (!cleaned.toLowerCase().endsWith(".pdf")) {
    throw new ValidationError("Filename must end with .pdf");
  }
  return cleaned;
}
```

### 既存 processor Lambda との互換性

processor Lambda (`lambda/processor/index.py`) の以下の処理は変更なしで動作する:

| 処理 | コード | 新キーでの結果 |
|------|-------|--------------|
| tmp パス | `os.path.basename(file_key)` | `請求書_2026年3月.pdf` |
| output キー | `file_key.replace("input/", "output/").replace(".pdf", ".json")` | `output/{uuid}/請求書_2026年3月.json` |
| S3 取得 | `s3.get_object(Key=file_key)` | そのまま動作 |

## API エンドポイント設計

### POST /jobs

OCR ジョブを作成し、PDF アップロード用の Presigned URL を返す。

```
Request:
  POST /jobs
  Header: x-api-key: <API_KEY>
  Body: { "filename": "請求書_2026年3月.pdf" }

Response: 201 Created
  {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "fileKey": "input/550e8400-e29b-41d4-a716-446655440000/請求書_2026年3月.pdf",
    "uploadUrl": "https://s3.amazonaws.com/...?X-Amz-...",
    "expiresIn": 900
  }
```

処理フロー:
1. UUID を生成（`job_id`、テーブル PK）
2. `filename` をサニタイズし `fileKey = input/{uuid}/{sanitized_filename}` を決定
3. DynamoDB に PENDING レコードを `PutItem`（`job_id`, `file_key`, `status`, `created_at`, `updated_at`, `original_filename`）
4. S3 Presigned PUT URL を発行（有効期限 15 分、Content-Type: application/pdf）
5. レスポンスを返却

### GET /jobs/:jobId

ジョブのステータスを取得する。`:jobId` は UUID 部分のみ。ステータスが `COMPLETED` の場合、OCR 結果取得用の Presigned GET URL を含める。

```
Request:
  GET /jobs/550e8400-e29b-41d4-a716-446655440000
  Header: x-api-key: <API_KEY>

Response (PENDING / PROCESSING):
  200 OK
  {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "PROCESSING",
    "createdAt": "2026-03-04T10:00:00Z",
    "updatedAt": "2026-03-04T10:00:05Z",
    "originalFilename": "請求書_2026年3月.pdf"
  }

Response (COMPLETED):
  200 OK
  {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "COMPLETED",
    "createdAt": "2026-03-04T10:00:00Z",
    "updatedAt": "2026-03-04T10:01:30Z",
    "originalFilename": "請求書_2026年3月.pdf",
    "processingTimeMs": 2500,
    "resultUrl": "https://s3.amazonaws.com/...?X-Amz-...",
    "resultExpiresIn": 3600
  }

Response (FAILED):
  200 OK
  {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "FAILED",
    "createdAt": "2026-03-04T10:00:00Z",
    "updatedAt": "2026-03-04T10:00:30Z",
    "originalFilename": "請求書_2026年3月.pdf",
    "errorMessage": "Failed to convert PDF to images"
  }
```

処理フロー:
1. `jobId` で StatusTable を `GetItem`（強整合性）。見つからなければ 404
2. ステータスが `COMPLETED` の場合、`output_key` に対する Presigned GET URL を発行（有効期限 1 時間）
3. ステータスが `FAILED` の場合、`error_message` を含める
4. レスポンスを返却

### GET /jobs

ジョブ一覧を取得する（GSI `status-created_at-index` を使用）。

```
Request:
  GET /jobs?status=COMPLETED&limit=20
  Header: x-api-key: <API_KEY>

Response: 200 OK
  {
    "items": [
      {
        "jobId": "550e8400-...",
        "status": "COMPLETED",
        "createdAt": "2026-03-04T10:00:00Z",
        "updatedAt": "2026-03-04T10:01:30Z",
        "originalFilename": "請求書_2026年3月.pdf"
      },
      ...
    ],
    "count": 20,
    "cursor": "eyJmaWxlX2tleS..."
  }

次ページ取得:
  GET /jobs?status=COMPLETED&limit=20&cursor=eyJmaWxlX2tleS...

最終ページ:
  { "items": [...], "count": 5, "cursor": null }
```

一覧のレスポンスには `resultUrl` を含めない（個別取得時のみ発行）。

#### ページネーション実装

DynamoDB の `Query` は `LastEvaluatedKey`（次ページの開始位置を示すキーオブジェクト）を返す。API ではこれを Base64url エンコードして `cursor` として返す。クライアントは不透明なトークンとして扱う。

```typescript
const result = await docClient.send(new QueryCommand({
  TableName: TABLE_NAME,
  IndexName: "status-created_at-index",
  KeyConditionExpression: "#s = :status",
  ExpressionAttributeNames: { "#s": "status" },
  ExpressionAttributeValues: { ":status": status },
  Limit: limit,
  ExclusiveStartKey: cursor
    ? JSON.parse(Buffer.from(cursor, "base64url").toString())
    : undefined,
}));

const nextCursor = result.LastEvaluatedKey
  ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url")
  : null;

return c.json({
  items: result.Items ?? [],
  count: result.Items?.length ?? 0,
  cursor: nextCursor,
});
```

| パラメータ | 説明 |
|-----------|------|
| `cursor` (レスポンス) | 次ページ取得用トークン。`null` なら最終ページ |
| `cursor` (クエリパラメータ) | 前回レスポンスの `cursor` をそのまま渡す |
| `limit` | 1ページあたりの最大件数（デフォルト 20、上限 100） |

### DELETE /jobs/:jobId

PENDING 状態のジョブをキャンセルする。物理削除ではなく **CANCELLED 状態に遷移**する（processor との競合を防止）。

```
Request:
  DELETE /jobs/550e8400-e29b-41d4-a716-446655440000
  Header: x-api-key: <API_KEY>

Response: 200 OK
  {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "CANCELLED"
  }

Error: 404 Not Found（存在しない jobId）
Error: 409 Conflict（PENDING 以外の場合）
  { "error": "Job is in PROCESSING state and cannot be cancelled" }
```

処理フロー:
1. `jobId` で StatusTable を `UpdateItem`（`ConditionExpression="#s = :pending"` で CANCELLED に遷移）
2. 条件不一致（PROCESSING / COMPLETED / FAILED）なら 409 を返す
3. S3 の input ファイルをベストエフォートで削除（失敗しても無視）

**物理削除ではなく状態遷移にする理由**:
- DELETE 直前に processor が PENDING → PROCESSING に更新した場合、物理削除すると processor がレコードを失う
- CANCELLED 状態なら processor 側でも早期終了でき、データの整合性が保たれる
- processor Lambda の冪等性チェック（`ConditionExpression="#s = :pending"`）により、CANCELLED ジョブは自動的にスキップされる

## ディレクトリ構成

```
lambda/api/
  index.ts              Hono アプリ定義 + Lambda ハンドラ export
  routes/
    jobs.ts             /jobs エンドポイント群
  lib/
    dynamodb.ts         DynamoDB クライアント & ヘルパー
    s3.ts               S3 クライアント & Presigned URL 発行
    errors.ts           エラーハンドリング
lib/
  api-stack.ts          CDK スタック (API Gateway + CloudFront + Lambda)
```

## DynamoDB 設計変更

### 主キーを `job_id` に変更（推奨）

現在の StatusTable は `file_key` が PK だが、API では全操作が `jobId` (UUID) ベースになるため、**テーブルの PK を `job_id` に変更**する。これにより GSI 経由の結果整合性問題を回避できる。

| 変更 | 詳細 |
|------|------|
| **PK 変更** | `file_key` (旧) → `job_id` (新) |
| `file_key` | 属性として保持（S3 キー参照用） |
| 新 GSI `status-created_at-index` | PK: `status`, SK: `created_at`（一覧用、既存と同様） |
| 新 GSI `file_key-index` | PK: `file_key`（processor が file_key から job_id を引く場合の保険） |

**メリット**:
- GET /jobs/:jobId が `GetItem`（強整合性）で取得可能。POST 直後の GET で 404 にならない
- DELETE /jobs/:jobId も直接 `UpdateItem` 可能。GSI 経由の2段階操作が不要
- API 側のコードがシンプルになる

**processor Lambda への影響と対応**:

S3 キー `input/{uuid}/{filename}` から `job_id` を抽出できる:

```python
# processor Lambda での変更箇所
job_id = file_key.split("/")[1]  # input/{uuid}/filename.pdf → uuid

table.update_item(
    Key={"job_id": job_id},  # file_key → job_id に変更
    ...
)
```

`os.path.basename(file_key)`, `file_key.replace(...)`, `s3.get_object(Key=file_key)` はそのまま動作。変更は DynamoDB の Key 指定のみ。

### DynamoDB レコード例

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "file_key": "input/550e8400-.../請求書_2026年3月.pdf",
  "status": "PENDING",
  "created_at": "2026-03-04T10:00:00Z",
  "updated_at": "2026-03-04T10:00:00Z",
  "original_filename": "請求書_2026年3月.pdf"
}
```

## CDK スタック設計 (ApiStack)

### Props

```typescript
interface ApiStackProps extends StackProps {
  bucket: Bucket;
  statusTable: Table;
}
```

### リソース

| リソース | 詳細 |
|---------|------|
| NodejsFunction | lambda/api/index.ts, Node.js 22.x, esbuild (`minify: true`), メモリ 256MB, タイムアウト 29s |
| LambdaRestApi | `endpointTypes: [REGIONAL]`, `proxy: true` ({proxy+} + ANY), ステージ: prod |
| API Key + Usage Plan | レート制限 (100 req/s), クォータ (10,000 req/day) |
| CloudFront Distribution | `RestApiOrigin(api)` (originPath は自動でステージ名に設定), `CachePolicy.CACHING_DISABLED`, `OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER` |

### IAM 権限

| 権限 | 対象リソース |
|------|------------|
| `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `Query` | StatusTable + GSI |
| `s3:PutObject` (presigned 用) | `bucket/input/*` |
| `s3:GetObject` (結果取得用) | `bucket/output/*` |
| `s3:DeleteObject` (キャンセル時ベストエフォート削除) | `bucket/input/*` |

### bin/app.ts への追加

```typescript
const apiStack = new ApiStack(app, "ApiStack", {
  env: { region, account },
  bucket: processingStack.bucket,
  statusTable: processingStack.statusTable,
});
```

## Hono アプリ実装方針

### エントリポイント (lambda/api/index.ts)

```typescript
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import type { LambdaEvent, LambdaContext } from "hono/aws-lambda";
import { jobsRoutes } from "./routes/jobs";

type Bindings = {
  event: LambdaEvent;
  lambdaContext: LambdaContext;
};

const app = new Hono<{ Bindings: Bindings }>();

app.route("/jobs", jobsRoutes);

export const handler = handle(app);
```

### AWS SDK クライアント初期化 (lambda/api/lib/dynamodb.ts)

```typescript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// ハンドラ外で初期化（コネクション再利用）
const client = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(client);
```

### Presigned URL 発行 (lambda/api/lib/s3.ts)

```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({});

/** PDF アップロード用 Presigned PUT URL（有効期限 15 分） */
export async function createUploadUrl(bucket: string, key: string): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: "application/pdf",
  });
  return getSignedUrl(s3Client, command, { expiresIn: 900 });
}

/** OCR 結果取得用 Presigned GET URL（有効期限 1 時間） */
export async function createResultUrl(bucket: string, key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
}
```

## CloudFront 設定詳細

### 重要な設定ポイント

- **RestApiOrigin**: CDK が自動的に `originPath` をステージ名 (`/prod`) に設定する。Hono のルート定義にステージ名は不要
- **OriginRequestPolicy**: `ALL_VIEWER_EXCEPT_HOST_HEADER` を使用。Host ヘッダーを転送すると API Gateway がリクエストを拒否する
- **AllowedMethods**: `ALLOW_ALL` (POST/PUT/DELETE を許可するため)

### キャッシュポリシー

初期段階は全エンドポイント `CACHING_DISABLED`。将来的に以下の最適化が可能:

| パスパターン | キャッシュ | 理由 |
|-------------|----------|------|
| `/jobs/*/result` | 検討中 (immutable ならキャッシュ可) | COMPLETED 後は結果が変わらない |
| `/jobs/*` | なし | ステータスは動的に変化する |
| `/jobs` | なし | 一覧は常に最新が必要 |

### ヘッダー転送

- `x-api-key`: API Gateway の API Key 認証に必要
- `Content-Type`: POST リクエストのボディパース用
- `Authorization`: 将来の Cognito 認証用に予約

### CDK 実装例

```typescript
const distribution = new cloudfront.Distribution(this, "Distribution", {
  defaultBehavior: {
    origin: new origins.RestApiOrigin(api),
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  },
});
```

## API Key の発行・管理

### 仕組み

API Gateway REST API の組み込み API Key 機能を使用する。CDK で `UsagePlan` + `ApiKey` を作成すると、API Gateway がランダムな API Key 値を自動生成する。

```
LambdaRestApi (apiKeyRequired: true)
    ↓
UsagePlan (レート制限 + クォータ)
    ↓
ApiKey (API Gateway が値を自動生成)
    ↓
CfnOutput で KeyId を出力
```

### CDK 実装

```typescript
const api = new LambdaRestApi(this, "Api", {
  handler: fn,
  proxy: true,
  apiKeySourceType: ApiKeySourceType.HEADER,
  defaultMethodOptions: {
    apiKeyRequired: true,
  },
});

const plan = api.addUsagePlan("UsagePlan", {
  throttle: { rateLimit: 100, burstLimit: 200 },
  quota: { limit: 10000, period: Period.DAY },
});
plan.addApiStage({ stage: api.deploymentStage });

const apiKey = api.addApiKey("ApiKey");
plan.addApiKey(apiKey);

new CfnOutput(this, "ApiKeyId", {
  value: apiKey.keyId,
  description: "API Key ID (値は CLI で取得)",
});
```

### キー値の取得

API Key の値はセキュリティ上 CloudFormation Output に直接出力されない。デプロイ後に CLI で取得する：

```bash
aws apigateway get-api-key --api-key <ApiKeyId> --include-value --query 'value' --output text
```

### 管理方式の比較

| 方式 | メリット | デメリット | 推奨シーン |
|------|---------|----------|-----------|
| API Gateway 組み込みのみ | CDK だけで完結、追加コスト $0 | ローテーションは手動 | 内部利用・PoC |
| + Secrets Manager 保存 | CI/CD で安全に配布、ローテーション可 | $0.40/月/シークレット | フロントエンド配布が必要な場合 |
| + Cognito 認証に移行 | ユーザーごとの認証、トークンベース | 実装コスト大 | マルチテナント・一般公開 |

### 注意

API Gateway の API Key は**認証（Authentication）ではなく識別・レート制限が主目的**。AWS 公式ドキュメントでも「API Key を唯一のアクセス制御に使わないこと」と明記されている。現アーキテクチャでは以下の2層で内部利用に十分な保護を提供する：

- **CloudFront 経由のみアクセス**: API Gateway リソースポリシーで直接アクセスを拒否
- **API Key**: クライアント識別 + Usage Plan によるレート制限

一般公開する場合は Cognito 認証の追加を検討する。

## セキュリティ考慮事項

### 1. CloudFront 経由のみアクセスの実現

API Gateway への直接アクセスを拒否するため、**CloudFront Origin Custom Header** + **API Gateway リソースポリシー**を組み合わせる。

```
CloudFront → カスタムヘッダー付与 (x-origin-verify: <secret>) → API Gateway → リソースポリシーで検証
```

**CDK 実装**:

```typescript
const originVerifySecret = "自動生成またはSecrets Managerから取得";

// CloudFront: カスタムヘッダーを付与
const origin = new origins.RestApiOrigin(api, {
  customHeaders: {
    "x-origin-verify": originVerifySecret,
  },
});

// API Gateway: リソースポリシーで検証
api.addToResourcePolicy(new PolicyStatement({
  effect: Effect.DENY,
  principals: [new AnyPrincipal()],
  actions: ["execute-api:Invoke"],
  resources: ["execute-api:/*"],
  conditions: {
    StringNotEquals: {
      "aws:Referer": originVerifySecret,  // カスタムヘッダーの代替として条件キーを使用
    },
  },
}));
```

> **注意**: `x-origin-verify` の値が漏洩すると直叩き可能になる。Secrets Manager でローテーションするか、WAF の IP 制限と併用する。

### 2. Presigned URL のスコープ

`input/{uuid}/` プレフィックスで限定。ファイル名はサニタイズ済み（制御文字除去 + `.pdf` 検証）でパストラバーサル不可。

### 3. アップロードファイルの検証

Content-Type 制限（`application/pdf`）だけでは不十分。以下の多層防御を適用:

| レイヤー | 方法 | タイミング |
|---------|------|-----------|
| Presigned URL | `Content-Type: application/pdf` を条件に含める | アップロード時 |
| Presigned URL | `Content-Length` の上限を設定（例: 100MB） | アップロード時 |
| processor Lambda | PDF マジックナンバー検証（先頭 `%PDF-`） | 処理開始時 |

```typescript
// Presigned URL 発行時に Content-Length 制限を追加
const command = new PutObjectCommand({
  Bucket: bucket,
  Key: key,
  ContentType: "application/pdf",
  // Content-Length は Presigned URL の Conditions では直接制限できないが、
  // S3 バケットポリシーで最大サイズを制限可能
});
```

```python
# processor Lambda: PDF マジックナンバー検証
with open(tmp_path, "rb") as f:
    header = f.read(5)
    if header != b"%PDF-":
        raise ValueError("Uploaded file is not a valid PDF")
```

### 4. 入力バリデーション

Hono の validator middleware で request body を検証。

### 5. レート制限

API Gateway Usage Plan で制御（100 req/s、10,000 req/day）。

### 6. CORS

必要に応じて Hono の cors middleware で設定。

## 注意事項・制約

| 項目 | 詳細 |
|------|------|
| API Gateway タイムアウト | REST API / HTTP API ともに **29 秒**が上限。Presigned URL 発行やステータス取得は十分だが、結果 JSON が大きい場合は注意 |
| REST API ステージプレフィックス | REST API v1 はパスに `/prod` を付加する。`RestApiOrigin` が `originPath` を自動設定するため Hono 側は意識不要 |
| Hono バンドルサイズ | コアは約 14KB。コールドスタートへの影響は最小限 |
| AWS SDK v3 keep-alive | v3.400+ ではデフォルトで有効。明示的な設定不要 |
| `processingTimeMs` の出どころ | processor Lambda が OCR 処理時間を計測し、COMPLETED 時に DynamoDB に保存済み（`processing_time_ms` 属性） |

## エッジケースと対策

| ケース | 対策 |
|-------|------|
| Presigned URL 発行後にアップロードしない | PENDING レコードが残る。TTL (24h) で PENDING → 自動削除を検討 |
| 同じファイル名を複数回アップロード | UUID ディレクトリが異なるため衝突しない |
| 日本語・特殊文字のファイル名 | S3 は UTF-8 キーを完全サポート。Presigned URL で自動エンコードされる |
| 大容量ファイル (> 100MB) | S3 Presigned URL は最大 5GB 対応。Lambda 側の処理時間に注意 |
| 結果取得時に output が未完成 | GET は常に 200 で返却。`status` と `resultUrl` の有無で状態を表現 |
| API Gateway 直接アクセス | CloudFront Origin Custom Header + リソースポリシーで拒否 |
| DELETE と processor の競合 | 物理削除ではなく CANCELLED 状態遷移で整合性を保持 |
| POST 直後の GET | PK が `job_id` なので `GetItem`（強整合性）で即座に取得可能 |

## パッケージ依存 (lambda/api)

```json
{
  "dependencies": {
    "hono": "^4",
    "@aws-sdk/client-dynamodb": "^3",
    "@aws-sdk/lib-dynamodb": "^3",
    "@aws-sdk/client-s3": "^3",
    "@aws-sdk/s3-request-presigner": "^3"
  },
  "devDependencies": {
    "@types/aws-lambda": "^8",
    "typescript": "^5"
  }
}
```

CDK 側の NodejsFunction が esbuild でバンドルするため、Lambda デプロイパッケージに含まれる。

## 実装順序

1. `lambda/api/` ディレクトリ作成、package.json, tsconfig.json
2. Hono アプリ + ルーティング実装
3. `lib/api-stack.ts` CDK スタック作成
4. `bin/app.ts` に ApiStack 追加
5. `npx cdk synth` で CDK Nag チェック
6. デプロイ & 動作確認
7. テストスクリプト作成
