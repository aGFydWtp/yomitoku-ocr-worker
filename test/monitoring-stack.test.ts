import { Match, Template } from "aws-cdk-lib/assertions";
import { App } from "aws-cdk-lib/core";
import { MonitoringStack } from "../lib/monitoring-stack";

const TEST_REGION = "ap-northeast-1";
const TEST_ACCOUNT = "123456789012";
const TEST_ENDPOINT_NAME = "yomitoku-async";

function createStack(opts: { endpointName?: string } = {}): {
  app: App;
  stack: MonitoringStack;
  template: Template;
} {
  const app = new App();
  const stack = new MonitoringStack(app, "TestMonitoringStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
    endpointName: opts.endpointName ?? TEST_ENDPOINT_NAME,
  });
  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("MonitoringStack (batch + async endpoint observability)", () => {
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

  // --- バッチ向け既存 CloudWatch アラーム ---
  describe("Batch CloudWatch Alarms (existing)", () => {
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
  });

  // --- Async Endpoint 向け新アラーム (Task 6.1 / 6.2) ---
  describe("Async Endpoint CloudWatch Alarms", () => {
    it("endpointName 指定時は合計 4 アラーム (バッチ 2 + エンドポイント 2)", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
    });

    it("HasBacklogWithoutCapacity アラームが AWS/SageMaker namespace で EndpointName dim 付きで生成される", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "AWS/SageMaker",
        MetricName: "HasBacklogWithoutCapacity",
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        Threshold: 1,
        Dimensions: Match.arrayWith([
          Match.objectLike({
            Name: "EndpointName",
            Value: TEST_ENDPOINT_NAME,
          }),
        ]),
      });
    });

    it("HasBacklogWithoutCapacity アラームは 5 分連続で発報する (Period*EvaluationPeriods = 300s)", () => {
      const { template } = createStack();
      const alarms = template.findResources("AWS::CloudWatch::Alarm", {
        Properties: { MetricName: "HasBacklogWithoutCapacity" },
      });
      const values = Object.values(alarms);
      expect(values.length).toBe(1);
      const props = (values[0] as { Properties: Record<string, unknown> })
        .Properties;
      const period = props.Period as number;
      const evaluationPeriods = props.EvaluationPeriods as number;
      expect(period * evaluationPeriods).toBe(300);
    });

    it("ApproximateAgeOfOldestRequest アラームが AWS/SageMaker namespace / 閾値 1800 / EvaluationPeriods=1", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "AWS/SageMaker",
        MetricName: "ApproximateAgeOfOldestRequest",
        ComparisonOperator: "GreaterThanThreshold",
        Threshold: 1800,
        EvaluationPeriods: 1,
        Dimensions: Match.arrayWith([
          Match.objectLike({
            Name: "EndpointName",
            Value: TEST_ENDPOINT_NAME,
          }),
        ]),
      });
    });

    it("新規 2 アラームも SNS Topic にアクションを配線している", () => {
      const { template } = createStack();
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const values = Object.values(alarms);
      expect(values.length).toBe(4);
      for (const alarm of values) {
        const actions = (alarm as { Properties: { AlarmActions?: unknown[] } })
          .Properties.AlarmActions;
        expect(Array.isArray(actions)).toBe(true);
        expect((actions ?? []).length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // --- endpointName 未指定時のフォールバック ---
  describe("Fallback when endpointName is undefined", () => {
    it("endpointName 未指定時はバッチ用 2 アラームのみ (エンドポイント用をスキップ)", () => {
      const app = new App();
      const stack = new MonitoringStack(app, "TestMonitoringStackNoEndpoint", {
        env: { region: TEST_REGION, account: TEST_ACCOUNT },
      });
      const template = Template.fromStack(stack);
      template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const serialized = JSON.stringify(alarms);
      expect(serialized).not.toContain("HasBacklogWithoutCapacity");
      expect(serialized).not.toContain("ApproximateAgeOfOldestRequest");
    });
  });

  // --- Stack Outputs ---
  describe("Stack Outputs", () => {
    it("AlarmTopicArn を出力する", () => {
      const { template } = createStack();
      template.hasOutput("AlarmTopicArn", { Value: Match.anyValue() });
    });
  });

  // --- 旧メトリクス/Realtime 専用アラームが混在しないこと ---
  describe("Legacy / realtime-only metrics absent", () => {
    it("旧 SQS / Lambda メトリクス名を参照していない", () => {
      const { template } = createStack();
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const serialized = JSON.stringify(alarms);
      expect(serialized).not.toContain("ApproximateAgeOfOldestMessage");
      expect(serialized).not.toContain("ApproximateNumberOfMessagesVisible");
      expect(serialized).not.toContain("AWS/SQS");
      expect(serialized).not.toContain("AWS/Lambda");
    });

    it("Realtime 専用 SageMaker メトリクス (Invocations/ModelLatency/OverheadLatency) を追加していない", () => {
      const { template } = createStack();
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const serialized = JSON.stringify(alarms);
      expect(serialized).not.toContain('"MetricName":"Invocations"');
      expect(serialized).not.toContain("ModelLatency");
      expect(serialized).not.toContain("OverheadLatency");
    });
  });

  // ---------------------------------------------------------------------------
  // Cost Explorer タグ戦略 (Task 7.4, Req 9.2)
  // ---------------------------------------------------------------------------
  describe("Cost Explorer タグ戦略 (Task 7.4)", () => {
    const hasTag = (tags: unknown, key: string, value: string): boolean => {
      if (!Array.isArray(tags)) return false;
      return tags.some(
        (t) =>
          typeof t === "object" &&
          t !== null &&
          (t as { Key?: unknown }).Key === key &&
          (t as { Value?: unknown }).Value === value,
      );
    };

    it("AlarmTopic (SNS) に yomitoku:stack=sagemaker-async と yomitoku:component=monitoring が付く", () => {
      const { template } = createStack({
        endpointName: "yomitoku-pro-endpoint",
      });
      const topics = template.findResources("AWS::SNS::Topic");
      const topicList = Object.values(topics);
      expect(topicList.length).toBe(1);
      const tags = (topicList[0] as { Properties?: { Tags?: unknown } })
        .Properties?.Tags;
      expect(hasTag(tags, "yomitoku:stack", "sagemaker-async")).toBe(true);
      expect(hasTag(tags, "yomitoku:component", "monitoring")).toBe(true);
    });
  });
});
