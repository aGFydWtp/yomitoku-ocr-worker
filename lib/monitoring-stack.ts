import { Topic } from "aws-cdk-lib/aws-sns";
import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib/core";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";

/**
 * MonitoringStack: アラーム通知用 SNS トピックを提供する。
 *
 * 旧 SQS/Lambda 向けの CloudWatch アラーム (QueueMessageAge / QueueDepth /
 * DLQ / LambdaErrors / LambdaDuration) はバッチ移行に伴い撤去済み (task 1.1)。
 * バッチ実行系 (Fargate / Step Functions / BatchTable / SageMaker Endpoint) を
 * 対象とした新しいアラームは後続 task 5.1 で追加する。
 */
export class MonitoringStack extends Stack {
  public readonly alarmTopic: Topic;

  constructor(scope: Construct, id: string, props?: StackProps) {
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

    new CfnOutput(this, "AlarmTopicArn", {
      value: this.alarmTopic.topicArn,
      description: "SNS topic ARN for alarm notifications",
    });
  }
}
