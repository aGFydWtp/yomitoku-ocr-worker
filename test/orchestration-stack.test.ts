import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { App, Duration, Stack } from "aws-cdk-lib/core";
import { OrchestrationStack } from "../lib/orchestration-stack";

const TEST_REGION = "ap-northeast-1";
const TEST_ACCOUNT = "123456789012";
const TEST_ENDPOINT_NAME = "yomitoku-pro-endpoint";
const TEST_ENDPOINT_CONFIG_NAME = "yomitoku-pro-config";

function createStack(): {
  app: App;
  stack: OrchestrationStack;
  template: Template;
} {
  const app = new App({
    context: {
      endpointName: TEST_ENDPOINT_NAME,
      endpointConfigName: TEST_ENDPOINT_CONFIG_NAME,
    },
  });

  // 依存リソースのダミースタック
  const depStack = new Stack(app, "DepStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
  });
  const mainQueue = new Queue(depStack, "MainQueue", {
    visibilityTimeout: Duration.seconds(3600),
  });
  const controlTable = new Table(depStack, "ControlTable", {
    partitionKey: { name: "lock_key", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });

  const stack = new OrchestrationStack(app, "TestOrchestrationStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
    mainQueue,
    controlTable,
  });
  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("OrchestrationStack", () => {
  // --- エンドポイント制御 Lambda ---
  describe("Endpoint Control Lambda", () => {
    it("Python 3.12 ランタイムで定義されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Runtime: "python3.12",
        Handler: "index.handler",
      });
    });

    it("環境変数が設定されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: {
            ENDPOINT_NAME: TEST_ENDPOINT_NAME,
            ENDPOINT_CONFIG_NAME: TEST_ENDPOINT_CONFIG_NAME,
            QUEUE_URL: Match.anyValue(),
            CONTROL_TABLE_NAME: Match.anyValue(),
          },
        },
      });
    });

    it("timeout が 30 秒", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Runtime: "python3.12",
        Timeout: 30,
      });
    });
  });

  // --- Step Functions ステートマシン ---
  describe("Step Functions State Machine", () => {
    it("ステートマシンが 1 つ存在する", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
    });

    it("stateMachine を公開プロパティとして持つ", () => {
      const { stack } = createStack();
      expect(stack.stateMachine).toBeDefined();
    });

    it("ステートマシン定義に AcquireLock ステップが含まれる", () => {
      const { template } = createStack();
      const machines = template.findResources(
        "AWS::StepFunctions::StateMachine",
      );
      const definition = JSON.stringify(Object.values(machines)[0]);
      expect(definition).toContain("AcquireLock");
    });

    it("ステートマシン定義に CheckEndpointStatus ステップが含まれる", () => {
      const { template } = createStack();
      const machines = template.findResources(
        "AWS::StepFunctions::StateMachine",
      );
      const definition = JSON.stringify(Object.values(machines)[0]);
      expect(definition).toContain("CheckEndpointStatus");
    });

    it("ステートマシン定義に CreateEndpoint ステップが含まれる", () => {
      const { template } = createStack();
      const machines = template.findResources(
        "AWS::StepFunctions::StateMachine",
      );
      const definition = JSON.stringify(Object.values(machines)[0]);
      expect(definition).toContain("CreateEndpoint");
    });

    it("ステートマシン定義に DeleteEndpoint ステップが含まれる", () => {
      const { template } = createStack();
      const machines = template.findResources(
        "AWS::StepFunctions::StateMachine",
      );
      const definition = JSON.stringify(Object.values(machines)[0]);
      expect(definition).toContain("DeleteEndpoint");
    });

    it("ステートマシン定義に CheckQueueStatus ステップが含まれる", () => {
      const { template } = createStack();
      const machines = template.findResources(
        "AWS::StepFunctions::StateMachine",
      );
      const definition = JSON.stringify(Object.values(machines)[0]);
      expect(definition).toContain("CheckQueueStatus");
    });

    it("ステートマシン定義に ReleaseLock ステップが含まれる", () => {
      const { template } = createStack();
      const machines = template.findResources(
        "AWS::StepFunctions::StateMachine",
      );
      const definition = JSON.stringify(Object.values(machines)[0]);
      expect(definition).toContain("ReleaseLock");
    });

    it("ステートマシン定義にクールダウン Wait が含まれる", () => {
      const { template } = createStack();
      const machines = template.findResources(
        "AWS::StepFunctions::StateMachine",
      );
      const definition = JSON.stringify(Object.values(machines)[0]);
      expect(definition).toContain("CooldownWait");
    });
  });

  // --- IAM Permissions ---
  describe("IAM Permissions", () => {
    it("Lambda に SageMaker エンドポイント操作権限がある", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: [
                "sagemaker:CreateEndpoint",
                "sagemaker:DeleteEndpoint",
                "sagemaker:DescribeEndpoint",
              ],
              Effect: "Allow",
            }),
          ]),
        },
      });
    });

    it("Lambda に SQS GetQueueAttributes 権限がある", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "sqs:GetQueueAttributes",
              Effect: "Allow",
            }),
          ]),
        },
      });
    });
  });

  // --- Stack Outputs ---
  describe("Stack Outputs", () => {
    it("StateMachineArn を出力する", () => {
      const { template } = createStack();
      template.hasOutput("StateMachineArn", { Value: Match.anyValue() });
    });

    it("EndpointControlFunctionName を出力する", () => {
      const { template } = createStack();
      template.hasOutput("EndpointControlFunctionName", {
        Value: Match.anyValue(),
      });
    });
  });
});
