import {
  Alarm,
  ComparisonOperator,
  Statistic,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { Topic } from "aws-cdk-lib/aws-sns";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";

export interface MonitoringStackProps extends StackProps {
  mainQueue: IQueue;
  deadLetterQueue: IQueue;
  processorFunction: IFunction;
}

export class MonitoringStack extends Stack {
  public readonly alarmTopic: Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const { mainQueue, deadLetterQueue, processorFunction } = props;

    // --- 5.2 SNS トピック ---
    this.alarmTopic = new Topic(this, "AlarmTopic", {
      displayName: "YomiToku OCR Worker Alarms",
    });

    const snsAction = new SnsAction(this.alarmTopic);

    // --- 5.1 CloudWatch Alarms ---

    // 5.1.1 SQS ApproximateAgeOfOldestMessage > 30分 (1800秒)
    const queueAgeAlarm = new Alarm(this, "QueueMessageAgeAlarm", {
      metric: mainQueue.metricApproximateAgeOfOldestMessage({
        statistic: Statistic.MAXIMUM,
        period: Duration.minutes(5),
      }),
      threshold: 1800,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription:
        "SQS メッセージの最大滞留時間が 30 分を超過。エンドポイント起動遅延の可能性。",
    });
    queueAgeAlarm.addAlarmAction(snsAction);

    // 5.1.2 SQS ApproximateNumberOfMessagesVisible > 100
    const queueDepthAlarm = new Alarm(this, "QueueDepthAlarm", {
      metric: mainQueue.metricApproximateNumberOfMessagesVisible({
        statistic: Statistic.MAXIMUM,
        period: Duration.minutes(5),
      }),
      threshold: 100,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription:
        "SQS キューの可視メッセージ数が 100 を超過。バースト対応の確認が必要。",
    });
    queueDepthAlarm.addAlarmAction(snsAction);

    // 5.1.3 DLQ ApproximateNumberOfMessagesVisible > 0
    const dlqAlarm = new Alarm(this, "DlqAlarm", {
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        statistic: Statistic.MAXIMUM,
        period: Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "DLQ にメッセージが到達。処理失敗の原因調査が必要。",
    });
    dlqAlarm.addAlarmAction(snsAction);

    // 5.1.4 Lambda Errors > 0
    const lambdaErrorAlarm = new Alarm(this, "LambdaErrorAlarm", {
      metric: processorFunction.metricErrors({
        statistic: Statistic.SUM,
        period: Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Lambda 処理エラーが発生。CloudWatch Logs の確認が必要。",
    });
    lambdaErrorAlarm.addAlarmAction(snsAction);

    // 5.1.5 Lambda Duration > 480秒 (タイムアウト10分の80%)
    const lambdaDurationAlarm = new Alarm(this, "LambdaDurationAlarm", {
      metric: processorFunction.metricDuration({
        statistic: Statistic.MAXIMUM,
        period: Duration.minutes(5),
      }),
      threshold: 480000,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription:
        "Lambda 処理時間が 480 秒（タイムアウトの 80%）を超過。処理時間の調査が必要。",
    });
    lambdaDurationAlarm.addAlarmAction(snsAction);

    // --- CDK Nag Suppressions ---
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

    // --- Outputs ---
    new CfnOutput(this, "AlarmTopicArn", {
      value: this.alarmTopic.topicArn,
      description: "SNS topic ARN for alarm notifications",
    });
  }
}
