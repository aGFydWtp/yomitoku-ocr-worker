import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  CpuArchitecture,
  FargateTaskDefinition,
  LogDriver,
  OperatingSystemFamily,
} from "aws-cdk-lib/aws-ecs";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import {
  CfnOutput,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib/core";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";

/**
 * BatchExecutionStack: バッチ実行用 ECS Cluster / Fargate Task Definition を提供するスタック。
 *
 * 旧単一ジョブ方式の Lambda 処理を廃止し、`yomitoku-client==0.2.0` を用いた
 * 長時間バッチ (最大 15 分以上) を Fargate タスクで実行するための基盤。
 *
 * 役割:
 *   - ECS Cluster (既定 VPC) と Fargate Task Definition (4 vCPU / 16 GB) を提供
 *   - Task Role に BatchTable/ControlTable/S3 batches prefix/SageMaker Endpoint 権限を付与
 *   - 環境変数に BATCH_TABLE_NAME / CONTROL_TABLE_NAME / BUCKET_NAME / ENDPOINT_NAME を配線
 *
 * `BATCH_JOB_ID` は Step Functions からの containerOverrides で渡すため
 * タスク定義には含めない (task 4.2 で StateMachine 側に実装)。
 */
export interface BatchExecutionStackProps extends StackProps {
  batchTable: ITable;
  controlTable: ITable;
  bucket: IBucket;
  /**
   * SageMaker エンドポイント名。呼び出し側 (bin/app.ts) で context から
   * 明示的に読み出して渡すことで、cdk.json への暗黙結合を避ける。
   */
  endpointName: string;
  /**
   * テスト時の Docker ビルド回避用にコンテナイメージを注入可能にする。
   * 本番 (bin/app.ts) では省略し、Dockerfile を `ContainerImage.fromAsset` でビルドする。
   */
  containerImage?: ContainerImage;
}

export class BatchExecutionStack extends Stack {
  public readonly cluster: Cluster;
  public readonly taskDefinition: FargateTaskDefinition;
  public readonly containerName: string;

  constructor(scope: Construct, id: string, props: BatchExecutionStackProps) {
    super(scope, id, props);

    const { batchTable, controlTable, bucket, endpointName, containerImage } =
      props;

    if (!endpointName) {
      throw new Error(
        "endpointName must be provided via BatchExecutionStackProps",
      );
    }

    // --- VPC ---
    // 既定では `Vpc.fromLookup(isDefault: true)` を使うが、これは synth 時に
    // EC2 DescribeVpcs を呼び `cdk.context.json` にキャッシュする副作用を伴う。
    // CI/CD で資格情報や事前キャッシュが無い場合、CDK はダミー VPC で synth を
    // 通してしまうため、明示的な `vpcId` context での上書きを推奨する。
    const explicitVpcId = this.node.tryGetContext("batchVpcId") as
      | string
      | undefined;
    const vpc = explicitVpcId
      ? Vpc.fromLookup(this, "BatchVpc", { vpcId: explicitVpcId })
      : Vpc.fromLookup(this, "BatchVpc", { isDefault: true });

    // --- ECS Cluster ---
    // Container Insights (v2) は monitoring フェーズ (task 5.1) で別途有効化予定。
    this.cluster = new Cluster(this, "BatchCluster", { vpc });

    // --- CloudWatch Logs ---
    // バッチ実行ログは監査 / トラブルシュート用途で保持するため `cdk destroy` でも残す。
    const logGroup = new LogGroup(this, "BatchLogGroup", {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- Fargate Task Definition (4 vCPU / 16 GB) ---
    this.taskDefinition = new FargateTaskDefinition(this, "BatchTaskDef", {
      cpu: 4096,
      memoryLimitMiB: 16384,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.X86_64,
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
    });

    // --- Container Definition ---
    this.containerName = "batch-runner";
    const image =
      containerImage ??
      ContainerImage.fromAsset("lambda/batch-runner", {
        exclude: [
          ".venv",
          "__pycache__",
          ".pytest_cache",
          ".coverage",
          "tests",
          ".gitkeep",
        ],
      });

    this.taskDefinition.addContainer(this.containerName, {
      image,
      logging: LogDriver.awsLogs({
        logGroup,
        streamPrefix: "batch-runner",
      }),
      environment: {
        BATCH_TABLE_NAME: batchTable.tableName,
        CONTROL_TABLE_NAME: controlTable.tableName,
        BUCKET_NAME: bucket.bucketName,
        ENDPOINT_NAME: endpointName,
      },
    });

    // --- Task Role IAM permissions ---
    batchTable.grantReadWriteData(this.taskDefinition.taskRole);
    controlTable.grantReadWriteData(this.taskDefinition.taskRole);

    // S3: batches/* prefix 配下への Get/Put/Delete/List
    this.taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        sid: "BatchS3Access",
        effect: Effect.ALLOW,
        actions: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
        ],
        resources: [`${bucket.bucketArn}/batches/*`],
      }),
    );
    this.taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        sid: "BatchS3List",
        effect: Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [bucket.bucketArn],
        conditions: {
          StringLike: {
            "s3:prefix": ["batches/*"],
          },
        },
      }),
    );

    // SageMaker: エンドポイント呼び出し + 状態確認
    this.taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        sid: "SageMakerInvokeEndpoint",
        effect: Effect.ALLOW,
        actions: ["sagemaker:InvokeEndpoint", "sagemaker:DescribeEndpoint"],
        resources: [
          `arn:aws:sagemaker:${this.region}:${this.account}:endpoint/${endpointName}`,
        ],
      }),
    );

    // --- CDK Nag suppressions ---
    NagSuppressions.addResourceSuppressions(
      this.taskDefinition,
      [
        {
          id: "AwsSolutions-ECS2",
          reason:
            "Environment variables (table/bucket/endpoint names) are non-sensitive " +
            "CloudFormation references resolved at deployment time.",
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "DynamoDB grantReadWriteData generates index/* wildcards and S3 batches/* " +
            "prefix wildcard is required for per-job key paths.",
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(this.cluster, [
      {
        id: "AwsSolutions-ECS4",
        reason:
          "Container Insights will be enabled in monitoring phase (task 5.1).",
      },
    ]);

    // --- Outputs ---
    new CfnOutput(this, "BatchTaskDefinitionArn", {
      value: this.taskDefinition.taskDefinitionArn,
      description: "Batch runner Fargate TaskDefinition ARN",
    });

    new CfnOutput(this, "BatchClusterName", {
      value: this.cluster.clusterName,
      description: "Batch runner ECS cluster name",
    });

    new CfnOutput(this, "BatchContainerName", {
      value: this.containerName,
      description: "Container name for containerOverrides",
    });
  }
}
