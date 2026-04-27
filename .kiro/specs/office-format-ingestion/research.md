# Gap Analysis: office-format-ingestion

## Analysis Summary

- **Current codebase state**: roadmap.md は P1 / P1b / P2 を Direct Implementation 未完として記載しているが、**git main では既に merge 済** (`666572f` / `276cbfe` / `ecaf3e0`)。したがって **Requirement 6 (ephemeralStorage 50 GiB + `MAX_TOTAL_BYTES=10GB`) の実装差分はほぼ無し**、OpenAPI description への Office 形式記述の加筆のみが残る
- **主な gap**: (1) API allowlist / contentType enum 拡張、(2) LibreOffice + CJK フォントを Dockerfile に追加、(3) 新モジュール `office_converter.py` の追加、(4) `main.py` への変換フェーズ挿入、(5) `process_log.jsonl` の `error_category` 追加と関連 TS/Py 連携、(6) `runner.py:171` の PDF ハードコード解消
- **Yomitoku-client / SageMaker Endpoint 側は無変更**で要件を満たせる (R7.2 を容易に充足)
- **Effort: M (3–7 日)、Risk: Medium** — CJK フォント描画 / LibreOffice 並列安全性 / image size 増分が主要リスク、いずれも discovery で緩和策を確認済
- **推奨アプローチ: Option B** (新規 `office_converter.py` モジュール + 既存モジュールの最小拡張)。既存 `lambda/batch-runner/*.py` が「1 関心事 = 1 モジュール」の原則で構成されており、変換は独立した責務

## Requirement-to-Asset Map

| 要件 | 関連既存資産 | gap 分類 | 備考 |
|---|---|---|---|
| **R1.1 Office 拡張子の受理** | `lambda/api/schemas.ts:49` `ALLOWED_EXTENSIONS = [".pdf"]` + `:72` `allowedExtensionRegex` | **Missing** | `[".pdf", ".pptx", ".docx", ".xlsx"]` への拡張 |
| **R1.2 contentType 既定値の導出** | `lambda/api/lib/batch-presign.ts:60` `contentType ?? "application/pdf"` | **Missing** | 拡張子ごとの MIME デフォルトマッピングが必要 |
| **R1.3 不正拡張子で 400** | `schemas.ts:94` `.refine()` | Constraint | allowlist に追加するだけで自動 |
| **R1.4 contentType enum** | `schemas.ts:102` `z.enum(["application/pdf", "application/octet-stream"])` | **Missing** | 3 種の OOXML MIME を enum に追加 |
| **R1.5 OpenAPI スキーマ更新** | `schemas.ts:98`, `:116`, `:149-157` (description) | **Missing** | 一連の description に pptx/docx/xlsx を反映 |
| **R2.1 Office → PDF 変換** | (該当なし) | **Missing** | `office_converter.py` を新規追加 |
| **R2.2 PDF のスキップ** | 既存 `main.py` の直列 pipeline | Constraint | 拡張子判定は `office_converter.is_office_format()` で局所化 |
| **R2.3 Async Endpoint への全ファイル PDF 送信** | `async_invoker.py:45-52` `_CONTENT_TYPE_OVERRIDES` | **Missing** | 変換後は PDF のみを AsyncInvoker に渡す構造なら override 追加は任意 (Office 形式は staging 前に PDF に変換済のため) |
| **R2.4 並列変換** | `settings.BatchRunnerSettings` env: `ASYNC_MAX_CONCURRENT` など | **Missing / Research** | 新規 env `OFFICE_CONVERT_MAX_CONCURRENT` の導入か、既存値の再利用かを design で決定 |
| **R2.5 CJK レンダリング** | Dockerfile: CJK フォント無し | **Missing** | `fonts-noto-cjk` + `fonts-ipaexfont` を APT で追加 |
| **R3.1-3 混在バッチ処理** | `main.py` 全体 / `batch_store.finalize_batch_status` | Constraint | ファイル形式に依存しないロジックを維持 |
| **R4.1 per-file FAILED 分離** | `batch_store.apply_process_log` + `update_file_result` | Constraint | 既存の per-file 更新で対応可。変換失敗を `ProcessLogEntry.success=False` として合流させる |
| **R4.2 `CONVERSION_FAILED` 記録** | `process_log_reader.ProcessLogEntry` + `batch_store` | **Missing** | `error_category` フィールドを追加 (Py dataclass + TS `FileItem`) |
| **R4.3 `OCR_FAILED` 区別** | `process_log_reader.py:60-82` (読み出し) + yomitoku-client 側の既存出力 | **Research / Missing** | yomitoku-client が `error_category` を吐くか要確認。吐かない場合は Python 側で `success=False && error_category==null → OCR_FAILED` に落とす変換ルールが必要 |
| **R4.4 後方互換** | `process_log_reader.py:71-81` | Constraint | `data.get("error_category")` で欠落時 None のまま読める |
| **R4.5 暗号化検知** | (該当なし) | **Missing / Research** | `msoffcrypto-tool` のような事前 detect library が最有力。design で採否確定 |
| **R4.6 変換 timeout** | subprocess timeout 仕様 | **Missing** | `office_converter.convert_office_to_pdf(timeout_sec=N)` 実装時に保証 |
| **R4.7 silent fail (成功 exit + 出力無し)** | discovery で確認済 (LibreOffice の既知挙動) | **Missing** | 出力ファイル存在チェックを `office_converter` 内で必須化 |
| **R4.8 PARTIAL 判定** | `batch_store.finalize_batch_status` | Constraint | 既存ロジックでカバー |
| **R5 変換後サイズ再検証** | (該当なし) | **Missing** | `office_converter` 返却後に size 計測、上限 1 GB を定数化 |
| **R6.1-3 MAX_TOTAL_BYTES=10GB** | `schemas.ts:42` (**既に 10 GB**) | **Done (既存)** | description の Office 文言追記のみ |
| **R6.4 ephemeral 要件** | `lib/batch-execution-stack.ts:174` `ephemeralStorageGiB: 50` (**既に 50**) | **Done (既存)** | 非退行テストのみ |
| **R6.5 50 GiB 割当て** | 同上 | **Done (既存)** | — |
| **R7.1 PDF only バッチで変換層不起動** | `main.py` の新変換フェーズ | Constraint | `if is_office_format(...)` で分岐 |
| **R7.2 SageMaker 入力契約維持** | `async_invoker.py` | Constraint | 変換後 PDF を staging するため契約は維持される |
| **R7.3 API 後方互換** | `schemas.ts` の enum / schema 拡張 (追加のみ、削除なし) | Constraint | 既存クライアントは影響なし |
| **R8.1-3 可視化互換** | `runner.py:171` `pdf_path = in_path / f"{basename}.pdf"` ハードコード | **Missing** | 変換後 PDF の探索パス変更。`input-converted/` 配下 or `input/` に直接上書きのどちらか design で確定 |
| **R9.1-3 監査用原本保持** | `s3_sync.download_inputs` + S3 lifecycle (`ProcessingStack`) | Constraint | 既存の input prefix を変更しなければ維持される |

## Impacted Files (Concrete)

### API (TypeScript)
- `lambda/api/schemas.ts` — `ALLOWED_EXTENSIONS` / `contentType` enum / description 文言、(任意) `ErrorCategory` enum 追加
- `lambda/api/lib/batch-presign.ts` — `contentType ?? "application/pdf"` の拡張子別マッピング化
- `lambda/api/lib/batch-store.ts` — `FileItem.errorCategory?: "CONVERSION_FAILED" | "OCR_FAILED"` 追加
- `lambda/api/__tests__/schemas.test.ts` / `lib/batch-presign.test.ts` / etc. — テスト拡充

### Batch Runner (Python)
- **新規**: `lambda/batch-runner/office_converter.py` — `convert_office_to_pdf()` / `is_office_format()` / `is_password_protected()` / サイズ検証
- `lambda/batch-runner/main.py` — `download_inputs` と `run_async_batch` の間に変換フェーズ挿入
- `lambda/batch-runner/runner.py:171` — 可視化の PDF 探索をハードコード PDF から「変換後 PDF パス」に変更
- `lambda/batch-runner/async_invoker.py:45-52` — `_CONTENT_TYPE_OVERRIDES` に Office 系 MIME を(設計次第で)追加
- `lambda/batch-runner/process_log_reader.py` — `ProcessLogEntry` に `error_category: str | None` 追加
- `lambda/batch-runner/batch_store.py:update_file_result` / `apply_process_log` — `error_category` を DDB FILE に書き込み
- `lambda/batch-runner/settings.py::BatchRunnerSettings.from_env` — 新 env (`OFFICE_CONVERT_MAX_CONCURRENT` / `OFFICE_CONVERT_TIMEOUT_SEC` / `MAX_CONVERTED_FILE_BYTES`) を追加
- **新規**: `lambda/batch-runner/tests/test_office_converter.py` + 既存 `test_main.py` / `test_runner.py` / `test_run_async_batch_e2e.py` への混在ケース追加

### Infrastructure (CDK)
- `lambda/batch-runner/Dockerfile` — APT で LibreOffice + CJK フォント (`fonts-noto-cjk` / `fonts-ipaexfont`) を追加、USER 変更前に `msoffcrypto-tool` 等を pip install
- `lambda/batch-runner/requirements.txt` — 暗号化検知ライブラリ追加
- `lib/batch-execution-stack.ts` — `OFFICE_CONVERT_*` を TaskDef environment に配線 (CDK prop 追加で十分)
- `test/batch-execution-stack.test.ts` — 新規 env 変数の assert
- `test/app-synth.test.ts` — 影響なし想定 (最終確認)

## Implementation Approach Options

### Option A: 既存コンポーネントのみ拡張
- `main.py` の pipeline に `download_inputs` 直後の inline conversion ループを埋め込む
- 変換ロジックを `main.py` に閉じる
- **Trade-offs**:
  - ✅ 新規ファイルを作らない / PR が小さく見える
  - ❌ `main.py` は既に 8 ステップ orchestration (heartbeat / DL / OCR / 可視化 / upload / process_log / finalize / heartbeat 削除) を担っており、単一責務を既に限界近くで保っている
  - ❌ LibreOffice 呼び出し + サブプロセス管理 + プロファイル分離 + タイムアウト + silent fail 検知 + サイズ検証を `main.py` に同居させると 500+ 行級に膨張
  - ❌ `structure.md` の「main.py 以外は副作用を持たない純粋関数か `boto3` client を引数で注入するクラスで構成する」ルールと整合しない (変換の副作用を main にさらに積む)
- **採用判断**: 非推奨

### Option B: 新規モジュール `office_converter.py` + 既存の最小拡張 (Recommended)
- 新規: `lambda/batch-runner/office_converter.py` (pure function + boto3 非依存のローカルユーティリティ)
  - `is_office_format(filename: str) -> bool`
  - `is_password_protected(path: Path) -> bool`
  - `convert_office_to_pdf(input_path: Path, work_dir: Path, timeout_sec: int) -> Path` (UserInstallation per-invocation、subprocess timeout、出力存在チェック)
  - `validate_converted_size(pdf_path: Path, max_bytes: int) -> None`
- `main.py` に 10–20 行の変換フェーズを挿入、失敗エントリを `process_log.jsonl` に追記するか、Python 側で `ProcessLogEntry` を直接生成して `apply_process_log` に合流させる
- 既存 `runner.py:171` は変換後 PDF の探索パスを汎用化 (basename lookup のみ、拡張子は固定)
- **Trade-offs**:
  - ✅ 「1 関心事 = 1 モジュール」 (structure.md) を踏襲
  - ✅ pytest で `office_converter` 単体テストが容易 (subprocess を `unittest.mock.patch` で差し替え可能)
  - ✅ 既存 `async_invoker.py` / `runner.py` / `batch_store.py` の改変は最小
  - ❌ 新規ファイル + 新規 env 変数 + 新規 pip 依存が発生 (レビュー対象点が増える)
- **採用判断**: 推奨

### Option C: 変換専用サイドカーコンテナ
- ECS TaskDefinition に 2 コンテナ (batch-runner + libreoffice-converter sidecar)、IPC は HTTP / Unix socket
- **Trade-offs**:
  - ✅ LibreOffice バージョン管理と Python runtime を独立できる
  - ✅ OCI image を小さく分けられる
  - ❌ `lib/batch-execution-stack.ts` の CDK 構造が複雑化 (現状 1 コンテナ想定のタスク)
  - ❌ IPC レイヤ実装 / ヘルスチェック / リトライ / ログ分離など付帯作業が大きい
  - ❌ 1 バッチ使い捨てモデル (task = 1 バッチ) でコールドスタート 2 倍
- **採用判断**: 現フェーズでは Over-engineering。`batch-scale-out` フェーズや本番運用で LibreOffice の限界が露呈してからの再設計候補

### Option D: 専用 Lambda + EventBridge S3 Object Created トリガで非同期変換 (検討済 · 不採用)
- 過去の社内実装 (`pptx_to_pdf_sample.py`) と同形態。S3 `input/` への PUT を EventBridge 経由で受け、別 Lambda コンテナ (LibreOffice 入り) が PDF を `output/` に書き出す
- **Trade-offs**:
  - ✅ Fargate batch-runner image を肥大化させない (LibreOffice は別アーティファクト)
  - ✅ 既に同型の実運用コードが存在し、レイヤ構成 (`shelf base`) や silent fail 検知ロジックがそのまま参考にできる
  - ❌ **バッチ単位の同期完了管理が壊れる**: Step Functions → Fargate task の中で「全 Office 変換完了」を待つ追加の polling / SQS join が必要
  - ❌ **ジョブステータス遷移が複雑化**: `PROCESSING` 中の sub-state (変換中 / 変換完了 / OCR 中) を表現する必要が出てくる。現行 `META.status` の楽観ロック設計と整合しない
  - ❌ **コールドスタート増**: Lambda コンテナの cold start が per-file で発生 (CJK フォント込み image は 1–3 秒)
  - ❌ **可視化フェーズが S3 から PDF を再 DL する必要**: 現在は Fargate 内ローカル `input/` 配下の PDF を `runner.py:171` がそのまま参照。Lambda 経路だと S3 経由で再取得する設計変更が必要
- **採用判断**: 同期完了管理 / ステータスモデルへの侵襲が大きく、単に「Office 受理」のために spec を逸脱した影響範囲を生む。**過去実装は使い回しレベルでの参考に留め、Option B 内で同等の意図を満たす**

## Effort & Risk

- **Effort: M (3–7 日)**
  - API schema 拡張: 0.5 日
  - `office_converter.py` 実装 + 単体テスト: 2 日
  - `main.py` 変換フェーズ統合 + E2E テスト: 1 日
  - Dockerfile 改修 + CJK 動作確認: 1 日
  - `error_category` TS/Py 両対応 + DDB 書き込み: 0.5 日
  - 可視化パス汎化 + テスト: 0.5 日
  - 回帰テスト + CI / cdk-nag: 0.5 日
- **Risk: Medium**
  - **Medium**: CJK フォント描画の silent defect (豆腐化したまま OCR が走ると結果精度が著しく劣化。fixture での目視 / 差分検証が必要)
  - **Medium**: LibreOffice 並列実行の profile lock / zombie 累積 (per-invocation `UserInstallation` で緩和、CI で並列負荷テストを入れる)
  - **Medium**: Docker image サイズ 900 MB 近辺での ECR push 時間増 (CI 時間 / Fargate 起動時間への影響を monitoring)
  - **Low**: `msoffcrypto-tool` の依存追加 (well-maintained、必要最小限の使い方に絞る)
  - **Low**: yomitoku-client 側の暗黙的 PDF 検査 (既に PDF 契約なので原則影響なし)

## Research Needed (for design phase)

1. **変換プロセス管理の具体形**: 生 `subprocess.run` で十分か、将来的に `unoserver` daemon モデルに切り替える場合の境界を design の Boundary Commitments に書き込むか
2. **暗号化検知ライブラリの採否**: `msoffcrypto-tool` を必須依存にする or サイズ / 簡易マジックバイト検査で代替
3. **`error_category` の yomitoku-client 側の吐き方**: 現状 `process_log.jsonl` に `error_category` フィールドが無ければ、Python 側での分類ルール ("変換失敗は Python 変換層で書く、それ以外の `success=False` は `OCR_FAILED` と解釈") を design で確定する
4. **変換成果物の S3 配置**: `batches/{id}/input-converted/` 新プレフィックスを切るか、ローカル temp のみで S3 には書かないか。R9 の原本保持と合わせて判断 (brief の Approach は「別プレフィックス」方向)
5. **`ASYNC_MAX_CONCURRENT` と `OFFICE_CONVERT_MAX_CONCURRENT` の関係**: CPU bound と I/O bound が混在するため、既存値を再利用する案と独立制御する案で design 決定
6. **Dockerfile ベースイメージ戦略 (二択)**:
   - **(a) `python:3.12-slim` + 自前 APT** で `libreoffice-core` / `libreoffice-impress` / `libreoffice-writer` / `libreoffice-calc` + `fonts-noto-cjk` + `fonts-ipaexfont` を入れる (discovery で確認済、image 700–900 MB 増)
   - **(b) `public.ecr.aws/shelf/lambda-libreoffice-base:25.8-python3.14-x86_64` を base に切り替え** (過去 Lambda 実装 `pptx_to_pdf_sample.py` で実績あり)。利点: LibreOffice 25.8 がプリバンドル、shelfio は Lambda コミュニティで実運用された image ⇒ 並列 / フォントの落とし穴を踏み越えている可能性。注意点: ① Python が 3.14 になり既存 `python:3.12-slim` 前提の yomitoku-client / opencv-python-headless 互換性を再検証必須、② バイナリ名が `libreoffice25.8` 固定で素の `soffice` ではないため call 側の抽象化が必要、③ CJK フォントが含まれるかは未確認 (含まれなければ `fonts-noto-cjk` 追加レイヤを継ぎ足す)、④ Lambda 用 base を Fargate で使う動作確認が必要 (image 自体は素の x86_64 Linux なので原則動くが、エントリポイント / レイヤ構造の差を確認)
   - design 時に (a)/(b) の image size / cold start / 互換性検証コストを測定して決定
7. **cdk-nag 影響**: ephemeralStorage 増量 (既に 50 GiB 済) / `FargateTaskDefinition` の新 env 追加で AwsSolutionsChecks に引っかかる項目は design 時点で確認
8. **roadmap.md の更新**: P1/P1b/P2 は完了済、office-format-ingestion から P2 責務記載を外して現実と整合させる (requirements.md の Boundary Context は Discovery 時の情報で書かれているため、design 時に brief / requirements の P2 言及を「事前に完了済 · 非退行で確認」の位置付けに調整)
9. **subprocess timeout 既定値**: 過去 Lambda 実装 (`pptx_to_pdf_sample.py`) は **240 秒** で運用実績あり (Lambda 15 分上限の中で安全マージン)。Fargate では task 全体タイムアウトが大きい (`batch_max_duration_sec`) ため余裕を持たせて 300 秒据え置きが第一候補。design でファイルサイズ別の挙動 (大型 PPTX で 240 秒超過の有無) を測定して最終決定
10. **silent fail 検知ロジックの実装雛形 (R4.7)**: `pptx_to_pdf_sample.py` から流用候補:
    ```python
    pdf = Path(pdf_path)
    if not pdf.exists() or pdf.stat().st_size == 0:
        raise RuntimeError(
            f"LibreOffice exited successfully but PDF was not generated: {pdf_path}"
        )
    ```
    - **ファイル存在チェック + サイズ 0 チェックを両方実施** (research 当初は存在チェックのみ言及、サイズ 0 を検知する一段細かい防御を追加採用するか design で確定)
11. **LibreOffice 起動フラグ**: 過去 Lambda 実装は `--headless --invisible --nodefault --nofirststartwizard --norestore` の 5 フラグ。**Fargate 並列実行ではこれに加えて `--nolockcheck` と per-invocation `-env:UserInstallation=file:///tmp/lo_profile_$UUID` が必須** (Lambda は単一 invocation のためサンプルでは不要だった)。design で最終フラグセットを確定し `office_converter._build_command()` 等のヘルパに集約

## Past Implementation Reference

過去に PPTX → PDF を **Lambda コンテナ** で実装したサンプルが `.kiro/specs/office-format-ingestion/pptx_to_pdf_sample.py` に保存されている。本 spec の Option B 実装で再利用可能な要素:

- **Base image 候補**: `public.ecr.aws/shelf/lambda-libreoffice-base:25.8-python3.14-x86_64` (Research Item #6 の (b))
- **silent fail 検知**: `pdf.exists() and pdf.stat().st_size > 0` の二段チェック (Research Item #10)
- **subprocess timeout 実績値**: 240 秒 (Research Item #9)
- **LibreOffice CLI 基本フラグ**: `--headless --invisible --nodefault --nofirststartwizard --norestore` (Research Item #11、Fargate 並列対応で `--nolockcheck` + `-env:UserInstallation` を追加)
- **パストラバーサル対策**: 既存 `lambda/api/lib/sanitize.ts` + `lambda/batch-runner/s3_sync.py` のガードと重複するため、`office_converter.py` には **不要** (二重ガードを避ける)
- **アーキテクチャ**: 同サンプルの「EventBridge → 専用 Lambda」設計は Option D に該当し、本 spec では同期完了管理 / ステータス整合性の観点で**不採用** (Option D 節参照)

## Recommendations for Design Phase

- **Preferred approach**: Option B (Option D は過去実装あれど不採用、根拠は Options 節)
- **Key design decisions to lock**:
  - `office_converter.py` の public API (`convert_office_to_pdf`, `is_office_format`, `is_password_protected`, `validate_converted_size`) の正確なシグネチャ
  - 変換失敗時の `ProcessLogEntry` 生成責務 (Python 変換層が直接書くか、yomitoku-client が吐くログに合流するか)
  - 変換後 PDF の保存場所 (S3 `input-converted/` vs ローカルのみ) と原本保持方針
  - Docker base image: 自前 APT (`python:3.12-slim`) vs `shelf/lambda-libreoffice-base` (Research Item #6 で測定後決定)
  - CJK フォントの選定 (`fonts-noto-cjk` 推奨 / IPA は代替、shelf base 採用時は同梱の有無を確認)
  - `ASYNC_MAX_CONCURRENT` との関係
  - LibreOffice CLI フラグセット (Research Item #11) と subprocess timeout 既定値 (Research Item #9)
  - silent fail 検知の粒度 (存在チェックのみ vs 存在 + サイズ 0、Research Item #10)
- **Past implementation reuse**: `pptx_to_pdf_sample.py` から base image 候補 / silent fail パターン / LibreOffice フラグの一部を流用
- **Research items** (上記一覧)
- **roadmap.md 同期**: spec 実装開始前に roadmap を最新状態に更新 (P1/P1b/P2 完了済を反映)
