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
  const statusTable = new Table(depStack, "TestStatusTable", {
    partitionKey: { name: "job_id", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });
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
    statusTable,
    controlTable,
    stateMachine,
  });

  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("ApiStack", () => {
  // --- 9.1 NodejsFunction ---
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

    it("環境変数に STATUS_TABLE_NAME, BUCKET_NAME, CONTROL_TABLE_NAME, STATE_MACHINE_ARN が設定されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: {
            STATUS_TABLE_NAME: Match.anyValue(),
            BUCKET_NAME: Match.anyValue(),
            CONTROL_TABLE_NAME: Match.anyValue(),
            STATE_MACHINE_ARN: Match.anyValue(),
          },
        },
      });
    });
  });

  // --- 9.1 API Gateway ---
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

  // --- 9.2 API Key + Usage Plan ---
  describe("API Key + Usage Plan", () => {
    it("API Key ソースが HEADER に設定されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        ApiKeySourceType: "HEADER",
      });
    });

    it("ApiKey リソースが作成されている", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::ApiGateway::ApiKey", 1);
    });

    it("UsagePlan にレート制限が設定されている（rateLimit: 100, burstLimit: 200）", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::ApiGateway::UsagePlan", {
        Throttle: {
          RateLimit: 100,
          BurstLimit: 200,
        },
      });
    });

    it("UsagePlan にクォータが設定されている（10,000 req/day）", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::ApiGateway::UsagePlan", {
        Quota: {
          Limit: 10000,
          Period: "DAY",
        },
      });
    });

    it("UsagePlanKey で ApiKey と UsagePlan が紐付けられている", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::ApiGateway::UsagePlanKey", 1);
    });
  });

  // --- 9.3 CloudFront Distribution ---
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

  // --- 9.4 API Gateway リソースポリシー ---
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

  // --- 9.5 IAM 権限 ---
  describe("IAM Permissions", () => {
    it("DynamoDB の読み書き権限が付与されている", () => {
      const { template } = createStack();
      // grantReadWriteData は単一ステートメントに全アクションを含める
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["dynamodb:PutItem"]),
              Effect: "Allow",
            }),
          ]),
        },
      });
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["dynamodb:GetItem"]),
              Effect: "Allow",
            }),
          ]),
        },
      });
    });

    it("S3 input/* への PutObject 権限が付与されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["s3:PutObject"]),
              Effect: "Allow",
            }),
          ]),
        },
      });
    });

    it("S3 output/* への GetObject 権限が付与されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["s3:GetObject*"]),
              Effect: "Allow",
            }),
          ]),
        },
      });
    });

    it("S3 input/* への DeleteObject 権限が付与されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "s3:DeleteObject*",
              Effect: "Allow",
            }),
          ]),
        },
      });
    });
  });

  // --- Stack Outputs ---
  describe("Stack Outputs", () => {
    it("ApiUrl を出力する", () => {
      const { template } = createStack();
      template.hasOutput("ApiUrl", { Value: Match.anyValue() });
    });

    it("ApiKeyId を出力する", () => {
      const { template } = createStack();
      template.hasOutput("ApiKeyId", { Value: Match.anyValue() });
    });

    it("DistributionDomainName を出力する", () => {
      const { template } = createStack();
      template.hasOutput("DistributionDomainName", {
        Value: Match.anyValue(),
      });
    });
  });
});
