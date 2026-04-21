# Research & Design Decisions — yomitoku-client-batch-migration

## Summary
- **Feature**: `yomitoku-client-batch-migration`
- **Discovery Scope**: Complex Integration（既存 1 PDF ジョブ同期処理 → yomitoku-client バッチモードへの全面置換）
- **Key Findings**:
  1. `yomitoku-client==0.2.0` の `analyze_batch_async` は「ディレクトリ単位入力 → ページ単位並列推論 → ディレクトリ単位出力」モデルで、`process_log.jsonl` はライブラリ側で自動生成される。運用者は本仕様のランタイムから単にライブラリを起動し、出力ディレクトリを S3 にシンクすれば要件 5/6/8 を充足できる。
  2. Lambda 15 分上限はバッチ規模によって突破するリスクが高く、運用を単一ランタイムで完結させるには Step Functions 配下の **ECS Fargate タスク** が現実的。Fargate は cold-start（数十秒）を抱えるが、既にバッチ起動は「アップロード完了後の明示イベント」駆動であり許容範囲内。
  3. 新 DynamoDB は **single-table 設計**（PK=`batchJobId`、SK=`META` / `FILE#{fileKey}`）を採用し、GSI1=`status-createdAt`（バッチ一覧）・GSI2=`parentBatchJobId`（再解析親子参照）のみを持つ。旧 `StatusTable` は Infrastructure as Code から完全削除する。
  4. アップロード完了検知は **明示的 `POST /batches/:batchJobId/start`** を正本とし、`process_log.jsonl` 以前の不整合を最小化する。アップロード未完了ファイルは `start` 時点で DDB から期待ファイル集合と S3 `HeadObject` で照合して欠損判定する。
  5. キャンセルは `PENDING` のみ許容（`409` on PROCESSING）。最大実行時間（既定 2 時間）は Step Functions のヘッドタイマーで制御し、超過時にタスクを停止して `FAILED` 遷移させる。
  6. CI guard は単純な `git grep` ベースの pre-commit/CI チェックで `\/jobs` 系参照と旧エンティティ命名（`job_id`、`StatusTable` 等）をブロックする。

## Research Log

### yomitoku-client バッチ API の実挙動 (E-1)
- **Context**: `analyze_batch_async` がどのディレクトリレイアウトを入出力として取るか、`process_log.jsonl` を書き出すのはライブラリか CLI かを確定したい。
- **Sources Consulted**:
  - `MLism-Inc/yomitoku-client` README（バッチセクション、`yomitoku-client batch -i <dir> -o <dir>` CLI）
  - `yomitoku_client.batch` モジュールのソース（`process_log` 書き出しと並列処理の責務）
  - `YomitokuClient.analyze_batch_async(input_dir, output_dir, ...)` シグネチャ
- **Findings**:
  - 入力ディレクトリ配下の `.pdf` / `.tiff` を再帰的に列挙し、`max_file_concurrency` と `max_page_concurrency` で制御。
  - `process_log.jsonl` は `output_dir` 直下にライブラリが生成する（`timestamp`, `file_path`, `output_path`, `dpi`, `executed`, `success`, `error`）。
  - `CircuitConfig` / `RequestConfig` は `analyze_async` と共通で、バッチ実行でも有効。
  - OCR 結果 JSON は `output_dir/<relative_path>.json` に書き出され、フォーマット変換（md/csv/html/pdf）はオプションとして追加生成される。
- **Implications**:
  - Processor 層は「S3 からバッチの `input/` プレフィックスをローカル `input_dir` に同期 → `analyze_batch_async` 実行 → `output_dir` を S3 `output/`・`results/`・`visualizations/`・`process_log.jsonl` に同期」の単純パイプラインに再設計できる。
  - `process_log.jsonl` を DDB File エンティティの状態更新にそのまま使える（要件 5.1, 8.1 を無改修で充足）。

### 実行ランタイム選定 (E-2)
- **Context**: 既存 processor は Lambda（Docker、10 分）。バッチ規模（数十 PDF・数百ページ）では 15 分を超える可能性が高く、単一ランタイムの延命か別ランタイムへの移行かを決める必要がある。
- **Sources Consulted**:
  - AWS Lambda 15 分制約、ECS Fargate task で Python 3.12 + `yomitoku-client` を走らせるコスト／レイテンシ事例
  - SageMaker Batch Transform／Async Inference の適合性（入力は SM エンドポイント呼び出しで完結するため、BT/Async はモデル側前提と二重化する）
- **Findings**:
  - Lambda 15 分では 100 ページ超で不安定。DPI 200 / `max_page_concurrency=2` では 1 ページあたり 2–5 秒、100 ページで 5–15 分相当。
  - Fargate は最大 1 時間超も容易。Step Functions `ecs:runTask.sync` で同期実行するとバッチ完了まで状態遷移を保持できる。
  - SageMaker Batch Transform／Async Inference はモデルコンテナ側実装の書き換えが必要で、Out of Scope（SageMaker 側再設計）のため不適切。
- **Implications**:
  - **選定: Fargate（Step Functions から `ecs:runTask.sync` で起動）**。既存 `OrchestrationStack` の state machine に `RunBatchTask` ステートを差し込む。
  - Fargate タスク定義は既存 `lambda/processor` の Dockerfile をベースに再利用（`CMD` を `processor.main` のバッチ版に変更）。

### アップロード完了検知 (E-3)
- **Context**: S3 への並列 PUT 完了を確実に検知するメカニズムが必要（要件 3.1, 3.2）。
- **Sources Consulted**:
  - 選択肢 (a) 終端 manifest を最後に PUT → EventBridge、(b) 期待ファイル数との DDB 差分ポーリング、(c) 明示的 `POST /batches/:id/start`
- **Findings**:
  - (a) は利用者側 SDK 実装が不確定。(b) はポーリング実装が発生する。(c) は利用者に責務を委ねるが、クライアント側は署名付き URL 完了後に start を叩くだけで済みシンプル。
  - 欠損判定は start 時に `ListObjectsV2` + DDB `FILE#` アイテムの照合で十分（S3 は PUT 後 strong consistency）。
- **Implications**:
  - **選定: (c) 明示 start**。`POST /batches/:batchJobId/start` が正本。自動化クライアントは署名付き URL 完了後に必ず start を呼ぶ。
  - start 時に欠損ファイルがあれば `400` で拒否。期限切れアップロード扱いは要件 3.3 の通り `FAILED` 遷移。

### DynamoDB スキーマ (E-4)
- **Context**: 新スキーマはバッチ／ファイル両レベルの状態を表現しつつアクセスパターン（バッチ詳細・ファイル一覧・ステータス一覧）を最小クエリで満たす必要。
- **Sources Consulted**:
  - AWS DynamoDB Single-Table Design（Rick Houlihan 推奨）、ホットキー回避策（時刻サフィックス・シャーディング）
  - 候補: (A) 2 テーブル（Batch / File）、(B) Single-table with PK/SK
- **Findings**:
  - (A) は Batch 取得とファイル一覧取得で 2 テーブル跨ぎのクエリが発生、トランザクションも分断。
  - (B) は PK=`BATCH#{batchJobId}`、SK=`META` / `FILE#{s3Key}` で `Query(PK=BATCH#id)` でバッチ全体を 1 クエリで取得可能。ステータス一覧は GSI1（`PK=status, SK=createdAt`）で解決。
- **Implications**:
  - **選定: (B) single-table**。ホットキー回避のため GSI1 の PK には `status` に日付ブロック（`STATUS#{status}#{yyyymm}`）を付けて分散する戦略を取る。
  - GSI2 は再解析親子参照（PK=`parentBatchJobId`）で、要件 8.2 を充足。

### キャンセル／タイムアウト意味論 (E-5)
- **Context**: 要件 7.5 は `PENDING` キャンセル許容・`PROCESSING` は `409`。要件 10.4 はバッチ最大実行時間超過で `FAILED` 化。
- **Sources Consulted**:
  - Step Functions のタイマーイベント、`States.Timeout` ハンドリング、Fargate `stopTask`
- **Findings**:
  - `PENDING` 中は DDB の条件付き更新で `CANCELLED` 遷移、S3 署名付き URL は有効期限で自動無効化。
  - `PROCESSING` 中は Fargate タスク実行中で中断不可（`409`）。最大実行時間は Step Functions の `TimeoutSeconds`（既定 7200）で強制停止。
- **Implications**:
  - state machine に `Catch: States.Timeout` → `FAILED` マークのパスを追加。`stopTask` で Fargate を確実に終了させる。

### CI guard 実装 (E-6)
- **Context**: 要件 12.4 は旧 API 参照残存時に CI で失敗させる運用。
- **Sources Consulted**: Biome lint（カスタムルール不向き）、`git grep` の CI ジョブ、pre-commit hook
- **Findings**:
  - Biome でのカスタムルール化は工数過剰。単純な禁止語 grep で十分。
  - CI で `npm run lint:legacy` のような grep スクリプトを実行、主要禁止語（`/jobs`, `StatusTable`, `job_id` 等）をヒットさせて失敗させる。
- **Implications**:
  - **選定: `scripts/check-legacy-refs.sh`（bash）を package.json の `lint:legacy` に束ね、CI ワークフローで実行**。pre-commit でも同じスクリプトを流す。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| A. In-place replace | 既存 `ProcessingStack`/`ApiStack` を直接改修 | スタック構成変更が最小 | 破壊的変更が 1 PR 集中、段階検証困難 | - |
| B. Parallel new stack | `BatchesStack` を新設 → 検証後に旧削除 | 新旧隔離、ロールバック容易 | 一時的に 2 系統のリソース、コスト一時増 | 移行期間が長期化しやすい |
| C. Hybrid phased **(採用)** | SageMaker / CloudFront / endpoint-control / SNS / 既存 S3 を共有、API ルート・DDB・Processor・Monitoring・OpenAPI を並行実装 → 検証 → 旧削除 | 共通インフラ再利用でコスト／工数最適、段階検証可能 | 置換タイミングの同期が必要 | Design で明確なカットオーバー定義 |

## Design Decisions

### Decision: Fargate タスクを Processor ランタイムとして採用
- **Context**: Lambda 15 分上限を超える可能性が高く、バッチ中断リスクを排除したい。
- **Alternatives Considered**:
  1. Lambda を延命（メモリ・並列度最適化で 15 分以内を狙う）
  2. SageMaker Batch Transform / Async Inference に処理主体を移す
  3. ECS Fargate（Step Functions から `ecs:runTask.sync`）
- **Selected Approach**: (3) Fargate タスク。既存 `lambda/processor/Dockerfile` を再利用してバッチランナーイメージを構築し、Step Functions がタスクを同期起動する。
- **Rationale**: 最大実行時間に余裕、Python 3.12 + `yomitoku-client` の依存を既存のままコンテナ化可能、Step Functions との連携が既存 `OrchestrationStack` と整合する。
- **Trade-offs**: Fargate cold-start（数十秒）が `start` → 推論開始に追加される。Lambda より運用コストは若干高いがアイドル課金なし。
- **Follow-up**: タスク定義の CPU/メモリ（初期 4vCPU / 16GB）とスループットを PoC で計測。

### Decision: Single-table DynamoDB 設計
- **Context**: バッチ／ファイル両エンティティの関連クエリを最小化したい。
- **Alternatives Considered**:
  1. 2 テーブル（BatchTable / FileTable）
  2. Single-table（PK=`BATCH#{id}`, SK=`META` or `FILE#{s3Key}`）
- **Selected Approach**: (2) Single-table。`Query(PK=BATCH#id)` で META + 全ファイルを 1 クエリ取得。
- **Rationale**: アクセスパターン (a)–(c) を 1–2 クエリで満たす、トランザクション境界が 1 テーブル内に収まる、GSI 設計で横断参照を明確化できる。
- **Trade-offs**: 属性命名／アイテム型識別の規約を実装・レビュー時に厳格化する必要がある（`entityType` 属性を必須にする）。
- **Follow-up**: Design の Data Models 節で `entityType = BATCH | FILE` とスキーマを完全定義。

### Decision: 明示 `POST /batches/:id/start` を完了検知正本とする
- **Context**: S3 並列アップロードの完了検知方式選択。
- **Alternatives Considered**:
  1. 終端マニフェスト PUT + EventBridge
  2. DDB 差分ポーリング
  3. 明示的 start エンドポイント
- **Selected Approach**: (3) 明示 start。欠損ファイルは `ListObjectsV2` と DDB の期待集合で判定。
- **Rationale**: クライアント側の実装が最も単純、並列 PUT の競合を気にせずに済む、欠損判定が start の 1 点に集約される。
- **Trade-offs**: クライアントが start を忘れた場合バッチは `PENDING` のまま滞留。TTL で自動 `FAILED` 化する運用補助を追加する。
- **Follow-up**: DDB に `ttl`（createdAt + 24h）を設定し期限切れ PENDING を自動削除。

### Decision: 旧リソースのカットオーバー方式（データ移行なし）
- **Context**: 要件 1 / 9 の完全廃止・データ移行なし方針。
- **Alternatives Considered**:
  1. Blue/Green 切替（旧と新を並行稼働 → 一定期間後に旧削除）
  2. カットオーバー（1 デプロイで旧リソース削除・新リソース作成）
- **Selected Approach**: (2) カットオーバー。1 回の CDK deploy で `StatusTable`（RETAIN ポリシー）を除去、Lambda / SQS / 旧ルートは同一 PR で削除。
- **Rationale**: 後方互換不要、旧 API の利用者は存在しない前提。アプリ層のリソース二重持ちを回避しコスト最適。
- **Trade-offs**: デプロイ中の短時間ダウンタイム（API 書き換え中）が発生。事前メンテナンス告知で吸収。
- **Follow-up**: `removalPolicy` を `RemovalPolicy.DESTROY` に一時変更してデプロイ後に元に戻すか、手動 `aws dynamodb delete-table` で確実に削除。

## Risks & Mitigations
- **R1: Fargate cold-start で start → 実行開始が数十秒遅延** — 運用文書にレイテンシ特性を明記、利用者向け SLA は「start 受付から初回推論開始まで 60 秒以内」を目標に設定。
- **R2: SageMaker エンドポイント単一インスタンス前提のため同時バッチ競合** — `ControlTable` の `concurrentBatchCount` を監視し、2 本目以降はキュー（SQS FIFO）で直列化。
- **R3: `process_log.jsonl` 欠損／破損時の状態同期崩れ** — Fargate タスクは process_log を S3 に書き込んだ後に DDB を更新する「ログ優先」順序を守り、タスク失敗時は DDB を `FAILED` に設定。
- **R4: `StatusTable` 削除時のデプロイ事故** — staging 環境での事前ドライラン、`--method=prepare-change-set` で差分確認後に deploy。
- **R5: CI guard が誤検知して無関係な一致をブロック** — 禁止語リストは固定し、`.kiro/` ディレクトリを除外する grep パスを明示。

## References
- [MLism-Inc/yomitoku-client](https://github.com/MLism-Inc/yomitoku-client) — バッチ CLI・`analyze_batch_async` ソース
- [AWS DynamoDB Single-Table Design](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-general-nosql-design.html)
- [AWS Step Functions — Run an ECS/Fargate task and wait for it to complete](https://docs.aws.amazon.com/step-functions/latest/dg/connect-ecs.html)
- [AWS Lambda limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) — 15 分タイムアウト制約
