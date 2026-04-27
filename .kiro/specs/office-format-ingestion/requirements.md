# Requirements Document

## Introduction

YomiToku OCR Worker は現在 `.pdf` のみを入力として受理しており、PowerPoint / Word / Excel 形式のドキュメントを OCR に流したい利用者は外部で PDF 化してから再アップロードする属人的な運用を強いられている。本 spec は **`.pptx` / `.docx` / `.xlsx` を API から直接受理し、Fargate batch-runner 内部で PDF へ正規化してから既存の SageMaker Async Inference パイプラインに流す** 入力 ingestion 拡張を定義する。

合わせて、roadmap に残っていた Direct Implementation P2 (1 バッチあたりの合計サイズ上限 10 GB 化と Fargate ephemeral storage 拡張) を本 spec の責務に内包する。LibreOffice による PDF 変換は追加のディスク I/O を発生させ、かつ P2 と同じモジュール (`lambda/api/schemas.ts` / `lib/batch-execution-stack.ts`) を触るため、二重変更を避ける目的で一括対応する。

## Boundary Context

- **In scope**:
  - `.pdf` / `.pptx` / `.docx` / `.xlsx` を入力として受理し、最終的に PDF として SageMaker Async Endpoint へ投入するまでの pipeline 拡張
  - Office 形式 → PDF への事前変換。変換後の PDF サイズ再チェック。変換失敗の per-file 分離と `error_category` 記録
  - 1 バッチ内での PDF と Office 形式の混在
  - 1 バッチあたり合計サイズ上限を 10 GB に引き上げ (P2 合流) と、それに必要な Fargate ephemeral storage 拡張
  - 日本語 (CJK) を含む Office 文書の正しいレンダリング
- **Out of scope**:
  - `.odp` / `.ods` / `.odt` など LibreOffice 独自形式や、`.doc` / `.ppt` / `.xls` などレガシー Microsoft Office 形式
  - 画像 (`.png` / `.jpg` 等) を直接 OCR 入力にする対応
  - パスワード保護ファイルの自動解除 (検知して失敗扱いにするのみ)
  - Yomitoku-client / SageMaker エンドポイント側の入力契約変更 (PDF 受理のまま維持)
  - 1 バッチあたりファイル数を 100 件超へ拡張する対応 (`batch-scale-out` spec の責務)
  - PPTX スライド番号の UI 露出など可視化の表記刷新
- **Adjacent expectations**:
  - **Upstream**: Direct Implementation P1 (`MAX_FILES_PER_BATCH=99`) 完了を前提 (`TransactWriteItems` 100 items 上限衝突の回避)
  - **Upstream**: SageMaker Async Endpoint は PDF + payload ≤ 1 GB を引き続き唯一の入力契約とする。本 spec 内で生成される変換後 PDF はこの契約を満たすことを保証する
  - **Downstream**: `batch-scale-out` spec (1 バッチ 1000 ファイル対応) は本 spec 完了後に着手し、本 spec が拡張した ephemeral storage 50 GB 相当を前提とする
  - **技術制約 (Discovery で確定)**: Office 形式から PDF への変換エンジンは LibreOffice headless を採用する。`unoconv` は 2025-03 に archived されたため採用しない。変換エンジンの差し替えや COM ベースの変換 (Microsoft Word/PowerPoint) は Out of scope

## Requirements

### Requirement 1: Office 形式の入力受理
**Objective:** OCR 利用者として、PDF に加えて PPTX / DOCX / XLSX を API から直接アップロードしたい。外部での事前 PDF 変換をやめてトレーサビリティを確保するため。

#### Acceptance Criteria
1. When 利用者が `.pdf` / `.pptx` / `.docx` / `.xlsx` のいずれかの拡張子を持つファイル名を含めて `POST /batches` を発行し、かつ各ファイルに対応する `contentType` を明示した場合、the Batch OCR API shall バッチを作成しアップロード用 presigned URL 群を返す。
2. When 利用者が `contentType` を省略した場合、the Batch OCR API shall ファイル拡張子から導出した既定の Content-Type (PDF なら `application/pdf`、PPTX なら `application/vnd.openxmlformats-officedocument.presentationml.presentation`、DOCX なら `application/vnd.openxmlformats-officedocument.wordprocessingml.document`、XLSX なら `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) を採用する。
3. If 利用者が `.pdf` / `.pptx` / `.docx` / `.xlsx` 以外の拡張子のファイル名を含めた場合、then the Batch OCR API shall HTTP 400 (`VALIDATION_ERROR`) を返しバッチを作成しない。
4. If 利用者が 許可された拡張子に対応しない `contentType` (たとえば `.pptx` に対し `application/pdf`) を明示した場合、then the Batch OCR API shall HTTP 400 を返しバッチを作成しない。
5. The Batch OCR API shall OpenAPI スキーマ (`/openapi.json`) 上の `allowedExtensions` と `contentType` enum に `.pdf` / `.pptx` / `.docx` / `.xlsx` および各対応 MIME type を列挙する。

### Requirement 2: Office 形式から PDF への事前変換
**Objective:** 運用者として、ユーザがアップロードした Office 形式ファイルが OCR 前に透明に PDF 化されてほしい。SageMaker Async Endpoint への入力契約 (PDF のみ) を維持したまま利用者体験を拡張するため。

#### Acceptance Criteria
1. When Batch Runner が S3 からダウンロードしたファイルの拡張子が `.pptx` / `.docx` / `.xlsx` のいずれかである場合、the Batch Runner shall SageMaker Async Endpoint への送信前に当該ファイルを PDF に変換する。
2. When Batch Runner がダウンロードしたファイルの拡張子が `.pdf` である場合、the Batch Runner shall 変換処理をスキップしそのまま SageMaker Async Endpoint へ送信する。
3. The Batch Runner shall SageMaker Async Endpoint へ送信する全ファイルを `application/pdf` として staging する。
4. While Batch Runner が変換処理を実行している間、the Batch Runner shall 個々のファイルの変換がバッチ内の他ファイルの変換および OCR 実行をブロックしないように並行実行する。
5. When 日本語 (ひらがな / カタカナ / 漢字) を含む Office 形式ファイルを変換した場合、the Batch Runner shall 変換後 PDF において元ドキュメントの日本語文字を代替文字 (豆腐 □ / "?") に置換することなく描画する。

### Requirement 3: 混在バッチ処理
**Objective:** 利用者として、1 回のバッチで PDF と Office 形式を混ぜてアップロードしたい。監査目的の大量ドキュメントを形式で分ける手間をなくすため。

#### Acceptance Criteria
1. When 1 バッチ内に PDF と Office 形式のファイルが混在してアップロードされた場合、the Batch OCR API shall 混在を理由にバッチを拒否しない。
2. When 混在バッチの処理が完了した場合、the Batch Runner shall PDF と Office 形式のファイル両方の結果 (OCR JSON / 可視化) を同一バッチの同じ出力階層に配置する。
3. The Batch Runner shall バッチ全体のステータス遷移 (`COMPLETED` / `PARTIAL` / `FAILED`) をファイルフォーマットの別なく同一のロジックで判定する。
4. If 1 リクエスト内のファイル群に同一 stem (拡張子を除いたベース名) を持つファイルが 2 件以上含まれた場合 (例: `report.pdf` と `report.pptx` の同時投入)、then the Batch OCR API shall HTTP 400 (`VALIDATION_ERROR`) を返しバッチを作成しない。stem 比較はサニタイズ後ファイル名に対し case-insensitive で行う。
5. When stem 重複によりバッチが拒否された場合、the Batch OCR API shall エラー本文に重複した stem 値と該当ファイル名を含めて利用者が修正方針を判断できるようにする。

### Requirement 4: 変換失敗の per-file 分離と可観測性
**Objective:** 運用者として、Office 形式変換に失敗したファイルがあってもバッチ全体を止めずに残りの成果を活かしたい。失敗原因をカテゴリ別に区別し Runbook に載せるため。

#### Acceptance Criteria
1. If あるファイルの PDF 変換が失敗した場合、then the Batch Runner shall 当該ファイルのみ FILE ステータスを `FAILED` に遷移させ、同一バッチ内の他ファイルと OCR 実行を継続する。
2. If あるファイルの PDF 変換が失敗した場合、then the Batch Runner shall `process_log.jsonl` に当該ファイルのエントリを追記し `error_category` フィールドに `CONVERSION_FAILED` を記録する。
3. When OCR 実行 (SageMaker Async Inference) 起因でファイルが失敗した場合、the Batch Runner shall `process_log.jsonl` の `error_category` に `OCR_FAILED` を記録する。
4. The Batch Runner shall `process_log.jsonl` の `error_category` が未指定の既存レコードに対し、読み込み時点で `null` として扱い後方互換を維持する。
5. If 入力された Office 形式ファイルが暗号化 / パスワード保護されている場合、then the Batch Runner shall 当該ファイルを `FAILED` + `error_category: CONVERSION_FAILED` とし `errorMessage` にパスワード保護である旨を記録する。
6. If PDF 変換処理が運用者が定める最大時間 (既定値: 300 秒 / ファイル) を超過した場合、then the Batch Runner shall 当該ファイルを `FAILED` + `error_category: CONVERSION_FAILED` とし、変換プロセスを強制終了する。
7. If PDF 変換ツールが成功終了コードを返しながらも出力 PDF ファイルが生成されなかった場合、then the Batch Runner shall 当該ファイルを `FAILED` + `error_category: CONVERSION_FAILED` とする。
8. When 同一バッチ内の 1 ファイル以上が `CONVERSION_FAILED` で失敗し他ファイルが成功した場合、the Batch Runner shall バッチ全体のステータスを `PARTIAL` とする。

### Requirement 5: 変換後 PDF サイズの再検証
**Objective:** 運用者として、変換後の PDF が SageMaker Async payload 上限を超える事態を早期に弾きたい。エンドポイント側エラーで運用アラートが鳴るのを避けるため。

#### Acceptance Criteria
1. When Office 形式ファイルから PDF への変換が完了した時点、the Batch Runner shall 変換後 PDF のサイズを計測する。
2. If 変換後 PDF のサイズが上限 (1 GB、SageMaker Async Inference の入力 payload 上限に一致) を超過した場合、then the Batch Runner shall 当該ファイルを `FAILED` + `error_category: CONVERSION_FAILED` とし、`errorMessage` に変換後サイズ超過である旨と実サイズを記録する。
3. The Batch Runner shall 変換前のアップロード済みサイズが上限 (Requirement 6 の per-file 上限) 以内であっても、変換後サイズ再検証を必ず実行する。

### Requirement 6: 1 バッチあたり合計サイズ上限の 10 GB 化と ephemeral storage 拡張
**Objective:** 運用者として、LibreOffice 変換で必要な一時ディスクを確保しつつ、1 バッチで扱える合計サイズを現状 500 MB から 10 GB に拡大したい。監査用の数千ページ規模のバッチを 1 回で投入できるようにするため。

#### Acceptance Criteria
1. The Batch OCR API shall 1 バッチあたりの合計ファイルサイズ上限を 10 GB として検証する。
2. If 利用者が合計 10 GB を超えるサイズのファイル群を含んだリクエストを送った場合、then the Batch OCR API shall HTTP 400 を返しバッチを作成しない。
3. The Batch OCR API shall OpenAPI スキーマ上の合計サイズ上限 description を 10 GB に更新する。
4. The Batch Runner shall 1 バッチ分のファイルダウンロード / PDF 変換 / 中間成果物 / 変換エンジンの一時ファイルを収容できるディスク容量を動作環境から提供される前提で実装される。
5. While Batch Runner タスクが実行されている間、the YomiToku OCR Worker shall Batch Runner に少なくとも 50 GiB 相当の ephemeral storage を割り当てる。

### Requirement 7: 既存 PDF フローの非退行
**Objective:** 既存の PDF 利用者として、Office 形式対応の追加によって従来のレイテンシと成功率が悪化してほしくない。本変更は純粋な拡張として位置付けたい。

#### Acceptance Criteria
1. When バッチが PDF ファイルのみで構成される場合、the Batch Runner shall Office 形式向けの変換処理を一切起動しない。
2. The YomiToku OCR Worker shall SageMaker Async Endpoint に対する入力契約 (PDF / payload ≤ 1 GB) を本 spec 実装後も維持する。
3. The Batch OCR API shall `.pdf` アップロードに関する既存のエンドポイント (`POST /batches` / `POST /batches/:id/start` / `GET /batches/:id` / `POST /batches/:id/reanalyze` 等) の URL・パラメータ・レスポンススキーマを後方互換に保つ。

### Requirement 8: 可視化の互換性
**Objective:** 利用者として、Office 形式からも従来の PDF 可視化 (layout / OCR オーバーレイ) を同じ形式で得たい。別途ビューワを用意せずに既存の成果物参照フローを使い続けるため。

#### Acceptance Criteria
1. When Office 形式ファイルの OCR と可視化生成が成功した場合、the Batch Runner shall PDF 入力と同じ命名規則 (`{basename}_{mode}_page_{index}.jpg`) で可視化 JPEG を生成し、同一 S3 プレフィックス配下に配置する。
2. The Batch Runner shall Office 形式由来のファイルの可視化についても、変換後 PDF のページ番号を可視化ファイル名の `page_{index}` に採用する。
3. When 変換後 PDF から可視化を生成する際、the Batch Runner shall PDF 入力を前提とした既存の可視化パイプラインをそのまま再利用する (変換済 PDF が PDF 入力と区別なく処理される)。

### Requirement 9: 監査用の元ファイル保持
**Objective:** 監査対応を担う利用者として、利用者がアップロードした原本ファイル (`.pptx` / `.docx` / `.xlsx` を含む) がバッチ処理後も参照可能であってほしい。OCR 結果と原本の突合により金融・法務・行政のトレーサビリティ要件を満たすため。

#### Acceptance Criteria
1. The YomiToku OCR Worker shall 利用者がアップロードした原本ファイルを、ファイル形式 (PDF / PPTX / DOCX / XLSX) によらず既存と同じ S3 retention policy 下で保持する。
2. While バッチの OCR 処理 (変換を含む) が進行している間、the Batch Runner shall 原本ファイルを削除または置換しない。
3. When 変換後 PDF をバッチの内部処理で生成した場合、the Batch Runner shall 変換後 PDF の保持または破棄を原本ファイルの保持要件とは独立に判断できる (原本の保持を前提に、中間成果物の扱いは実装判断とする)。
