import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Bucket } from "aws-cdk-lib/aws-s3";
import {
  DefinitionBody,
  Pass,
  StateMachine,
} from "aws-cdk-lib/aws-stepfunctions";
import { App, Stack } from "aws-cdk-lib/core";
import { ApiStack } from "../lib/api-stack";

const TEST_REGION = "us-east-1";
const TEST_ACCOUNT = "123456789012";

function createStack(): {
  app: App;
  stack: ApiStack;
  template: Template;
} {
  const app = new App();
  const depStack = new Stack(app, "DepStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
  });

  const bucket = new Bucket(depStack, "TestBucket");
  const controlTable = new Table(depStack, "TestControlTable", {
    partitionKey: { name: "lock_key", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });
  const stateMachine = new StateMachine(depStack, "TestStateMachine", {
    definitionBody: DefinitionBody.fromChainable(new Pass(depStack, "Start")),
  });

  const stack = new ApiStack(app, "TestApiStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
    bucket,
    controlTable,
    stateMachine,
  });

  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("ApiStack (legacy StatusTable wiring removed)", () => {
  // --- NodejsFunction ---
  describe("NodejsFunction", () => {
    it("ランタイムが Node.js 24.x である", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Runtime: "nodejs24.x",
      });
    });

    it("タイムアウトが 29 秒", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Timeout: 29,
      });
    });

    it("メモリサイズが 256 MB", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        MemorySize: 256,
      });
    });

    it("環境変数に BUCKET_NAME / CONTROL_TABLE_NAME / STATE_MACHINE_ARN が設定されている (STATUS_TABLE_NAME は撤去)", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: {
            BUCKET_NAME: Match.anyValue(),
            CONTROL_TABLE_NAME: Match.anyValue(),
            STATE_MACHINE_ARN: Match.anyValue(),
          },
        },
      });
    });

    it("STATUS_TABLE_NAME 環境変数が存在しない", () => {
      const { template } = createStack();
      const fns = template.findResources("AWS::Lambda::Function");
      const serialized = JSON.stringify(fns);
      expect(serialized).not.toContain("STATUS_TABLE_NAME");
    });
  });

  // --- API Gateway ---
  describe("API Gateway", () => {
    it("LambdaRestApi が REGIONAL エンドポイントで作成されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        EndpointConfiguration: {
          Types: ["REGIONAL"],
        },
      });
    });
  });

  // --- API Key は不要（CloudFront + WAF で制御） ---
  describe("API Key が存在しないこと", () => {
    it("ApiKey リソースが作成されていない", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::ApiGateway::ApiKey", 0);
    });

    it("UsagePlan が作成されていない", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::ApiGateway::UsagePlan", 0);
    });
  });

  // --- CloudFront Distribution ---
  describe("CloudFront Distribution", () => {
    it("CloudFront Distribution が作成されている", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    });

    it("Origin Custom Header x-origin-verify が設定されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          Origins: Match.arrayWith([
            Match.objectLike({
              OriginCustomHeaders: Match.arrayWith([
                Match.objectLike({
                  HeaderName: "x-origin-verify",
                  HeaderValue: Match.anyValue(),
                }),
              ]),
            }),
          ]),
        },
      });
    });

    it("ViewerProtocolPolicy が redirect-to-https である", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          DefaultCacheBehavior: Match.objectLike({
            ViewerProtocolPolicy: "redirect-to-https",
          }),
        },
      });
    });

    it("AllowedMethods が全メソッド許可である", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          DefaultCacheBehavior: Match.objectLike({
            AllowedMethods: Match.arrayWith([
              "GET",
              "HEAD",
              "OPTIONS",
              "PUT",
              "PATCH",
              "POST",
              "DELETE",
            ]),
          }),
        },
      });
    });
  });

  // --- API Gateway リソースポリシー ---
  describe("API Gateway Resource Policy", () => {
    it("リソースポリシーに DENY ステートメントが含まれている（Referer 不一致時）", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        Policy: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Action: "execute-api:Invoke",
              Condition: {
                StringNotEquals: {
                  "aws:Referer": Match.anyValue(),
                },
              },
            }),
          ]),
        }),
      });
    });

    it("リソースポリシーに ALLOW ステートメントが含まれている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        Policy: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "execute-api:Invoke",
            }),
          ]),
        }),
      });
    });
  });

  // --- IAM 権限（legacy 撤去済み） ---
  describe("IAM Permissions", () => {
    it("StatusTable への DynamoDB 書き込み権限が存在しない (legacy)", () => {
      const { template } = createStack();
      const policies = template.findResources("AWS::IAM::Policy");
      const serialized = JSON.stringify(policies);
      expect(serialized).not.toContain("TestStatusTable");
    });
  });

  // --- Stack Outputs ---
  describe("Stack Outputs", () => {
    it("ApiUrl を出力する", () => {
      const { template } = createStack();
      template.hasOutput("ApiUrl", { Value: Match.anyValue() });
    });

    it("DistributionDomainName を出力する", () => {
      const { template } = createStack();
      template.hasOutput("DistributionDomainName", {
        Value: Match.anyValue(),
      });
    });
  });
});
