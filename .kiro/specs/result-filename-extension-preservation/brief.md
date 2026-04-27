# Brief: result-filename-extension-preservation

## Problem

OCR 結果のメイン JSON ファイル名が原本の拡張子を失っている (`report.pdf` → `report.json`、`report.pptx` → `report.json`)。これにより:

- 複数フォーマット (PDF / PPTX / DOCX / XLSX) を扱うバッチで、出力 JSON だけを見て元ドキュメントの形式が判別できない
- 同名で拡張子だけ違うファイル (`report.pdf` と `report.pptx` を同一バッチに投入した場合) が `report.json` で衝突する余地がある
- 監査用途で原本と OCR 結果を機械的に突合する処理が後段のクライアントで複雑化する

`office-format-ingestion` spec の進行により Office 形式が API で受理可能になることで、上記問題が顕在化する。

## Current State

- **メイン OCR JSON 命名**: `lambda/batch-runner/async_invoker.py:492` で `persisted_path = output_dir / f"{file_stem}.json"`。原本拡張子を完全に剥がしている
- **可視化 JPEG 命名**: `lambda/batch-runner/runner.py:146` で `{basename}_{mode}_page_{idx}.jpg`、`runner.py:170-171` で `basename = json_file.stem` から `{basename}.pdf` を逆引きしている (JSON ファイル名と入力 PDF 名が `.json` / `.pdf` の差で対応する前提)
- **追加フォーマット (`.md` / `.csv` / `.html` / `.pdf`)**: yomitoku-client が SageMaker コンテナ内で命名するため batch-runner からは制御不可。命名規約は yomitoku-client 側の責務
- **`s3_sync.py:37-46`** の `_EXT_TO_CATEGORY` マップは拡張子ベースで分類するため、ファイル名先頭部の変更には影響しない
- **`batch_store.py:237`** の `result_key` 組み立ては `entry.output_path.name` ベースのため、メイン JSON 命名変更に追従する
- **`batch_store.apply_process_log` の DDB FILE PK 解決 (済)**: `office-format-ingestion` の ultrareview 後追加修正 (Bug 001) で、`apply_process_log(..., converted_filename_map={"deck.pdf": "deck.pptx"})` を受け取り PK lookup 時に変換後 PDF 名 → 原本 Office 名へ書き戻す機構が既に入った。これにより本 spec の「PK 半分」 (= 変換成功 PPTX の DDB FILE 行が PENDING に残る問題) は前倒しで解消済み。本 spec のスコープは引き続き **JSON 命名側 (`{stem}.json` → `{full_filename}.json`)** に限定される

## Desired Outcome

- メイン OCR JSON のファイル名が **`{原本ファイル名}.json`** (例: `report.pdf.json` / `report.pptx.json` / `report.docx.json` / `report.xlsx.json`) になる
- 既存の可視化 / 追加フォーマット / 失敗ログ処理は破壊しない
- API の `BatchFile.resultKey` 経由で取得できる S3 キーは `batches/{id}/output/{原本ファイル名}.json` になる
- 既存 API consumer に対しては「`resultKey` が `.json` 終端である保証は維持されるが、`.json` 直前のファイル名部分に拡張子 (例: `.pdf`) が含まれる」という migration メモを OpenAPI description で明示する

## Approach

`async_invoker.py` でメイン JSON を保存する際の命名規約を変更し、それに連動して可視化 lookup ロジックを書き換える。

### コア改修
1. **`async_invoker.py:492`**: `output_dir / f"{file_stem}.json"` → `output_dir / f"{original_filename}.json"`
   - `file_stem` は SageMaker InferenceId のための変換 (非 ASCII → SHA-1) が入っており、原本ファイル名そのものではない
   - `stem_to_input` dict が既に `stem → file_path` を持つので、`file_path.name` から原本ファイル名を取得できる
2. **`runner.py:170-171`**: 可視化の PDF lookup を二段拡張子対応に書き換え
   - 旧: `basename = json_file.stem` (`.json` を 1 段剥がす) → `pdf_path = in_path / f"{basename}.pdf"`
   - 新: `original_name = json_file.name[:-len(".json")]` で原本ファイル名を取り出し、PDF (元 PDF または変換後 PDF) を resolve する
3. **`batch_store.apply_process_log`** の `result_key` 組み立ては `entry.output_path.name` から自動追従 (改修不要)

### Office 形式との整合
- `office-format-ingestion` 完了後、Fargate batch-runner 内で `report.pptx` は変換後 `report.pdf` (ローカルのみ) として処理される
- async_invoker は **原本ファイル名 (`report.pptx`)** を JSON 命名に使う必要があるため、main → convert → async_invoker のパスで「原本ファイル名」を 1 引数追加して受け渡す
- `convert_office_files` の戻り値に `{converted_pdf_filename: original_filename}` のマッピングを含める拡張が必要

### 追加フォーマット (`.md`/`.csv`/`.html`) のスコープ判断
- yomitoku-client モデル側で命名されるため batch-runner から直接変更不可
- 本 spec ではメイン JSON のみ対象とし、追加フォーマットの命名統一は **将来 spec** で扱う (post-rename を batch-runner で行うか、yomitoku-client patch を待つかの設計判断が必要)

### 既存ユーザーへの破壊的変更の扱い
- `.pdf` ユーザーの出力ファイル名が `report.json` → `report.pdf.json` に変わる
- `BatchFile.resultKey` をパースしている API consumer に影響
- 移行戦略は design 時に決定 (一発切り替え / feature flag / 一定期間の dual-write など)

## Scope

- **In**:
  - `async_invoker.py` のメイン JSON 命名規約変更 (`{file_stem}.json` → `{original_filename}.json`)
  - `runner.py` 可視化 lookup ロジックの二段拡張子対応
  - `office-format-ingestion` で導入される `convert_office_files` 戻り値への `{converted_pdf_name: original_filename}` マッピング追加 (本 spec で行う改修)
  - `batch_store.py` の `result_key` 連動確認 (動作確認のみ)
  - OpenAPI description (`BatchFile.resultKey`) の更新と migration ノート
  - `test_async_invoker.py` / `test_runner.py` / `test_run_async_batch_e2e.py` / `test_main.py` 等の test fixture と assert の新仕様への移行
- **Out**:
  - 追加フォーマット (`.md` / `.csv` / `.html`) のファイル名変更 (yomitoku-client 側の責務)
  - 可視化 JPEG (`{basename}_{mode}_page_{idx}.jpg`) の命名変更 (現状維持)
  - 既存バッチ (実行中 / 過去分) の遡及リネーム
  - DynamoDB FILE アイテムの `resultKey` 属性のスキーマ変更 (値だけ変わる、属性名は維持)
  - 新 API バージョン番号の発行 / `/v2/batches` などのパス分離

## Boundary Candidates

- **メイン JSON 命名規約の変更**: `lambda/batch-runner/async_invoker.py` (Async Inference 出力 download 時の命名)
- **可視化 lookup ロジック**: `lambda/batch-runner/runner.py:170-171` の `json_file.stem → pdf_path` 解決
- **原本ファイル名の伝播**: `main.py` / `convert_office_files` (office-format-ingestion 由来) / async_invoker の引数チェーン
- **API documentation**: `lambda/api/schemas.ts` の `BatchFile.resultKey` description

## Out of Boundary

- yomitoku-client (SageMaker コンテナ内) のファイル命名仕様
- 追加フォーマット (`extra_formats`) で生成される `.md` / `.csv` / `.html` / `.pdf` の命名
- 可視化 JPEG (`runner.py::generate_all_visualizations`) の命名
- 既存バッチ結果の遡及的リネーム / S3 オブジェクトの一括移動
- API のメジャーバージョン分離

## Upstream / Downstream

- **Upstream**: `office-format-ingestion` spec — Office 形式の入力受理と Fargate 内変換が成立して初めて、命名統一の必要性が顕在化する。本 spec は office-format-ingestion 完了 (deploy) 後に着手することを前提
- **Downstream**: 将来 `extra-format-naming-unification` spec (仮称) — 追加フォーマット (`.md`/`.csv`/`.html`) も拡張子保持にする場合、yomitoku-client patch または batch-runner での post-rename を検討する別 spec

## Existing Spec Touchpoints

- **Extends**: なし (新規 spec)
- **Adjacent / Avoid Overlap**:
  - `office-format-ingestion`: `async_invoker.py` / `runner.py` を共通で触る。両者の merge 順序を確定させ (本 spec が後)、test fixture の追従を本 spec の責務として明記
  - `batch-scale-out`: 1000 ファイル対応で `async_invoker` のスループット改修が入る場合、命名ロジックの非リグレッションを確認する程度

## Constraints

- **後方互換性**: API レスポンスの `resultKey` スキーマ (string) は維持するが、URL 中のファイル名部分が変わる。既存 API consumer に影響あり → migration window / 通知方針を design で決定
- **可視化 lookup の正確性**: `runner.py` の `basename` 解決ロジックを破壊しないこと。Office 形式 (原本 `.pptx` / 変換後 `.pdf`) と PDF 形式 (原本 = 変換後 = `.pdf`) の双方で正しい PDF が見つかること
- **InferenceId と命名の分離**: SageMaker `InferenceId` は ASCII 制約 + 64 文字上限のため `_safe_ident()` で SHA-1 化される場合がある。一方ローカル JSON 命名は原本ファイル名 (UTF-8、サニタイズ後) を使うため、両者を別系統で管理する必要がある
- **テストデータ移行**: `test_async_invoker.py` / `test_run_async_batch_e2e.py` などで `{stem}.json` を fixture として直接 assert しているコードを全面的に書き換える必要あり
- **DynamoDB `result_key` 値の不変属性名**: 属性名 `resultKey` は変えず、値 (`batches/{id}/output/{name}`) のフォーマットのみ変える
- **追加フォーマットとの非対称**: メイン JSON は `report.pptx.json` / 追加 markdown は `report.md` という非対称が一時的に発生する。design で「将来統一する前提のメモ」を OpenAPI description に残す方針を確定
