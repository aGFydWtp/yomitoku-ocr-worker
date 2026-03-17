import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
} from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { DockerImageCode, DockerImageFunction } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { BlockPublicAccess, Bucket, EventType } from "aws-cdk-lib/aws-s3";
import { SqsDestination } from "aws-cdk-lib/aws-s3-notifications";
import { type DeadLetterQueue, Queue } from "aws-cdk-lib/aws-sqs";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib/core";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";

export class ProcessingStack extends Stack {
  public readonly bucket: Bucket;
  public readonly mainQueue: Queue;
  public readonly deadLetterQueue: Queue;
  public readonly statusTable: Table;
  public readonly controlTable: Table;
  public readonly processorFunction: DockerImageFunction;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- 2.2 SQS キュー（S3 通知より先に定義） ---

    // DLQ
    this.deadLetterQueue = new Queue(this, "DeadLetterQueue", {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    NagSuppressions.addResourceSuppressions(this.deadLetterQueue, [
      {
        id: "AwsSolutions-SQS3",
        reason: "This queue is itself a DLQ; it does not need another DLQ.",
      },
    ]);

    // メインキュー
    const dlqSetting: DeadLetterQueue = {
      queue: this.deadLetterQueue,
      maxReceiveCount: 3,
    };

    this.mainQueue = new Queue(this, "MainQueue", {
      visibilityTimeout: Duration.seconds(720),
      retentionPeriod: Duration.days(14),
      receiveMessageWaitTime: Duration.seconds(20),
      deadLetterQueue: dlqSetting,
      enforceSSL: true,
    });

    // --- 2.1 S3 バケット ---
    this.bucket = new Bucket(this, "DataBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
      enforceSSL: true,
      eventBridgeEnabled: true,
    });

    // S3 → SQS: OCR processor Lambda の入力トリガー（独立パス）
    // S3 → EventBridge → Step Functions: エンドポイントライフサイクル管理（独立パス）
    // 両パスは同じ input/ プレフィックスで発火するが、互いに独立して動作する
    this.bucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new SqsDestination(this.mainQueue),
      { prefix: "input/" },
    );

    // S3 access logging: suppress because this is a single-bucket setup
    // and CloudTrail data events can be used for auditing instead
    NagSuppressions.addResourceSuppressions(this.bucket, [
      {
        id: "AwsSolutions-S1",
        reason:
          "Access logging is not required for this bucket. " +
          "CloudTrail data events will be used for auditing if needed.",
      },
    ]);

    // Suppress CDK Nag for CDK-internal S3 notification handler Lambda
    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "The BucketNotificationsHandler Lambda is auto-created by CDK " +
          "to manage S3 event notifications. Its AWSLambdaBasicExecutionRole " +
          "managed policy cannot be replaced without ejecting from the L2 construct.",
        appliesTo: [
          "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        ],
      },
    ]);

    // --- 2.3 DynamoDB ステータステーブル ---
    this.statusTable = new Table(this, "StatusTable", {
      partitionKey: { name: "job_id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.statusTable.addGlobalSecondaryIndex({
      indexName: "status-created_at-index",
      partitionKey: { name: "status", type: AttributeType.STRING },
      sortKey: { name: "created_at", type: AttributeType.STRING },
    });

    this.statusTable.addGlobalSecondaryIndex({
      indexName: "file_key-index",
      partitionKey: { name: "file_key", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // --- 2.4 DynamoDB エンドポイント制御テーブル ---
    this.controlTable = new Table(this, "ControlTable", {
      partitionKey: { name: "lock_key", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // --- 3.4 処理ワーカー Lambda ---
    const endpointName = this.node.tryGetContext("endpointName") as
      | string
      | undefined;
    if (!endpointName) {
      throw new Error(
        "endpointName must be set in cdk.json context or via --context",
      );
    }

    this.processorFunction = new DockerImageFunction(
      this,
      "ProcessorFunction",
      {
        code: DockerImageCode.fromImageAsset("lambda/processor"),
        memorySize: 2048,
        timeout: Duration.minutes(10),
        reservedConcurrentExecutions: 4,
        environment: {
          ENDPOINT_NAME: endpointName,
          BUCKET_NAME: this.bucket.bucketName,
          STATUS_TABLE_NAME: this.statusTable.tableName,
        },
      },
    );

    // 3.4.3 SQS Event Source Mapping
    this.processorFunction.addEventSource(
      new SqsEventSource(this.mainQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // --- 3.5 IAM Permissions ---
    // 3.5.1 S3 input/ read
    this.bucket.grantRead(this.processorFunction, "input/*");
    // 3.5.2 S3 output/ write
    this.bucket.grantPut(this.processorFunction, "output/*");
    // 3.5.6 S3 visualizations/ write
    this.bucket.grantPut(this.processorFunction, "visualizations/*");
    // 3.5.3 DynamoDB status table read/write
    this.statusTable.grantReadWriteData(this.processorFunction);
    // 3.5.4 SQS consume (automatically granted by SqsEventSource)
    // 3.5.5 SageMaker InvokeEndpoint + DescribeEndpoint
    this.processorFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "SageMakerEndpointAccess",
        effect: Effect.ALLOW,
        actions: ["sagemaker:InvokeEndpoint", "sagemaker:DescribeEndpoint"],
        resources: [
          `arn:aws:sagemaker:${this.region}:${this.account}:endpoint/${endpointName}`,
        ],
      }),
    );

    // CDK Nag suppressions for Lambda
    NagSuppressions.addResourceSuppressions(
      this.processorFunction,
      [
        {
          id: "AwsSolutions-L1",
          reason:
            "This Lambda uses a Docker container image (DockerImageFunction), " +
            "not a managed runtime. Runtime version management is handled by the Dockerfile.",
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "S3 grantRead/grantPut use wildcard actions (s3:GetObject*, s3:GetBucket*, " +
            "s3:List*, s3:Abort*) scoped to specific prefixes (input/*, output/*). " +
            "DynamoDB grantReadWriteData includes index/* for GSI access. " +
            "These are the minimum permissions generated by CDK L2 grant methods.",
          appliesTo: [
            "Action::s3:GetBucket*",
            "Action::s3:GetObject*",
            "Action::s3:List*",
            "Action::s3:Abort*",
            "Resource::<DataBucketE3889A50.Arn>/input/*",
            "Resource::<DataBucketE3889A50.Arn>/output/*",
            "Resource::<DataBucketE3889A50.Arn>/visualizations/*",
            "Resource::<StatusTable0F76785B.Arn>/index/*",
          ],
        },
      ],
      true,
    );

    // --- Outputs ---
    new CfnOutput(this, "BucketName", {
      value: this.bucket.bucketName,
      description: "S3 bucket for input/output files",
    });

    new CfnOutput(this, "MainQueueUrl", {
      value: this.mainQueue.queueUrl,
      description: "Main SQS queue URL",
    });

    new CfnOutput(this, "MainQueueArn", {
      value: this.mainQueue.queueArn,
      description: "Main SQS queue ARN (consumed by OCR processor Lambda)",
    });

    new CfnOutput(this, "DeadLetterQueueArn", {
      value: this.deadLetterQueue.queueArn,
      description: "Dead letter queue ARN",
    });

    new CfnOutput(this, "StatusTableName", {
      value: this.statusTable.tableName,
      description: "DynamoDB status table name",
    });

    new CfnOutput(this, "ControlTableName", {
      value: this.controlTable.tableName,
      description: "DynamoDB endpoint control table name",
    });

    new CfnOutput(this, "ProcessorFunctionName", {
      value: this.processorFunction.functionName,
      description: "OCR processor Lambda function name",
    });
  }
}
