# Requirements Document

## Project Description (Input)
https://github.com/MLism-Inc/yomitoku-client に記載のあるバッチ処理に移行したい

## Introduction
本仕様は、現行の YomiToku OCR Worker（1 ジョブ = 1 PDF の同期風処理）を、yomitoku-client が提供する「バッチ処理モード」（ディレクトリ配下の複数ファイルをページ単位で並列推論し、`process_log.jsonl` を含む構造化出力を生成する処理）へ**全面的に置き換える**ことを目的とする。既存の単一ファイル API（`POST /jobs` 等）、その DynamoDB スキーマ、単一ジョブ専用の Lambda／SQS／S3 レイアウト・IAM 権限・メトリクスなど、バッチ化後に不要となるリソースは削除する。DB スキーマはバッチ処理に最適な構造へ再設計し、後方互換は一切維持しない。ユーザーはバッチ API のみを通じて OCR 処理を利用し、運用者は `process_log.jsonl` を中心とした観測・再解析運用に移行する。

## Boundary Context
- **In scope**:
  - バッチジョブの作成・アップロード・実行・結果取得を行う新 API（バッチ API）への全面置換
  - yomitoku-client の `analyze_batch_async` 相当の処理モデル（ページ分割並列・サーキットブレーカ・リトライ）導入
  - バッチ処理に最適化された DynamoDB スキーマの再設計（バッチ単位・ファイル単位の両レベル状態を表現）
  - S3 レイアウトのバッチ向け再設計（入力・出力・ログ・可視化の配置統一）
  - 不要となった単一ジョブ向け API ルート、DynamoDB 属性／テーブル、Lambda ハンドラ・コード、SQS 契約、S3 キーパターン、IAM 権限、CloudWatch メトリクス／ダッシュボード、OpenAPI 定義、テスト、`scripts/` 等の削除
- **Out of scope**:
  - SageMaker エンドポイントの自動起動／停止ライフサイクル自体の再設計（既存 `OrchestrationStack` の方針を継承。ただし単一ジョブ前提の起動トリガや状態表現は、バッチ前提に置換する範囲で変更可）
  - SageMaker インスタンスタイプ選定・モデルバージョンのアップグレード
  - CloudFront／WAF／API Gateway の経路制御方針そのものの再設計（新 API を新経路で提供する変更は許容）
  - yomitoku-client パッケージ本体への機能追加
- **Adjacent expectations**:
  - SageMaker エンドポイント制御（`endpoint-control`）は、バッチ実行中は `IN_SERVICE` を維持し、実行終了後は既存ポリシーで停止する
  - DynamoDB ジョブ状態テーブルは、引き続き利用者に観測されるステータスの正本だが、スキーマは完全に置換される（データ移行は原則行わない）
  - 既存の単一ジョブ API 利用者は存在しないか、または本置換に先立って移行完了している前提とする

## Requirements

### Requirement 1: 単一ジョブ API および関連リソースの廃止
**Objective:** As a 運用者, I want 旧「1 PDF 1 ジョブ」API とそれに付随する全リソースを削除したい, so that バッチ処理のみが正本となり、二重運用・デッドコード・余分なコストが発生しない

#### Acceptance Criteria
1. The YomiToku OCR Worker shall 旧 `POST /jobs` / `GET /jobs/:id` / `GET /jobs` / `DELETE /jobs/:id` / `GET /jobs/:id/visualizations` 等、単一ジョブ前提の公開ルートを提供しない
2. The YomiToku OCR Worker shall 単一ジョブ前提で定義された DynamoDB テーブル・属性・GSI を削除し、後方互換の読み取りパスを提供しない
3. The YomiToku OCR Worker shall 単一ジョブ専用の Lambda ハンドラ（`lambda/processor/index.py` 等）と関連 Docker イメージ構成、SQS 契約、IAM 権限、CloudWatch メトリクス／アラーム、OpenAPI 定義、`scripts/` テストスクリプトを削除または新バッチ向けへ再設計する
4. The YomiToku OCR Worker shall S3 の `input/{basePath}/{jobId}/{filename}` / `output/{basePath}/{jobId}/{filename}.json` 形式など、単一ジョブ特有のキーレイアウトを廃止し、バッチ向けレイアウトに統一する
5. If 廃止された旧 API のパスが呼び出された場合, then the YomiToku OCR Worker shall `404` を返し、後方互換的な応答は行わない

### Requirement 2: バッチジョブの作成とアップロード受付
**Objective:** As a API 利用者, I want 複数の PDF をひとつのバッチジョブとして登録しアップロード先を取得する, so that 1 回の発注で関連文書一式を OCR 処理に投入できる

#### Acceptance Criteria
1. When 利用者が `POST /batches` に basePath と対象ファイル一覧（filename と任意のメタデータ）を指定して要求した場合, the YomiToku OCR Worker shall 単一の `batchJobId` と各ファイルに対応する署名付き S3 アップロード URL 群を返却する
2. The YomiToku OCR Worker shall 1 バッチあたりの最大ファイル数・合計サイズ・単一ファイル最大サイズの上限を定義し、超過した要求を 400 系エラーで拒否する
3. If 要求に `.pdf` 以外の拡張子が含まれ、かつ許容拡張子として合意されていない場合, then the YomiToku OCR Worker shall 当該ファイルを理由付きで拒否し、バッチ全体の作成を失敗として応答する
4. While エンドポイント状態が `IN_SERVICE` ではない場合, the YomiToku OCR Worker shall `503` を返しエンドポイント起動要求をキックする
5. The YomiToku OCR Worker shall 署名付き URL の有効期限を明示し、利用者がその期間内にアップロードを完了する前提を応答に含める

### Requirement 3: アップロード完了検知とバッチ実行トリガ
**Objective:** As a API 利用者, I want アップロード完了後に自動または明示操作でバッチ実行が開始されること, so that 追加の運用介入なしに OCR 処理を走らせられる

#### Acceptance Criteria
1. When バッチ配下の全ファイルのアップロード完了が検知された場合, the YomiToku OCR Worker shall 当該バッチを `PROCESSING` 状態へ遷移させて実行を開始する
2. Where 利用者が明示的な開始要求 (`POST /batches/:batchJobId/start` 相当) を送信する運用を選択した場合, the YomiToku OCR Worker shall 当該要求を受けて実行を開始し、未アップロードのファイルがあれば欠損を明示したエラーで拒否する
3. If 署名付き URL の期限切れ後にバッチが開始された場合, then the YomiToku OCR Worker shall 未到着ファイルを欠損として扱い、バッチ全体を失敗として `FAILED` に遷移させる
4. The YomiToku OCR Worker shall 実行開始時点の `startedAt` タイムスタンプとバッチメタデータを永続化し、利用者が後から参照できるようにする

### Requirement 4: バッチ処理の並列実行と障害耐性
**Objective:** As a 運用者, I want yomitoku-client バッチモードの並列処理・サーキットブレーカ・リトライを利用したい, so that 大量文書でもスループットと安定性を両立できる

#### Acceptance Criteria
1. When バッチ実行が開始された場合, the YomiToku OCR Worker shall yomitoku-client のバッチ処理（ファイル並列＋PDF/TIFF のページ単位並列推論）を適用する
2. The YomiToku OCR Worker shall ファイル単位・ページ単位のリトライ上限、コネクション／リードタイムアウト、サーキットブレーカ閾値・クールダウン時間を、利用者／運用者が構成可能な設定として公開する
3. While サーキットブレーカが開いている間, the YomiToku OCR Worker shall 後続のエンドポイント呼び出しを一時停止し、一定時間経過後に自動復帰する
4. If 個別ファイルの処理が最大リトライ回数に達して失敗した場合, then the YomiToku OCR Worker shall 当該ファイルを失敗として記録しつつ、残余ファイルの処理を継続する
5. The YomiToku OCR Worker shall 1 バッチ内で同時に進行するファイル数とページ数の上限を運用上設定でき、SageMaker エンドポイントへの過負荷を防ぐ

### Requirement 5: process_log.jsonl とファイル単位ステータスの提供
**Objective:** As a API 利用者／運用者, I want バッチ内の各ファイル処理結果を一覧で確認したい, so that 成功・失敗の切り分けと再実行判断ができる

#### Acceptance Criteria
1. The YomiToku OCR Worker shall バッチ完了時に `process_log.jsonl` を生成し、1 行 1 レコードで少なくとも以下を含める: `timestamp`、`file_path`（入力）、`output_path`（JSON 結果）、`dpi`、`executed`、`success`、`error`（失敗時は事由文字列、成功時は null）
2. When 利用者が `GET /batches/:batchJobId` を要求した場合, the YomiToku OCR Worker shall バッチ全体のステータス、総ファイル数、成功件数、失敗件数、進行中件数、開始・更新タイムスタンプを返却する
3. When 利用者が `GET /batches/:batchJobId/files` を要求した場合, the YomiToku OCR Worker shall 各ファイルのステータス・処理時間・エラーメッセージ・結果成果物への署名付き URL を返却する
4. The YomiToku OCR Worker shall `process_log.jsonl` 自体の署名付きダウンロード URL を提供し、利用者が JSON Lines としてそのまま取得できるようにする

### Requirement 6: 結果成果物と可視化出力の生成
**Objective:** As a API 利用者, I want OCR 結果 JSON・可視化画像・任意のフォーマット変換出力をバッチ単位で取得したい, so that バッチパイプラインの成果物をそのまま利用できる

#### Acceptance Criteria
1. The YomiToku OCR Worker shall バッチ内で成功した各ファイルについて JSON 形式の OCR 結果を生成し、バッチ配下の決められた配置で取得可能にする
2. The YomiToku OCR Worker shall 成功した各ファイルについて、layout／ocr モードの可視化画像をページ単位で生成し、バッチ配下の既知のプレフィックスに配置する
3. Where 利用者がバッチ作成時に追加フォーマット（markdown／csv／html／pdf など、yomitoku-client が標準でサポートするもの）を指定した場合, the YomiToku OCR Worker shall 該当フォーマットの変換出力を生成する
4. If 可視化画像または追加フォーマット変換が失敗した場合, then the YomiToku OCR Worker shall OCR 本体の成功状態を維持しつつ、失敗内容をファイル単位のエラー情報に付記する
5. The YomiToku OCR Worker shall バッチ成果物取得用の署名付き URL を発行し、利用者の明示要求時のみ URL を発行（未完了ジョブでは 404 または 409 を返す）する

### Requirement 7: バッチ全体ステータスと部分成功の取扱い
**Objective:** As a API 利用者, I want バッチ全体のステータスから成功・部分成功・失敗を区別したい, so that 自動化パイプラインがポスト処理判断を行える

#### Acceptance Criteria
1. The YomiToku OCR Worker shall バッチステータスとして少なくとも `PENDING`、`PROCESSING`、`COMPLETED`、`PARTIAL`、`FAILED`、`CANCELLED` を提供する
2. When バッチ配下の全ファイルが成功した場合, the YomiToku OCR Worker shall ステータスを `COMPLETED` に設定する
3. When バッチ配下の一部ファイルが成功し一部が失敗した場合, the YomiToku OCR Worker shall ステータスを `PARTIAL` に設定し、成功件数と失敗件数を応答に含める
4. When 全ファイルが失敗した、またはインフラ要因（エンドポイント長時間停止等）で処理続行不能と判断した場合, the YomiToku OCR Worker shall ステータスを `FAILED` に設定しエラー要約を返す
5. While バッチが `PENDING` 状態の場合, the YomiToku OCR Worker shall `DELETE /batches/:batchJobId` によるキャンセルを許容し、`PROCESSING` 以降はキャンセル不可で `409` を返す

### Requirement 8: 失敗ファイルのみの再解析運用
**Objective:** As a 運用者, I want `process_log.jsonl` に基づき失敗ファイルだけを再処理したい, so that エンドポイント負荷とコストを抑えつつ成功率を底上げできる

#### Acceptance Criteria
1. When 運用者が既存バッチを基に「失敗ファイルのみ再解析」を要求した場合, the YomiToku OCR Worker shall 元バッチの `process_log.jsonl` から `success=false` のファイル集合を特定し、新規バッチとして投入する
2. The YomiToku OCR Worker shall 再解析バッチが元バッチを参照できるよう親子関係（元 `batchJobId`）をメタデータに保持する
3. When 再解析が成功した場合, the YomiToku OCR Worker shall 元バッチの最終成果物取得 API から、最新成功結果（再解析側を優先）を取得可能な経路を提供する
4. If 元バッチが存在しない・`process_log.jsonl` が欠損している場合, then the YomiToku OCR Worker shall 再解析要求を `404` または `409` で拒否する

### Requirement 9: バッチ処理に最適化された DynamoDB スキーマの採用
**Objective:** As a 運用者, I want バッチ単位とファイル単位の両レベル状態を効率的に扱えるデータモデルにしたい, so that 単一ジョブ前提の属性を捨て、アクセスパターン（バッチ詳細取得・ファイル一覧取得・ステータス検索）を最小コストで満たせる

#### Acceptance Criteria
1. The YomiToku OCR Worker shall 旧「ジョブ 1 件 = アイテム 1 件」スキーマを廃止し、バッチエンティティとファイルエンティティ（または同等の構造）を表現する新スキーマのみを提供する
2. The YomiToku OCR Worker shall 新スキーマで少なくとも以下のアクセスパターンを、単一クエリまたは最小限のクエリで満たす: (a) バッチ単体の取得、(b) バッチ配下のファイル一覧取得、(c) ステータスによるバッチ検索／ページング
3. The YomiToku OCR Worker shall 旧スキーマのデータ移行を行わず、置換前の既存バッチ・ジョブは参照不能になることを前提とする（データ移行要件は本スペックの範囲外）
4. The YomiToku OCR Worker shall 新スキーマの GSI／属性名／キー構成が、ファイル数・バッチ数の増大に対しスケールアウトに耐える設計（ホットキー回避、パーティション分散）であることを定義する
5. The YomiToku OCR Worker shall 旧テーブル／GSI を Infrastructure-as-Code 上から削除し、デプロイ後にアカウントに残存させない

### Requirement 10: エンドポイント・運用制約との整合
**Objective:** As a 運用者, I want バッチ処理がエンドポイントのライフサイクルおよびコスト制約と整合していること, so that アイドル課金ゼロ方針を維持できる

#### Acceptance Criteria
1. While バッチ実行中の場合, the YomiToku OCR Worker shall エンドポイントを `IN_SERVICE` に維持するためのシグナル（例: キュー上の未処理メッセージ）を発し続ける
2. When バッチ実行が完了・失敗・キャンセルされた場合, the YomiToku OCR Worker shall 既存のエンドポイント自動停止ロジックと協調し、アイドル判定を阻害しない
3. The YomiToku OCR Worker shall バッチ実行中の主要メトリクス（処理中ファイル数、成功／失敗件数、サーキットブレーカ発動回数、累計ページ数）を CloudWatch へ出力し、旧単一ジョブ用メトリクスは削除する
4. If 単一バッチの総処理時間が定義された上限を超過した場合, then the YomiToku OCR Worker shall 当該バッチを `FAILED` 化してエンドポイントを解放する
5. The YomiToku OCR Worker shall バッチ API を現行同等のアクセス制御（CloudFront 経由必須、WAF 任意）下で公開し、直接アクセスを拒否する

### Requirement 11: 非機能要件（スループット・可観測性・運用上限）
**Objective:** As a 運用者, I want バッチ処理のスループットと運用上限を事前に約束したい, so that キャパシティ計画と SLA を策定できる

#### Acceptance Criteria
1. The YomiToku OCR Worker shall 所定の SageMaker インスタンスタイプごとに目標スループットを文書化し（例: `ml.g5.xlarge` での目標ページ／時間を yomitoku-client 推奨値ベースで明示）、実測値をメトリクスとして継続的に出力する
2. The YomiToku OCR Worker shall 1 バッチあたりの最大ファイル数、合計サイズ、最大実行時間、同時実行バッチ数の上限を設定値として公開する
3. The YomiToku OCR Worker shall バッチごとの開始・終了タイムスタンプ、ページ総数、失敗件数、処理時間を CloudWatch Logs に記録する
4. If 総処理時間または総ページ数が上限しきい値を超過した場合, then the YomiToku OCR Worker shall 運用者向けアラート（SNS 通知等、既存 `MonitoringStack` ポリシー）を発火させる
5. The YomiToku OCR Worker shall `process_log.jsonl` および成果物のリテンション方針（保管期間と自動削除条件）を定義し、旧単一ジョブ前提のリテンション設定は削除する

### Requirement 12: OpenAPI / ドキュメントの刷新
**Objective:** As a API 利用者, I want 新バッチ API のみが文書化された状態にしたい, so that 旧 API との混乱なくクライアント実装を進められる

#### Acceptance Criteria
1. The YomiToku OCR Worker shall 公開 OpenAPI ドキュメント（`/doc`）および Swagger UI（`/ui`）から旧 `/jobs` 系エンドポイントの定義を完全に削除する
2. The YomiToku OCR Worker shall バッチ API (`/batches` 系) の全ルートを OpenAPI に記述し、パラメータ・応答・エラーコードを正準定義とする
3. The YomiToku OCR Worker shall リポジトリ内の `README.md`、設計資料（例: `API実装検討.md`）、サンプルコード、`scripts/` 連携スクリプトを新 API 前提に更新し、旧 API 記述を削除する
4. If 旧 API への参照が残存している場合, then CI または Lint チェックが失敗し、マージを阻止する運用とする
