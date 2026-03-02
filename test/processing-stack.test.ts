import { Match, Template } from "aws-cdk-lib/assertions";
import { App } from "aws-cdk-lib/core";
import { ProcessingStack } from "../lib/processing-stack";

const TEST_REGION = "ap-northeast-1";
const TEST_ACCOUNT = "123456789012";

const TEST_ENDPOINT_NAME = "yomitoku-pro-endpoint";

function createStack(): {
  app: App;
  stack: ProcessingStack;
  template: Template;
} {
  const app = new App({
    context: {
      endpointName: TEST_ENDPOINT_NAME,
    },
  });
  const stack = new ProcessingStack(app, "TestProcessingStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
  });
  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("ProcessingStack", () => {
  // --- 2.1 S3 バケット ---
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

    it("S3 イベント通知が SQS に設定されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("Custom::S3BucketNotifications", {
        NotificationConfiguration: {
          QueueConfigurations: Match.arrayWith([
            Match.objectLike({
              Events: ["s3:ObjectCreated:*"],
              Filter: {
                Key: {
                  FilterRules: [{ Name: "prefix", Value: "input/" }],
                },
              },
            }),
          ]),
        },
      });
    });

    it("bucketName を公開プロパティとして持つ", () => {
      const { stack } = createStack();
      expect(stack.bucket).toBeDefined();
    });
  });

  // --- 2.2 SQS キュー ---
  describe("SQS Queue", () => {
    it("メインキューの visibilityTimeout が 3600 秒", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SQS::Queue", {
        VisibilityTimeout: 3600,
        MessageRetentionPeriod: 1209600,
        ReceiveMessageWaitTimeSeconds: 20,
      });
    });

    it("DLQ が設定されている（maxReceiveCount: 3）", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SQS::Queue", {
        RedrivePolicy: {
          maxReceiveCount: 3,
          deadLetterTargetArn: Match.anyValue(),
        },
      });
    });

    it("DLQ の messageRetentionPeriod が 14 日（1209600 秒）", () => {
      const { template } = createStack();
      // DLQ は RedrivePolicy を持たないキューとして識別
      template.hasResourceProperties("AWS::SQS::Queue", {
        MessageRetentionPeriod: 1209600,
        RedrivePolicy: Match.absent(),
      });
    });

    it("mainQueue を公開プロパティとして持つ", () => {
      const { stack } = createStack();
      expect(stack.mainQueue).toBeDefined();
    });

    it("deadLetterQueue を公開プロパティとして持つ", () => {
      const { stack } = createStack();
      expect(stack.deadLetterQueue).toBeDefined();
    });
  });

  // --- 2.3 DynamoDB ステータステーブル ---
  describe("DynamoDB Status Table", () => {
    it("PK が file_key (String) である", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        KeySchema: [{ AttributeName: "file_key", KeyType: "HASH" }],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "file_key", AttributeType: "S" },
        ]),
      });
    });

    it("GSI: status-created_at-index が設定されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: "status-created_at-index",
            KeySchema: [
              { AttributeName: "status", KeyType: "HASH" },
              { AttributeName: "created_at", KeyType: "RANGE" },
            ],
          }),
        ],
      });
    });

    it("PAY_PER_REQUEST (オンデマンド) 課金である", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        KeySchema: [{ AttributeName: "file_key", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      });
    });

    it("statusTable を公開プロパティとして持つ", () => {
      const { stack } = createStack();
      expect(stack.statusTable).toBeDefined();
    });
  });

  // --- 2.4 DynamoDB エンドポイント制御テーブル ---
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
        KeySchema: [{ AttributeName: "lock_key", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      });
    });

    it("controlTable を公開プロパティとして持つ", () => {
      const { stack } = createStack();
      expect(stack.controlTable).toBeDefined();
    });
  });

  // --- 3.4 処理ワーカー Lambda ---
  describe("Processor Lambda", () => {
    it("DockerImageFunction が定義されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        PackageType: "Image",
      });
    });

    it("memorySize が 2048 MB", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        MemorySize: 2048,
      });
    });

    it("timeout が 600 秒（10分）", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Timeout: 600,
      });
    });

    it("reservedConcurrentExecutions が 4", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        ReservedConcurrentExecutions: 4,
      });
    });

    it("環境変数に ENDPOINT_NAME, BUCKET_NAME, STATUS_TABLE_NAME が設定されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: {
            ENDPOINT_NAME: TEST_ENDPOINT_NAME,
            BUCKET_NAME: Match.anyValue(),
            STATUS_TABLE_NAME: Match.anyValue(),
          },
        },
      });
    });

    it("processorFunction を公開プロパティとして持つ", () => {
      const { stack } = createStack();
      expect(stack.processorFunction).toBeDefined();
    });
  });

  // --- 3.4.3 SQS Event Source Mapping ---
  describe("SQS Event Source Mapping", () => {
    it("batchSize が 1", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        BatchSize: 1,
      });
    });

    it("reportBatchItemFailures が有効", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        FunctionResponseTypes: ["ReportBatchItemFailures"],
      });
    });
  });

  // --- 3.5 IAM Permissions ---
  describe("IAM Permissions", () => {
    it("SageMaker InvokeEndpoint 権限がエンドポイント ARN に限定されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "sagemaker:InvokeEndpoint",
              Effect: "Allow",
              Resource: `arn:aws:sagemaker:${TEST_REGION}:${TEST_ACCOUNT}:endpoint/${TEST_ENDPOINT_NAME}`,
            }),
          ]),
        },
      });
    });
  });

  // --- リソース数の確認 ---
  describe("Resource counts", () => {
    it("DynamoDB テーブルが 2 つ存在する", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::DynamoDB::Table", 2);
    });

    it("SQS キューが 2 つ存在する（メイン + DLQ）", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::SQS::Queue", 2);
    });

    it("S3 バケットが 1 つ存在する", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::S3::Bucket", 1);
    });
  });

  // --- Stack Outputs ---
  describe("Stack Outputs", () => {
    it("BucketName を出力する", () => {
      const { template } = createStack();
      template.hasOutput("BucketName", { Value: Match.anyValue() });
    });

    it("MainQueueUrl を出力する", () => {
      const { template } = createStack();
      template.hasOutput("MainQueueUrl", { Value: Match.anyValue() });
    });

    it("MainQueueArn を出力する", () => {
      const { template } = createStack();
      template.hasOutput("MainQueueArn", { Value: Match.anyValue() });
    });

    it("DeadLetterQueueArn を出力する", () => {
      const { template } = createStack();
      template.hasOutput("DeadLetterQueueArn", { Value: Match.anyValue() });
    });

    it("StatusTableName を出力する", () => {
      const { template } = createStack();
      template.hasOutput("StatusTableName", { Value: Match.anyValue() });
    });

    it("ControlTableName を出力する", () => {
      const { template } = createStack();
      template.hasOutput("ControlTableName", { Value: Match.anyValue() });
    });

    it("ProcessorFunctionName を出力する", () => {
      const { template } = createStack();
      template.hasOutput("ProcessorFunctionName", {
        Value: Match.anyValue(),
      });
    });
  });
});
