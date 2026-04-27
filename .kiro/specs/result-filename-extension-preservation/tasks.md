# Implementation Plan

## 1. Foundation — フィルナムマッピングヘルパ

- [x] 1.1 `office_converter.build_filename_maps` ヘルパ関数を追加
  - `ConvertResult` を受け取り、`(local_to_original, original_to_local)` の双方向マッピングを 1 箇所で原子的に構築する関数を実装する (Single Source of Truth、Critical Issue 1 への design 解決策 案 A)
  - `convert_result.succeeded` (`ConvertedFile(original_path, pdf_path)` の list) を走査し、key/value を Path.name ベースで構築。`succeeded` が空であれば両 map とも空 dict を返す
  - 関数の戻り値型は `tuple[dict[str, str], dict[str, str]]` で型ヒント明示
  - `test_office_converter.py` に新規ユニットテストを追加: 単一 ConvertedFile / 複数 / 空入力の 3 ケースで両 map が完全な逆引き関係 (`local_to_original[v] == k for k, v in original_to_local.items()`) であることを assert
  - **観察可能な完了**: `pytest lambda/batch-runner/tests/test_office_converter.py::test_build_filename_maps` が pass し、新ヘルパ関数が 3 ケースで invariant を満たす
  - _Requirements: 1.2, 1.3, 2.2, 2.3_

## 2. Core — 各モジュールの命名 / lookup ロジック改修 (並列実行可能)

- [x] 2.1 (P) `async_invoker` の JSON persist 命名規約を `{原本ファイル名}.json` に変更
  - `run_async_batch` 関数および `AsyncInvoker.__init__` (または `run_batch` メソッド) に `local_to_original: dict[str, str] | None = None` 引数を追加し、`AsyncInvoker._drain_queue` 内で参照可能にする
  - `_drain_queue` の persist パス組み立てを `output_dir / f"{file_stem}.json"` から `output_dir / f"{output_filename}.json"` に変更。`output_filename = (local_to_original or {}).get(file_path.name, file_path.name)` で解決
  - SageMaker `InferenceId` 用の `_safe_ident` (SHA-1 16 文字) は persist パス計算に **使わない**。ローカル persist には API レイヤでサニタイズ済の filename をそのまま使用する (R1.4 invariant)
  - `test_async_invoker.py` を更新: 既存 `endswith("ok.json")` を `endswith("ok.pdf.json")` に書換、新規ケースとして (a) PDF 入力 → `report.pdf.json`、(b) `local_to_original={"deck.pdf": "deck.pptx"}` 経由 Office → `deck.pptx.json`、(c) 非 ASCII / サニタイズ済 filename (例: `_____.pdf` → `_____.pdf.json`) の 3 ケース、いずれも persist パスに `_safe_ident` 由来の SHA-1 文字列が含まれないことを assert
  - **観察可能な完了**: `pytest lambda/batch-runner/tests/test_async_invoker.py` が全件 pass し、新仕様で persist された JSON ファイルパスが原本ファイル名 + `.json` で終端する
  - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - _Boundary: AsyncInvoker_

- [x] 2.2 (P) `runner.generate_all_visualizations` の二段拡張子 lookup 対応
  - 関数シグネチャに `original_to_local: dict[str, str] | None = None` 引数を追加
  - lookup ロジックを書換: `original_input_name = json_file.name[:-len(".json")]` で `.json` を 1 段だけ剥がし、`local_pdf_basename = (original_to_local or {}).get(original_input_name, original_input_name)` で local PDF basename を解決、`pdf_path = in_path / local_pdf_basename`
  - lookup 失敗時 (`pdf_path.exists() == False`) は既存挙動と同じ silent skip + warning ログを維持。エラーメッセージのみ `"local PDF not found: {local_pdf_basename}"` に更新
  - 可視化 JPEG ファイル名 (`{basename}_{mode}_page_{idx}.jpg`) は既存規約据え置き (R2.4)
  - `test_runner.py` を更新 / 追加: (a) PDF native (`report.pdf.json` + 空 `original_to_local` → `report.pdf` 解決)、(b) Office case (`deck.pptx.json` + `original_to_local={"deck.pptx": "deck.pdf"}` → `deck.pdf` 解決)、(c) lookup miss (該当 PDF 不在 → `errors_per_file` に記録) の 3 ケース
  - **観察可能な完了**: `pytest lambda/batch-runner/tests/test_runner.py` が全件 pass し、両形式の JSON から正しい local PDF が解決される
  - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - _Boundary: runner.generate_all_visualizations_

- [x] 2.3 (P) `BatchFile.resultKey` の OpenAPI description を新フォーマット仕様に更新
  - `lambda/api/schemas.ts` L367-371 の `BatchFile.resultKey` schema description を以下の 4 要素を含む文字列に書換: (1) 値フォーマット `batches/{batchJobId}/output/{原本ファイル名}.json` (`{原本ファイル名}` は `BatchFile.filename` と一致、原本拡張子を含む) と例示 (`report.pdf.json` / `deck.pptx.json` / `report.docx.json` / `report.xlsx.json`)、(2) 旧フォーマット (`{stem}.json`) からの変更点と既存 consumer の basename 抽出処理への影響を含む移行ノート、(3) 属性名 `resultKey` および `.json` 終端は不変 (R4.3)、(4) yomitoku-client が出力する追加フォーマット (`.md` / `.csv` / `.html`) は本 spec の対象外で、命名は yomitoku-client 規約のまま、将来 spec で統一の可能性ありという非対称メモ
  - `example` プロパティを `batches/abc-123/output/document.pdf.json` に更新
  - **観察可能な完了**: `pnpm cdk synth ApiStack` が成功し、生成された OpenAPI ドキュメントの `BatchFile.resultKey.description` に上記 4 要素が含まれる
  - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - _Boundary: lambda/api/schemas.ts BatchFile_

## 3. Integration — `main.py` のオーケストレーション配線

- [x] 3.1 `main.py` でフィルナムマッピングを構築し下流モジュールに pipe through
  - 既存の `pdf_to_original` 構築ロジック (L201-221) を `office_converter.build_filename_maps(convert_result)` の戻り値で置き換え、`local_to_original` および `original_to_local` の 2 変数を取得
  - `apply_process_log(..., converted_filename_map=local_to_original)` の呼び出しは引数名を維持しつつ value を新変数 `local_to_original` を流用 (Bug 001 互換維持)
  - `run_async_batch(...)` 呼び出しに `local_to_original=local_to_original` を追加
  - `generate_all_visualizations(...)` 呼び出しに `original_to_local=original_to_local` を追加
  - ネイティブ PDF のみのバッチでは両 map が空 dict のまま下流に渡され、identity 解決で新仕様 (`{name}.pdf.json`) が PDF にも自動適用されることを保証
  - `test_main.py` の既存ケースを更新: 混在バッチ (PDF + Office + 変換失敗) の E2E で `local_to_original` / `original_to_local` が `run_async_batch` / `generate_all_visualizations` / `apply_process_log` の 3 箇所に正しく届くことを mock assert
  - **観察可能な完了**: `pytest lambda/batch-runner/tests/test_main.py` が全件 pass し、orchestrator 経由で各 sub-module に正しい map が注入される
  - _Depends: 1.1, 2.1, 2.2_
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 2.1, 2.2, 2.3_
  - _Boundary: main.py orchestrator_

## 4. Test Fixture 移行 — 旧フォーマット `{stem}.json` の書換 (並列実行可能)

- [x] 4.1 (P) Python テスト fixture を新仕様 (`{name}.json`) へ移行
  - `lambda/batch-runner/tests/test_async_invoker.py` (L955) / `test_run_async_batch_e2e.py` (L252, L784) / `test_main.py` (L758, L830, L960) / `test_batch_store.py` (L116, L313, L322, L335, L373, L435, L483, L515, L557, L564) の `output_path` / `resultKey` リテラルおよび `f"{stem}.json"` 系構築式を新フォーマット (`{name}.json`、Office は `{name}.pptx.json` 等) に書換
  - 新規テストケース追加: (a) `test_run_async_batch_e2e.py` で混在バッチ (PDF + PPTX + DOCX + XLSX + 変換失敗 PPTX) の resultKey 全件検証、(b) `test_async_invoker.py` で非 ASCII filename ケース (R1.4 ガード)、(c) 既存バッチ fixture を pre-populate しておき、新仕様 deploy 後にその resultKey 値が遡及更新されないことを assert (R5.1, R5.2)
  - 失敗ケース (CONVERSION_FAILED / OCR_FAILED) で resultKey が未設定であることを既存テストで再検証 (R3.1, R3.2)
  - PENDING / PROCESSING 状態の FILE で resultKey が DDB に存在しないことを assert (R3.3)
  - **観察可能な完了**: `pytest lambda/batch-runner/tests/` が全件 pass し、旧フォーマット `{stem}.json` の assert / fixture が完全に新フォーマットに置き換わっている
  - _Depends: 2.1, 2.2, 3.1_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 3.1, 3.2, 3.3, 5.1, 5.2_
  - _Boundary: lambda/batch-runner/tests/_

- [ ] 4.2 (P) TypeScript テスト fixture を新仕様 (`{name}.json`) へ移行
  - `lambda/api/__tests__/lib/batch-presign.test.ts` (L220) / `batch-store.test.ts` (L175, L243) / `routes/batches.test.ts` (L116) の `resultKey` 値リテラル (`output/sample.json` / `output/a.json` 等) を新フォーマット (例: `output/document.pdf.json` / `output/a.pdf.json`) に書換
  - `lambda/api/__tests__/openapi-description.test.ts` に新規アサーション追加: `BatchFile.resultKey.description` が「`{原本ファイル名}.json`」「移行ノート」「追加フォーマット非対称メモ」「`.json` 終端不変」の 4 要素文言を含むことを検証 (R4.1, R4.2, R4.3, R4.4)
  - **観察可能な完了**: `pnpm test` (Vitest) が全件 pass し、OpenAPI description テストが新仕様の 4 要素文言を確認する
  - _Depends: 2.3_
  - _Requirements: 1.5, 4.1, 4.2, 4.3, 4.4_
  - _Boundary: lambda/api/__tests__/_

## 5. Validation — 契約ガードと E2E

- [ ] 5.1 Legacy reference contract guard (移行漏れ検出機構) の実装
  - `scripts/check-legacy-refs.sh` を拡張、または新規 `scripts/check-result-key-format.sh` を作成し、以下の正規表現で旧フォーマット fixture / 構築式の取り残しを検出する: (a) `output_dir\s*/\s*f"\{(?:file_)?stem\}\.json"` (Python `f"{stem}.json"` 系)、(b) `output/[a-zA-Z0-9_-]+\.json["']` (拡張子なし basename + `.json` のリテラル)
  - 除外リスト (false positive 防止): `process_log.jsonl` / `_async/outputs/{uuid}.out` / yomitoku-client 規約 (`{stem}_{ext}.json` の `extra_formats` 出力) / 本 script 自体
  - 違反 1 件以上で `exit 1`、0 件で `exit 0` を返す
  - `pnpm lint` の実行チェーンに統合 (現状 `pnpm lint` は biome + check-legacy-refs を呼ぶため、同所に追加)
  - 契約テストとして `test/check-legacy-refs.test.ts` パターンに準拠する Vitest 単体ケースを追加 (`scripts/check-result-key-format.sh` を runtime 起動して `exit 0` を確認)
  - **観察可能な完了**: 違反コードを意図的に追加して `pnpm lint` を実行すると `exit 1` で失敗し、適切に取り除くと `exit 0` で成功する
  - _Depends: 4.1, 4.2_
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 4.1_
  - _Boundary: scripts/, test/_

- [ ] 5.2 E2E 混在バッチ統合テスト (`test_run_async_batch_e2e.py`) の新仕様再検証
  - 既存の混在バッチ test case (PDF + PPTX + 変換失敗 PPTX) を新仕様で再アサート: `BatchFile.resultKey` が `/{name}.{ext}.json` 終端、可視化 JPEG が `{stem}_{mode}_page_{idx}.jpg` 形式で生成、`CONVERSION_FAILED` / `OCR_FAILED` で resultKey 未設定、PENDING/PROCESSING で resultKey 不在
  - 既存バッチ非影響シナリオ: pre-existing fixture として旧フォーマット `resultKey="batches/old/output/legacy.json"` を持つ FILE 行を DDB に投入 → 新仕様の `apply_process_log` を別バッチで実行 → 旧バッチの resultKey 値が unchanged であることを assert (R5.1, R5.2)
  - In-flight handling シナリオ: 新仕様コードを 1 バッチ走らせた後、別の新規バッチで `{name}.{ext}.json` 形式が一貫して生成されることを assert (R5.3、Fargate task 単位 deploy のセマンティクスを moto + Stubber で再現)
  - **観察可能な完了**: `pytest lambda/batch-runner/tests/test_run_async_batch_e2e.py` が全件 pass し、混在バッチで R1〜R5 の全 ACs が moto + Stubber 経由で観測される
  - _Depends: 3.1, 4.1_
  - _Requirements: 1.1, 1.2, 1.5, 2.1, 2.2, 3.1, 3.2, 3.3, 5.1, 5.2, 5.3_
  - _Boundary: lambda/batch-runner/tests/test_run_async_batch_e2e.py_

## Implementation Notes

- **Task 2.1 boundary blind spot**: Task 2.1 added `local_to_original` to `AsyncInvoker.__init__` (in `async_invoker.py`) but missed the `run_async_batch` wrapper function that lives in `runner.py:39` (NOT in `async_invoker.py`). Discovered during Task 3.1 implementation when `main.py` started passing `local_to_original=...` to `runner.run_async_batch(...)`. Fixed in Task 3.1's commit by extending the boundary to include `runner.py:run_async_batch` signature and AsyncInvoker forward. Future tasks: when a "function in module X" boundary is declared, check both the source module AND any wrapper functions exported from sibling modules.
