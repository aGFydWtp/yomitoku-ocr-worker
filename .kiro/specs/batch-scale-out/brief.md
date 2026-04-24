# Brief: batch-scale-out

## Problem

バッチ OCR API の 1 バッチあたりのファイル数上限が 99 (実装側 100 だがオフバイワンで) に制約されている。大量ドキュメントの一括 OCR (例: 数千 PDF のアーカイブスキャン) を流したいユーザーは、バッチを複数に手分割する必要があり、運用コスト (API 呼び出し回数 × 再解析単位の煩雑化) と UX が劣化している。

## Current State

- `MAX_FILES_PER_BATCH = 100` (実質 99): `putBatchWithFiles` が `TransactWriteItems` で `1 META + N FILE` を 1 呼び出しに詰めるため、DynamoDB 仕様 (100 items / transaction) で制約される
- `MAX_TOTAL_BYTES = 500 MB → P2 で 10 GB に拡張予定`: Fargate ephemeral storage 50 GB で実用上限 ~18 GB まで許容可能
- `MAX_FILE_BYTES = 50 MB → P1b で 1 GB に拡張予定`: SageMaker Async 1 GB が真の上限
- 進捗 API (`GET /batches/:id/files`) は既に cursor pagination 対応済で 1000 件レスポンスに耐える

ギャップ: 1000 ファイル化には DDB 書き込み方式の再設計、orphan 対策、SLO 再定義、throughput 戦略の全てが必要。

## Desired Outcome

以下を満たした状態:

- `POST /batches` が 1000 ファイルまで受理し、正常系で 1 バッチが `COMPLETED` / `PARTIAL` / `FAILED` のいずれかに到達する
- `TransactWriteItems` 100 items 制約を直接触らない設計 (= BatchWriteItem か分割 Put) に切り替わっている
- バッチ作成中 (META 書き込み後、FILE 書き込み未完) の crash で生じる orphan META は自動的に掃除される (TTL か cleanup lambda)
- 1000 ファイルバッチの期待所要時間 (warm / cold 別) が OpenAPI description に記載されている
- `ApproximateAgeOfOldestRequestAlarm` などの監視しきい値が 1000 ファイル運用で誤報しない値に再調整されている
- `/files` エンドポイントが 1000 件でも cursor pagination で 200 OK を安定して返す (既実装の延長)

## Approach

メタ先行 + FILE を BatchWriteItem で分割書き込み:

1. `putBatchWithFiles` を 2 フェーズ化:
   - Phase 1: META を `PutItem` で書く (status=`PENDING`, TTL 24h)
   - Phase 2: FILE 群を `BatchWriteItem` で 25 items × ceil(N/25) 回に分けて書く
2. Phase 2 の途中で crash した場合は META が orphan になるが、現行 TTL (`BATCH_PENDING_TTL_SECONDS = 24h`) で自動削除される
3. Phase 2 完了後に META.filesWritten フラグを Set (読み手が「完了 meta のみ処理対象」と判別できる)
4. `GET /batches/:id/files` は `filesWritten=true` の META のみ 200 を返し、途中状態は 404 or 409

非原子化を許容する判断の根拠:
- 現行の cancel パス (PENDING → CANCELLED) は TransactWriteItems で 1 item 更新のみ。ここは atomic 維持
- Batch 作成時の部分失敗は「ユーザーにエラーを返して作り直し」で吸収できる (再 POST = 新 batchJobId)

## Scope

- **In**:
  - `MAX_FILES_PER_BATCH = 1000` への引き上げ
  - `putBatchWithFiles` の書き込みパターン再設計
  - orphan 掃除戦略の決定と実装 (TTL 延長 or cleanup lambda)
  - 監視しきい値の再調整 (`ApproximateAgeOfOldestRequestAlarm` 閾値、`BatchDurationAlarm` 閾値)
  - 1000 ファイルバッチ用の処理時間見積り更新 (OpenAPI description)
  - throughput スケール戦略の決定 (`MaxConcurrentInvocationsPerInstance` の引き上げ可否、`asyncMaxCapacity` の引き上げ幅)
  - パフォーマンステスト / 1000 ファイル E2E の自動化戦略 (フル E2E は不可なので段階的)
- **Out**:
  - 異なる文書フォーマット対応 (PDF 以外) — 別スコープ
  - バッチ間優先度キュー — 別スコープ
  - 1000 ファイル超えの拡張 — 本 spec の外

## Boundary Candidates

- **データ層**: `lambda/api/lib/batch-store.ts::putBatchWithFiles` の書き換え + orphan 掃除ロジック
- **API 層**: `lambda/api/schemas.ts::MAX_FILES_PER_BATCH` の引き上げ + OpenAPI description 更新 + エラーパス (部分書き込み失敗時の HTTP status)
- **インフラ層**: `lib/sagemaker-stack.ts` の `asyncMaxCapacity` 引き上げ、`lib/monitoring-stack.ts` のアラーム閾値調整
- **運用 / ドキュメント**: Runbook / README の 1000 ファイル時の期待所要時間表の追加

## Out of Boundary

- **yomitoku-client の推論側チューニング**: 本 spec は呼び出し側 (runner) のスケールのみ
- **SageMaker instance type の変更**: `ml.g5.xlarge` 維持前提
- **既存 PR / 1 ファイル 1 GB 対応 (P1b) の破壊的変更**: `MAX_FILE_BYTES` は P1b で更新済、本 spec は触らない

## Upstream / Downstream

- **Upstream**:
  - P1 (`MAX_FILES_PER_BATCH = 99` + オフバイワン修正) — 完了前提
  - P2 (`FargateTaskDefinition.ephemeralStorageGiB = 50`) — 合計サイズの増加に対応する前提
  - `sagemaker-async-inference-migration` (Async 基盤) — 完了済
- **Downstream**:
  - 将来の「優先度キュー / バッチ間スケジューリング」 spec があれば本 spec の throughput 改善を前提
  - コスト最適化 (`MaxConcurrentInvocationsPerInstance` 調整) の検討

## Existing Spec Touchpoints

- **Extends**: なし (既存 spec の延長ではなく新規)
- **Adjacent**:
  - `sagemaker-async-inference-migration`: インフラ側の境界 (Endpoint / Auto Scaling) は触らない
  - `yomitoku-client-batch-migration`: runner 側の並列度 / async_max_concurrent のみ境界として再検討対象

## Constraints

- **DynamoDB**: `TransactWriteItems` 100 items / 4 MB、`BatchWriteItem` 25 items / 16 MB
- **SageMaker Async Inference**: 入力 payload 1 GB / リクエスト、`InvocationTimeoutSeconds` 3600 秒
- **Fargate**: ephemeral storage 最大 200 GB (P2 で 50 GB 予約、1000 file 平均 10 MB なら 10 GB 消費で余裕)
- **既存 API 契約**: `GET /batches/:id/files` の cursor pagination は破壊禁止。レスポンス shape も既存互換
- **運用コスト**: GPU instance 時間が線形に増える。ユーザーに事前見積り UX を提供したい (OpenAPI description or `/batches` レスポンスの `estimatedDurationSeconds`)
