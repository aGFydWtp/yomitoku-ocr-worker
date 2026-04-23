import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Alias } from "aws-cdk-lib/aws-kms";
import { Topic } from "aws-cdk-lib/aws-sns";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";
// M6: BatchExecutionStack の RunBatchTask 側タイムアウトと常に一致させるため
// 定数を一箇所 (batch-execution-stack) に正とする。
import { BATCH_TASK_TIMEOUT_SECONDS } from "./batch-execution-stack";

/**
 * MonitoringStack: バッチ運用アラーム通知用の SNS トピックと CloudWatch
 * アラームを提供する。
 *
 * バッチ観測メトリクス (BatchRunnerTask が EMF/PutMetricData で発行):
 *   - `FilesFailedTotal >= FILES_FAILED_THRESHOLD` (5 分 Sum)
 *   - `BatchDurationSeconds > BATCH_MAX_DURATION_SEC` (5 分 Max)
 *
 * SageMaker Async Endpoint 観測 (Task 6.1 / 6.2, `endpointName` 指定時のみ):
 *   - `HasBacklogWithoutCapacity >= 1` (5 分連続) — キューにリクエストがあるのに
 *     キャパが 0 なら自動スケールが詰まっている可能性あり
 *   - `ApproximateAgeOfOldestRequest > 1800` (1 datapoint) — キュー滞留が 30 分
 *     を超えたら SLA 危険域
 */
export interface MonitoringStackProps extends StackProps {
  /** `FilesFailedTotal` アラームの閾値 (既定: 10 件/5 分)。 */
  readonly filesFailedThreshold?: number;
  /** `BatchDurationSeconds` アラームの閾値 (秒, 既定: 7200)。 */
  readonly batchMaxDurationSec?: number;
  /**
   * Async Endpoint 名。`HasBacklogWithoutCapacity` /
   * `ApproximateAgeOfOldestRequest` アラームの `Dimension.EndpointName`
   * として参照する。未指定時は両アラームをスキップする。
   */
  readonly endpointName?: string;
}

const METRIC_NAMESPACE = "YomiToku/Batch";
const SAGEMAKER_NAMESPACE = "AWS/SageMaker";
const DEFAULT_FILES_FAILED_THRESHOLD = 10;
const DEFAULT_BATCH_MAX_DURATION_SEC = BATCH_TASK_TIMEOUT_SECONDS;
const OLDEST_REQUEST_AGE_THRESHOLD_SEC = 1800;

export class MonitoringStack extends Stack {
  public readonly alarmTopic: Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps = {}) {
    super(scope, id, props);

    // M3: SNS トピックを AWS 管理 KMS キー (alias/aws/sns) で保管時暗号化する。
    // 監視通知のペイロードにはバッチ ID や失敗件数が含まれるため、
    // CloudWatch Alarm → SNS 経路で保管時暗号化を行い最小限の機密保護を確保する。
    this.alarmTopic = new Topic(this, "AlarmTopic", {
      displayName: "YomiToku OCR Worker Alarms",
      masterKey: Alias.fromAliasName(
        this,
        "AlarmTopicKmsAlias",
        "alias/aws/sns",
      ),
    });

    NagSuppressions.addResourceSuppressions(this.alarmTopic, [
      {
        id: "AwsSolutions-SNS3",
        reason:
          "SNS topic does not require SSL enforcement for alarm notifications. " +
          "Subscriptions will be added manually via AWS Console after deployment.",
      },
    ]);

    const snsAction = new SnsAction(this.alarmTopic);
    const filesFailedThreshold =
      props.filesFailedThreshold ?? DEFAULT_FILES_FAILED_THRESHOLD;
    const batchMaxDurationSec =
      props.batchMaxDurationSec ?? DEFAULT_BATCH_MAX_DURATION_SEC;

    // --- Alarm: FilesFailedTotal (5 分 Sum >= threshold) ---
    const filesFailedMetric = new Metric({
      namespace: METRIC_NAMESPACE,
      metricName: "FilesFailedTotal",
      statistic: "Sum",
      period: Duration.minutes(5),
    });

    const filesFailedAlarm = new Alarm(this, "FilesFailedAlarm", {
      metric: filesFailedMetric,
      threshold: filesFailedThreshold,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "FilesFailedTotal が閾値を超えた: BatchRunner の失敗率を確認",
    });
    filesFailedAlarm.addAlarmAction(snsAction);

    // --- Alarm: BatchDurationSeconds (5 分 Max > BATCH_MAX_DURATION_SEC) ---
    const batchDurationMetric = new Metric({
      namespace: METRIC_NAMESPACE,
      metricName: "BatchDurationSeconds",
      statistic: "Maximum",
      period: Duration.minutes(5),
    });

    const batchDurationAlarm = new Alarm(this, "BatchDurationAlarm", {
      metric: batchDurationMetric,
      threshold: batchMaxDurationSec,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "BatchDurationSeconds が BATCH_MAX_DURATION_SEC を超えた: タイムアウト／ハング疑い",
    });
    batchDurationAlarm.addAlarmAction(snsAction);

    // --- Async Endpoint 用アラーム (Task 6.1 / 6.2) ---
    // endpointName 未指定時はスキップ: Sagemaker スタック未デプロイ環境
    // (PR 検証用の部分 synth など) で本スタック単独ビルドを許容するため。
    if (props.endpointName) {
      const endpointDimensions = { EndpointName: props.endpointName };

      // HasBacklogWithoutCapacity: キューに pending があるのに instance=0
      // の状態を 5 分連続検知 (1 分 × 5 period)。短い瞬間的なゼロ化は
      // スケールアウト中の正常動作なので除外する。
      const backlogMetric = new Metric({
        namespace: SAGEMAKER_NAMESPACE,
        metricName: "HasBacklogWithoutCapacity",
        statistic: "Maximum",
        period: Duration.minutes(1),
        dimensionsMap: endpointDimensions,
      });
      const backlogAlarm = new Alarm(this, "HasBacklogWithoutCapacityAlarm", {
        metric: backlogMetric,
        threshold: 1,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription:
          "HasBacklogWithoutCapacity=1 が 5 分連続: 自動スケールが詰まっている可能性",
      });
      backlogAlarm.addAlarmAction(snsAction);

      // ApproximateAgeOfOldestRequest: 最古リクエスト滞留秒。1800s (= 30 分)
      // を 1 datapoint で発報し、早期に SLA 侵食を検知する。
      const oldestAgeMetric = new Metric({
        namespace: SAGEMAKER_NAMESPACE,
        metricName: "ApproximateAgeOfOldestRequest",
        statistic: "Maximum",
        period: Duration.minutes(1),
        dimensionsMap: endpointDimensions,
      });
      const oldestAgeAlarm = new Alarm(
        this,
        "ApproximateAgeOfOldestRequestAlarm",
        {
          metric: oldestAgeMetric,
          threshold: OLDEST_REQUEST_AGE_THRESHOLD_SEC,
          evaluationPeriods: 1,
          comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: TreatMissingData.NOT_BREACHING,
          alarmDescription:
            "ApproximateAgeOfOldestRequest > 1800s: キュー滞留が 30 分を超過",
        },
      );
      oldestAgeAlarm.addAlarmAction(snsAction);
    }

    new CfnOutput(this, "AlarmTopicArn", {
      value: this.alarmTopic.topicArn,
      description: "SNS topic ARN for alarm notifications",
    });
  }
}
