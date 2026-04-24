# Runbook: 旧 `StatusTable` カットオーバー削除手順

## 目的

`yomitoku-client-batch-migration` による「1 PDF 1 ジョブ」→ バッチ API 刷新のカットオーバー時点で、AWS アカウントに残存する旧 `StatusTable`（DynamoDB）を確実に削除する。

本 Runbook は CDK 変更ではなく **手動削除手順** で旧テーブルを除去する。理由:

- 旧 `StatusTable` は CDK 定義時点から `removalPolicy=RETAIN` で運用されており、Task 1.1（commit `f17808c`）で CDK 定義を撤去した時点ではテーブル実体は AWS アカウントに残存している。
- CDK から既に定義を失っているため、`removalPolicy=DESTROY` への一時変更 → `cdk deploy` による削除ルートは取れない（CloudFormation から見えない孤立リソースのため）。
- 要件 1.2 / 9.3 / 9.5 により「旧テーブルをアカウントに残存させない」ことが必達。

## 適用範囲

- 対象アカウント: staging / production
- 対象リソース: 旧 `StatusTable`（物理名は環境により異なる。`*StatusTable*` を含む DynamoDB テーブル）
- 実施タイミング: 新バッチスタック `cdk deploy --all` が安定した直後（旧 API 遮断と CI guard 有効化後）
- 前提: 現在の `lib/` に `StatusTable` は存在しない（`lib/processing-stack.ts` 参照）。`BatchTable` / `ControlTable` は `RETAIN` のまま維持する

## 事前条件

- [ ] メンテナンス通知済み（production 時）
- [ ] 旧 `/jobs` API 参照元クライアントがゼロであることを確認済み
- [ ] 当該バッチ刷新のソースツリーで `bash scripts/check-legacy-refs.sh` が `✓ No legacy references found.` を返す
- [ ] `pnpm lint && pnpm test` グリーン
- [ ] `aws sts get-caller-identity` で対象アカウント・リージョンが正しいことを確認

## 手順

### 1. 事前通知（production のみ）

- 運用チャネルに「旧 StatusTable を手動削除する」旨を告知し、削除ウィンドウを合意する。
- 旧 `/jobs` API を叩くクライアントが 0 であること（CloudFront / API Gateway のアクセスログ・メトリクス）を再確認する。

### 2. レガシー参照ガード

リポジトリルートで以下を実行し、旧 API/DDB/S3 キーに対する参照が実コードに残っていないことを保証する:

```bash
bash scripts/check-legacy-refs.sh
# 期待: ✓ No legacy references found.
```

失敗する場合は本 Runbook を中断し、該当ファイルを先に刷新する。

### 3. 新スタックのデプロイ

```bash
pnpm build
pnpm cdk deploy --all --require-approval never
```

- 旧 `ProcessingStack` 配下の `StatusTable` リソースは CDK に存在しないため、**この deploy だけでは物理テーブルは消えない**。
- deploy 完了後、`cdk diff` がクリーンであること（`There were no differences`）を確認する。

### 4. 旧 `StatusTable` の特定

```bash
aws dynamodb list-tables --output text \
  | tr '\t' '\n' \
  | grep -i StatusTable || true
```

- 該当行が 1 件だけ出ることが期待値（例: `YomiToku...ProcessingStack-StatusTable0F76785B-XXXXXXXX`）。
- `BatchTable` / `ControlTable` はこのフィルタに引っかからない命名であり、誤削除対象になり得ない。
- 2 件以上ヒットした場合は削除を中断し、レビューする。
- 0 件ヒットであれば本 Runbook の目的は既に達成されている（手順 7 まで飛ばしてよい）。

### 5. バックアップ取得（保険）

削除は不可逆のため、念のため on-demand バックアップを取る:

```bash
TABLE_NAME="<手順 4 で特定した物理名>"
aws dynamodb create-backup \
  --table-name "$TABLE_NAME" \
  --backup-name "${TABLE_NAME}-cutover-$(date -u +%Y%m%dT%H%M%SZ)"
```

- PITR が有効なテーブルでも `CreateBackup` による on-demand バックアップを残す運用とする。
- バックアップ ARN を記録しておく。

### 6. 削除

```bash
aws dynamodb delete-table --table-name "$TABLE_NAME"
```

削除完了（`TableStatus=DELETING` → 消滅）を確認:

```bash
aws dynamodb describe-table --table-name "$TABLE_NAME" 2>&1 \
  | grep -q "ResourceNotFoundException" && echo "DELETED" || echo "STILL_EXISTS"
# 期待: DELETED
```

### 7. 事後検証

```bash
# 1. テーブル一覧に StatusTable が存在しないこと
aws dynamodb list-tables --output text \
  | tr '\t' '\n' \
  | grep -i StatusTable \
  && { echo "FAIL: StatusTable still present"; exit 1; } \
  || echo "OK: no StatusTable"

# 2. 新バッチ API の smoke test（staging）
#    - POST /batches → 201
#    - POST /batches/:id/start → 202
#    - GET /batches/:id → status が終端に遷移
```

- staging では Runbook 適用後に最小 PDF（1〜3 件）でのハッピーパス smoke test をパスさせることを完了条件とする（Task 7.1 と連動）。
- production では既存の監視ダッシュボード（CloudWatch `BatchInFlight` / アラーム）がエラーバースト無しで推移することを 24 時間観測する。

## ロールバック制約

- **手順 6 の `delete-table` は不可逆**。バックアップからの `RestoreTableFromBackup` は可能だが、削除直前時点のデータに戻るだけで、その後の書き込みは失われる。
- 旧 `/jobs` API と旧 Lambda は既に CDK 上に存在しないため、アプリケーション層でのロールバック経路は存在しない（設計 `Migration Strategy` の Phase 3 以降は戻せない前提）。
- カットオーバー失敗時は以下のみが取り得る対応:
  1. 新 API のデプロイ状態は維持する（バッチ API 側は機能している前提）
  2. 旧 StatusTable に依存していた第三者がいた場合は、バックアップからの復元で一時救済
  3. 恒久対応は新バッチ API へのクライアント移行のみ

## 失敗系と対処

| 事象 | 対処 |
|-----|-----|
| `delete-table` が `ResourceInUseException` で失敗 | `describe-table` の `TableStatus` を確認。`ACTIVE` まで待ってから再試行 |
| 手順 4 で 2 件以上ヒット | 物理名を全件記録。真に旧 `StatusTable` 由来のものだけを 1 件ずつ処理 |
| 手順 4 で 0 件ヒットだが、手順 3 の deploy で CFn ドリフトが出た | 別原因。本 Runbook 対象外 |
| バックアップ作成が課金上限に抵触 | on-demand バックアップ有効化を事前申請する |

## 関連資料

- 要件: `.kiro/specs/yomitoku-client-batch-migration/requirements.md#requirement-1` / `#requirement-9`
- 設計 Migration Strategy: `.kiro/specs/yomitoku-client-batch-migration/design.md`
- 旧リソース撤去コミット: `f17808c` (Task 1.1)
- CI ガード: `scripts/check-legacy-refs.sh`
