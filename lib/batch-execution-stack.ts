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
  Choice,
  Condition,
  DefinitionBody,
  Fail,
  IntegrationPattern,
  JsonPath,
  StateMachine,
  Succeed,
  Timeout,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  CallAwsService,
  DynamoAttributeValue,
  DynamoDeleteItem,
  DynamoGetItem,
  DynamoPutItem,
  DynamoUpdateItem,
  EcsFargateLaunchTarget,
  EcsRunTask,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib/core";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";

/** RunBatchTask (.sync) の task timeout。BatchRunner の最大実行時間 2 時間に合わせる。 */
export const BATCH_TASK_TIMEOUT_SECONDS = 7200;

/**
 * StateMachine 全体のタイムアウト。`BATCH_TASK_TIMEOUT_SECONDS` に
 * Lock 獲得・エンドポイント確認・ロック解放などのオーバーヘッド (約 800 秒)
 * を加えた値で、タスク自体のタイムアウトより必ず長くする。
 */
export const SFN_EXECUTION_TIMEOUT_SECONDS = BATCH_TASK_TIMEOUT_SECONDS + 800;

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
  public readonly stateMachine: StateMachine;

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
    // ControlTable は heartbeat (Put/Update/Delete) のみ利用。
    // GetItem/Scan は不要なので `grantReadWriteData` の広範な権限は付けず、
    // 必要最小限のアクションに絞る。
    this.taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        sid: "BatchControlTableHeartbeat",
        effect: Effect.ALLOW,
        actions: [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:ConditionCheckItem",
        ],
        resources: [controlTable.tableArn],
      }),
    );

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

    // --- Step Functions: BatchExecutionStateMachine ---
    const definition = this.buildBatchStateMachineDefinition(
      batchTable,
      controlTable,
      endpointName,
    );

    // SFN 全体タイムアウト: RunBatchTask の taskTimeout より必ず長く設定する
    this.stateMachine = new StateMachine(this, "BatchExecutionStateMachine", {
      definitionBody: DefinitionBody.fromChainable(definition),
      timeout: Duration.seconds(SFN_EXECUTION_TIMEOUT_SECONDS),
    });

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

    NagSuppressions.addResourceSuppressions(
      this.stateMachine,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Step Functions execution role wildcards are generated by CDK for " +
            "ECS RunTask/StopTask and DynamoDB grant methods over per-batch keys.",
        },
        {
          id: "AwsSolutions-SF1",
          reason:
            "CloudWatch Logs for Step Functions will be enabled in monitoring phase (task 5.1).",
        },
        {
          id: "AwsSolutions-SF2",
          reason:
            "X-Ray tracing for Step Functions will be evaluated in monitoring phase (task 5.1).",
        },
      ],
      true,
    );

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

    new CfnOutput(this, "BatchStateMachineArn", {
      value: this.stateMachine.stateMachineArn,
      description: "Batch execution Step Functions state machine ARN",
    });
  }

  /**
   * BatchExecutionStateMachine の定義を構築する。
   *
   * フロー:
   *   AcquireBatchLock (ControlTable, BATCH_EXEC_LOCK#{id}, attribute_not_exists)
   *     ├─ ConditionalCheckFailedException → LockNotAcquired (Succeed)
   *     └─ 成功 → EnsureEndpointInService
   *   EnsureEndpointInService (sagemaker:DescribeEndpoint)
   *     └─ EndpointStatus == InService → RunBatchTask
   *        それ以外                    → WaitEndpoint (60s) → EnsureEndpointInService (ループ)
   *   RunBatchTask (ecs:runTask.sync, taskTimeout=BATCH_TASK_TIMEOUT_SECONDS)
   *     ├─ States.Timeout / States.TaskFailed / States.ALL
   *     │    → MarkFailedForced → ReleaseBatchLockOnError → Failed
   *     │    (注: `.sync` (RUN_JOB) 統合では SFN がタスクを自動停止するため
   *     │     明示的な stopTask は不要)
   *     └─ 成功 → AggregateResults
   *   AggregateResults (BatchTable META の status を読む)
   *     └─ DetermineFinalStatus
   *        ├─ COMPLETED → MarkCompleted → ReleaseBatchLock → Done
   *        ├─ PARTIAL   → MarkPartial   → ReleaseBatchLock → Done
   *        └─ otherwise → MarkFailed    → ReleaseBatchLock → Done
   */
  private buildBatchStateMachineDefinition(
    batchTable: ITable,
    controlTable: ITable,
    endpointName: string,
  ) {
    const batchPkKey = DynamoAttributeValue.fromString(
      JsonPath.format("BATCH#{}", JsonPath.stringAt("$.batchJobId")),
    );
    const lockKey = DynamoAttributeValue.fromString(
      JsonPath.format("BATCH_EXEC_LOCK#{}", JsonPath.stringAt("$.batchJobId")),
    );
    const metaSortKey = DynamoAttributeValue.fromString("META");

    // --- AcquireBatchLock ---
    const acquireBatchLock = new DynamoPutItem(this, "AcquireBatchLock", {
      table: controlTable,
      item: {
        lock_key: lockKey,
        execution_id: DynamoAttributeValue.fromString(
          JsonPath.stringAt("$$.Execution.Id"),
        ),
        acquired_at: DynamoAttributeValue.fromString(
          JsonPath.stringAt("$$.Execution.StartTime"),
        ),
      },
      conditionExpression: "attribute_not_exists(lock_key)",
      resultPath: JsonPath.DISCARD,
    });

    const lockNotAcquired = new Succeed(this, "LockNotAcquired", {
      comment: "Another execution already holds the batch lock",
    });

    // --- EnsureEndpointInService (describe → choice → wait loop) ---
    const ensureEndpointInService = new CallAwsService(
      this,
      "EnsureEndpointInService",
      {
        service: "sagemaker",
        action: "describeEndpoint",
        parameters: { EndpointName: endpointName },
        iamResources: [
          `arn:aws:sagemaker:${this.region}:${this.account}:endpoint/${endpointName}`,
        ],
        resultPath: "$.endpointResult",
      },
    );

    const waitEndpoint = new Wait(this, "WaitEndpoint", {
      time: WaitTime.duration(Duration.seconds(60)),
    });

    // --- RunBatchTask (ecs:runTask.sync, 7200s timeout) ---
    const containerDefinition = this.taskDefinition.findContainer(
      this.containerName,
    );
    if (!containerDefinition) {
      throw new Error(
        `Container definition '${this.containerName}' not found in task definition`,
      );
    }
    const runBatchTask = new EcsRunTask(this, "RunBatchTask", {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      launchTarget: new EcsFargateLaunchTarget(),
      integrationPattern: IntegrationPattern.RUN_JOB,
      taskTimeout: Timeout.duration(
        Duration.seconds(BATCH_TASK_TIMEOUT_SECONDS),
      ),
      containerOverrides: [
        {
          containerDefinition,
          environment: [
            {
              name: "BATCH_JOB_ID",
              value: JsonPath.stringAt("$.batchJobId"),
            },
          ],
        },
      ],
      resultPath: "$.ecsResult",
    });

    // --- AggregateResults ---
    const aggregateResults = new DynamoGetItem(this, "AggregateResults", {
      table: batchTable,
      key: { PK: batchPkKey, SK: metaSortKey },
      resultPath: "$.metaResult",
    });

    // --- Mark* states (idempotent UpdateItem on META.status) ---
    const buildMarkStatus = (id: string, status: string) =>
      new DynamoUpdateItem(this, id, {
        table: batchTable,
        key: { PK: batchPkKey, SK: metaSortKey },
        expressionAttributeNames: { "#s": "status" },
        expressionAttributeValues: {
          ":s": DynamoAttributeValue.fromString(status),
        },
        updateExpression: "SET #s = :s",
        resultPath: JsonPath.DISCARD,
      });
    const markCompleted = buildMarkStatus("MarkCompleted", "COMPLETED");
    const markPartial = buildMarkStatus("MarkPartial", "PARTIAL");
    const markFailed = buildMarkStatus("MarkFailed", "FAILED");
    const markFailedForced = buildMarkStatus("MarkFailedForced", "FAILED");

    // --- ReleaseBatchLock (success & error variants) ---
    const releaseBatchLock = new DynamoDeleteItem(this, "ReleaseBatchLock", {
      table: controlTable,
      key: { lock_key: lockKey },
      resultPath: JsonPath.DISCARD,
    });
    const releaseBatchLockOnError = new DynamoDeleteItem(
      this,
      "ReleaseBatchLockOnError",
      {
        table: controlTable,
        key: { lock_key: lockKey },
        resultPath: JsonPath.DISCARD,
      },
    );

    // StopBatchTask は意図的に省略する。`EcsRunTask` の RUN_JOB (.sync) 統合は
    // States.Timeout / States.TaskFailed 発生時に SFN ランタイムが自動的に
    // `ecs:StopTask` を発行する仕様であり、Cause (JSON 文字列) から TaskArn を
    // 抽出して明示的に stopTask を呼び出すことは正しく行えない (H3 コードレビュー
    // 対応)。

    // --- Terminal states ---
    const done = new Succeed(this, "Done", {
      comment: "Batch execution completed",
    });
    const failed = new Fail(this, "Failed", {
      cause: "Batch execution failed; see execution history for details",
    });

    // --- Wiring ---
    acquireBatchLock.addCatch(lockNotAcquired, {
      errors: ["DynamoDB.ConditionalCheckFailedException"],
      resultPath: "$.lockError",
    });
    acquireBatchLock.next(ensureEndpointInService);

    const endpointReady = new Choice(this, "EndpointReady?")
      .when(
        Condition.stringEquals("$.endpointResult.EndpointStatus", "InService"),
        runBatchTask,
      )
      .otherwise(waitEndpoint);

    ensureEndpointInService.next(endpointReady);
    waitEndpoint.next(ensureEndpointInService);

    // タイムアウト・タスク失敗時は SFN ランタイムが自動で stopTask を発行する。
    // 本 StateMachine 側では MarkFailedForced に直接遷移させる。
    runBatchTask.addCatch(markFailedForced, {
      errors: ["States.Timeout", "States.TaskFailed"],
      resultPath: "$.errorInfo",
    });
    // 想定外エラー (States.ALL は単独で指定する必要がある) も同様に MarkFailedForced。
    runBatchTask.addCatch(markFailedForced, {
      errors: ["States.ALL"],
      resultPath: "$.errorInfo",
    });
    runBatchTask.next(aggregateResults);

    const finalStatusChoice = new Choice(this, "DetermineFinalStatus")
      .when(
        Condition.stringEquals("$.metaResult.Item.status.S", "COMPLETED"),
        markCompleted,
      )
      .when(
        Condition.stringEquals("$.metaResult.Item.status.S", "PARTIAL"),
        markPartial,
      )
      .otherwise(markFailed);
    aggregateResults.next(finalStatusChoice);

    markCompleted.next(releaseBatchLock);
    markPartial.next(releaseBatchLock);
    markFailed.next(releaseBatchLock);
    releaseBatchLock.next(done);

    markFailedForced.next(releaseBatchLockOnError);
    releaseBatchLockOnError.next(failed);

    return acquireBatchLock;
  }
}
