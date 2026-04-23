import { Match, Template } from "aws-cdk-lib/assertions";
import { ContainerImage } from "aws-cdk-lib/aws-ecs";
import { App } from "aws-cdk-lib/core";
import { ApiStack } from "../lib/api-stack";
import { resolveAsyncRuntimeContext } from "../lib/async-runtime-context";
import { BatchExecutionStack } from "../lib/batch-execution-stack";
import { MonitoringStack } from "../lib/monitoring-stack";
import { ProcessingStack } from "../lib/processing-stack";
import { SagemakerStack } from "../lib/sagemaker-stack";

// Task 10.2: `cdk synth --all` 横断で Async 移行契約が守られていることを
// 担保する統合テスト。bin/app.ts と同じ構成でスタックを配線し、下記 6 点を
// 検証する:
//   1. OrchestrationStack が存在しない
//   2. SagemakerStack に AsyncInferenceConfig + CfnScalableTarget +
//      SNS Topic×2 + SQS Queue×2 (主 Queue、DLQ 除く) が含まれる
//   3. Realtime `ProductionVariant` (InitialInstanceCount=1) が全スタック
//      横断で不在
//   4. MonitoringStack に Async アラーム 2 本 (HasBacklogWithoutCapacity /
//      ApproximateAgeOfOldestRequest) が追加、Realtime 系は 0 本
//   5. `yomitoku:stack=sagemaker-async` タグが新リソースに伝搬
//   6. BatchTable / ControlTable / ProcessLog 契約 (PK/SK/GSI) が不変
// (Requirements: 1.3, 6.4, 9.2, 10.3, 10.5)

const TEST_REGION = "ap-northeast-1";
const TEST_ACCOUNT = "123456789012";
const TEST_ENDPOINT_NAME = "yomitoku-pro-endpoint";
const TEST_ENDPOINT_CONFIG_NAME = "yomitoku-pro-config";
const TEST_MODEL_PACKAGE_ARN =
  "arn:aws:sagemaker:ap-northeast-1:123456789012:model-package/test-model";

type SynthResult = {
  app: App;
  processingStack: ProcessingStack;
  sagemakerStack: SagemakerStack;
  batchExecutionStack: BatchExecutionStack;
  apiStack: ApiStack;
  monitoringStack: MonitoringStack;
  templates: {
    processing: Template;
    sagemaker: Template;
    batchExecution: Template;
    api: Template;
    monitoring: Template;
  };
};

function synthAllStacks(): SynthResult {
  const app = new App({
    context: {
      modelPackageArn: TEST_MODEL_PACKAGE_ARN,
      endpointConfigName: TEST_ENDPOINT_CONFIG_NAME,
      endpointName: TEST_ENDPOINT_NAME,
    },
  });

  const env = { region: TEST_REGION, account: TEST_ACCOUNT };
  const asyncRuntime = resolveAsyncRuntimeContext(app.node);

  const processingStack = new ProcessingStack(app, "ProcessingStack", { env });

  const sagemakerStack = new SagemakerStack(app, "SagemakerStack", {
    env,
    asyncRuntime,
    bucket: processingStack.bucket,
    endpointName: TEST_ENDPOINT_NAME,
  });

  const batchExecutionStack = new BatchExecutionStack(
    app,
    "BatchExecutionStack",
    {
      env,
      batchTable: processingStack.batchTable,
      controlTable: processingStack.controlTable,
      bucket: processingStack.bucket,
      endpointName: TEST_ENDPOINT_NAME,
      successQueue: sagemakerStack.successQueue,
      failureQueue: sagemakerStack.failureQueue,
      asyncRuntime,
      // Docker build を回避するためプレースホルダを注入
      containerImage: ContainerImage.fromRegistry("placeholder:latest"),
    },
  );

  const apiStack = new ApiStack(app, "ApiStack", {
    env,
    bucket: processingStack.bucket,
    controlTable: processingStack.controlTable,
    batchTable: processingStack.batchTable,
    batchExecutionStateMachine: batchExecutionStack.stateMachine,
  });

  const monitoringStack = new MonitoringStack(app, "MonitoringStack", {
    env,
    endpointName: TEST_ENDPOINT_NAME,
  });

  return {
    app,
    processingStack,
    sagemakerStack,
    batchExecutionStack,
    apiStack,
    monitoringStack,
    templates: {
      processing: Template.fromStack(processingStack),
      sagemaker: Template.fromStack(sagemakerStack),
      batchExecution: Template.fromStack(batchExecutionStack),
      api: Template.fromStack(apiStack),
      monitoring: Template.fromStack(monitoringStack),
    },
  };
}

describe("app-synth: cdk synth --all 横断契約 (Task 10.2)", () => {
  let synth: SynthResult;
  beforeAll(() => {
    synth = synthAllStacks();
  });

  describe("1) OrchestrationStack の不在", () => {
    it("App 内に OrchestrationStack ID の子ノードが存在しない", () => {
      const children = synth.app.node.children.map((c) => c.node.id);
      expect(children).not.toContain("OrchestrationStack");
    });

    it("app.node.tryFindChild('OrchestrationStack') が undefined", () => {
      expect(synth.app.node.tryFindChild("OrchestrationStack")).toBeUndefined();
    });
  });

  describe("2) SagemakerStack の Async 必須リソース", () => {
    it("AsyncInferenceConfig が 1 本の EndpointConfig に含まれる", () => {
      const configs = synth.templates.sagemaker.findResources(
        "AWS::SageMaker::EndpointConfig",
        {
          Properties: Match.objectLike({
            AsyncInferenceConfig: Match.anyValue(),
          }),
        },
      );
      expect(Object.keys(configs).length).toBe(1);
    });

    it("Application Auto Scaling ScalableTarget が 1 本", () => {
      synth.templates.sagemaker.resourceCountIs(
        "AWS::ApplicationAutoScaling::ScalableTarget",
        1,
      );
    });

    it("SNS Topic が 2 本 (成功 / 失敗通知)", () => {
      synth.templates.sagemaker.resourceCountIs("AWS::SNS::Topic", 2);
    });

    it("SQS Queue (主 Queue) が 2 本含まれる", () => {
      // 主キュー 2 (Success / Failure) + DLQ 2 = 合計 4 が期待される。
      // DLQ は必ず RedriveAllowPolicy を持たないため、RedrivePolicy で区別する。
      const queues = synth.templates.sagemaker.findResources("AWS::SQS::Queue");
      const mainQueues = Object.values(queues).filter(
        (q) =>
          (q.Properties as { RedrivePolicy?: unknown }).RedrivePolicy !==
          undefined,
      );
      expect(mainQueues.length).toBe(2);
    });
  });

  describe("3) Realtime ProductionVariant (InitialInstanceCount=1) の不在", () => {
    it.each([
      ["processing"],
      ["sagemaker"],
      ["batchExecution"],
      ["api"],
      ["monitoring"],
    ] as const)("%s template に InitialInstanceCount=1 の ProductionVariant が存在しない", (stackName) => {
      const template = synth.templates[stackName];
      const configs = template.findResources("AWS::SageMaker::EndpointConfig");
      for (const resource of Object.values(configs)) {
        const variants = (
          resource.Properties as {
            ProductionVariants?: Array<{ InitialInstanceCount?: number }>;
          }
        ).ProductionVariants;
        for (const variant of variants ?? []) {
          expect(variant.InitialInstanceCount).not.toBe(1);
        }
      }
    });
  });

  describe("4) MonitoringStack に Async アラーム 2 本、Realtime アラーム 0 本", () => {
    it("HasBacklogWithoutCapacity アラームが存在する", () => {
      synth.templates.monitoring.hasResourceProperties(
        "AWS::CloudWatch::Alarm",
        {
          MetricName: "HasBacklogWithoutCapacity",
          Namespace: "AWS/SageMaker",
          Dimensions: Match.arrayWith([
            Match.objectLike({
              Name: "EndpointName",
              Value: TEST_ENDPOINT_NAME,
            }),
          ]),
        },
      );
    });

    it("ApproximateAgeOfOldestRequest アラームが存在する", () => {
      synth.templates.monitoring.hasResourceProperties(
        "AWS::CloudWatch::Alarm",
        {
          MetricName: "ApproximateAgeOfOldestRequest",
          Namespace: "AWS/SageMaker",
          Dimensions: Match.arrayWith([
            Match.objectLike({
              Name: "EndpointName",
              Value: TEST_ENDPOINT_NAME,
            }),
          ]),
        },
      );
    });

    it("Realtime 系メトリクス (Invocations / ModelLatency / OverheadLatency) のアラームが存在しない", () => {
      const alarms = synth.templates.monitoring.findResources(
        "AWS::CloudWatch::Alarm",
      );
      const realtimeMetricNames = new Set([
        "Invocations",
        "InvocationsPerInstance",
        "ModelLatency",
        "OverheadLatency",
        "Invocation4XXErrors",
        "Invocation5XXErrors",
      ]);
      for (const resource of Object.values(alarms)) {
        const props = resource.Properties as {
          MetricName?: string;
          Namespace?: string;
        };
        if (props.Namespace === "AWS/SageMaker" && props.MetricName) {
          expect(realtimeMetricNames.has(props.MetricName)).toBe(false);
        }
      }
    });
  });

  describe("5) yomitoku:stack=sagemaker-async タグの伝搬", () => {
    function hasAsyncStackTag(
      tags: Array<{ Key: string; Value: string }> | undefined,
    ): boolean {
      return Boolean(
        tags?.some(
          (t) => t.Key === "yomitoku:stack" && t.Value === "sagemaker-async",
        ),
      );
    }

    it("SagemakerStack の代表リソース (SNS / SQS / EndpointConfig) に付与されている", () => {
      const sns = synth.templates.sagemaker.findResources("AWS::SNS::Topic");
      for (const resource of Object.values(sns)) {
        expect(
          hasAsyncStackTag(
            (
              resource.Properties as {
                Tags?: Array<{ Key: string; Value: string }>;
              }
            ).Tags,
          ),
        ).toBe(true);
      }

      const sqs = synth.templates.sagemaker.findResources("AWS::SQS::Queue");
      for (const resource of Object.values(sqs)) {
        expect(
          hasAsyncStackTag(
            (
              resource.Properties as {
                Tags?: Array<{ Key: string; Value: string }>;
              }
            ).Tags,
          ),
        ).toBe(true);
      }

      const ec = synth.templates.sagemaker.findResources(
        "AWS::SageMaker::EndpointConfig",
      );
      for (const resource of Object.values(ec)) {
        expect(
          hasAsyncStackTag(
            (
              resource.Properties as {
                Tags?: Array<{ Key: string; Value: string }>;
              }
            ).Tags,
          ),
        ).toBe(true);
      }
    });

    it("BatchExecutionStack の代表リソース (Cluster / TaskDefinition) に付与されている", () => {
      const types = [
        "AWS::ECS::Cluster",
        "AWS::ECS::TaskDefinition",
        "AWS::Logs::LogGroup",
      ];
      for (const type of types) {
        const resources = synth.templates.batchExecution.findResources(type);
        for (const resource of Object.values(resources)) {
          expect(
            hasAsyncStackTag(
              (
                resource.Properties as {
                  Tags?: Array<{ Key: string; Value: string }>;
                }
              ).Tags,
            ),
          ).toBe(true);
        }
      }
    });

    it("MonitoringStack の AlarmTopic に付与されている", () => {
      const sns = synth.templates.monitoring.findResources("AWS::SNS::Topic");
      for (const resource of Object.values(sns)) {
        expect(
          hasAsyncStackTag(
            (
              resource.Properties as {
                Tags?: Array<{ Key: string; Value: string }>;
              }
            ).Tags,
          ),
        ).toBe(true);
      }
    });
  });

  describe("6) BatchTable / ControlTable / ProcessLog 契約の不変性", () => {
    it("BatchTable が PK/SK (STRING) + GSI1 + GSI2 を持つ", () => {
      synth.templates.processing.hasResourceProperties("AWS::DynamoDB::Table", {
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
          { AttributeName: "GSI1PK", AttributeType: "S" },
          { AttributeName: "GSI1SK", AttributeType: "S" },
          { AttributeName: "GSI2PK", AttributeType: "S" },
          { AttributeName: "GSI2SK", AttributeType: "S" },
        ]),
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: "GSI1",
            KeySchema: [
              { AttributeName: "GSI1PK", KeyType: "HASH" },
              { AttributeName: "GSI1SK", KeyType: "RANGE" },
            ],
          }),
          Match.objectLike({
            IndexName: "GSI2",
            KeySchema: [
              { AttributeName: "GSI2PK", KeyType: "HASH" },
              { AttributeName: "GSI2SK", KeyType: "RANGE" },
            ],
          }),
        ]),
        TimeToLiveSpecification: {
          AttributeName: "ttl",
          Enabled: true,
        },
      });
    });

    it("ControlTable が lock_key (STRING) を PK に持つ", () => {
      synth.templates.processing.hasResourceProperties("AWS::DynamoDB::Table", {
        KeySchema: [{ AttributeName: "lock_key", KeyType: "HASH" }],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "lock_key", AttributeType: "S" },
        ]),
      });
    });

    it("ProcessingStack に旧 `job_id` / `StatusTable` / `MainQueue` 識別子が含まれない", () => {
      const json = JSON.stringify(synth.templates.processing.toJSON());
      expect(json).not.toContain('"job_id"');
      expect(json).not.toContain("StatusTable");
      expect(json).not.toContain("MainQueue");
    });
  });
});
