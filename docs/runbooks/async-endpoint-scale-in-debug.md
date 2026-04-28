# Runbook: Async Endpoint scale-in 進捗停滞切り分け

## 目的

`async-endpoint-scale-in-protection` 仕様で追加した
`Yomitoku/AsyncEndpoint::InflightInvocations` メトリクスを使い、OCR バッチの進捗が止まったように見えるときに、SageMaker Async Endpoint の scale-in、キュー滞留、batch-runner 異常終了のどれが原因かを切り分ける。

本 Runbook は、処理中ジョブが残る間の早期 scale-in 抑止が正しく効いているかを確認するための手順である。Realtime から Async へのカットオーバー手順は [`sagemaker-async-cutover.md`](./sagemaker-async-cutover.md) を参照する。

## 適用範囲

- 対象アカウント: staging / production
- 対象リージョン: `ap-northeast-1`
- 対象 Endpoint: `yomitoku-pro-endpoint`
- 対象メトリクス:
  - `Yomitoku/AsyncEndpoint` / `InflightInvocations` / `EndpointName`
  - `AWS/SageMaker` / `ApproximateBacklogSize` / `EndpointName`
  - `AWS/SageMaker` / `ApproximateAgeOfOldestRequest` / `EndpointName`
  - `AWS/SageMaker` / `HasBacklogWithoutCapacity` / `EndpointName`
- 対象外:
  - `asyncMaxCapacity > 1` に引き上げた後の per-instance scale-in 保護再設計
  - CloudWatch メトリクスの取り込み遅延そのものの解消
  - 既に開始済みの Application Auto Scaling scale-in action の取り消し
  - API 側の進捗表示フォールバック改善

## 事前条件

- [ ] `aws sts get-caller-identity` で対象アカウントを確認済み
- [ ] `AWS_REGION=ap-northeast-1` を設定済み
- [ ] `ENDPOINT_NAME=yomitoku-pro-endpoint` を設定済み
- [ ] 対象バッチ ID と、Step Functions execution ARN または ECS task ARN を把握済み
- [ ] CloudWatch Metrics / Alarms、ECS Tasks、Application Auto Scaling activities を閲覧できる IAM 権限がある

```bash
export AWS_REGION=ap-northeast-1
export ENDPOINT_NAME=yomitoku-pro-endpoint
```

## 切り分け手順

### Step 1 — CloudWatch コンソールで in-flight 数を確認する

CloudWatch コンソールで以下を開く。

1. Metrics → All metrics → Custom namespaces → `Yomitoku/AsyncEndpoint`
2. Dimension `EndpointName` を選択
3. `InflightInvocations` を選択
4. Statistic を `Sum`、Period を `1 minute` に設定
5. 対象バッチの投入時刻から現在までを表示

判定:

- `InflightInvocations > 0` が継続している: batch-runner は未通知の Async invoke を保持している。scale-in 抑止の入力は publish されているため、Step 2 で Endpoint capacity と backlog を確認する。
- `InflightInvocations = 0` かつ backlog も 0: Endpoint 側の作業は残っていない可能性が高い。DynamoDB の batch status / process log / API 進捗反映遅延を確認する。
- `InflightInvocations` の datapoint が存在しない: publisher 起動前、CloudWatch Logs/EMF 取り込み遅延、または batch-runner 起動失敗の可能性。Step 4 へ進む。

CLI で同じ値を確認する場合:

```bash
START=$(date -u -v-30M '+%Y-%m-%dT%H:%M:%SZ')
END=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

aws cloudwatch get-metric-statistics \
  --namespace Yomitoku/AsyncEndpoint \
  --metric-name InflightInvocations \
  --dimensions Name=EndpointName,Value="$ENDPOINT_NAME" \
  --statistics Sum \
  --period 60 \
  --start-time "$START" \
  --end-time "$END" \
  --region "$AWS_REGION" \
  --output table
```

### Step 2 — backlog / oldest age / capacity 0 を組み合わせて判定する

CloudWatch コンソールで同じ時間範囲に以下を重ねる。

- `AWS/SageMaker::ApproximateBacklogSize` (`Average`, 1 minute)
- `AWS/SageMaker::ApproximateAgeOfOldestRequest` (`Maximum`, 1 minute)
- `AWS/SageMaker::HasBacklogWithoutCapacity` (`Maximum`, 1 minute)
- `Yomitoku/AsyncEndpoint::InflightInvocations` (`Sum`, 1 minute)

判定フロー:

| 観測 | 主な疑い | 次の確認 |
| --- | --- | --- |
| `InflightInvocations > 0` かつ Endpoint instance が 0 | scale-in 抑止メトリクスが評価に間に合っていない、または既に開始済みの scale-in action | Step 3 |
| `HasBacklogWithoutCapacity >= 1` かつ `ApproximateAgeOfOldestRequest` が増加 | scale-from-zero 経路の失敗、capacity 不足、Application Auto Scaling failure | Step 3 |
| `ApproximateBacklogSize > 0` だが `HasBacklogWithoutCapacity = 0` | instance は存在するが処理が進んでいない、または SageMaker 側で処理遅延 | SageMaker endpoint logs / model container logs |
| `InflightInvocations = 0` かつ `ApproximateBacklogSize = 0` だが API 進捗が止まる | runner の finalization、DynamoDB 更新、process log 反映の問題 | batch-runner logs / BatchTable |

Endpoint の現在 capacity は以下で確認する。

```bash
aws sagemaker describe-endpoint \
  --endpoint-name "$ENDPOINT_NAME" \
  --region "$AWS_REGION" \
  --query 'ProductionVariants[].{Variant:VariantName,Desired:DesiredInstanceCount,Current:CurrentInstanceCount}' \
  --output table
```

### Step 3 — scale-in / scale-out 履歴を確認する

Application Auto Scaling の scaling activities を確認し、進捗停滞時刻の前後で scale-in が起きたかを見る。

```bash
aws application-autoscaling describe-scaling-activities \
  --service-namespace sagemaker \
  --resource-id "endpoint/${ENDPOINT_NAME}/variant/AllTraffic" \
  --scalable-dimension sagemaker:variant:DesiredInstanceCount \
  --region "$AWS_REGION" \
  --query 'ScalingActivities[0:20].{Start:StartTime,End:EndTime,Status:StatusCode,Cause:Cause,Message:StatusMessage}' \
  --output table
```

確認ポイント:

- `StatusCode=Successful` の scale-in が `InflightInvocations > 0` の評価期間より前に開始している場合、本機能の保証範囲外である。既に開始済みの scale-in action は本機能では取り消せない。
- `StatusCode=Failed` で `InsufficientCapacity` や IAM error が出ている場合、scale-from-zero 側の障害として扱う。`sagemaker-async-cutover.md` のトラブルシュートも参照する。
- `Cause` に target tracking policy が出ており、同時刻の math 入力が 0 と評価されている場合、CloudWatch metric ingestion / missing data のタイミングを疑う。

### Step 4 — batch-runner 異常終了と最後の publish 値を突き合わせる

batch-runner が OOM / SIGKILL / ECS task stop で終了した場合、`InflightInvocations` の最後の publish 値は CloudWatch period 内に残る。これは過去値の恒久固定ではなく、period 経過後は target tracking 上で欠損または 0 扱いになる。

直近値を確認する。

```bash
aws cloudwatch get-metric-statistics \
  --namespace Yomitoku/AsyncEndpoint \
  --metric-name InflightInvocations \
  --dimensions Name=EndpointName,Value="$ENDPOINT_NAME" \
  --statistics Sum \
  --period 60 \
  --start-time "$START" \
  --end-time "$END" \
  --region "$AWS_REGION" \
  --query 'Datapoints | sort_by(@, &Timestamp)[-5:]' \
  --output table
```

ECS task の終了理由を確認する。`CLUSTER_NAME` は `BatchExecutionStack` の ECS Cluster 名に置き換える。

```bash
export CLUSTER_NAME=<ecs-cluster-name>

aws ecs list-tasks \
  --cluster "$CLUSTER_NAME" \
  --desired-status STOPPED \
  --region "$AWS_REGION" \
  --query 'taskArns[0:10]' \
  --output text

aws ecs describe-tasks \
  --cluster "$CLUSTER_NAME" \
  --tasks <task-arn> \
  --region "$AWS_REGION" \
  --query 'tasks[].{LastStatus:lastStatus,StopCode:stopCode,StoppedReason:stoppedReason,Containers:containers[].{Name:name,ExitCode:exitCode,Reason:reason}}' \
  --output table
```

判定:

- `StoppedReason` / container `Reason` に OOM、`SIGKILL`、essential container exit がある: runner 異常終了として扱う。最後の `InflightInvocations` が 1 period 程度残るのは想定範囲。
- ECS task が RUNNING だが `InflightInvocations` が更新されない: publisher thread の異常、stdout/CloudWatch Logs 経路、または EMF 取り込み失敗を疑う。
- ECS task が STOPPED で、最後の publish から 2 period 以上経過しても `InflightInvocations` が非 0 として評価される: CloudWatch 側の表示範囲/統計設定を再確認し、`Sum` + `Period=60` で取り直す。

### Step 5 — CloudWatch Logs で publisher の出力を確認する

batch-runner の log group から EMF JSON と publisher error を確認する。

```bash
aws logs filter-log-events \
  --log-group-name <batch-runner-log-group-name> \
  --filter-pattern '"InflightInvocations"' \
  --region "$AWS_REGION" \
  --max-items 20

aws logs filter-log-events \
  --log-group-name <batch-runner-log-group-name> \
  --filter-pattern '"inflight_publisher"' \
  --region "$AWS_REGION" \
  --max-items 20
```

`inflight_publisher: start failed (non-fatal)` または publish 失敗ログがある場合でも、OCR 本体は observability-only として継続する設計である。進捗停止の主因が publisher そのものとは限らないため、Step 2 / Step 3 の endpoint 側メトリクスと合わせて判断する。

## 保証境界

本機能が保証するのは、batch-runner が publish した in-flight 値が CloudWatch の target tracking 評価期間に反映された後、その評価に基づく scale-in 判定で instance 数 0 への早期縮退を抑止することだけである。

保証範囲外:

- publisher 起動前の scale-in 判定
- CloudWatch Logs / EMF / Metrics の取り込み遅延中の判定
- 既に開始済みの Application Auto Scaling scale-in action
- batch-runner プロセスが OOM / SIGKILL で終了した後の未完了 invoke の復旧
- `asyncMaxCapacity > 1` へ引き上げた構成での per-instance utilization としての正しさ
- API 進捗表示、DynamoDB finalization、process log 書き込みの不具合

`asyncMaxCapacity > 1` の警告が synth 時に出ている場合は、本 Runbook で運用回避せず、`.kiro/specs/async-endpoint-scale-in-protection/` の design / tasks を再評価して scale-in 保護ロジックを再設計する。

## エスカレーション基準

以下のいずれかに該当する場合は、障害対応としてエスカレーションする。

- `InflightInvocations > 0` が CloudWatch に反映済みなのに、その後の target tracking scale-in で instance が 0 になる
- `HasBacklogWithoutCapacity >= 1` が 5 分以上継続し、scale-out activity が失敗している
- `ApproximateAgeOfOldestRequest` が 30 分以上増加し続ける
- ECS task が RUNNING のまま publisher datapoint が 2 period 以上欠損する
- 同じ EndpointName で複数 batch-runner が並走しており、`InflightInvocations` の `Sum` が実 task 数と明らかに一致しない

## 補足

- `InflightInvocations` は task 識別 dimension を持たない。複数 task の値は `EndpointName` dimension の `Sum` で合算する。
- 単一 batch-runner は同一 CloudWatch period 内に 2 回以上 publish しない設計で、Sum 集約による二重計上を避ける。
- shutdown 時の 0 publish は「過去 datapoint の上書き」ではなく、現在値 0 の新規 datapoint である。
- CloudWatch コンソールで period や statistic を変えると見え方が変わる。切り分け時は `Period=60`、`InflightInvocations=Sum` を基準にする。

## 参照

- [`sagemaker-async-cutover.md`](./sagemaker-async-cutover.md) — Async Endpoint カットオーバーと scale-from-zero 障害の基本手順
- `.kiro/specs/async-endpoint-scale-in-protection/requirements.md`
- `.kiro/specs/async-endpoint-scale-in-protection/design.md`
- `.kiro/specs/async-endpoint-scale-in-protection/tasks.md`
