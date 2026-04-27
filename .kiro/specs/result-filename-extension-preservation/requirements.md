# Requirements Document

## Introduction

OCR バッチ処理結果のメイン JSON ファイル名から原本ドキュメントの拡張子が剥がれているため (`report.pdf` / `report.pptx` / `report.docx` / `report.xlsx` がいずれも `report.json` で出力される)、`office-format-ingestion` のリリースによって複数フォーマットが API で受理可能になることで、以下の問題が顕在化する:

- 複数フォーマット混在バッチで、`BatchFile.resultKey` だけを見て元ドキュメントの形式を機械的に判別できない
- 同名で拡張子だけ違うファイルが同一の resultKey で衝突する余地がある (現行 stem 一意制約で API 側で弾かれてはいるが、命名側でも判別可能性を確保したい)
- 監査用途で原本と OCR 結果を機械的に突合する後段処理が複雑化する

本 spec は、メイン OCR JSON の S3 命名規約を `{file_stem}.json` から `{原本ファイル名}.json` (例: `report.pdf.json` / `deck.pptx.json`) に変更し、可視化 lookup と既存テスト fixture を新規約に追従させる。`BatchFile.resultKey` は既存 API consumer に対する破壊的変更となるため、OpenAPI description で値フォーマットの変更を明示する。

## Boundary Context

- **In scope**:
  - メイン OCR JSON の S3 命名規約変更 (`{stem}.json` → `{原本ファイル名}.json`)
  - 可視化 lookup ロジックの二段拡張子対応 (PDF / Office 形式の双方で正しく PDF を解決)
  - Office 形式の原本ファイル名 (`deck.pptx`) を変換後 PDF (`deck.pdf`) と分離して保持する仕組み
  - `BatchFile.resultKey` の OpenAPI description 更新と移行通知
  - 既存テスト fixture / assertion の新規約への移行
- **Out of scope**:
  - 追加フォーマット (`.md` / `.csv` / `.html`) のファイル名統一 (yomitoku-client 側責務、将来 spec)
  - 可視化 JPEG (`{basename}_{mode}_page_{idx}.jpg`) の命名変更
  - 既存バッチ (実行中 / 過去分) の遡及リネーム / S3 オブジェクトの一括移動
  - DynamoDB の `resultKey` 属性名の変更 (値フォーマットのみ変更)
  - 新 API バージョン番号の発行 / `/v2/batches` などのパス分離
- **Adjacent expectations**:
  - `office-format-ingestion` で導入された `convert_office_files` 戻り値 (変換後 PDF と原本 Office パスのペア) と `apply_process_log` の `converted_filename_map` 機構を本 spec のスコープで再利用する
  - 入力ファイル名に対する API レイヤのサニタイズ規則 (空白処理 / 非 ASCII 処理) は本 spec で変更しない。本 spec は「サニタイズ後の原本ファイル名」を JSON 命名に使用する
  - yomitoku-client が SageMaker コンテナ内で生成する追加フォーマット (`.md` / `.csv` / `.html`) の命名は本 spec で変更せず、メイン JSON とのファイル名非対称が一時的に発生する

## Requirements

### Requirement 1: メイン OCR JSON ファイル名の拡張子保持

**Objective:** API consumer として、`BatchFile.resultKey` から原本ドキュメントの形式を機械的に判別したいので、メイン OCR JSON ファイル名に原本拡張子を含めてほしい。

#### Acceptance Criteria

1. When 入力 `report.pdf` の OCR が成功したとき、the Batch Runner Service shall save the main OCR JSON to S3 key `batches/{batchJobId}/output/report.pdf.json`.
2. When 入力 `deck.pptx` (Office 形式、Fargate 内で `deck.pdf` に変換) の OCR が成功したとき、the Batch Runner Service shall save the main OCR JSON to S3 key `batches/{batchJobId}/output/deck.pptx.json` (変換後 PDF の名前ではなく原本 Office 名を使用).
3. When 入力 `report.docx` または `report.xlsx` の OCR が成功したとき、the Batch Runner Service shall save the main OCR JSON to S3 key `batches/{batchJobId}/output/report.docx.json` または `batches/{batchJobId}/output/report.xlsx.json`.
4. When 入力ファイル名が非 ASCII 文字またはサニタイズ対象文字を含むとき、the Batch Runner Service shall ensure the resulting `resultKey` value contains exactly the same サニタイズ済の原本ファイル名が API レスポンスの `BatchFile.filename` と一致するようにし、内部的なハッシュ済識別子をファイル名に流出させない。
5. When API consumer が `GET /batches/{batchJobId}` で対象ファイルを照会したとき、the API Service shall return `BatchFile.resultKey` の値として `batches/{batchJobId}/output/{原本ファイル名}.json` 形式の S3 キーを返す。

### Requirement 2: 可視化機能の非リグレッション

**Objective:** Operator として、メイン JSON 命名規約の変更によって OCR 結果の可視化 (PDF オーバーレイ JPEG) が壊れないことを保証したい。

#### Acceptance Criteria

1. When 入力 `report.pdf` の OCR + 可視化が完了したとき、the Batch Runner Service shall produce visualization JPEGs at `batches/{batchJobId}/visualizations/report_{mode}_page_{idx}.jpg`.
2. When 入力 `deck.pptx` (Office 形式、Fargate 内で `deck.pdf` に変換) の OCR + 可視化が完了したとき、the Batch Runner Service shall produce visualization JPEGs at `batches/{batchJobId}/visualizations/deck_{mode}_page_{idx}.jpg`.
3. When 可視化処理が JSON ファイルから対応する PDF (元 PDF または変換後 PDF) を逆引きするとき、the Batch Runner Service shall correctly resolve the PDF path for both PDF inputs and Office-format inputs converted to PDF, without raising file-not-found errors.
4. The Batch Runner Service shall preserve the existing visualization JPEG naming convention (`{basename}_{mode}_page_{idx}.jpg`, where `{basename}` is the stem of the original document name).

### Requirement 3: 失敗ケースとエラーカテゴリの整合

**Objective:** API consumer として、変換失敗 / OCR 失敗時のレスポンスが新命名規約でも一貫していることを保証したい。

#### Acceptance Criteria

1. If Office 形式の入力ファイル (例: `deck.pptx`) の変換が失敗したとき、the API Service shall return `BatchFile.errorCategory = CONVERSION_FAILED` and shall not return a `BatchFile.resultKey` value for that file.
2. If OCR 推論が失敗したとき、the API Service shall return `BatchFile.errorCategory = OCR_FAILED` and shall not return a `BatchFile.resultKey` value for that file.
3. While ファイルが処理中 (`PENDING` / `PROCESSING`) の状態にあるとき、the API Service shall not return a `BatchFile.resultKey` value for that file.

### Requirement 4: API ドキュメントと移行通知

**Objective:** 既存 API consumer として、`BatchFile.resultKey` の値フォーマット変更を事前に把握し、パース処理を更新できるようにしたい。

#### Acceptance Criteria

1. The API Service shall update the OpenAPI description of `BatchFile.resultKey` to specify that the value now follows the format `batches/{batchJobId}/output/{原本ファイル名}.json`, where `{原本ファイル名}` retains the original file extension (例: `report.pdf.json` / `deck.pptx.json` / `report.docx.json` / `report.xlsx.json`).
2. The API Service shall include a migration note in the OpenAPI description explaining that the `.json` 直前のファイル名部分に原本拡張子が含まれるよう変更されたこと、および既存 consumer の `resultKey` パース処理 (basename を抽出する場合) に影響することを明示する。
3. The API Service shall preserve the `resultKey` attribute name and the invariant that the value ends with `.json` (terminating extension は変更しない).
4. The API Service shall document in the OpenAPI description that メイン JSON と yomitoku-client が出力する追加フォーマット (`.md` / `.csv` / `.html`) の命名は一時的に非対称 (例: メイン `report.pdf.json` / 追加 `report.md`) であり、将来 spec で統一する可能性があると注記する。

### Requirement 5: 既存バッチへの非影響

**Objective:** 運用担当者として、本変更が既にデプロイ済の OCR バッチ (実行中 / 過去分) の S3 オブジェクトおよび DynamoDB の `resultKey` 値を破壊しないことを保証したい。

#### Acceptance Criteria

1. The Batch Runner Service shall not retroactively rename existing main OCR JSON objects in S3 for previously completed batches.
2. The Batch Runner Service shall not retroactively update `resultKey` values in existing DynamoDB FILE items.
3. When 本変更のデプロイ後に新規作成されたバッチが実行されたとき、only those new batches shall produce main JSON files following the new naming convention; in-flight バッチ (デプロイ前に開始されたが未完了のもの) の挙動は design phase で決定する。
