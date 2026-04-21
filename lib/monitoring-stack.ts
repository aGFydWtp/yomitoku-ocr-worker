import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Topic } from "aws-cdk-lib/aws-sns";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";

/**
 * MonitoringStack: バッチ運用アラーム通知用の SNS トピックと CloudWatch
 * アラームを提供する。
 *
 * Task 5.1 で `YomiToku/Batch` namespace のカスタムメトリクスを対象にした
 * 以下 2 つのアラームを追加している:
 *   - `FilesFailedTotal >= FILES_FAILED_THRESHOLD` (5 分 Sum)
 *   - `BatchDurationSeconds > BATCH_MAX_DURATION_SEC` (5 分 Max)
 *
 * メトリクス自体は BatchRunnerTask が EMF/PutMetricData で発行するため、
 * 本スタックは namespace 名とメトリクス名の整合性のみ保証する。
 */
export interface MonitoringStackProps extends StackProps {
  /** `FilesFailedTotal` アラームの閾値 (既定: 10 件/5 分)。 */
  readonly filesFailedThreshold?: number;
  /** `BatchDurationSeconds` アラームの閾値 (秒, 既定: 7200)。 */
  readonly batchMaxDurationSec?: number;
}

const METRIC_NAMESPACE = "YomiToku/Batch";
const DEFAULT_FILES_FAILED_THRESHOLD = 10;
const DEFAULT_BATCH_MAX_DURATION_SEC = 7200;

export class MonitoringStack extends Stack {
  public readonly alarmTopic: Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps = {}) {
    super(scope, id, props);

    this.alarmTopic = new Topic(this, "AlarmTopic", {
      displayName: "YomiToku OCR Worker Alarms",
    });

    NagSuppressions.addResourceSuppressions(this.alarmTopic, [
      {
        id: "AwsSolutions-SNS2",
        reason:
          "SNS topic encryption is not required for alarm notifications. " +
          "Messages contain alarm metadata only, no sensitive data.",
      },
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

    new CfnOutput(this, "AlarmTopicArn", {
      value: this.alarmTopic.topicArn,
      description: "SNS topic ARN for alarm notifications",
    });
  }
}
