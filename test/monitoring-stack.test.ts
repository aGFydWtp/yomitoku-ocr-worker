import { Match, Template } from "aws-cdk-lib/assertions";
import { DockerImageCode, DockerImageFunction } from "aws-cdk-lib/aws-lambda";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { App, Duration, Stack } from "aws-cdk-lib/core";
import { MonitoringStack } from "../lib/monitoring-stack";

const TEST_REGION = "ap-northeast-1";
const TEST_ACCOUNT = "123456789012";

function createStack(): {
  app: App;
  stack: MonitoringStack;
  template: Template;
} {
  const app = new App();

  // 依存リソースのダミースタック
  const depStack = new Stack(app, "DepStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
  });

  const deadLetterQueue = new Queue(depStack, "DeadLetterQueue", {
    retentionPeriod: Duration.days(14),
  });

  const mainQueue = new Queue(depStack, "MainQueue", {
    visibilityTimeout: Duration.seconds(3600),
    deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 },
  });

  const processorFunction = new DockerImageFunction(
    depStack,
    "ProcessorFunction",
    {
      code: DockerImageCode.fromImageAsset("lambda/processor"),
      timeout: Duration.minutes(10),
    },
  );

  const stack = new MonitoringStack(app, "TestMonitoringStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
    mainQueue,
    deadLetterQueue,
    processorFunction,
  });

  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("MonitoringStack", () => {
  // --- SNS トピック ---
  describe("SNS Topic", () => {
    it("SNS トピックが 1 つ存在する", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::SNS::Topic", 1);
    });
  });

  // --- CloudWatch Alarms ---
  describe("CloudWatch Alarms", () => {
    it("アラームが 5 つ存在する", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::CloudWatch::Alarm", 5);
    });

    it("SQS ApproximateAgeOfOldestMessage アラーム（閾値 1800 秒）", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "ApproximateAgeOfOldestMessage",
        Namespace: "AWS/SQS",
        Threshold: 1800,
        ComparisonOperator: "GreaterThanThreshold",
        EvaluationPeriods: 1,
        Statistic: "Maximum",
      });
    });

    it("SQS ApproximateNumberOfMessagesVisible アラーム（閾値 100）", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "ApproximateNumberOfMessagesVisible",
        Namespace: "AWS/SQS",
        Threshold: 100,
        ComparisonOperator: "GreaterThanThreshold",
        EvaluationPeriods: 1,
        Statistic: "Maximum",
      });
    });

    it("DLQ ApproximateNumberOfMessagesVisible アラーム（閾値 0）", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "ApproximateNumberOfMessagesVisible",
        Namespace: "AWS/SQS",
        Threshold: 0,
        ComparisonOperator: "GreaterThanThreshold",
        EvaluationPeriods: 1,
        Statistic: "Maximum",
        TreatMissingData: "notBreaching",
      });
    });

    it("Lambda Errors アラーム（閾値 0）", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "Errors",
        Namespace: "AWS/Lambda",
        Threshold: 0,
        ComparisonOperator: "GreaterThanThreshold",
        EvaluationPeriods: 1,
        Statistic: "Sum",
        TreatMissingData: "notBreaching",
      });
    });

    it("Lambda Duration アラーム（閾値 480000 ミリ秒）", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "Duration",
        Namespace: "AWS/Lambda",
        Threshold: 480000,
        ComparisonOperator: "GreaterThanThreshold",
        EvaluationPeriods: 1,
        Statistic: "Maximum",
      });
    });

    it("全アラームに SNS アクションが設定されている", () => {
      const { template } = createStack();
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      for (const alarm of Object.values(alarms)) {
        const props = (alarm as Record<string, unknown>).Properties as Record<
          string,
          unknown
        >;
        expect(props.AlarmActions).toBeDefined();
        expect((props.AlarmActions as unknown[]).length).toBeGreaterThanOrEqual(
          1,
        );
      }
    });
  });

  // --- Stack Outputs ---
  describe("Stack Outputs", () => {
    it("AlarmTopicArn を出力する", () => {
      const { template } = createStack();
      template.hasOutput("AlarmTopicArn", { Value: Match.anyValue() });
    });
  });
});
