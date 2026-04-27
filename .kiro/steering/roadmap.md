# Roadmap

## Overview

バッチ OCR API の 1 バッチあたりのスケール上限 (ファイル数 / 合計サイズ / 1 ファイルサイズ) に余剰がある。調査の結果、**真のハードリミットは「ファイル数」の DynamoDB `TransactWriteItems` 100 items 制約が最も厳しい**と判明。合計サイズ・1 ファイルサイズは OpenAPI description のみで強制されておらず、Fargate の ephemeral storage と SageMaker Async Inference の payload 上限 (1 GB) が実ボトルネック。

段階的に解放する。P1 (オフバイワン修正) と P2 (Fargate ephemeralStorage 拡張) は小粒で可逆のため直接実装、P3 (1000 ファイル対応) は DDB 書き込みパターンの根本変更を含み spec を起こして設計 / レビューフェーズを経る。

## Approach Decision

- **Chosen**: 3 フェーズ段階解放 (P1/P2 direct implementation + P3 spec-driven)
- **Why**:
  - P1 (99 files): 現行 `MAX_FILES_PER_BATCH=100` + 1 META = 101 items が `TransactWriteItems` 上限を超えるバグ修正。数行で完結、早めに塞ぎたい
  - P2 (ephemeral 50 GB): CDK prop 1 行追加 + description 更新の低リスク変更。`MAX_TOTAL_BYTES` を 10 GB に引き上げて実用性を向上
  - P3 (1000 files): 非原子化・orphan 掃除・SLO 再定義・throughput 戦略など複数の設計判断が絡むため spec 必須
- **Updates (2026-04-25, office-format-ingestion 合流)**:
  - P2 (ephemeralStorage 50 GB + `MAX_TOTAL_BYTES=10GB`) は `office-format-ingestion` spec に責務移管。LibreOffice 変換で同じレイヤ (`lib/batch-execution-stack.ts` / `lambda/api/schemas.ts`) を触るため二度手間 / 衝突回避のため直接実装候補から除外
- **Rejected alternatives**:
  - **全部を 1 spec**: P1 が数行のバグ修正なので spec の overhead (req → design → tasks) が本体より大きい
  - **P1/P2 も spec 化**: 同様に overhead 過剰。steering + task commit message で十分
  - **P3 を直接実装**: 非原子化の設計をレビューなしで通すのは保守性リスクが高い

## Scope

- **In**:
  - `MAX_FILES_PER_BATCH` / `MAX_TOTAL_BYTES` / `MAX_FILE_BYTES` の上限引き上げ
  - 強制層 (Zod validation) と description (OpenAPI) の整合
  - Fargate TaskDefinition の ephemeral storage 拡張
  - DynamoDB 書き込みパターンの再設計 (P3)
- **Out**:
  - SageMaker instance type の変更 (ml.g5.xlarge 維持)
  - yomitoku-client の推論側改善
  - バッチ間の優先度キュー / スロットリング機構

## Constraints

- **DynamoDB**: `TransactWriteItems` 100 items / 4 MB、`BatchWriteItem` 25 items / 16 MB
- **SageMaker Async Inference**: 入力 payload 1 GB / リクエスト、`InvocationTimeoutSeconds` 3600 秒
- **Fargate**: ephemeral storage default 20 GB、最大 200 GB
- **既存 API 契約**: `GET /batches/:id/files` の cursor pagination は P3 でも互換維持必須
- **運用影響**: `ApproximateAgeOfOldestRequestAlarm` 閾値 (30 分) の再検討が P3 で必要

## Boundary Strategy

- **なぜこの分割か**:
  - P1 はバグ修正で「今すぐ」が望ましい。spec のレビューフェーズで遅延させる価値がない
  - P2 は config 変更で独立。P3 と無関係に先行投入できる (ephemeral 拡張は P3 実装にも必要なので布石にもなる)
  - P3 は複数の設計論点を含むため spec で形式化
- **Shared seams to watch**:
  - `lambda/api/schemas.ts` の constant: P1/P2/P3 全てが同じ constants を触る。P1→P2→P3 の順で更新していく
  - `lambda/api/lib/batch-store.ts::putBatchWithFiles`: P1 は触らない、P3 が根本変更
  - `lib/batch-execution-stack.ts::FargateTaskDefinition`: P2 で ephemeralStorageGiB 追加、P3 で throughput 調整

## Existing Spec Updates

なし (本件は既存の `sagemaker-async-inference-migration` / `yomitoku-client-batch-migration` のいずれの境界にも属さない新規領域)

## Direct Implementation Candidates

- [ ] **P1**: `MAX_FILES_PER_BATCH = 99` に修正し TransactWriteItems 上限衝突を回避 (即日対応、数行、可逆)
- [ ] **P1b**: `MAX_FILE_BYTES` を 1 GB に引き上げ、OpenAPI description を SageMaker Async の実上限に合わせる (未強制の定数更新のみ)

## Specs (dependency order)

- [ ] office-format-ingestion — `.pptx` / `.docx` / `.xlsx` を API 入力で受理し、Fargate batch-runner で LibreOffice headless を介して PDF 変換してから Async Inference に流す。失敗分離 (`error_category: CONVERSION_FAILED`)、変換後 PDF サイズ再チェック (≤1 GB)、CJK フォント同梱、per-invocation UserInstallation、subprocess timeout、暗号化事前検知を含む。**P2 (ephemeralStorage 50 GB + `MAX_TOTAL_BYTES=10GB`) を本スペック責務に内包** (LibreOffice 変換で I/O 増、かつ `schemas.ts` / `batch-execution-stack.ts` を同時に触るため衝突回避)。Dependencies: P1 (`MAX_FILES_PER_BATCH=99`)
- [ ] result-filename-extension-preservation — メイン OCR JSON のファイル名規約を `{stem}.json` から `{原本ファイル名}.json` (例: `report.pdf.json` / `report.pptx.json`) に変更。`async_invoker.py:492` の命名と `runner.py:170-171` の可視化 lookup を二段拡張子対応に書き換え。**`.pdf` ユーザー含む API consumer に対して resultKey 命名が変わる破壊的変更を含む** ため office-format-ingestion とは分離。追加フォーマット (`.md`/`.csv`/`.html`) は yomitoku-client 側の責務で本 spec の Out。Dependencies: office-format-ingestion (Office 形式が混在する状況で命名要件が顕在化、`async_invoker` / `runner.py` の merge 順序整理が必要)
- [ ] batch-scale-out — 1 バッチ 1000 ファイル対応。DDB 書き込みを META Put → FILE BatchWriteItem の 2 フェーズ化、orphan 掃除戦略 (TTL 延長 or 明示 cleanup)、SLO 再定義 (1000 files × 数秒)、throughput スケール戦略 (`MaxConcurrentInvocationsPerInstance` / `asyncMaxCapacity`)、監視しきい値の再調整を含む。Dependencies: P1 + office-format-ingestion (後者で `ephemeralStorage` 50 GB 拡張が入るため)
