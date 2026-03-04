import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Bucket } from "aws-cdk-lib/aws-s3";
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

  const stack = new ApiStack(app, "TestApiStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
    bucket,
    statusTable,
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

    it("環境変数に STATUS_TABLE_NAME と BUCKET_NAME が設定されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: {
            STATUS_TABLE_NAME: Match.anyValue(),
            BUCKET_NAME: Match.anyValue(),
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
  });
});
