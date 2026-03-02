import { Match, Template } from "aws-cdk-lib/assertions";
import { App } from "aws-cdk-lib/core";
import { SagemakerStack } from "../lib/sagemaker-stack";

const TEST_MODEL_PACKAGE_ARN =
  "arn:aws:sagemaker:ap-northeast-1:123456789012:model-package/test-model";
const TEST_REGION = "ap-northeast-1";
const TEST_ACCOUNT = "123456789012";
const TEST_ENDPOINT_CONFIG_NAME = "yomitoku-pro-config";

function createStack(): {
  app: App;
  stack: SagemakerStack;
  template: Template;
} {
  const app = new App({
    context: {
      modelPackageArn: TEST_MODEL_PACKAGE_ARN,
      endpointConfigName: TEST_ENDPOINT_CONFIG_NAME,
    },
  });
  const stack = new SagemakerStack(app, "TestSagemakerStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
  });
  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("SagemakerStack", () => {
  describe("context validation", () => {
    it("modelPackageArn 未設定時にエラーをスローする", () => {
      const app = new App({
        context: { endpointConfigName: TEST_ENDPOINT_CONFIG_NAME },
      });
      expect(
        () =>
          new SagemakerStack(app, "Bad", {
            env: { region: TEST_REGION, account: TEST_ACCOUNT },
          }),
      ).toThrow("modelPackageArn must be set");
    });

    it("endpointConfigName 未設定時にエラーをスローする", () => {
      const app = new App({
        context: { modelPackageArn: TEST_MODEL_PACKAGE_ARN },
      });
      expect(
        () =>
          new SagemakerStack(app, "Bad", {
            env: { region: TEST_REGION, account: TEST_ACCOUNT },
          }),
      ).toThrow("endpointConfigName must be set");
    });
  });

  describe("IAM Role", () => {
    it("sagemaker.amazonaws.com の信頼ポリシーを持つ", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: "sts:AssumeRole",
              Effect: "Allow",
              Principal: { Service: "sagemaker.amazonaws.com" },
            },
          ],
        },
      });
    });

    it("ECR, CloudWatch Logs の権限を持つ", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: "EcrImagePull",
              Action: "ecr:GetAuthorizationToken",
              Resource: "*",
            }),
            Match.objectLike({
              Sid: "EcrImageGet",
              Action: Match.arrayWith(["ecr:BatchGetImage"]),
            }),
            Match.objectLike({
              Sid: "CloudWatchLogs",
              Action: Match.arrayWith(["logs:CreateLogGroup"]),
            }),
          ]),
        },
      });
    });
  });

  describe("CfnModel", () => {
    it("Marketplace モデルパッケージ ARN を参照する", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SageMaker::Model", {
        Containers: [{ ModelPackageName: TEST_MODEL_PACKAGE_ARN }],
      });
    });

    it("実行ロール ARN を設定する", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SageMaker::Model", {
        ExecutionRoleArn: Match.anyValue(),
      });
    });
  });

  describe("CfnEndpointConfig", () => {
    it("指定された endpointConfigName を使用する", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SageMaker::EndpointConfig", {
        EndpointConfigName: TEST_ENDPOINT_CONFIG_NAME,
      });
    });

    it("ml.g5.xlarge / initialInstanceCount: 1 を設定する", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SageMaker::EndpointConfig", {
        ProductionVariants: [
          Match.objectLike({
            VariantName: "AllTraffic",
            InstanceType: "ml.g5.xlarge",
            InitialInstanceCount: 1,
          }),
        ],
      });
    });

    it("CfnModel の ModelName を参照する", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SageMaker::EndpointConfig", {
        ProductionVariants: [
          Match.objectLike({
            ModelName: Match.anyValue(),
          }),
        ],
      });
    });
  });

  describe("Stack Outputs", () => {
    it("EndpointConfigName を出力する", () => {
      const { template } = createStack();
      template.hasOutput("EndpointConfigName", {
        Value: TEST_ENDPOINT_CONFIG_NAME,
      });
    });

    it("ModelName を出力する", () => {
      const { template } = createStack();
      template.hasOutput("ModelName", {
        Value: Match.anyValue(),
      });
    });
  });

  describe("public properties", () => {
    it("endpointConfigName を公開する", () => {
      const { stack } = createStack();
      expect(stack.endpointConfigName).toBe(TEST_ENDPOINT_CONFIG_NAME);
    });

    it("modelName を公開する", () => {
      const { stack } = createStack();
      expect(stack.modelName).toBeDefined();
    });
  });
});
