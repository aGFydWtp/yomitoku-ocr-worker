# Runbook: SageMaker Realtime → Asynchronous Inference カットオーバー手順

## 目的

`sagemaker-async-inference-migration` 仕様に従い、AWS アカウント内の YomiToku-Pro 推論基盤を既存 **Realtime Endpoint** (Endpoint lifecycle を Step Functions で動的に作成/削除する方式) から **Asynchronous Inference Endpoint** (常設 + Application Auto Scaling で 0 ↔ N にスケール) へ切り替える。

本 Runbook は CDK デプロイとマネジメントコンソール/AWS CLI 操作の混成手順で構成される。理由:

- 新 `SagemakerStack` は **AsyncInferenceConfig 付きの別名 EndpointConfig** (`*-async` サフィックス) で CfnEndpoint を所有するため、CDK デプロイだけでは旧 Endpoint / 旧 EndpointConfig は削除されない (CloudFormation から見えない孤立リソース化)。
- カットオーバー中は `/batches` API が新エンドポイントを参照するため、旧 Endpoint へのトラフィックは自然に 0 に収束する。しかし **旧 EndpointConfig と旧 Endpoint 本体は明示削除** が必要。
- 要件 1.4 / 7.x / 9.1 により「旧リソースを AWS アカウントに残存させない」ことが必達。

## 適用範囲

- 対象アカウント: staging → production の順
- 対象リージョン: `ap-northeast-1` (既定)。capacity 逼迫時のみ `us-east-1` を退避用オプションとして使用
- 対象リソース
  - **削除対象**: 旧 `yomitoku-pro-endpoint` (Realtime) / 旧 `yomitoku-pro-config` EndpointConfig (`-async` サフィックスなし) / 旧 `OrchestrationStack` (CloudFormation)
  - **新設/維持**: 新 Async `CfnEndpoint` / `CfnEndpointConfig` (`*-async`) / `CfnScalableTarget` / SNS Topic×2 / SQS Queue×2
- 実施タイミング: 新 `cdk deploy SagemakerStack` が成功し smoke PoC が green になった直後
- 前提: `BatchTable` / `ControlTable` / `ProcessLog` は変更しない (`yomitoku-client-batch-migration` 仕様 owner)

## 事前条件 (Pre-flight)

- [ ] メンテナンス通知済み (production 時)
- [ ] `aws sts get-caller-identity` で対象アカウント・リージョンが正しいことを確認
- [ ] `bash scripts/check-legacy-refs.sh` が `✓ No legacy references found.` を返す
- [ ] `pnpm lint && pnpm test` グリーン
- [ ] `pnpm cdk synth --all` がエラーなく完了
- [ ] **in-flight バッチ 0 確認**: DynamoDB `BatchTable` に `status IN (RUNNING, PENDING)` のアイテムが無いこと。`GSI1PK` の物理フォーマットは `STATUS#{status}#{YYYYMM}` の月パーティション化で (`lambda/api/lib/batch-store.ts::gsi1pk()`)、単月だけ問い合わせても過去月から移行した in-flight を見逃す恐れがあるため、**META アイテムを `ScanFilter` で横断検索する**:
  ```bash
  # BatchTable 名を CloudFormation Output から動的に取得 (手動置換ミスを防ぐ)
  BATCH_TABLE=$(aws cloudformation describe-stacks --stack-name ProcessingStack \
    --region ap-northeast-1 \
    --query "Stacks[0].Outputs[?OutputKey=='BatchTableName'].OutputValue" --output text)

  aws dynamodb scan \
    --table-name "$BATCH_TABLE" \
    --filter-expression "SK = :meta AND (#st = :r OR #st = :p)" \
    --expression-attribute-names '{"#st":"status"}' \
    --expression-attribute-values '{":meta":{"S":"META"},":r":{"S":"RUNNING"},":p":{"S":"PENDING"}}' \
    --region ap-northeast-1 --select COUNT
  # ScannedCount ではなく Count=0 を期待。非 0 なら `/batches/:id/status` で完了を待つか手動 CANCEL
  ```
- [ ] **smoke PoC 成功確認**: staging の新 Async Endpoint に対し、固定テスト PDF 1 ファイル (~20 ページ) を `invoke_endpoint_async` で送信し、
  - SuccessTopic → SuccessQueue にメッセージが着信
  - `batches/_async/outputs/*.out` が S3 に出力
  - 実処理時間が 90 秒以内
  - `ApproximateBacklogSizePerInstance` が 5 分以内に 0 に戻ることを目視確認

## 7 ステップ カットオーバー手順

### Step 1 — 新 `SagemakerStack` をデプロイ (Async Endpoint 新設)

```bash
pnpm build
pnpm cdk deploy SagemakerStack -c region=ap-northeast-1 --require-approval never
```

期待される副作用:

- 新 CfnEndpoint (`yomitoku-pro-endpoint`) が `*-async` EndpointConfig で InService になる。`InitialInstanceCount=0` で起動するため、`DesiredInstanceCount=0` から scale-out されるのは実トラフィックが来たとき。
- 旧 Realtime Endpoint は **そのまま残る** (本 Step では削除しない)。旧 OrchestrationStack 由来の SFN は既に無効化済み。
- SNS SuccessTopic / ErrorTopic、SQS SuccessQueue / FailureQueue、CfnScalableTarget / CfnScalingPolicy が新設される。

検証コマンド:

```bash
aws sagemaker describe-endpoint --endpoint-name yomitoku-pro-endpoint --region ap-northeast-1 \
  --query '{Status:EndpointStatus,Config:EndpointConfigName}'
# 期待: Status=InService, Config=yomitoku-pro-config-async
```

### Step 2 — smoke PoC (新 Endpoint 単体)

Pre-flight の smoke PoC シナリオを **staging の新 Async Endpoint** で再実行する。結果が以下を満たさない場合は Step 3 以降に進まず、原因究明後に Step 1 から再試行する。

- [ ] SuccessQueue に 1 件のメッセージが長 polling で取得できる
- [ ] `s3://<BucketName>/batches/_async/outputs/` 配下に `.out` が生成
- [ ] `ApproximateAgeOfOldestRequest` が 300 秒以下で収束
- [ ] `HasBacklogWithoutCapacity` が 0 に戻る

> **ロールバック可能ポイントはここまで。Step 3 以降は非可逆。**
>
> Step 1 で新 Endpoint を作っただけで API トラフィックはまだ旧 Realtime Endpoint (EndpointControl 経由) に向いているため、この時点なら `cdk destroy SagemakerStack` で新 Endpoint を撤去するだけで状態を戻せる。Step 3 で `BatchExecutionStack` をデプロイするとバッチ runner の invoke 先が Async Endpoint に切り替わり、旧 Realtime 経路には戻せなくなる。

### Step 3 — `BatchExecutionStack` をデプロイ (runner を Async に切替)

```bash
pnpm cdk deploy BatchExecutionStack -c region=ap-northeast-1 --require-approval never
```

本 Step の副作用:

- ECS Fargate TaskDefinition に `SUCCESS_QUEUE_URL` / `FAILURE_QUEUE_URL` / `ASYNC_*_PREFIX` / `ASYNC_MAX_CONCURRENT` の環境変数が注入される。
- Task Role から Realtime API (`sagemaker:InvokeEndpoint` / `DescribeEndpoint`) 権限が消え、`sagemaker:InvokeEndpointAsync` と SQS ReceiveMessage/DeleteMessage/ChangeMessageVisibility/GetQueueAttributes のみになる。
- Step Functions BatchExecutionStateMachine から `EnsureEndpointInService` / `WaitEndpoint` / `EndpointReady?` ステップが消え、AcquireBatchLock → RunBatchTask に直結する。

### Step 4 — `MonitoringStack` をデプロイ (Async アラーム追加)

```bash
pnpm cdk deploy MonitoringStack -c region=ap-northeast-1 --require-approval never
```

新規 CloudWatch Alarm:

- `HasBacklogWithoutCapacityAlarm` (5 分連続 `>=1`): 自動スケールが詰まっていることを検知
- `ApproximateAgeOfOldestRequestAlarm` (`> 1800` 秒, 1 datapoint): キュー滞留が 30 分超過

旧 Realtime 系アラーム (`Invocations` / `ModelLatency` / `OverheadLatency`) は追加されないことを以下で確認:

```bash
aws cloudwatch describe-alarms --alarm-name-prefix MonitoringStack --region ap-northeast-1 \
  --query 'MetricAlarms[].{Name:AlarmName,Metric:MetricName}' --output table
```

### Step 5 — `ApiStack` をデプロイ (API Lambda を orchestration 非依存に)

```bash
pnpm cdk deploy ApiStack -c region=ap-northeast-1 --require-approval never
```

本 Step の副作用:

- API Lambda の環境変数から `STATE_MACHINE_ARN` (EndpointControl 由来) が消え、`BATCH_EXECUTION_STATE_MACHINE_ARN` のみになる。
- `POST /batches` が `endpoint_state` ゲートに関係なく常に 201 を返すようになる (503 返却経路は撤去済み)。
- `POST /up` / `GET /status` の旧 API は既に撤去済みであることを最終確認。

### Step 6 — 旧 Realtime Endpoint を削除

ここが **ロールバック不能ポイント**。実施前に Step 1〜5 の全アラームが緑 / API レイテンシ / エラーレートに異常が無いことを 30 分以上観察する。

```bash
# 1) 旧 Endpoint を参照する in-flight バッチが 0 であることを再確認
#    (Pre-flight と同じ scan を再実行。GSI1PK は月パーティション化されており
#     単月 query では過去月の RUNNING を見逃すため scan を用いる)
BATCH_TABLE=$(aws cloudformation describe-stacks --stack-name ProcessingStack \
  --region ap-northeast-1 \
  --query "Stacks[0].Outputs[?OutputKey=='BatchTableName'].OutputValue" --output text)

aws dynamodb scan \
  --table-name "$BATCH_TABLE" \
  --filter-expression "SK = :meta AND (#st = :r OR #st = :p)" \
  --expression-attribute-names '{"#st":"status"}' \
  --expression-attribute-values '{":meta":{"S":"META"},":r":{"S":"RUNNING"},":p":{"S":"PENDING"}}' \
  --region ap-northeast-1 --select COUNT
# Count=0 を期待

# 2) 旧 Endpoint が新 EndpointConfig (`-async`) を参照済みであることを念押し確認
aws sagemaker describe-endpoint --endpoint-name yomitoku-pro-endpoint --region ap-northeast-1 \
  --query 'EndpointConfigName'
# 期待: "yomitoku-pro-config-async"
```

> 旧 Endpoint はすでに CfnEndpoint の更新によって新 `*-async` EndpointConfig を参照している。`aws sagemaker delete-endpoint` は **新 Endpoint そのものを消すため、本来のカットオーバーでは実行しない**。本 Runbook での「Endpoint 削除」は、`yomitoku-pro-endpoint` とは **物理名が異なる** 旧 shadow Endpoint (たとえば `yomitoku-pro-endpoint-legacy` 等) がある場合にだけ対象となる。存在しない場合は本 Step を skip してよい。

### Step 7 — 旧 EndpointConfig を削除

```bash
# 旧 Realtime 用 EndpointConfig (名前に `-async` が付かないもの) をリスト
aws sagemaker list-endpoint-configs --region ap-northeast-1 \
  --query 'EndpointConfigs[?!contains(EndpointConfigName, `-async`)].EndpointConfigName'

# 上記でリストされた 1 件 (想定: yomitoku-pro-config) を削除
aws sagemaker delete-endpoint-config \
  --endpoint-config-name yomitoku-pro-config \
  --region ap-northeast-1
```

検証:

```bash
aws sagemaker describe-endpoint-config --endpoint-config-name yomitoku-pro-config --region ap-northeast-1 2>&1 | grep -i 'ResourceNotFound'
# 期待: `ResourceNotFound: Could not find endpoint configuration "yomitoku-pro-config".`
```

## カットオーバー中の `/batches` 503 運用 (Req 7.5)

新 Async Endpoint は常設で InService のため、旧 Realtime 方式で必要だった「Endpoint IDLE/CREATING 中の 503 返却」は撤去済み。**カットオーバー中も `/batches` は 201 を返す**。ただし以下の緊急時は意図的に 503 を返す運用を行う:

- Step 3〜5 の間でバッチ runner の環境変数が旧/新で不整合なリリースが発生した
- `HasBacklogWithoutCapacityAlarm` が発報し、AutoScaling が明らかに機能していない

上記が確認された場合は CloudFront の緊急レスポンス機能で `/batches` に対して一時的に 503 を返す。手順:

1. CloudFront Distribution の Custom Error Responses から `HTTP 503` エラーページを `/batches` に対して 5 分間返却するルールを追加
2. Alarm が緑に戻り、手動で `invoke_endpoint_async` の smoke が通るまで維持
3. ルール解除後、直前の失敗バッチは `POST /batches/:id/reanalyze` で再実行

## 退避用リージョン (`us-east-1`) への切替判定基準

### 退避判定条件 (Req 8.3)

以下を **いずれか** 満たしたら退避用 `us-east-1` へ切替を検討する:

- `ap-northeast-1` で `ml.g5.xlarge` の scale-out 成功率が **1 日 95% 未満** に低下 (CloudWatch `HasBacklogWithoutCapacity=1` が 1 日累計 60 分超で観測された場合)
- 1 週間に 3 回以上 `InsufficientCapacityException` を runner ログで確認
- AWS サポートから capacity 制限の長期化アナウンスを受領

### 退避手順

1. `cdk.context.json` に `"region": "us-east-1"` を追加するか、以下で直接 deploy:
   ```bash
   pnpm cdk deploy --all -c region=us-east-1 --require-approval never
   ```
2. 退避リージョンのスタックは **全リソース (S3 / DynamoDB / Step Functions / CloudFront オリジン) が新設** される。既存 `ap-northeast-1` スタックのデータは一切移行されない
3. CloudFront ディストリビューションのオリジンを `us-east-1` の API Gateway に手動で切替。Route53 Alias / WAF も退避リージョン向けに再バインド
4. `ap-northeast-1` の capacity が回復したら逆手順で戻す (データ不整合に注意)

## 月次コスト実測記録テンプレ

| 月 | Async Endpoint (instance-hour) | S3 PUT/GET (GB) | SNS/SQS (msg) | CloudWatch Alarm | 合計 | 事前見積り | 乖離率 |
|----|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| 202X-MM | $ | $ | $ | $ | $ | $ | % |

### 事前見積り乖離 20% 超過時の是正手順

1. **Over-scale (コスト超過)**:
   - `MaxCapacity` を `asyncMaxCapacity` context で低減 (例: 4 → 2)
   - `InvocationTimeoutSeconds` を短縮し backlog の飽和を早めに失敗させる (runner 側で早期 retry)
   - 同一バッチ内のファイルを集約し、invoke 回数を削減 (client-side batching)
2. **Under-serve (レイテンシ増加)**:
   - `scaleInCooldownSeconds` を延長し、scale-in の揺り戻しを抑制
   - `maxConcurrentInvocationsPerInstance` を上げて 1 instance あたりのスループット増
   - ファイル分割を細かくし、backlog を早期にバースト消化

## トラブルシュート

### 症状 A: S3 出力が来ない

1. **原因切り分け**:
   - SuccessQueue に `NumberOfMessagesReceived` が入っているか確認 (CloudWatch)
   - runner ログで `invoke_endpoint_async` の `OutputLocation` 応答を確認
   - `batches/_async/errors/` に `.err` が出ていないか確認
2. **対応**:
   - `.err` がある: 内容 (通常は Python exception traceback JSON) を runner ログと突合し、再解析 (`POST /batches/:id/reanalyze`)
   - `.err` が無い: IAM 権限不足の可能性。SageMaker Execution Role の S3AsyncOutputPut ポリシーを確認

### 症状 B: `HasBacklogWithoutCapacity` が解消しない

1. **原因切り分け**:
   - `aws sagemaker describe-endpoint` で `EndpointStatus=InService` / `ProductionVariants[].CurrentInstanceCount`
   - `aws application-autoscaling describe-scaling-activities --service-namespace sagemaker` で scale-out の失敗原因を確認
2. **対応**:
   - `InsufficientCapacityException` → 退避 region 判定へ
   - IAM エラー → Application Auto Scaling service-linked role の有無確認
   - メトリクス欠損 → CloudWatch `AWS/SageMaker` namespace の `ApproximateBacklogSizePerInstance` がロールアップされているか

### 症状 C: scale-out が遅延する

1. **原因切り分け**:
   - `ScaleOutCooldown` (既定 60 秒) とメトリクスの datapoint 頻度 (1 分粒度) で理論上最短 ~90 秒の遅延
   - cold start (コンテナ pull + model load) で最大 +3〜5 分
2. **対応**:
   - 許容レイテンシと照合し、必要なら `MinCapacity` を 0 → 1 に引き上げる (アイドルコスト増とのトレードオフ)
   - 大ピーク前に手動で `register-scalable-target --min-capacity 2` で warm-up

## 参照

- 設計背景 (Realtime → Async 選定理由, Auto Scaling パラメータ根拠, 呼び出し契約変更): `.kiro/specs/sagemaker-async-inference-migration/design.md`
- 要件トレース: `.kiro/specs/sagemaker-async-inference-migration/requirements.md` §7, §8, §9, §11
- 関連 CDK 実装: `lib/sagemaker-stack.ts`, `lib/batch-execution-stack.ts`, `lib/monitoring-stack.ts`, `lib/region-context.ts`

## ロールバック可否サマリ

| Step | ロールバック手段 | 備考 |
|------|----------|------|
| 1. SagemakerStack deploy | `cdk destroy SagemakerStack` | 可。旧 Realtime Endpoint は残存しており影響無し |
| 2. smoke PoC | n/a (観測のみ) | 失敗時は Step 1 から再試行 |
| 3. BatchExecutionStack deploy | **不可** | runner の invoke 先が Async に切替。以降は前進のみ |
| 4. MonitoringStack deploy | 実質不可 | アラーム追加のみで可逆だが、Step 3 済のため実質前進のみ |
| 5. ApiStack deploy | 実質不可 | 同上 |
| 6. 旧 Endpoint 削除 | **不可** | 物理削除後は復旧不能 |
| 7. 旧 EndpointConfig 削除 | **不可** | 物理削除後は復旧不能 |
