import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { ContainerImage } from "aws-cdk-lib/aws-ecs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { App, Stack } from "aws-cdk-lib/core";
import { BatchExecutionStack } from "../lib/batch-execution-stack";

const TEST_REGION = "ap-northeast-1";
const TEST_ACCOUNT = "123456789012";
const TEST_ENDPOINT_NAME = "yomitoku-pro-endpoint";

function createStack(): {
  app: App;
  stack: BatchExecutionStack;
  template: Template;
} {
  const app = new App();

  const depStack = new Stack(app, "DepStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
  });
  const batchTable = new Table(depStack, "BatchTable", {
    partitionKey: { name: "PK", type: AttributeType.STRING },
    sortKey: { name: "SK", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });
  const controlTable = new Table(depStack, "ControlTable", {
    partitionKey: { name: "lock_key", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });
  const bucket = new Bucket(depStack, "DataBucket");

  const stack = new BatchExecutionStack(app, "TestBatchExecutionStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
    batchTable,
    controlTable,
    bucket,
    endpointName: TEST_ENDPOINT_NAME,
    // テスト用にプレースホルダイメージを注入（Docker ビルドを避ける）
    containerImage: ContainerImage.fromRegistry("placeholder:latest"),
  });
  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("BatchExecutionStack", () => {
  describe("ECS Cluster", () => {
    it("ECS クラスタが 1 つ存在する", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::ECS::Cluster", 1);
    });
  });

  describe("Fargate Task Definition", () => {
    it("Fargate 互換で 4 vCPU (4096) / 16 GB (16384) のタスク定義が存在する", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::ECS::TaskDefinition", {
        Cpu: "4096",
        Memory: "16384",
        NetworkMode: "awsvpc",
        RequiresCompatibilities: ["FARGATE"],
      });
    });

    it("コンテナ定義に awslogs ログドライバが設定されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::ECS::TaskDefinition", {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            LogConfiguration: Match.objectLike({
              LogDriver: "awslogs",
            }),
          }),
        ]),
      });
    });

    it("BatchTable/ControlTable/Bucket/Endpoint を参照する環境変数が配線されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::ECS::TaskDefinition", {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([
              Match.objectLike({ Name: "BATCH_TABLE_NAME" }),
              Match.objectLike({ Name: "CONTROL_TABLE_NAME" }),
              Match.objectLike({ Name: "BUCKET_NAME" }),
              Match.objectLike({
                Name: "ENDPOINT_NAME",
                Value: TEST_ENDPOINT_NAME,
              }),
            ]),
          }),
        ]),
      });
    });

    it("taskDefinition と cluster を公開プロパティとして持つ", () => {
      const { stack } = createStack();
      expect(stack.taskDefinition).toBeDefined();
      expect(stack.cluster).toBeDefined();
      expect(stack.containerName).toBeDefined();
    });
  });

  describe("CloudWatch Logs", () => {
    it("LogGroup が作成され保持期間が設定されている", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::Logs::LogGroup", 1);
      template.hasResourceProperties(
        "AWS::Logs::LogGroup",
        Match.objectLike({ RetentionInDays: Match.anyValue() }),
      );
    });
  });

  describe("Task Role IAM", () => {
    it("Task Role が BatchTable と ControlTable の DDB 更新系 Action を持つ", () => {
      const { template } = createStack();
      // DDB grantReadWriteData は Query/GetItem/PutItem/UpdateItem/DeleteItem を含むポリシーを生成する。
      // Match.arrayWith は subsequence セマンティクスなので CDK 生成順 (Query→GetItem→...→PutItem→...→DeleteItem) に合わせる。
      const requiredActions = [
        "dynamodb:Query",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
      ];
      template.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: Match.arrayWith(requiredActions),
                Effect: "Allow",
              }),
            ]),
          }),
        }),
      );
    });

    it("Task Role が S3 batches/* prefix への Get/Put/Delete/AbortMultipartUpload を持つ", () => {
      const { template } = createStack();
      // Match.arrayWith は subsequence セマンティクスなので、CDK が生成する
      // 宣言順 (GetObject → PutObject → DeleteObject → AbortMultipartUpload) に合わせる。
      template.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: Match.arrayWith([
                  "s3:GetObject",
                  "s3:PutObject",
                  "s3:DeleteObject",
                  "s3:AbortMultipartUpload",
                ]),
                Effect: "Allow",
                Sid: "BatchS3Access",
                // batches/* prefix 付きリソース (Fn::Join 生成)
                Resource: Match.objectLike({
                  "Fn::Join": Match.arrayWith([
                    Match.arrayWith([Match.stringLikeRegexp("/batches/\\*")]),
                  ]),
                }),
              }),
            ]),
          }),
        }),
      );
    });

    it("Task Role が S3 ListBucket を batches/* prefix 条件付きで持つ", () => {
      const { template } = createStack();
      // ListBucket はバケット全体 ARN が対象のため、prefix 条件による絞り込みが必須。
      template.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: "s3:ListBucket",
                Effect: "Allow",
                Sid: "BatchS3List",
                Condition: Match.objectLike({
                  StringLike: Match.objectLike({
                    "s3:prefix": ["batches/*"],
                  }),
                }),
              }),
            ]),
          }),
        }),
      );
    });

    it("Task Role が SageMaker InvokeEndpoint と DescribeEndpoint を持つ", () => {
      const { template } = createStack();
      template.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: Match.arrayWith([
                  "sagemaker:InvokeEndpoint",
                  "sagemaker:DescribeEndpoint",
                ]),
                Effect: "Allow",
              }),
            ]),
          }),
        }),
      );
    });
  });

  describe("Outputs", () => {
    it("TaskDefinition ARN と Cluster 名を CfnOutput で公開する", () => {
      const { template } = createStack();
      const outputs = template.findOutputs("*");
      const keys = Object.keys(outputs);
      expect(keys.some((k) => /TaskDefinition/i.test(k))).toBe(true);
      expect(keys.some((k) => /Cluster/i.test(k))).toBe(true);
    });
  });

  describe("Props validation", () => {
    it("endpointName が空文字 / 未指定の場合エラーになる", () => {
      const app = new App();
      const depStack = new Stack(app, "DepStack", {
        env: { region: TEST_REGION, account: TEST_ACCOUNT },
      });
      const batchTable = new Table(depStack, "B", {
        partitionKey: { name: "PK", type: AttributeType.STRING },
        billingMode: BillingMode.PAY_PER_REQUEST,
      });
      const controlTable = new Table(depStack, "C", {
        partitionKey: { name: "lock_key", type: AttributeType.STRING },
        billingMode: BillingMode.PAY_PER_REQUEST,
      });
      const bucket = new Bucket(depStack, "D");

      expect(() => {
        new BatchExecutionStack(app, "Bad", {
          env: { region: TEST_REGION, account: TEST_ACCOUNT },
          batchTable,
          controlTable,
          bucket,
          endpointName: "",
          containerImage: ContainerImage.fromRegistry("placeholder:latest"),
        });
      }).toThrow(/endpointName/);
    });
  });
});
