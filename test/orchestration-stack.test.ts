import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { App, Stack } from "aws-cdk-lib/core";
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
  const app = new App();

  // 依存リソースのダミースタック
  const depStack = new Stack(app, "DepStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
  });
  const controlTable = new Table(depStack, "ControlTable", {
    partitionKey: { name: "lock_key", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });
  const bucket = new Bucket(depStack, "DataBucket");

  const stack = new OrchestrationStack(app, "TestOrchestrationStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
    controlTable,
    bucket,
    endpointName: TEST_ENDPOINT_NAME,
    endpointConfigName: TEST_ENDPOINT_CONFIG_NAME,
  });
  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("OrchestrationStack (legacy wiring cleaned up)", () => {
  // --- エンドポイント制御 Lambda ---
  describe("Endpoint Control Lambda", () => {
    it("Python 3.12 ランタイムで定義されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Runtime: "python3.12",
        Handler: "index.handler",
      });
    });

    it("環境変数に ENDPOINT_NAME / ENDPOINT_CONFIG_NAME / CONTROL_TABLE_NAME が設定されている (QUEUE_URL は撤去)", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: {
            ENDPOINT_NAME: TEST_ENDPOINT_NAME,
            ENDPOINT_CONFIG_NAME: TEST_ENDPOINT_CONFIG_NAME,
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

    it("ステートマシン定義に ReleaseLock ステップが含まれる", () => {
      const { template } = createStack();
      const machines = template.findResources(
        "AWS::StepFunctions::StateMachine",
      );
      const definition = JSON.stringify(Object.values(machines)[0]);
      expect(definition).toContain("ReleaseLock");
    });

    it("ステートマシン定義に CheckBatchInFlight ステップが含まれ、DeleteEndpoint の前段で使われる (Task 4.3)", () => {
      const { template } = createStack();
      const machines = template.findResources(
        "AWS::StepFunctions::StateMachine",
      );
      const definition = JSON.stringify(Object.values(machines)[0]);
      // Lambda の新アクション名がペイロードに直列化されている
      expect(definition).toContain("check_batch_in_flight");
      // 専用ステート名 + in-flight 判定 + 待機ループ
      expect(definition).toContain("CheckBatchInFlight");
      expect(definition).toContain("WaitForBatches");
      // in_flight_count のフィールドを SFN Choice が参照している
      expect(definition).toContain("in_flight_count");
    });

    it("レガシーの check_queue_status がステートマシン定義から完全に消滅している", () => {
      const { template } = createStack();
      const machines = template.findResources(
        "AWS::StepFunctions::StateMachine",
      );
      const definition = JSON.stringify(Object.values(machines)[0]);
      expect(definition).not.toContain("check_queue_status");
      expect(definition).not.toContain("queue_empty");
    });

    it("BatchInFlightChoice のタイムアウト経路が ReleaseLockOnError 経由で ExecutionFailed に到達する (H4)", () => {
      const { template } = createStack();
      const machines = template.findResources(
        "AWS::StepFunctions::StateMachine",
      );
      const resource = Object.values(machines)[0] as {
        Properties: { DefinitionString: unknown };
      };
      const defString = resource.Properties.DefinitionString as {
        "Fn::Join": [string, unknown[]];
      };
      const joined = defString["Fn::Join"][1]
        .filter((chunk): chunk is string => typeof chunk === "string")
        .join("");
      // Choice と分岐先が定義されている
      expect(joined).toContain("BatchInFlightChoice");
      expect(joined).toMatch(
        /"NumericGreaterThanEquals":\s*120[^}]*"Next":\s*"ReleaseLockOnError"/,
      );
      // ReleaseLockOnError ステートが存在し、Next が ExecutionFailed (Fail state) である
      expect(joined).toMatch(
        /"ReleaseLockOnError":\s*\{[^}]*"Next":\s*"ExecutionFailed"/,
      );
      // ExecutionFailed が Fail type として終端に存在する
      expect(joined).toMatch(/"ExecutionFailed":\s*\{[^}]*"Type":\s*"Fail"/);
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

    it("SQS GetQueueAttributes 権限が付与されていない (legacy 撤去)", () => {
      const { template } = createStack();
      const policies = template.findResources("AWS::IAM::Policy");
      const serialized = JSON.stringify(policies);
      expect(serialized).not.toContain("sqs:GetQueueAttributes");
    });
  });

  // --- EventBridge Rule は legacy (input/ prefix) のため撤去済み ---
  describe("EventBridge Rule removed", () => {
    it("S3 ObjectCreated ルールが存在しない", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::Events::Rule", 0);
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
