# Brief: office-format-ingestion

## Problem

現状 API は `.pdf` のみ受理し (`lambda/api/schemas.ts:49` の `ALLOWED_EXTENSIONS = [".pdf"]`)、Office 系ドキュメント (PowerPoint / Word / Excel) を OCR に流したい利用者は外部で PDF 化してから再アップロードする運用を強いられている。定期デジタル化や監査対応 (product.md の target use case 1–2) では PPTX / DOCX / XLSX のまま取り込みたい要求が強く、事前変換の属人化はトレーサビリティも損なう。

## Current State

- API: `ALLOWED_EXTENSIONS=[".pdf"]` / `contentType in {"application/pdf","application/octet-stream"}` で PDF 以外は 400 で弾かれる
- Fargate batch-runner: `s3_sync.download_inputs` は拡張子非依存で DL するが、後段が PDF 前提
  - `runner.py:171` は `in_path / f"{basename}.pdf"` をハードコード
  - `async_invoker._CONTENT_TYPE_OVERRIDES` に PDF/画像しかない
  - Dockerfile は `python:3.12-slim` + opencv-python-headless のみで Office を扱う術がない
- roadmap の Direct Implementation 候補に P2 (`ephemeralStorageGiB=50` + `MAX_TOTAL_BYTES=10GB`) が残っており、本スペックが LibreOffice 変換で追加ディスク I/O を発生させるため P2 を内包して扱う必要がある (Q5:c)
- Yomitoku-client (SageMaker エンドポイント) 側は **変更不要**。常に PDF を受ける契約を維持する

## Desired Outcome

- ユーザが `.pdf` に加え `.pptx` / `.docx` / `.xlsx` を直接アップロードでき、Fargate 側で PDF 変換 (LibreOffice headless) を経て既存の Async Inference パイプラインに流れる
- 1 バッチ内に PDF と Office 混在が可能
- 変換失敗 (破損 / パスワード保護 / タイムアウト / 変換後サイズ超過) は当該ファイルのみ `FAILED` にし、`process_log.jsonl` に **新しい error category (`CONVERSION_FAILED`)** で記録される。バッチ全体は継続
- 既存 PDF フローのレイテンシ / 成功率を悪化させない (変換は PDF ファイルをスキップ)
- P2 (ephemeralStorage 50 GB / MAX_TOTAL_BYTES 10 GB) も本スペックで完了する

## Approach

**Approach 1: 生 `soffice --headless` subprocess + per-invocation profile**

- Fargate Docker image に LibreOffice 最小構成 (`libreoffice-core` + `libreoffice-impress` + `libreoffice-writer` + `libreoffice-calc` / `--no-install-recommends`) + CJK フォント (`fonts-noto-cjk` + `fonts-ipaexfont`) を追加
- 新モジュール `lambda/batch-runner/office_converter.py` を作成
  - 入口: `convert_office_to_pdf(input_path: Path, work_dir: Path, timeout_sec: int) -> Path`
  - コマンド: `soffice --headless --nolockcheck --norestore --nofirststartwizard -env:UserInstallation=file:///tmp/lo_profile_{uuid} --convert-to pdf --outdir <dir> <input>`
  - 事前チェック: `msoffcrypto-tool` 等で暗号化判定 (検出したら `CONVERSION_FAILED` で早期 fail)
  - subprocess.run で timeout、出力ファイル存在チェック、プロファイル dir の cleanup
  - 並列度は semaphore (CPU 数上限、`OFFICE_CONVERT_MAX_CONCURRENT` env var で調整)
- `main.py` の pipeline に `download → convert_office_files → run_async_batch` を挿入
  - Q2:c に従い、元ファイルは `input/` 維持、変換済 PDF は `batches/{id}/input-converted/{stem}.pdf` に別プレフィックスで置く (S3 upload は別途検討、ローカル変換のみでも可)
  - yomitoku に渡すのは常に変換後 PDF (または元 PDF)、ファイル stem を保持
- `runner.generate_all_visualizations` は変換後 PDF (`input-converted/` or local) を探すよう一般化 (Q6:a に従い PDF ページ番号のまま、追加メタデータなし)
- API 側 (`schemas.ts`) の allowlist と contentType enum を拡張:
  - `.pdf`, `.pptx`, `.docx`, `.xlsx` (Q1:b)
  - MIME: `application/pdf`, `application/vnd.openxmlformats-officedocument.presentationml.presentation`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/octet-stream`
- **変換後 PDF サイズの再チェック** (Q4:b) を conversion 直後に実行、`MAX_CONVERTED_FILE_BYTES` (SageMaker Async payload 1 GB に合わせる) 超過なら `CONVERSION_FAILED`
- **P2 統合** (Q5:c): `lib/batch-execution-stack.ts` の `FargateTaskDefinition` に `ephemeralStorageGiB: 50`、`schemas.ts` の `MAX_TOTAL_BYTES` を 10 GB に引き上げ、OpenAPI description も更新
- `process_log.jsonl` スキーマに `error_category: "CONVERSION_FAILED" | "OCR_FAILED" | null` を追加し、`ProcessLogEntry` / `batch_store.apply_process_log` / `FileItem` を連動

## Scope

- **In**:
  - `.pptx` / `.docx` / `.xlsx` の API allowlist + contentType 拡張
  - Fargate Dockerfile への LibreOffice + CJK フォント追加 (image size 予算 700–900 MB 増を許容)
  - `office_converter.py` 新規モジュール (soffice 呼び出し / 暗号化検知 / timeout / プロファイル分離 / cleanup)
  - `main.py` への変換フェーズ挿入 (PDF はスキップ、Office のみ変換)
  - 変換後 PDF サイズの上限 (`MAX_CONVERTED_FILE_BYTES`) チェック
  - `process_log.jsonl` の `error_category` 追加と DDB FILE 連携
  - 可視化の汎化 (`runner.py:171` のハードコード除去、変換後 PDF を参照)
  - `async_invoker._CONTENT_TYPE_OVERRIDES` の content-type マッピング整備
  - **P2 統合**: `FargateTaskDefinition.ephemeralStorageGiB=50` + `MAX_TOTAL_BYTES=10 GB` 引き上げ + OpenAPI description 更新
  - 単体テスト (`test_office_converter.py`) + E2E (`test_run_async_batch_e2e.py` に pptx 混在ケース追加) — soffice の stub / 出力 PDF の fixture 戦略

- **Out**:
  - PPTX スライド番号を可視化ファイル名に反映する等の UI 改善 (Q6:a: PDF ページ番号のまま)
  - `.odp` / `.ods` / `.odt` 等 LibreOffice 独自形式 (需要が出たら将来拡張)
  - 画像フォーマット (`.png` / `.jpg`) を直接 OCR 入力にする対応 (これは yomitoku-client 側の別議論)
  - パスワード保護ファイルの自動解除 (検知して FAILED にするのみ)
  - LibreOffice バージョン自動更新 / セキュリティパッチの自動運用 (Dependabot スコープ外)
  - SageMaker 推論側の変更 (yomitoku-client は PDF 契約維持)

## Boundary Candidates

- **API 層の入力契約拡張**: `lambda/api/schemas.ts` (allowlist, contentType, size limit) + OpenAPI description
- **コンテナ環境**: `lambda/batch-runner/Dockerfile` (LibreOffice + CJK フォント追加)
- **変換エンジン**: `lambda/batch-runner/office_converter.py` (新規、soffice 呼び出し層)
- **オーケストレーション**: `lambda/batch-runner/main.py` への変換フェーズ挿入
- **エラーモデル**: `process_log.jsonl` スキーマ + `ProcessLogEntry` + `FileItem.errorCategory`
- **可視化の汎化**: `runner.py::generate_all_visualizations` の PDF path 生成
- **CDK 側キャパ**: `lib/batch-execution-stack.ts` (ephemeralStorage) + `lambda/api/schemas.ts` (`MAX_TOTAL_BYTES`)

## Out of Boundary

- Yomitoku-client / SageMaker エンドポイント側のコード変更 (PDF 入力契約を維持)
- 既存 Realtime Endpoint 関連の互換レイヤ (撤去済なので触らない)
- 1 バッチ 1000 ファイル対応 (`batch-scale-out` spec の P3 責務)
- Windows/Mac ネイティブ API (Word/PowerPoint COM 等) を使う変換経路

## Upstream / Downstream

- **Upstream**:
  - **Direct Implementation P1** (`MAX_FILES_PER_BATCH=99` 修正): 本スペックより先に入る前提 (数行のバグ修正)
  - `yomitoku-client-batch-migration` spec: PDF 入力契約の前提として完了している必要あり
  - `sagemaker-async-inference-migration` spec: Async Inference の I/O 契約が固まっていること
- **Downstream**:
  - `batch-scale-out` spec (1000 ファイル対応): 本スペック完了後に依存なく進められる (本スペックが ephemeralStorage 50 GB を先に入れるため、1000 ファイル対応の前提条件を満たす副次効果)
  - 将来的な `.odp` / `.ods` 等 LibreOffice 独自形式の追加 (新規 brief)

## Existing Spec Touchpoints

- **Extends**: なし (既存 3 spec のいずれの境界にも属さない新規ドメイン)
- **Adjacent / Avoid Overlap**:
  - `batch-scale-out`: 両者が `lambda/api/schemas.ts` の constants (`MAX_TOTAL_BYTES`) と `lib/batch-execution-stack.ts::FargateTaskDefinition` (ephemeralStorage) に触る → **本スペックが P2 を取り込むことで衝突を回避** (roadmap.md で責務移管)
  - `yomitoku-client-batch-migration`: yomitoku invoke の content-type override マップを共有。`_CONTENT_TYPE_OVERRIDES` の拡張は本スペックで行い、Office 形式の staging 名を PDF 拡張子に揃える (staging 済ファイルは PDF のみ) ことで契約を保つ

## Constraints

- **LibreOffice 並列実行**: shared user profile でデッドロック → **呼び出しごとに `-env:UserInstallation` で独立プロファイル必須**。並列度は vCPU 数上限 (`OFFICE_CONVERT_MAX_CONCURRENT` env、default=vCPU count)
- **CJK フォント**: `fonts-noto-cjk` + `fonts-ipaexfont` を Docker image に明示追加 (欠落するとフォント代替で日本語文字化けの可能性)
- **イメージサイズ**: base 追加で 700–900 MB 増 → ECR push / pull 時間と Fargate タスク起動時間が延びる (許容可能 SLO: 起動 30 秒→60 秒程度)
- **ハング対策**: 破損ファイルで 100% CPU ハング既知 → subprocess timeout 必須 (`OFFICE_CONVERT_TIMEOUT_SEC`, default=300)
- **暗号化ファイル**: soffice は silent fail (exit 0 + 出力なし) → 事前 detection (`msoffcrypto-tool`) + 出力ファイル存在チェック二段階
- **メモリ**: 500 MB PPTX で ~4–6 GB RAM 消費 → Fargate task memory を確認 / 必要なら引き上げ
- **LibreOffice ライセンス**: MPL 2.0、subprocess 呼び出しは aggregation で商用利用 OK、ただし Docker image 内の `LICENSE` 同梱必須
- **`unoconv` は 2025-03 archived** → 採用禁止。`soffice` direct subprocess を使用
- **SageMaker payload 上限 1 GB**: 変換後 PDF がこれを超えたら `CONVERSION_FAILED` (Q4:b の再チェックで保証)
- **DynamoDB `TransactWriteItems` 100 items**: P1 で 99 に修正済前提
- **一時ディレクトリ**: soffice profile + 変換中間ファイル + 元ファイルで ephemeral 消費 → P2 で 50 GB に拡張 (本スペック内で実施)
