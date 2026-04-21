import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import {
  CfnOutput,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib/core";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";

/**
 * ProcessingStack: バッチ移行後の共通基盤スタック。
 *
 * 保持リソース:
 *   - `bucket`       : 入出力用 S3 バケット (EventBridge 通知あり)
 *   - `controlTable` : SageMaker エンドポイント制御ロック用 DynamoDB テーブル
 *
 * 旧単一ジョブ方式で存在した `StatusTable` / `MainQueue` / `DeadLetterQueue` /
 * `ProcessorFunction` / S3→SQS 通知 / `/input`・`/output`・`/visualizations`
 * プレフィックスに紐づく IAM 付与は撤去済み (task 1.1)。
 * `BatchTable` は後続 task 1.2 で本スタックに追加する。
 */
export class ProcessingStack extends Stack {
  public readonly bucket: Bucket;
  public readonly controlTable: Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- S3 バケット ---
    this.bucket = new Bucket(this, "DataBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
      enforceSSL: true,
      eventBridgeEnabled: true,
    });

    NagSuppressions.addResourceSuppressions(this.bucket, [
      {
        id: "AwsSolutions-S1",
        reason:
          "Access logging is not required for this bucket. " +
          "CloudTrail data events will be used for auditing if needed.",
      },
    ]);

    // CDK-internal S3 notification handler Lambda のマネージドポリシー許容
    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "The BucketNotificationsHandler Lambda is auto-created by CDK " +
          "to wire S3 EventBridge notifications. Its AWSLambdaBasicExecutionRole " +
          "managed policy cannot be replaced without ejecting from the L2 construct.",
        appliesTo: [
          "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        ],
      },
    ]);

    // --- DynamoDB エンドポイント制御テーブル ---
    this.controlTable = new Table(this, "ControlTable", {
      partitionKey: { name: "lock_key", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // --- Outputs ---
    new CfnOutput(this, "BucketName", {
      value: this.bucket.bucketName,
      description: "S3 bucket for batch inputs and outputs",
    });

    new CfnOutput(this, "ControlTableName", {
      value: this.controlTable.tableName,
      description: "DynamoDB endpoint control table name",
    });
  }
}
