# Gap Analysis: result-filename-extension-preservation

## 1. Current State Investigation

### 主要モジュールと現状の挙動

| モジュール | 該当箇所 | 現状の挙動 |
|---|---|---|
| `lambda/batch-runner/async_invoker.py` | L362, L492 | `file_stem = file_path.stem` → 永続化先 `output_dir / f"{file_stem}.json"` |
| `lambda/batch-runner/runner.py` | L170-171 | 可視化 lookup: `basename = json_file.stem` → `pdf_path = in_path / f"{basename}.pdf"` (`.json` を 1 段だけ剥がす前提) |
| `lambda/batch-runner/office_converter.py` | L268-394 | `convert_office_files()` → `ConvertResult(succeeded=[ConvertedFile(original_path, pdf_path)], failed=[...])` を返す。原本→変換後の対応情報は既に保持 |
| `lambda/batch-runner/main.py` | L201-221 | `pdf_to_original: dict[str, str] = {converted_pdf.name: original_office.name}` を組み立てて `apply_process_log(..., converted_filename_map=pdf_to_original)` に渡している |
| `lambda/batch-runner/main.py` | L230-254 | `run_async_batch(input_dir, output_dir, log_path, ...)` および `generate_all_visualizations(input_dir, output_dir)` には `pdf_to_original` を渡していない (現在は basename = local file 名前提) |
| `lambda/batch-runner/batch_store.py` | L297-299 | `result_key = f"batches/{batch_job_id}/output/{Path(entry.output_path).name}"` — `entry.output_path.name` から自動追従 |
| `lambda/batch-runner/batch_store.py` | L236, L255-285 | `apply_process_log(..., converted_filename_map: dict[str, str] | None = None)` — Bug 001 修正で導入済 (key=converted PDF basename, value=original filename) |
| `lambda/api/schemas.ts` | L367-371 | `resultKey: z.string().optional()` — OpenAPI description は generic、format invariant 未明示 |
| `lambda/api/lib/batch-query.ts` | L81 | DDB から `i.resultKey as string | undefined` を read のみ。値変換なし |
| `lambda/batch-runner/s3_sync.py` | L37-49 | `_EXT_TO_CATEGORY`: `.json → ("output", None)` / `.md, .csv, .html, .pdf → ("results", "result")` / `.jpg, .jpeg, .png → ("visualizations", "visualization")`。拡張子末尾で分類するため二段拡張子 (`.pdf.json`) でも `.json → output` に正しく振り分けられる |

### Convention / Pattern の制約

- **DynamoDB 双方契約**: `lambda/api/lib/batch-store.ts` と `lambda/batch-runner/batch_store.py` は同じキー/属性を読み書きする (steering の構造規約)。`resultKey` 属性名は不変。値フォーマットの変更のみ。
- **EARS 規約 + 現行命名**: 可視化 JPEG (`{basename}_{mode}_page_{idx}.jpg`) の `{basename}` は **stem** ベース。本 spec では JSON 命名のみ変更し、JPEG 命名は据え置く (R2.4)。
- **Async InferenceId と JSON 命名は別系統**: `_safe_ident` (SHA-1 16 文字) は SageMaker InferenceId / S3 input key 用で、ローカル JSON 保存名には適用されない (現状 `file_stem` をそのまま使用)。
- **テスト pattern**: `lambda/batch-runner/tests/` は moto + Stubber で完結。`lambda/batch-runner/.venv` 内の `yomitoku-client` は SageMaker コンテナ側で `{stem}_{ext}.json` と命名 (追加フォーマット用) — batch-runner からは制御不可 (Out of scope)。

## 2. Requirements Feasibility Analysis

### Requirement → Asset Map (Gap タグ付き)

| Req | 必要な変更 | 既存資産 | Gap |
|---|---|---|---|
| **R1.1** PDF `report.pdf` → `report.pdf.json` | `async_invoker.py:492` の命名を `f"{file_path.name}.json"` に変更 | `async_invoker.py` 内の `file_path` (`Path` オブジェクト) | **Missing** (命名規約の単純置換、追加データ不要) |
| **R1.2** PPTX `deck.pptx` → `deck.pptx.json` | `async_invoker.py` が「ローカル PDF basename → 原本 Office basename」を解決できるように `main.py` から逆引き map を渡す | `main.py:201-221` の `pdf_to_original` (既存) | **Missing** (引数追加と pipe through。データソースは既存) |
| **R1.3** DOCX/XLSX 同様 | R1.2 と同じ機構で対応 | 同上 | R1.2 と同時解決 |
| **R1.4** 非 ASCII / サニタイズ | API レイヤでサニタイズ済の filename をそのまま JSON 命名に使用 | `s3_sync.py` で `download` した local file 名 = サニタイズ済 DDB filename | **Constraint** (現状の sanitize → S3 → download チェーンに依存。サニタイズ規則自体は本 spec で変更しない) |
| **R1.5** API 経由 `resultKey` 値 | `batch_store.py:297-299` の `result_key` 組み立てが `entry.output_path.name` 自動追従 | `batch_store.apply_process_log` | **No code change** (async_invoker の命名変更が直接反映される) |
| **R2.1** PDF 可視化 | `runner.py` の json→pdf lookup を「`.json` を 1 段剥がす」→「変換後 PDF basename を解決する」に書き換え | `runner.py:170-171` | **Missing** (lookup ロジック書き換え) |
| **R2.2** PPTX 可視化 | 同上 + 原本→変換後 map (`{deck.pptx.json: deck.pdf}`) を渡す | `main.py` の `pdf_to_original` を逆向きに使う (`original.name → pdf.name`) | **Missing** (`main.py` から `generate_all_visualizations` への引数追加) |
| **R2.3** 可視化 PDF 解決の一貫性 | R2.1 + R2.2 の結合 | — | R2.1/R2.2 同時解決 |
| **R2.4** 可視化 JPEG 命名据え置き | 既存規約 (`{basename}_{mode}_page_{idx}.jpg`) を維持 | `runner.py:146` | **No code change** |
| **R3.1** 変換失敗時 errorCategory + no resultKey | 既存 `_append_conversion_failures_to_log` + `apply_process_log` で実装済 | `main.py:227`, `batch_store.py` | **No code change** (テストで非リグレッション検証) |
| **R3.2** OCR 失敗時 errorCategory + no resultKey | 既存挙動 (failure path で `output_path` 未設定 → resultKey 未書込) | `apply_process_log` | **No code change** (テストで非リグレッション検証) |
| **R3.3** PENDING/PROCESSING で resultKey 無し | 既存挙動 | — | **No code change** |
| **R4.1** OpenAPI description 更新 | `schemas.ts:367-371` の `BatchFile.resultKey` description を新フォーマットで上書き | `schemas.ts` | **Missing** (description 文字列追加) |
| **R4.2** 移行ノート | 同上 | 同上 | **Missing** |
| **R4.3** `.json` 終端不変 | description で明示 | 同上 | **Missing** (記述追加) |
| **R4.4** 追加フォーマットとの非対称メモ | 同上 | 同上 | **Missing** (記述追加) |
| **R5.1** S3 遡及リネーム無し | コードに retroactive 操作を入れない | — | **Constraint** (migration script を作らない方針を design で確定) |
| **R5.2** DDB resultKey 遡及更新無し | 同上 | — | **Constraint** |
| **R5.3** in-flight バッチの扱い | デプロイ時点で `RUNNING` 状態のバッチがどう振る舞うか | — | **Research Needed** (design phase で決定: hard cutover / runtime feature flag / dual-write) |

### Test Fixture Migration Surface

```
lambda/batch-runner/tests/
├── test_async_invoker.py         L955: assert success_row["output_path"].endswith("ok.json")
├── test_run_async_batch_e2e.py   L252: assert by_stem["ok"]["output_path"].endswith("ok.json")
│                                 L784: assert deck_pptx_item.get("resultKey", "").endswith("/deck.json")  ← 新仕様で /deck.pptx.json に変更
├── test_main.py                  L758, L960: "output_path": str(output_dir / f"{stem}.json")
│                                 L830: assert deck_pptx_item.get("resultKey", "").endswith("/deck.json")  ← 同上
├── test_batch_store.py           L116, L313, L322, L335, L373, L435, L483, L515, L557, L564
│                                 (output_path / resultKey assert を {name}.json で書き換え)
├── test_s3_sync.py               L231, L241, L242, L303 (sample_0.json 等のフィクスチャ — basename 命名は本 spec の影響範囲外、ただし二段拡張子テスト追加)
└── lambda/api/__tests__/
    ├── lib/batch-presign.test.ts L220
    ├── lib/batch-store.test.ts   L175, L243
    └── routes/batches.test.ts    L116
```

合計 **約 22 件** の assert / fixture を新仕様 (`{name}.json`) に書き換え。さらに Office 形式 (`deck.pptx.json`) の test case を **新規追加** (PPTX/DOCX/XLSX 各 1 ケース最小)。

### 非機能要件

- **Performance**: 命名変更による hot path への影響なし (string concat 1 回追加のみ)。
- **Security/Privacy**: ファイル名は API レイヤでサニタイズ済。本 spec で扱う `original_filename` は「サニタイズ後の DDB filename」と一致する前提。
- **Reliability**: 後方互換破壊 (R4 の migration). API consumer の `resultKey` パース処理が壊れる可能性 → OpenAPI description で事前通知。

## 3. Implementation Approach Options

### Option A: Extend Existing Components (Recommended)

**変更対象ファイル**:
- `lambda/batch-runner/async_invoker.py` — `persist` ロジックの命名を `f"{file_stem}.json"` → `f"{original_filename}.json"`。引数として `original_name_map: dict[str, str]` を `run_async_batch` から流す
- `lambda/batch-runner/runner.py` — `generate_all_visualizations` の json→pdf lookup を二段拡張子対応に書き換え。引数 `original_to_pdf_map: dict[str, str]` を追加 (`{deck.pptx: deck.pdf}` の方向で受け取る)
- `lambda/batch-runner/main.py` — 既存 `pdf_to_original` を `run_async_batch` と `generate_all_visualizations` に追加引数として pipe through (逆向きが必要なら `original_to_pdf` も組み立て)
- `lambda/api/schemas.ts` — `BatchFile.resultKey` の OpenAPI description 更新
- 既存テスト fixture 約 22 件の書き換え + Office 形式テスト追加
- `batch_store.py:297-299` — **変更不要** (`entry.output_path.name` 自動追従)

**Compatibility**: 
- ✅ 既存 PDF クライアントの場合、入力ファイル名の `.pdf` がそのまま `{name}.pdf.json` に反映 → 後方互換破壊だが OpenAPI description で通知
- ✅ DDB スキーマ・属性名は不変
- ❌ 既存 `BatchFile.resultKey` パース処理 (basename 抽出を `.json` で 1 段剥がしている consumer) は破壊される

**Trade-offs**:
- ✅ 変更が局所化 (3〜4 モジュール + テスト)、新規ファイルなし
- ✅ 既存 office-format-ingestion の `pdf_to_original` 機構を再利用
- ✅ Phase 5 の E2E test (`test_run_async_batch_e2e.py`) が既に Office 形式を網羅 → fixture 移行で coverage 維持
- ❌ 22 箇所の fixture 移行に伴うミスマッチリスク
- ❌ 移行戦略 (R5.3) を別途決める必要あり

### Option B: Create New Components (Not Recommended)

ファイル命名規約の集約を `naming_policy.py` モジュールとして新設。`async_invoker` と `runner` がそれを参照する形に。

**Trade-offs**:
- ✅ 命名規約の単一責任化 (将来 `.md`/`.csv` 統一時の拡張点)
- ❌ 1 関数 (たかだか 5 行) のために新規モジュール追加は YAGNI
- ❌ 現状 2 箇所の call site のみ → 抽象化の費用対効果が低い

### Option C: Hybrid (Optional Migration Strategy)

Option A + ランタイム feature flag (`RESULT_KEY_NAMING=legacy|extension_preserved`)。

**Trade-offs**:
- ✅ Production rollback が即時可能
- ✅ Canary バッチで段階リリース可能
- ❌ env var 追加で BatchRunnerSettings 拡張が必要
- ❌ Feature flag 撤去のための後続 PR が必要 (技術的負債リスク)
- ❌ A consumer がフォーマットを判別できない期間が発生

## 4. Implementation Complexity & Risk

- **Effort: M (3–7 days)**  
  Code changes は Option A で 3〜4 モジュール + 約 22 箇所の test fixture 書き換え + Office E2E case 追加 + OpenAPI description test。新規パターンや外部依存追加なし。本人作業 ~3 日 + レビュー / 修正バッファ ~2 日。

- **Risk: Medium**  
  - 後方互換破壊 (`BatchFile.resultKey` 値フォーマット) → API consumer 側の影響。既存の internal consumer (`/batches/{id}` の UI consumer 等) は migration が必要。
  - ~22 箇所の fixture 書き換えで漏れ発生リスク。Phase 5 の `test_run_async_batch_e2e.py` E2E 網羅と OpenAPI description test で検出可能。
  - `runner.py` の二段拡張子 lookup 書き換えで visualization regression リスク (Phase 5 R8 と同等の検証が必要)。

## 5. Research Needed (design phase へ持ち越し)

1. **Migration strategy 確定**: 
   - hard cutover (deploy 後の新規バッチのみ新仕様)
   - feature flag (`RESULT_KEY_NAMING` env var で制御、staged rollout 後に flag 撤去)
   - dual-write (deprecation window 中は両 key で書き、reader 側で新→旧 fallback)
   
   現状ユースケース (1 アカウント / 内部 API consumer のみ) を踏まえると hard cutover が現実的だが、API description 更新タイミングと CloudFront キャッシュの整合性を design で詰める必要あり。

2. **In-flight batch handling**: デプロイ瞬間に `RUNNING` 状態のバッチが存在した場合、batch-runner のコンテナイメージ更新は次回 task 起動から反映されるため挙動差は出ないが、Step Functions task の長時間実行 (>1h) の場合の整合性を確認。

3. **OpenAPI description のフォーマット**: 単一文字列 description で migration ノートを書ききるか、`x-deprecated-fields` / `x-migration` のような extension key を使うか。Hono + zod-openapi の表現可否を design で確認。

4. **`runner.py` の lookup 失敗時の挙動**: 二段拡張子化に失敗した場合 (例: 想定外の `.json` ファイルが残っている) のフォールバック方針。現状は `pdf_path` が存在しないと silently skip しているが、想定外ケースでの warning ログ追加を検討。

## 6. Recommendations for Design Phase

### 推奨アプローチ
- **Option A (Extend Existing Components)** を採用
- 移行戦略は **hard cutover** をベースに検討 (内部 consumer のみのため実現可能性高い)。Feature flag は overhead を勘案して不採用候補
- `pdf_to_original` を逆向きにした `original_to_pdf` map (`{deck.pptx: deck.pdf}`) を `main.py` で組み立て、`run_async_batch` と `generate_all_visualizations` の両方に pipe through

### 主要設計判断ポイント
1. 引数の型: `dict[str, str]` でシンプルに保つか、`@dataclass(frozen=True) FilenameMapping` を導入するか
2. `async_invoker` の internal API: `original_name_map` を `AsyncInvoker.__init__` に持たせるか、`run_async_batch` 関数引数で都度渡すか (現状 1 batch = 1 invocation のため後者で十分)
3. 可視化 lookup 失敗時の error reporting 方針 (silent skip 維持 / warning ログ追加 / metric 化)
4. OpenAPI migration ノートの書き方と内部 consumer (CloudFront UI など) への通知タイミング

### Carry-Forward Research Items
- (R5.3) Migration strategy 最終決定 — design 段階で確定
- (R4.1-R4.4) OpenAPI description の具体的な文言ドラフト — design 段階で記述
- runner.py lookup 失敗時の error policy — design 段階で確定

---

## Design Synthesis Outcomes (2026-04-27)

### 1. Generalization
- R1.1 (PDF), R1.2 (PPTX), R1.3 (DOCX/XLSX), R1.4 (非 ASCII / サニタイズ) は同一の問題「ローカル basename → 原本ファイル名のマッピングを使って JSON 命名する」のバリエーション
- 一般化された capability: **filename mapping** (`local_basename → original_input_filename` および逆向き)
- ネイティブ PDF: identity (entry なし → `dict.get(key, key)` で fallback)
- Office: 明示的な entry (`convert_office_files` の戻り値から構築)

### 2. Build vs. Adopt
- **Adopt** (再利用): `office-format-ingestion` で導入された `pdf_to_original` 構築ロジック (`main.py:201-221`)、`apply_process_log(..., converted_filename_map)` 機構、`ConvertResult.succeeded[ConvertedFile(original_path, pdf_path)]` データ構造
- **Build** (新規): なし。既存マッピングを `async_invoker` / `runner` にも pipe through するための引数追加に閉じる
- 外部ライブラリ追加なし

### 3. Simplification
- **却下**: `naming_policy.py` 新規モジュール (research の Option B) — 1 関数 5 行のために抽象化費用対効果が低い (YAGNI)
- **却下**: Feature flag による段階移行 (research の Option C) — 内部 consumer のみ + Fargate task 単位 deploy で in-flight 影響なしのため hard cutover が現実的
- **却下**: `@dataclass(frozen=True) FilenameMapping` ラッパー — `dict[str, str]` 1 つで完結するため不要
- **採用**: シンプルな `dict[str, str]` を関数引数で渡す (steering の「副作用のない純粋関数」原則と整合)

### Final Design Decisions
- **Mapping ownership**: `main.py` がオーケストレータとして両方向 map (`local_to_original` / `original_to_local`) を所有、下流モジュールは引数で受け取る
- **Migration strategy**: hard cutover (no feature flag, no dual-write, no migration script)
- **In-flight handling**: Fargate task 単位 deploy のため、deploy 瞬間に走っている task は旧 image で完了する (Step Functions Execution の startedAt が deploy 時刻より早ければ旧フォーマット、それ以降は新フォーマット)
- **Lookup failure policy**: 既存挙動を維持 (silent skip + warning ログ)、エラーメッセージのみ「local PDF not found: {basename}」に更新

### Design Review Gate Status
- Mechanical checks: 全 19 numeric requirement IDs が design.md の Traceability Table に出現 ✅
- Boundary section populated: This Spec Owns / Out of Boundary / Allowed Dependencies / Revalidation Triggers すべて記述済 ✅
- File Structure Plan: 具体的 path とファイルごとの責務を記述 ✅
- No orphan components: 4 component (`main.py`, `async_invoker`, `runner`, `schemas.ts`) すべて File Structure Plan に対応 ✅
