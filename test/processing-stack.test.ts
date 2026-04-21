import { Match, Template } from "aws-cdk-lib/assertions";
import { App } from "aws-cdk-lib/core";
import { ProcessingStack } from "../lib/processing-stack";

const TEST_REGION = "ap-northeast-1";
const TEST_ACCOUNT = "123456789012";

function createStack(): {
  app: App;
  stack: ProcessingStack;
  template: Template;
} {
  const app = new App();
  const stack = new ProcessingStack(app, "TestProcessingStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
  });
  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("ProcessingStack (legacy resources removed)", () => {
  // --- S3 バケット（共通基盤として残存） ---
  describe("S3 Bucket", () => {
    it("パブリックアクセスブロックが有効化されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it("bucket を公開プロパティとして持つ", () => {
      const { stack } = createStack();
      expect(stack.bucket).toBeDefined();
    });

    it("EventBridge 通知が有効化されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("Custom::S3BucketNotifications", {
        NotificationConfiguration: {
          EventBridgeConfiguration: {},
        },
      });
    });

    it("S3 バケットが 1 つだけ存在する", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::S3::Bucket", 1);
    });
  });

  // --- S3 ライフサイクルルール (batches/* リテンション) ---
  describe("S3 Lifecycle Rules (batches/* retention)", () => {
    it("logs: prefix=batches/ + tag=log で 365 日リテンションルールが存在する", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              ExpirationInDays: 365,
              Status: "Enabled",
              Prefix: "batches/",
              TagFilters: Match.arrayWith([
                { Key: "batch-content-type", Value: "log" },
              ]),
            }),
          ]),
        },
      });
    });

    it("visualizations: prefix=batches/ + tag=visualization で 30 日リテンションルールが存在する", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              ExpirationInDays: 30,
              Status: "Enabled",
              Prefix: "batches/",
              TagFilters: Match.arrayWith([
                { Key: "batch-content-type", Value: "visualization" },
              ]),
            }),
          ]),
        },
      });
    });

    it("results: prefix=batches/ + tag=result で 30 日リテンションルールが存在する", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              ExpirationInDays: 30,
              Status: "Enabled",
              Prefix: "batches/",
              TagFilters: Match.arrayWith([
                { Key: "batch-content-type", Value: "result" },
              ]),
            }),
          ]),
        },
      });
    });

    it("ライフサイクルルールが 3 本定義されている", () => {
      const { template } = createStack();
      const buckets = template.findResources("AWS::S3::Bucket");
      const bucket = Object.values(buckets)[0] as {
        Properties?: {
          LifecycleConfiguration?: { Rules?: unknown[] };
        };
      };
      const rules = bucket?.Properties?.LifecycleConfiguration?.Rules ?? [];
      expect(rules).toHaveLength(3);
    });
  });

  // --- DynamoDB エンドポイント制御テーブル（batch 方式でも継続利用） ---
  describe("DynamoDB Endpoint Control Table", () => {
    it("PK が lock_key (String) である", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        KeySchema: [{ AttributeName: "lock_key", KeyType: "HASH" }],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "lock_key", AttributeType: "S" },
        ]),
      });
    });

    it("PAY_PER_REQUEST (オンデマンド) 課金である", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        BillingMode: "PAY_PER_REQUEST",
      });
    });

    it("controlTable を公開プロパティとして持つ", () => {
      const { stack } = createStack();
      expect(stack.controlTable).toBeDefined();
    });
  });

  // --- DynamoDB BatchTable (Single-table: PK/SK + GSI1 + GSI2 + TTL) ---
  describe("DynamoDB BatchTable", () => {
    it("PK が PK (String)、SK が SK (String) の複合キーである", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
        ]),
      });
    });

    it("GSI1 が GSI1PK (HASH) / GSI1SK (RANGE) / KEYS_ONLY projection で定義されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: "GSI1",
            KeySchema: [
              { AttributeName: "GSI1PK", KeyType: "HASH" },
              { AttributeName: "GSI1SK", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "KEYS_ONLY" },
          }),
        ]),
      });
    });

    it("GSI2 が GSI2PK (HASH) / GSI2SK (RANGE) / KEYS_ONLY projection で定義されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: "GSI2",
            KeySchema: [
              { AttributeName: "GSI2PK", KeyType: "HASH" },
              { AttributeName: "GSI2SK", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "KEYS_ONLY" },
          }),
        ]),
      });
    });

    it("TTL 属性 (ttl) が有効化されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TimeToLiveSpecification: {
          AttributeName: "ttl",
          Enabled: true,
        },
      });
    });

    it("PAY_PER_REQUEST 課金で PITR が有効化されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        BillingMode: "PAY_PER_REQUEST",
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
        TimeToLiveSpecification: {
          AttributeName: "ttl",
          Enabled: true,
        },
      });
    });

    it("batchTable を公開プロパティとして持つ", () => {
      const { stack } = createStack();
      expect(stack.batchTable).toBeDefined();
    });

    it("DynamoDB テーブルが 2 つ存在する (controlTable + batchTable)", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::DynamoDB::Table", 2);
    });
  });

  // --- 旧リソースが存在しないこと ---
  describe("Legacy resources removed", () => {
    it("SQS Queue が存在しない", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::SQS::Queue", 0);
    });

    it("Lambda Function (Processor) が存在しない", () => {
      const { template } = createStack();
      // BucketNotificationsHandler の Lambda を除外するため PackageType: Image を確認
      const lambdas = template.findResources("AWS::Lambda::Function");
      const imageFunctions = Object.values(lambdas).filter(
        (r) =>
          (r as Record<string, unknown>).Properties &&
          ((r as Record<string, unknown>).Properties as Record<string, unknown>)
            .PackageType === "Image",
      );
      expect(imageFunctions).toHaveLength(0);
    });

    it("Lambda EventSourceMapping (SQS trigger) が存在しない", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::Lambda::EventSourceMapping", 0);
    });

    it("旧プロパティ statusTable が公開されていない", () => {
      const { stack } = createStack();
      expect(
        (stack as unknown as Record<string, unknown>).statusTable,
      ).toBeUndefined();
    });

    it("旧プロパティ mainQueue が公開されていない", () => {
      const { stack } = createStack();
      expect(
        (stack as unknown as Record<string, unknown>).mainQueue,
      ).toBeUndefined();
    });

    it("旧プロパティ deadLetterQueue が公開されていない", () => {
      const { stack } = createStack();
      expect(
        (stack as unknown as Record<string, unknown>).deadLetterQueue,
      ).toBeUndefined();
    });

    it("旧プロパティ processorFunction が公開されていない", () => {
      const { stack } = createStack();
      expect(
        (stack as unknown as Record<string, unknown>).processorFunction,
      ).toBeUndefined();
    });
  });

  // --- Stack Outputs ---
  describe("Stack Outputs", () => {
    it("BucketName を出力する", () => {
      const { template } = createStack();
      template.hasOutput("BucketName", { Value: Match.anyValue() });
    });

    it("ControlTableName を出力する", () => {
      const { template } = createStack();
      template.hasOutput("ControlTableName", { Value: Match.anyValue() });
    });

    it("BatchTableName を出力する", () => {
      const { template } = createStack();
      template.hasOutput("BatchTableName", { Value: Match.anyValue() });
    });

    it("旧 Output (MainQueueUrl / MainQueueArn / DeadLetterQueueArn / StatusTableName / ProcessorFunctionName) が存在しない", () => {
      const { template } = createStack();
      const outputs = template.findOutputs("*");
      const names = Object.keys(outputs);
      expect(names).not.toContain("MainQueueUrl");
      expect(names).not.toContain("MainQueueArn");
      expect(names).not.toContain("DeadLetterQueueArn");
      expect(names).not.toContain("StatusTableName");
      expect(names).not.toContain("ProcessorFunctionName");
    });
  });
});
