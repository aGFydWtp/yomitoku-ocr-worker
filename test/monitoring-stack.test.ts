import { Match, Template } from "aws-cdk-lib/assertions";
import { App } from "aws-cdk-lib/core";
import { MonitoringStack } from "../lib/monitoring-stack";

const TEST_REGION = "ap-northeast-1";
const TEST_ACCOUNT = "123456789012";

function createStack(): {
  app: App;
  stack: MonitoringStack;
  template: Template;
} {
  const app = new App();
  const stack = new MonitoringStack(app, "TestMonitoringStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
  });
  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("MonitoringStack (batch observability, Task 5.1)", () => {
  // --- SNS トピック ---
  describe("SNS Topic", () => {
    it("SNS トピックが 1 つ存在する", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::SNS::Topic", 1);
    });

    it("alarmTopic を公開プロパティとして持つ", () => {
      const { stack } = createStack();
      expect(stack.alarmTopic).toBeDefined();
    });

    it("SNS トピックが KMS で保管時暗号化される (M3)", () => {
      const { template } = createStack();
      // Alias.fromAliasName("alias/aws/sns") は KmsMasterKeyId を
      // `Fn::Join` で "arn:<partition>:kms:<region>:<account>:alias/aws/sns" に展開する。
      template.hasResourceProperties(
        "AWS::SNS::Topic",
        Match.objectLike({
          KmsMasterKeyId: Match.objectLike({
            "Fn::Join": Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp("alias/aws/sns")]),
            ]),
          }),
        }),
      );
    });
  });

  // --- バッチ向け CloudWatch アラーム (Task 5.1) ---
  describe("Batch CloudWatch Alarms", () => {
    it("FilesFailedTotal と BatchDurationSeconds の 2 アラームを持つ", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    });

    it("FilesFailedTotal アラームが YomiToku/Batch namespace で定義されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "YomiToku/Batch",
        MetricName: "FilesFailedTotal",
        Statistic: "Sum",
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
      });
    });

    it("BatchDurationSeconds アラームが BATCH_MAX_DURATION_SEC(=7200) を閾値とする", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "YomiToku/Batch",
        MetricName: "BatchDurationSeconds",
        Threshold: 7200,
        ComparisonOperator: "GreaterThanThreshold",
      });
    });

    it("両アラームが SNS Topic にアクションを配線している", () => {
      const { template } = createStack();
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const values = Object.values(alarms);
      expect(values.length).toBe(2);
      for (const alarm of values) {
        const actions = (alarm as { Properties: { AlarmActions?: unknown[] } })
          .Properties.AlarmActions;
        expect(Array.isArray(actions)).toBe(true);
        expect((actions ?? []).length).toBeGreaterThanOrEqual(1);
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

  // --- 旧メトリクス/アラームが混在しないこと ---
  describe("Legacy metrics absent", () => {
    it("SQS / ApproximateAgeOfOldestMessage / QueueDepth などの旧メトリクス名を参照していない", () => {
      const { template } = createStack();
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const serialized = JSON.stringify(alarms);
      expect(serialized).not.toContain("ApproximateAgeOfOldestMessage");
      expect(serialized).not.toContain("ApproximateNumberOfMessagesVisible");
      expect(serialized).not.toContain("AWS/SQS");
      expect(serialized).not.toContain("AWS/Lambda");
    });
  });
});
