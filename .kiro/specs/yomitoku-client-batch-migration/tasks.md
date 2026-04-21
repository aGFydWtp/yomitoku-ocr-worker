# Implementation Plan

本計画は `yomitoku-client-batch-migration` を Kiro ルールに従って Foundation → Core → Integration → Validation の順で実装するタスク集合である。各サブタスクは 1–3 時間規模で、`design.md` の Components & Interfaces と Data Models の境界に整合させる。並列実行可能なタスクには `(P)` を付与する。

## 1. Foundation: 基盤リソースの整備と旧リソース削除

- [x] 1.1 旧 OCR 実行系リソースを CDK から撤去する
  - `ProcessingStack` から `StatusTable`・`MainQueue`・`DeadLetterQueue`・`ProcessorFunction`・`SqsEventSource`・`SqsDestination` と関連 IAM 権限を削除する
  - `ProcessingStack` 外部公開プロパティ（`mainQueue` / `deadLetterQueue` / `statusTable` / `processorFunction`）とそれを参照している他スタックの配線を整理する
  - 旧 Nag suppression の対象識別子（`StatusTable0F76785B`、`DataBucket... /input/*`、`/output/*`、`/visualizations/*`）を削除し、`cdk synth` が新リソース構成でエラーなく完了することを確認する
  - `cdk synth` のスナップショット差分で旧リソースが全消滅していることを観測可能な完了条件とする
  - _Requirements: 1.2, 1.3, 1.4, 9.3, 9.5_

- [x] 1.2 Single-table `BatchTable` と新 S3 ライフサイクルを追加する
  - `ProcessingStack` に `BatchTable`（PK=`PK`、SK=`SK`、PAY_PER_REQUEST、PITR 有効）を追加する
  - GSI1（`GSI1PK = STATUS#{status}#{yyyymm}`、`GSI1SK = createdAt`、META のみ projection）と GSI2（`GSI2PK = PARENT#{parentBatchJobId}`、`GSI2SK = createdAt`、META のみ projection）を定義する
  - PENDING アイテムの `ttl` 属性を有効化する
  - S3 バケットへ `batches/*` 配下のリテンションルール（`logs/` は長期保管、`visualizations/` と `results/` は短期）を追加する
  - `cdk synth` で `BatchTable` と GSI 2 本が存在し、`StatusTable` が存在しないことを確認する
  - _Requirements: 9.1, 9.2, 9.4, 11.5_

- [x] 1.3 CI レガシー参照ガードを導入する
  - `scripts/check-legacy-refs.sh` を作成し、`/jobs`・`StatusTable`・`job_id`・`MainQueue`・`ProcessorFunction`・旧 S3 キー（`input/{`、`output/{`、`visualizations/{`）等の禁止語を `git grep` でブロックする
  - `.kiro/`・`node_modules/`・`.git/`・`cdk.out/` を除外パスに指定する
  - `package.json` に `lint:legacy` スクリプトを登録し、既存の lint タスクチェーンに組み込む
  - `npm run lint:legacy` が旧参照をすべて検出して非ゼロ終了し、クリーンな状態ではゼロ終了する挙動を観測可能な完了条件とする
  - _Requirements: 12.4_

## 2. Core: バッチ API ドメイン

- [x] 2.1 (P) バッチ系 Zod/OpenAPI スキーマを整備する
  - `JOB_STATUSES`・`CreateJobBody*`・`JobDetailResponse*`・`VisualizationsResponse*`・`CancelJobResponse` など旧スキーマを削除する
  - `BATCH_STATUSES = ["PENDING","PROCESSING","COMPLETED","PARTIAL","FAILED","CANCELLED"]` を定義する
  - `CreateBatchBodySchema`（basePath + files[] + extraFormats? + 上限値）・`CreateBatchResponseSchema`（batchJobId + uploads[]）・`BatchDetailSchema`・`BatchFileSchema` + 一覧／ページング用スキーマ・`ProcessLogLinkSchema`・`ReanalyzeRequestSchema` を定義する
  - 上限定数（`MAX_FILES_PER_BATCH`、`MAX_TOTAL_BYTES`、`MAX_FILE_BYTES`、`ALLOWED_EXTENSIONS`）を `schemas.ts` から export する
  - Zod の検証失敗が `400` エラー応答に変換されることをユニットテストで確認する
  - _Requirements: 2.2, 2.3, 2.5, 11.2_
  - _Boundary: ApiFunction (schemas)_

- [x] 2.2 (P) `BatchStore` Single-table リポジトリを実装する
  - META アイテム作成と FILE アイテム一括追加を 1 つの TransactWriteItems で原子化する `putBatchWithFiles` を実装する
  - `transitionBatchStatus`（`expectedCurrent` 条件付き更新）と `updateFileResult`（`status != COMPLETED` 条件）を実装する
  - `getBatchWithFiles`（`Query(PK=BATCH#id)`）、`listBatchesByStatus`（GSI1、`STATUS#{status}#{yyyymm}` シャーディング考慮）、`listChildBatches`（GSI2）を実装する
  - `parentBatchJobId`・`startedAt`・`totals` を含む META アイテムの属性変換ヘルパを `BatchStore` 内に閉じ込める
  - ユニットテストで DynamoDB Local または `@aws-sdk/client-dynamodb` のモックに対し CRUD 一巡が成功することを確認する
  - _Requirements: 3.4, 5.2, 5.3, 7.1, 8.2, 9.1, 9.2_
  - _Boundary: BatchStore_

- [x] 2.3 (P) 複数ファイル署名付き URL 発行器を実装する
  - `batches/{batchJobId}/input/{filename}` 形式の S3 キーを決定論的に生成する
  - ファイル単位の署名付き PUT URL を一括生成し、`expiresIn`（15 分）を応答に含める
  - 結果取得（`output/*.json`、`results/*`、`visualizations/*`、`logs/process_log.jsonl`）向け署名付き GET URL ヘルパを併設し、有効期限を 60 分に設定する
  - `MAX_FILES_PER_BATCH` を超過した要求は呼び出し段階で拒否することを観測可能な完了条件とする
  - _Requirements: 2.1, 2.5, 5.4, 6.5_
  - _Boundary: BatchPresign_

- [x] 2.4 `POST /batches` ルートを実装する
  - CloudFront `x-origin-verify` ヘッダ検証を既存ミドルウェアから継承する
  - 入力検証（拡張子・ファイル数・合計サイズ）を Zod で実施する
  - エンドポイント状態が `IN_SERVICE` でない場合は `503` を返しつつ `POST /up` 相当のキックを発火する
  - `BatchStore.putBatchWithFiles` と `BatchPresign` を呼び出し、`batchJobId` と `uploads[]` を返す
  - 成功時 DDB に META (`status=PENDING`, `ttl=now+24h`) と FILE アイテムが永続化されていることを統合テストで確認する
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 10.5_
  - _Depends: 2.1, 2.2, 2.3_

- [ ] 2.5 `POST /batches/:batchJobId/start` ルートを実装する
  - META の `status=PENDING` を条件に `PROCESSING` へ遷移させ、`startedAt` を記録する
  - `ListObjectsV2` で `batches/{id}/input/` を走査し、DDB の FILE 期待集合との差分で欠損ファイルを判定する
  - 欠損がある場合は `400` で拒否し、状態遷移を行わない
  - 成功時は `BatchExecutionStateMachine` を `StartExecution` でキックし、実行 ARN を応答に含める
  - ステートマシン起動後に META が `PROCESSING` で `startedAt` を持つことを統合テストで確認する
  - _Requirements: 3.1, 3.2, 3.4, 10.5_
  - _Depends: 2.2, 4.1_

- [x] 2.6 (P) `GET /batches` と `GET /batches/:batchJobId` ルートを実装する
  - 一覧は GSI1 を用い `status` + `yyyymm` フィルタとカーソルページングを提供する
  - 詳細は `BatchStore.getBatchWithFiles` 結果から META と集計値 (`totals`) を整形して返す
  - 存在しない `batchJobId` は `404` を返す
  - 応答に `status`・`totals`・`createdAt`・`startedAt`・`updatedAt`・`parentBatchJobId` が含まれることを統合テストで確認する
  - _Requirements: 5.2, 9.2_
  - _Boundary: ApiFunction (read)_
  - _Depends: 2.2_

- [x] 2.7 (P) ファイル一覧・`process_log` 取得ルートを実装する
  - `GET /batches/:batchJobId/files` は FILE アイテムをページングで返し、完了ファイルには `BatchPresign` で `output/*.json` と `visualizations/*` の署名付き URL を付与する
  - `GET /batches/:batchJobId/process-log` は `PENDING`/`PROCESSING` では `409`、存在しない場合は `404`、終端状態のみ `logs/process_log.jsonl` の署名付き URL を返す
  - 再解析親子（`parentBatchJobId`）がある場合は子側の最新成功結果を優先する overlay ロジックを `GET /batches/:id/files` に適用する
  - 終端状態で両エンドポイントが正しい署名付き URL を返すことを統合テストで確認する
  - _Requirements: 5.3, 5.4, 6.5, 8.3_
  - _Boundary: ApiFunction (read)_
  - _Depends: 2.2, 2.3_

- [x] 2.8 (P) キャンセル・再解析ルートを実装する
  - `DELETE /batches/:batchJobId` は META `status=PENDING` を条件に `CANCELLED` へ遷移させ、それ以外は `409`、未存在は `404` を返す
  - `POST /batches/:batchJobId/reanalyze` は元バッチが終端状態であること・`process_log.jsonl` が存在することを確認し、`success=false` の FILE のみを対象とする新バッチを `BatchStore` に作成する
  - 新バッチは元の `batchJobId` を `parentBatchJobId` に記録し、GSI2 で親子参照が可能であることを確認する
  - 元バッチ不在・`process_log.jsonl` 欠損時は `404`/`409` を返す
  - 再解析成功時に子バッチが `PENDING` で登録され、親子関係が DDB に永続化されていることを統合テストで確認する
  - _Requirements: 7.5, 8.1, 8.2, 8.4_
  - _Boundary: ApiFunction (mutation)_
  - _Depends: 2.2, 2.3_

## 3. Core: Fargate バッチランナー

- [ ] 3.1 `lambda/batch-runner` コンテナと設定層を整備する
  - `lambda/processor/Dockerfile` をベースに Python 3.12 + `yomitoku-client==0.2.0` をインストールする Dockerfile を配置する
  - `settings.py` で環境変数（`BATCH_JOB_ID`、`BUCKET_NAME`、`BATCH_TABLE_NAME`、`CONTROL_TABLE_NAME`、`ENDPOINT_NAME`、`MAX_FILE_CONCURRENCY`、`MAX_PAGE_CONCURRENCY`、`MAX_RETRIES`、`READ_TIMEOUT`、`CIRCUIT_THRESHOLD`、`CIRCUIT_COOLDOWN`、`BATCH_MAX_DURATION_SEC`、`EXTRA_FORMATS`）を `dataclass` 型で集約する
  - エントリポイント `main.py` を作成し、ローカルでの dry-run（モック S3 / DDB）で設定ロード成功まで到達することを観測可能な完了条件とする
  - _Requirements: 4.2, 4.5, 10.1_
  - _Boundary: BatchRunnerTask_

- [ ] 3.2 (P) S3 入出力同期層を実装する
  - `batches/{batchJobId}/input/` 配下を `/tmp/input/` にダウンロードする同期ルーチンを実装する
  - ローカル `output_dir` を `batches/{batchJobId}/{output,results,visualizations,logs}/` 配下に分類アップロードするルーチンを実装する
  - `HeadObject` を用いて DDB の FILE 期待集合と S3 実在集合を照合し、欠損があれば即 `FAILED` で終了する
  - ユニットテストで期待集合照合の失敗パスが早期終了することを確認する
  - _Requirements: 3.2, 4.1, 6.1, 6.2, 6.3_
  - _Boundary: BatchRunnerTask (s3_sync)_
  - _Depends: 3.1_

- [ ] 3.3 `analyze_batch_async` 実行と設定注入を実装する
  - `YomitokuClient` を `CircuitConfig(threshold, cooldown_time)` と `RequestConfig(read_timeout, connect_timeout, max_retries)` 付きでインスタンス化する
  - `analyze_batch_async(input_dir, output_dir, max_file_concurrency, max_page_concurrency, extra_formats)` を呼び出し、`process_log.jsonl` が `output_dir` 直下に生成されることを確認する
  - ページ単位可視化生成は `parse_pydantic_model(result)` → `DocumentResult.visualize(img, mode)` を layout/ocr 双方で呼び出し、失敗は FILE エラーへ付記しバッチ継続する
  - 実行開始前後に CloudWatch Logs へ `batchJobId`、ファイル数、経過時間、サーキット発動回数を構造化ログとして出力する
  - 小規模 PoC（3 PDF）で `output/*.json`・`visualizations/*.jpg`・`results/*.{md,csv,html,pdf}`・`logs/process_log.jsonl` が生成されることを観測可能な完了条件とする
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 6.1, 6.2, 6.3, 6.4, 11.3_
  - _Depends: 3.1_

- [ ] 3.4 `process_log.jsonl` → DDB 反映と最終集計を実装する
  - `process_log.jsonl` を 1 行ずつ読み込み、`BatchStore.updateFileResult` 相当の条件付き更新で FILE アイテムへ反映する
  - 成功／失敗件数を集計し、全件成功 → `COMPLETED`、混在 → `PARTIAL`、全件失敗またはインフラ中断 → `FAILED` に META を遷移させる
  - 遷移は `transitionBatchStatus` で `expectedCurrent=PROCESSING` の条件付き更新を行う
  - 集計後に `totals` と `updatedAt` が DDB META に反映されていることを統合テストで確認する
  - _Requirements: 5.1, 5.2, 7.2, 7.3, 7.4_
  - _Depends: 3.3_

- [ ] 3.5 `ControlTable` バッチ heartbeat と終了シグナルを実装する
  - 実行開始時に `ControlTable` の `lock_key=BATCH_IN_FLIGHT#{batchJobId}` に `expiresAt=now+max_duration` を書き込む
  - 進捗の節目で heartbeat を更新し、タスク終了時に heartbeat アイテムを削除する
  - `concurrentBatchCount` を GSI や Scan ではなく `ControlTable` の既定キー（例: `ACTIVE#COUNT`）で一貫して管理し、`EndpointControl` が参照可能にする
  - タスク終了時に heartbeat アイテムが存在しないことを統合テストで確認する
  - _Requirements: 10.1_
  - _Depends: 3.1_

## 4. Core: オーケストレーションとエンドポイント制御

- [ ] 4.1 `BatchExecutionStack` と Fargate タスク定義を構築する
  - 新しい ECS クラスタ（既存 VPC 継承 or 新規デフォルト VPC）と Fargate タスク定義（4 vCPU / 16 GB、ログドライバ awslogs）を作成する
  - タスクロールに `BatchTable` と `ControlTable` の必要 Action、`batches/*` 配下の S3 put/get、`sagemaker:InvokeEndpoint`/`DescribeEndpoint` を付与する
  - 環境変数を `BatchTable` 名・`ControlTable` 名・`BUCKET_NAME`・`ENDPOINT_NAME` で配線する
  - `cdk synth` で Fargate タスク定義と ECS クラスタが生成されることを観測可能な完了条件とする
  - _Requirements: 4.1, 4.5, 10.1, 10.5_

- [ ] 4.2 `BatchExecutionStateMachine` を実装する
  - ステート: `AcquireBatchLock` → `EnsureEndpointInService`（未起動なら `CreateEndpoint` or `WaitEndpoint` ループ）→ `RunBatchTask`（`ecs:runTask.sync`、`TimeoutSeconds=BATCH_MAX_DURATION_SEC`）→ `AggregateResults` → 終端 → `ReleaseBatchLock`
  - `Catch: States.Timeout` または `States.TaskFailed` 時は `MarkFailed` で META を `FAILED` に遷移させ、`ecs:stopTask` を呼ぶ
  - 終端状態は META に永続化済みの `totals` を読み直して `COMPLETED`/`PARTIAL`/`FAILED` の最終フラグを検証する
  - `StartExecution(batchJobId)` → タイムアウト経路 → META が `FAILED` になることを統合テストで確認する
  - _Requirements: 3.3, 7.2, 7.3, 7.4, 10.4_
  - _Depends: 4.1, 3.4_

- [ ] 4.3 `EndpointControl` を `BatchTable` / `ControlTable` heartbeat ベースに差し替える
  - `lambda/endpoint-control/index.py` の `check_queue_status`（SQS 深度）を `ControlTable` の `BATCH_IN_FLIGHT#*` 件数チェックに置換する
  - アイドル判定（`concurrentBatchCount == 0` が一定時間継続）後に `DeleteEndpoint` へ進むロジックを維持する
  - 既存 `EndpointLifecycleStateMachine` のステート定義を新信号源に整合させる
  - 旧 `MainQueue` 参照がコード・IAM・CDK から消滅することを観測可能な完了条件とする
  - _Requirements: 10.1, 10.2_
  - _Depends: 3.5_

## 5. Core: 可観測性とリテンション

- [ ] 5.1 バッチ向け CloudWatch メトリクスとアラームを整備する
  - `MonitoringStack` を更新し `YomiToku/Batch` namespace の `BatchInFlight`・`FilesSucceededTotal`・`FilesFailedTotal`・`PagesProcessedTotal`・`CircuitBreakerOpened`・`BatchDurationSeconds` を発行する
  - `BatchRunnerTask` から EMF 形式もしくは `PutMetricData` で上記メトリクスを出力する
  - `FilesFailedTotal > threshold` と `BatchDurationSeconds > BATCH_MAX_DURATION_SEC` のアラームを SNS Topic に配線する
  - 旧単一ジョブ前提のメトリクスとアラームを CDK から削除する
  - `cdk synth` で新メトリクス／アラームのみが存在することを観測可能な完了条件とする
  - _Requirements: 10.3, 11.1, 11.3, 11.4_
  - _Depends: 1.1, 3.4_

## 6. Integration: ルーティング・ドキュメント・カットオーバー

- [ ] 6.1 旧 `/jobs` ルートと関連コードを削除する
  - `lambda/api/routes/jobs.ts`・`jobs.routes.ts`・関連テストを削除する
  - `lambda/api/index.ts` から `/jobs` ルート登録と旧 OpenAPI meta を削除し、`/batches` ルーターと Batch API 用 OpenAPI meta を登録する
  - `lambda/api/lib/validate.ts` の `parseFilepath`／`validateBasePath` 等、単一 `filepath` 前提の検証関数を削除する
  - `/jobs` 系 URL にアクセスしたとき `404` が返ることを統合テストで確認する
  - _Requirements: 1.1, 1.5, 12.1, 12.2_
  - _Depends: 2.4, 2.5, 2.6, 2.7, 2.8_

- [ ] 6.2 API Lambda の IAM 権限・環境変数をバッチ用に再スコープする
  - `ApiStack` の grants を `batches/*` プレフィックスに限定し、旧 `input/*`/`output/*`/`visualizations/*` grants を削除する
  - `BatchTable` の必要 Action（`PutItem`、`UpdateItem`、`Query` on GSI1/GSI2、`TransactWriteItems`）を付与する
  - `BatchExecutionStateMachine` ARN を Lambda 環境変数に渡し、`StartExecution` 権限を付与する
  - CDK Nag 抑制対象の識別子を新リソース向けに更新する
  - `cdk synth` で旧 grants が存在しないことを観測可能な完了条件とする
  - _Requirements: 1.3, 1.4, 10.5_
  - _Depends: 6.1, 1.2, 4.2_

- [ ] 6.3 OpenAPI / README / 設計資料をバッチ API 基準に刷新する
  - `/doc`・`/ui` のメタデータから旧 `/jobs` 定義を除去し、`/batches` 系エンドポイントのパラメータ・応答・エラーコードを正準定義とする
  - `README.md` のセットアップ・利用例・運用フローを `/batches` 系に書き換える
  - `API実装検討.md` など旧 API 記述を含む設計ドキュメントを更新または archive 化する
  - `scripts/` 配下の旧 API 連携スクリプトを削除または新 API 用に書き換える
  - `npm run lint:legacy` がゼロ終了することを観測可能な完了条件とする
  - _Requirements: 12.1, 12.2, 12.3_
  - _Depends: 1.3, 6.1_

- [ ] 6.4 `StatusTable` カットオーバー削除手順を IaC に反映する
  - `StatusTable` の `removalPolicy` を一時的に `DESTROY` へ変更する CDK 差分、またはデプロイ直前に手動で `aws dynamodb delete-table` を実行する Runbook を `docs/runbooks/` に整備する
  - カットオーバー手順（1. 事前通知、2. `scripts/check-legacy-refs.sh`、3. `cdk deploy --all`、4. 旧 DDB 確認、5. ロールバック制約の確認）を明文化する
  - Runbook を手動実行した staging 環境で旧 `StatusTable` が消滅することを観測可能な完了条件とする
  - _Requirements: 1.2, 9.3, 9.5_
  - _Depends: 1.1_

## 7. Validation: 統合・E2E 検証

- [ ] 7.1 バッチ作成 → 実行 → `COMPLETED` のハッピーパス E2E テスト
  - staging 環境で 3–5 PDF をアップロードし、`POST /batches` → `POST /start` → `GET /batches/:id` がステップごとに期待状態へ遷移することを検証する
  - `GET /batches/:id/files` から署名付き URL 経由で結果 JSON・可視化画像を取得できることを検証する
  - `GET /batches/:id/process-log` で `process_log.jsonl` を取得し、各行がライブラリ仕様（`timestamp`、`file_path`、`output_path`、`dpi`、`executed`、`success`、`error`）に適合することを確認する
  - _Requirements: 2.1, 3.1, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 7.2_
  - _Depends: 6.2_

- [ ] 7.2 `PARTIAL` と `FAILED` 遷移の E2E テスト
  - 故意に壊した PDF を含むバッチで `PARTIAL` に遷移し、`totals.succeeded`/`totals.failed` が正しいことを検証する
  - SageMaker エンドポイント未起動で `POST /batches` が `503` を返し、`POST /up` 連携後に作成できることを検証する
  - `BATCH_MAX_DURATION_SEC` を低値に設定した staging 実行で `States.Timeout` → `FAILED` へ遷移することを検証する
  - `ecs:stopTask` が呼ばれタスクが停止していることを CloudWatch Logs で確認する
  - _Requirements: 2.4, 3.3, 4.4, 7.3, 7.4, 10.4_
  - _Depends: 7.1_

- [ ] 7.3 キャンセル・再解析・親子参照の統合テスト
  - `PENDING` 状態で `DELETE /batches/:id` を呼び出し `CANCELLED` 遷移を検証する
  - `PROCESSING` 中の `DELETE` が `409` を返すことを検証する
  - 失敗を含むバッチに対し `POST /reanalyze` を実行し、失敗ファイルのみの子バッチが作成されること・GSI2 から親子参照が可能なことを検証する
  - `GET /batches/:id/files` が再解析の最新成功結果を優先する overlay ロジックに従うことを検証する
  - _Requirements: 7.5, 8.1, 8.2, 8.3, 8.4_
  - _Depends: 6.2_

- [ ] 7.4 レガシー遮断と CI guard の回帰検証
  - `/jobs` 系 URL への GET/POST が `404` を返すことを検証する
  - `scripts/check-legacy-refs.sh` に意図的な禁止語を混入させた差分で CI が失敗することを確認し、差分戻し後にグリーンへ復帰することを確認する
  - `cdk diff` を staging / production 双方の stage で実行し、旧 `StatusTable`/`MainQueue`/`ProcessorFunction` が残存していないことを確認する
  - _Requirements: 1.1, 1.5, 12.4_
  - _Depends: 6.3, 6.4_

- [ ]* 7.5 スループットとサーキットブレーカの性能観測
  - `ml.g5.xlarge` エンドポイントで 20 PDF（平均 5 ページ/PDF）を処理し、`PagesProcessedTotal`・`BatchDurationSeconds` から 100 ページ／時間の下限目標を観測する
  - SageMaker エンドポイントの連続エラーを fault injection で誘発し、`CircuitBreakerOpened` メトリクスが増加することを確認する
  - 本タスクは性能 SLA の追認で、MVP 後に回せる補助検証であり、要件 11.1 の受入れ条件を満たす性能計測を追補する
  - _Requirements: 11.1_
  - _Depends: 7.1_
