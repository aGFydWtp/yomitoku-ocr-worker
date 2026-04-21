# Gap Analysis: yomitoku-client-batch-migration

本ドキュメントは、`requirements.md` に定義された「yomitoku-client バッチ処理モードへの全面置換」要件と、現行コードベースのギャップを分析するレポートです。Design フェーズに渡す事前知見として位置付けます。

## A. 現行状態インベントリ（削除／置換／再利用の粒度）

### A-1. API 層 (`lambda/api/`)
- **Delete**:
  - `routes/jobs.routes.ts`, `routes/jobs.ts` — 単一ジョブ向け CRUD ルート
  - `lib/validate.ts` の `parseFilepath` / `validateBasePath` 等、単一 `filepath` 形式前提の検証
  - `schemas.ts` の `CreateJobBody*` / `JobDetailResponse*` / `VisualizationsResponse*` 等
  - 旧 OpenAPI 定義（`index.ts` 内の `app.route("/jobs", …)` 関連部分）
- **Replace**:
  - `schemas.ts`: バッチ系（`CreateBatchBodySchema`, `BatchDetailSchema`, `BatchFilesResponseSchema` 等）に全面再定義
  - `routes/status.ts`, `routes/up.ts`: エンドポイント状態系は維持しつつ、状態モデルを「バッチ実行中」基準に調整
- **Reuse**:
  - `lib/dynamodb.ts`, `lib/errors.ts`, `lib/sanitize.ts`, `lib/sfn.ts`
  - `lib/s3.ts` — 署名付き URL 生成の基本機能（スコープは `batches/*` へ変更）
  - Hono + Zod + OpenAPI の骨格、CloudFront origin-verify ヘッダ検証

### A-2. Processor (`lambda/processor/index.py`)
- **Delete**:
  - SQS レコードからの `file_key` 抽出と単一 PDF 処理フロー（`extract_file_key`, `extract_job_id`, `process_file`）
  - `input/` → `output/` キー書き換えロジック（単一ジョブレイアウト前提）
- **Replace**:
  - 呼び出しモデル: `YomitokuClient.analyze_async(tmp_path)` → `analyze_batch_async(input_dir, output_dir, ...)`
  - 可視化生成ロジック: `_generate_and_upload_visualizations` はバッチレイアウト（ファイル単位プレフィックス）に再配線
- **Reuse**:
  - `yomitoku-client==0.2.0` の import（`YomitokuClient`, `parse_pydantic_model`, `CircuitConfig`, `RequestConfig`）
  - Docker ベースイメージ・コンテナビルド構成

### A-3. DynamoDB / Storage (`lib/processing-stack.ts`)
- **Delete**:
  - `StatusTable`（PK=`job_id`、GSI=`status-created_at`, `file_key`）および関連属性
  - S3 キーパターン `input/{basePath}/{jobId}/{filename}`, `output/{basePath}/{jobId}/{filename}.json`, `visualizations/{basePath}/{jobId}/...`
- **Replace**:
  - S3 レイアウトを `batches/{batchJobId}/...`（input/output/results/visualizations/process_log.jsonl）へ統一
- **Reuse**:
  - `ControlTable`（`lock_key` PK）— エンドポイント制御の楽観ロック用途で継続利用
  - S3 バケット本体・ライフサイクル基盤

### A-4. キュー & オーケストレーション
- **Delete / Replace**:
  - S3 → SQS → Lambda の「1 オブジェクト 1 メッセージ」経路（`lib/processing-stack.ts` 内 SQS/DLQ 関連、`SqsEventSource` マッピング）
  - `lambda/endpoint-control/index.py` の SQS 深度ポーリング `check_queue_status` は「バッチ実行中フラグ or タイムアウト監視」ベースへ置換
- **Reuse**:
  - `OrchestrationStack` の Step Functions 骨格とエンドポイント CRUD ステートマシン（状態遷移ロジックはバッチ基準へ修正）
  - EventBridge Rule の仕組み（トリガー条件を変更）

### A-5. IAM / Monitoring (`lib/api-stack.ts`, `lib/monitoring-stack.ts`)
- **Delete**:
  - 単一ジョブ用 S3 put/get/delete grants（`input/*`, `output/*`）
  - 単一ジョブ前提の CloudWatch アラーム／メトリクス
- **Replace**:
  - grants を `batches/*/input`, `batches/*/output`, `batches/*/visualizations`, `batches/*/process_log.jsonl` に再スコープ
  - メトリクスを「バッチ単位（in-flight/failure/page 数/サーキットブレーカ発動回数）」へ刷新
- **Reuse**:
  - CloudFront Distribution / WAF / `x-origin-verify` 防御機構
  - SNS 通知基盤

### A-6. Docs / Tests / Scripts
- **Delete**:
  - `README.md` の `/jobs` 系フロー、`API実装検討.md`・関連設計ドキュメントの旧 API 記述
  - `lambda/api/__tests__/routes/jobs.*` 系、`scripts/` 内の旧 API 連携
  - `test/` 内 CDK スナップショットのうち旧リソース前提のアサーション
- **New**:
  - バッチ API 用 E2E / 統合テスト、CI guard（旧 `/jobs` 参照の禁止 lint）

## B. 要件 → 資産マップ（12 要件）

| Req | タグ | 主対象 | 備考 |
|-----|------|--------|------|
| 1 廃止 | Delete | `routes/jobs.*`, `StatusTable`, SQS/DLQ, 旧 S3 キー, 旧 IAM, 旧メトリクス, 旧 OpenAPI | すべて後方互換なし削除 |
| 2 POST /batches | New / Reuse | `routes/batches.*`(新), `schemas.ts`(新), `lib/s3.ts`(再) | 署名付き URL 群を返却 |
| 3 完了検知・Start | New / Unknown | S3 完了トリガ方式（Unknown）, Start endpoint | E-3 で方式決定 |
| 4 並列・障害耐性 | Reuse / New | `YomitokuClient`, `CircuitConfig`, `RequestConfig`（再） + 上限設定（新） | ライブラリ側機能を活用 |
| 5 process_log & 詳細取得 | New / Unknown | `process_log.jsonl` 生成／配信, `GET /batches/:id/files` | lib 側生成 vs 手動構築（E-1） |
| 6 成果物・可視化・変換 | Replace / Optional | 可視化再配線, md/csv/html/pdf 変換（オプション） | 失敗は非致命扱い |
| 7 ステータス・PARTIAL | New | `BatchStatus` 遷移、集計属性 | Step Functions に PARTIAL ロジック追加 |
| 8 失敗のみ再解析 | New | 親子 `batchJobId`、`process_log.jsonl` パース | 成果物マージ戦略は Design へ |
| 9 DDB スキーマ | Delete / New / Constraint | `StatusTable` 削除、新 Batch/File エンティティ、ホットキー回避 | single-table vs 2-table（E-4） |
| 10 エンドポイント整合 | Reuse / Replace | `endpoint-control` のシグナル源を変更 | バッチ終了時のアイドル判定と協調 |
| 11 非機能 | New | スループット目標、上限値、リテンション | 実測メトリクス整備 |
| 12 OpenAPI / Docs / CI | Replace / New | `/doc`, `/ui`, `README.md`, CI guard | 旧 API 記述完全排除 |

## C. 実装アプローチ候補

### Option A: 既存スタックを直接書き換え（In-place replace）
- 現行 `ProcessingStack` / `ApiStack` を直接改修して `/batches` 系に差し替える
- ✅ スタック構成変更が最小、デプロイ粒度が小さい
- ❌ 一度の PR で破壊的変更が集中、段階的検証が困難

### Option B: 新スタック併設 → 旧削除（Parallel new stack, then retire）
- 新 `BatchesStack`（API ルート・DDB・処理 Lambda をまとめる）を追加
- 検証完了後に旧 `ProcessingStack` / 旧ルートを削除
- ✅ 新旧隔離、テスト容易、ロールバック容易
- ❌ 一時的に 2 系統のリソース、コスト一時増、ログ分散

### Option C: 基盤共有・アプリ層置換（Hybrid phased, 推奨）
- 共有: SageMaker Stack / CloudFront / WAF / endpoint-control / SNS / 既存 S3 Bucket
- 置換: API ルート・DDB スキーマ・Processor・Monitoring・OpenAPI を並行実装 → 検証 → 旧削除
- ✅ 共通インフラの再利用でコスト＆工数最適、段階検証可能、Option B の隔離メリットを一定確保
- ❌ 置換タイミングの同期が必要、Design で明確なカットオーバー定義必須

**推奨: Option C**。CloudFront / SageMaker / endpoint-control は再設計対象外（Out of scope）であり、これらを共有しつつアプリ層を並行実装 → 切替するのが全体コストと整合性で最適。

## D. 工数・リスク概算

| 領域 | Effort | Risk | 根拠 |
|------|:------:|:----:|------|
| API 層（`/batches` 実装＋旧削除） | M | M | 既存 Hono/OpenAPI パターン踏襲。ただし presigned URL を複数ファイル返却する設計が新規 |
| DynamoDB 再設計＆移行 | M | H | 単一テーブル vs 2 テーブル、ホットキー回避、GSI 設計が未確定（E-4） |
| S3 完了検知トリガ | S | M | 実装自体は軽量だがメカニズム選定（タグ付き終端オブジェクト vs マニフェスト）が E-3 |
| バッチ処理ワーカー | L | H | Lambda 15 分制限との兼ね合い。Fargate / SageMaker Batch Transform の採否は E-2 |
| process_log 取扱・再解析 | M | M | yomitoku-client の生成仕様（E-1）次第で手動実装の有無が変わる |
| Orchestration 改修 | M | M | Step Functions の状態遷移を PARTIAL / 再解析に合わせて拡張 |
| Monitoring 刷新 | S | L | 既存 SNS / CloudWatch 基盤を再利用、メトリクス名だけ変更 |
| Docs / CI guard | S | L | README・OpenAPI 更新、旧 API 参照禁止 lint（biome / CI grep） |

## E. Research Needed（Design フェーズへ持ち越し）

1. **yomitoku-client バッチ API の実挙動** — `analyze_batch_async` が `process_log.jsonl` を自動で書き出すのはライブラリか CLI かを確定（ライブラリが書かない場合はワーカー側で構築）。CircuitBreaker は `CircuitConfig` で注入すれば batch でも有効か確認。
2. **バッチ実行環境** — Lambda 15 分で典型ケースを収容可能かベンチ。超過する場合は Fargate / SageMaker Async / Batch Transform の選定（コスト・起動レイテンシ・IAM 影響を比較）。
3. **アップロード完了検知方式** — (a) 終端マニフェストを最後に PUT → EventBridge、(b) 期待ファイル数との DDB 差分ポーリング、(c) 明示的 `POST /batches/:id/start` のみの 3 案比較。
4. **DynamoDB スキーマ** — 単一テーブル（PK=`PK:BATCH#{id}`, SK=`META` / `FILE#{fileKey}`）vs 2 テーブル。GSI: `STATUS#{status}` for cross-batch listing、ホットキー回避策（`created_at` ハッシュ混入など）。
5. **キャンセル / タイムアウト意味論** — `PROCESSING` 中のキャンセルは不可で `409` とするか、割り込み可能にするか。バッチの最大実行時間と SNS アラート閾値。
6. **CI guard 実装** — 旧 `/jobs` 参照禁止を biome ルール／pre-commit／CI grep のいずれで実現するか。

## F. 主要制約

1. Lambda 15 分タイムアウト制約 — 現行 processor は 10 分設定。バッチ規模によっては別実行基盤が必要。
2. SageMaker エンドポイント単一インスタンス前提 — 同時並行バッチ数に事実上の上限あり（最大 1 推奨）。
3. endpoint-control 信号源の変更 — SQS 深度 → バッチ実行中フラグ（DDB or EventBridge）へ差し替え。既存 `check_queue_status` の完全置換が必要。
4. CloudFront `x-origin-verify` ヘッダ強制 — 新バッチ API でも継承。API Gateway リソースポリシーは維持。
5. CDK Nag suppressions — 旧リソース向け抑制ルールを新リソースにも再適用（IAM4/IAM5 等）。
6. `yomitoku-client==0.2.0` に固定 — バッチ関連不具合が見つかった場合は version up 要否を Design 時点で判断。

## G. Design へ引き継ぐ推奨事項

- **アプローチ**: Option C（基盤共有・アプリ層置換）を採用
- **先決事項**（E から優先順に確定）: E-1 → E-2 → E-4 → E-3 → E-5 → E-6
- **早期プロトタイプ推奨**: `analyze_batch_async` の小規模 PoC（3–5 ファイル）を実装し、process_log / 可視化出力 / CircuitBreaker 動作を実測
- **カットオーバー戦略**: 新スキーマ DDB と旧 `StatusTable` を一時並存させず、デプロイ単位で一度に置換（本仕様ではデータ移行なし）
