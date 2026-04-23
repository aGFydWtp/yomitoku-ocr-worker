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
  /**
   * Async Endpoint 名。Task 6.x で
   * `HasBacklogWithoutCapacity` / `ApproximateAgeOfOldestRequest`
   * アラームの `Dimension.EndpointName` として参照する。
   * Task 1.1 時点では配管のみ用意し optional で受ける。
   */
  readonly endpointName?: string;
}

const METRIC_NAMESPACE = "YomiToku/Batch";
const DEFAULT_FILES_FAILED_THRESHOLD = 10;
const DEFAULT_BATCH_MAX_DURATION_SEC = BATCH_TASK_TIMEOUT_SECONDS;

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

    new CfnOutput(this, "AlarmTopicArn", {
      value: this.alarmTopic.topicArn,
      description: "SNS topic ARN for alarm notifications",
    });
  }
}
