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

describe("MonitoringStack (legacy alarms removed)", () => {
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
  });

  // --- 旧アラームが存在しないこと（batch 向けは task 5.1 で再追加） ---
  describe("Legacy alarms removed", () => {
    it("CloudWatch Alarm が存在しない", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
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
