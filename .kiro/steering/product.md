# Product Overview

YomiToku OCR Worker は、AWS SageMaker Marketplace の **YomiToku-Pro** モデルに PDF をバッチ投入して構造化 OCR 結果 (JSON / Markdown / CSV / HTML / PDF) を返す、サーバレスな OCR バッチ処理プラットフォーム。**1 バッチあたり最大 100 ファイル / 500 MB**、完全マネージドな AWS インフラ (Lambda / Step Functions / ECS Fargate / DynamoDB / CloudFront) で運用する。

## Core Capabilities

- **バッチジョブライフサイクル管理**: 作成 → アップロード URL 発行 → 実行開始 → 進捗/結果参照 → 失敗ファイルのみ再解析。すべて REST API (Hono + API Gateway + CloudFront) 経由。
- **ゼロアイドルコストの GPU 推論**: SageMaker Async Inference + Application Auto Scaling で GPU インスタンス (`ml.g5.xlarge`) を 0 台 ↔ N 台に伸縮。アイドル時は課金ゼロ。
- **並列処理と部分失敗耐性**: yomitoku-client がファイル単位で OCR、`process_log.jsonl` を per-file で記録。1 バッチ内で `COMPLETED` / `PARTIAL` / `FAILED` を区別し、失敗分だけ `POST /batches/:id/reanalyze` で再投入できる。
- **単一テーブルの状態ストア**: DynamoDB `BatchTable` (PK/SK + GSI1/GSI2 + TTL) に META と FILE を共存させ、`STATUS#{status}#{YYYYMM}` GSI で月別ステータス検索を提供。
- **観測性の作り込み**: CloudWatch アラーム (`HasBacklogWithoutCapacity` / `ApproximateAgeOfOldestRequest` / `FilesFailedTotal` / `BatchDurationSeconds`)、`ControlTable` heartbeat、Cost Explorer 用の `yomitoku:component` タグ戦略。

## Target Use Cases

1. **大量 PDF の定期的なデジタル化** — アーカイブスキャン / 契約書ライブラリ等、数百〜数千 PDF を 5〜30 分レイテンシで構造化したい業務。稼働時間よりコスト予測性が重要なシナリオ。
2. **監査対応を前提とした OCR** — バッチ ID → ファイル単位ログ → S3 出力までの完全なトレーサビリティが要件 (金融・法務・行政)。
3. **`ap-northeast-1` の `ml.g5.xlarge` キャパ逼迫時の退避運用** — 常設 Realtime Endpoint が取れない環境で、Async の自動スケール + バックログ蓄積 + 必要なら `us-east-1` 退避で負荷を流す。

## Value Proposition

**「アイドルコスト 0 で、GPU キャパに依存せず回るバッチ OCR」**。以前は Step Functions が Realtime Endpoint を毎ジョブ create/delete して `InsufficientCapacity` に繰り返しぶつかる構成だったのを、Async Inference 常設 + `HasBacklogWithoutCapacity` による 0→1 bootstrap + TargetTracking による N への伸縮に置き換えて、capacity 取得のタイミング依存性とアイドル課金を同時に解消している。

---
_Patterns and purpose, not exhaustive features._
