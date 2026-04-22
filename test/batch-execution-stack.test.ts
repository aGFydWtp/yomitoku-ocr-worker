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

    it("StateMachine ARN を CfnOutput で公開する", () => {
      const { template } = createStack();
      const outputs = template.findOutputs("*");
      const keys = Object.keys(outputs);
      expect(keys.some((k) => /BatchStateMachine/i.test(k))).toBe(true);
    });
  });

  describe("BatchExecutionStateMachine", () => {
    it("Step Functions ステートマシンが 1 つ存在する", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
    });

    it("stateMachine を公開プロパティとして持つ", () => {
      const { stack } = createStack();
      expect(stack.stateMachine).toBeDefined();
      expect(stack.stateMachine.stateMachineArn).toBeDefined();
    });

    it("定義に主要ステート名が含まれる", () => {
      const { template } = createStack();
      const sm = template.findResources("AWS::StepFunctions::StateMachine");
      const defStr = JSON.stringify(sm);
      for (const s of [
        "AcquireBatchLock",
        "EnsureEndpointInService",
        "WaitEndpoint",
        "RunBatchTask",
        "AggregateResults",
        "MarkCompleted",
        "MarkPartial",
        "MarkFailed",
        "MarkFailedForced",
        "ReleaseBatchLock",
        "ReleaseBatchLockOnError",
      ]) {
        expect(defStr).toContain(s);
      }
    });

    it("StopBatchTask ステートは定義されない (SFN .sync が自動停止するため; H3)", () => {
      const { template } = createStack();
      const sm = template.findResources("AWS::StepFunctions::StateMachine");
      const defStr = JSON.stringify(sm);
      // 明示的な StopBatchTask ステートを削除済み
      expect(defStr).not.toContain("StopBatchTask");
      // 失敗経路が直接 MarkFailedForced に遷移する
      expect(defStr).toContain(
        '\\"ErrorEquals\\":[\\"States.Timeout\\",\\"States.TaskFailed\\"],\\"ResultPath\\":\\"$.errorInfo\\",\\"Next\\":\\"MarkFailedForced\\"',
      );
      expect(defStr).toContain(
        '\\"ErrorEquals\\":[\\"States.ALL\\"],\\"ResultPath\\":\\"$.errorInfo\\",\\"Next\\":\\"MarkFailedForced\\"',
      );
    });

    it("RunBatchTask が ecs:runTask.sync を利用し TimeoutSeconds=7200 で動作する", () => {
      const { template } = createStack();
      const sm = template.findResources("AWS::StepFunctions::StateMachine");
      const defStr = JSON.stringify(sm);
      // ECS RunTask の .sync integration pattern
      expect(defStr).toMatch(/ecs:runTask\.sync/);
      // TimeoutSeconds=7200 が SFN 定義に直列化されている
      expect(defStr).toMatch(/\\"TimeoutSeconds\\":\s*7200/);
    });

    it("Catch: States.Timeout / States.TaskFailed が定義されている", () => {
      const { template } = createStack();
      const sm = template.findResources("AWS::StepFunctions::StateMachine");
      const defStr = JSON.stringify(sm);
      expect(defStr).toContain("States.Timeout");
      expect(defStr).toContain("States.TaskFailed");
      // SFN が .sync (RUN_JOB) で自動的にタスクを停止するため、
      // SFN 実行ロールには ecs:StopTask が自動付与される (IAM テスト参照)
    });

    it("AcquireBatchLock が ControlTable への putItem を ConditionExpression 付きで発行する", () => {
      const { template } = createStack();
      const sm = template.findResources("AWS::StepFunctions::StateMachine");
      const defStr = JSON.stringify(sm);
      expect(defStr).toMatch(/dynamodb:putItem/);
      expect(defStr).toMatch(/attribute_not_exists/);
      expect(defStr).toMatch(/BATCH_EXEC_LOCK/);
    });

    it("SFN 実行ロールが ECS RunTask と StopTask 権限を持つ", () => {
      const { template } = createStack();
      template.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({ Action: "ecs:RunTask" }),
            ]),
          }),
        }),
      );
      // StopTask は describeEndpoint / stopTask 用 CallAwsService が追加するポリシーに含まれる
      template.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: Match.arrayWith(["ecs:StopTask"]),
              }),
            ]),
          }),
        }),
      );
    });

    it("SFN 実行ロールが SageMaker DescribeEndpoint 権限を持つ", () => {
      const { template } = createStack();
      // CallAwsService は service/action を Action 文字列にマッピングするが、
      // 単一 Action/配列どちらで生成されるかは CDK バージョンに依存するため
      // IAM ポリシー全体の直列化で存在確認する。
      const policies = template.findResources("AWS::IAM::Policy");
      expect(JSON.stringify(policies)).toContain("sagemaker:DescribeEndpoint");
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
