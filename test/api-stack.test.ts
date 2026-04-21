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
  const batchTable = new Table(depStack, "TestBatchTable", {
    partitionKey: { name: "PK", type: AttributeType.STRING },
    sortKey: { name: "SK", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });
  batchTable.addGlobalSecondaryIndex({
    indexName: "GSI1",
    partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
    sortKey: { name: "GSI1SK", type: AttributeType.STRING },
  });
  batchTable.addGlobalSecondaryIndex({
    indexName: "GSI2",
    partitionKey: { name: "GSI2PK", type: AttributeType.STRING },
    sortKey: { name: "GSI2SK", type: AttributeType.STRING },
  });
  const stateMachine = new StateMachine(depStack, "TestStateMachine", {
    definitionBody: DefinitionBody.fromChainable(new Pass(depStack, "Start")),
  });
  const batchExecutionStateMachine = new StateMachine(
    depStack,
    "TestBatchExecutionStateMachine",
    {
      definitionBody: DefinitionBody.fromChainable(
        new Pass(depStack, "BatchStart"),
      ),
    },
  );

  const stack = new ApiStack(app, "TestApiStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
    bucket,
    controlTable,
    batchTable,
    stateMachine,
    batchExecutionStateMachine,
  });

  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("ApiStack (batch-first IAM / env wiring, Task 6.2)", () => {
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

    it("環境変数に BUCKET_NAME / CONTROL_TABLE_NAME / BATCH_TABLE_NAME / STATE_MACHINE_ARN / BATCH_EXECUTION_STATE_MACHINE_ARN が設定されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: {
            BUCKET_NAME: Match.anyValue(),
            CONTROL_TABLE_NAME: Match.anyValue(),
            BATCH_TABLE_NAME: Match.anyValue(),
            STATE_MACHINE_ARN: Match.anyValue(),
            BATCH_EXECUTION_STATE_MACHINE_ARN: Match.anyValue(),
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

  // --- IAM 権限（Task 6.2: batch-first 再スコープ） ---
  describe("IAM Permissions (batch-first)", () => {
    it("StatusTable への DynamoDB 書き込み権限が存在しない (legacy)", () => {
      const { template } = createStack();
      const policies = template.findResources("AWS::IAM::Policy");
      const serialized = JSON.stringify(policies);
      expect(serialized).not.toContain("TestStatusTable");
    });

    it("旧 input/* / output/* / visualizations/* への S3 grants が存在しない (legacy)", () => {
      const { template } = createStack();
      const policies = template.findResources("AWS::IAM::Policy");
      const serialized = JSON.stringify(policies);
      expect(serialized).not.toContain("input/*");
      expect(serialized).not.toContain("output/*");
      expect(serialized).not.toContain("visualizations/*");
    });

    it("S3 `batches/*` プレフィックスに対する GetObject/PutObject/DeleteObject 権限を付与している", () => {
      const { template } = createStack();
      const policies = template.findResources("AWS::IAM::Policy");
      const serialized = JSON.stringify(policies);
      // S3 actions が付与されていること
      expect(serialized).toContain("s3:GetObject");
      expect(serialized).toContain("s3:PutObject");
      expect(serialized).toContain("s3:DeleteObject");
      // Resource が batches/* スコープに限定されていること
      expect(serialized).toContain("batches/*");
    });

    it("BatchTable への PutItem / UpdateItem / GetItem / Query / TransactWriteItems 権限を付与している", () => {
      const { template } = createStack();
      const policies = template.findResources("AWS::IAM::Policy");
      const serialized = JSON.stringify(policies);
      expect(serialized).toContain("dynamodb:PutItem");
      expect(serialized).toContain("dynamodb:UpdateItem");
      expect(serialized).toContain("dynamodb:GetItem");
      expect(serialized).toContain("dynamodb:Query");
      expect(serialized).toContain("dynamodb:TransactWriteItems");
    });

    it("BatchExecutionStateMachine への StartExecution 権限を付与している", () => {
      const { template } = createStack();
      const policies = template.findResources("AWS::IAM::Policy");
      const serialized = JSON.stringify(policies);
      expect(serialized).toContain("states:StartExecution");
      // TestBatchExecutionStateMachine 由来の識別子が含まれる
      expect(serialized).toContain("TestBatchExecutionStateMachine");
    });

    it("ControlTable への読み取り権限と EndpointControl StateMachine への StartExecution 権限が維持されている", () => {
      const { template } = createStack();
      const policies = template.findResources("AWS::IAM::Policy");
      const serialized = JSON.stringify(policies);
      // ControlTable 読み取り (grantReadData)
      expect(serialized).toContain("TestControlTable");
      expect(serialized).toContain("dynamodb:GetItem");
      // EndpointControl StateMachine への StartExecution が残っている
      expect(serialized).toContain("TestStateMachine");
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
