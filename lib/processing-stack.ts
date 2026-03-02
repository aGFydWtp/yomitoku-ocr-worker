import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
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
      visibilityTimeout: Duration.seconds(3600),
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
    });

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
      partitionKey: { name: "file_key", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.statusTable.addGlobalSecondaryIndex({
      indexName: "status-created_at-index",
      partitionKey: { name: "status", type: AttributeType.STRING },
      sortKey: { name: "created_at", type: AttributeType.STRING },
    });

    // --- 2.4 DynamoDB エンドポイント制御テーブル ---
    this.controlTable = new Table(this, "ControlTable", {
      partitionKey: { name: "lock_key", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

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
      description: "Main SQS queue ARN (used by EventBridge Pipes in Phase 4)",
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
  }
}
