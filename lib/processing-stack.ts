import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
} from "aws-cdk-lib/aws-dynamodb";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import {
  CfnOutput,
  Duration,
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
 *   - `batchTable`   : Single-table BatchTable (PK/SK + GSI1/GSI2 + TTL)
 *
 * 旧単一ジョブ方式の状態テーブル / SQS キュー / 処理ワーカー Lambda /
 * S3→SQS 通知 / 単一ジョブ向けプレフィックスに紐づく IAM 付与は撤去済み
 * (task 1.1)。
 */
export class ProcessingStack extends Stack {
  public readonly bucket: Bucket;
  public readonly controlTable: Table;
  public readonly batchTable: Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- S3 バケット ---
    this.bucket = new Bucket(this, "DataBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
      enforceSSL: true,
      eventBridgeEnabled: true,
      lifecycleRules: [
        {
          // logs: 長期保管 (365 日)
          id: "BatchLogsRetention",
          prefix: "batches/",
          tagFilters: { "batch-content-type": "log" },
          expiration: Duration.days(365),
          enabled: true,
        },
        {
          // visualizations: 短期 (30 日)
          id: "BatchVisualizationsRetention",
          prefix: "batches/",
          tagFilters: { "batch-content-type": "visualization" },
          expiration: Duration.days(30),
          enabled: true,
        },
        {
          // results: 短期 (30 日)
          id: "BatchResultsRetention",
          prefix: "batches/",
          tagFilters: { "batch-content-type": "result" },
          expiration: Duration.days(30),
          enabled: true,
        },
      ],
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

    // --- DynamoDB BatchTable (Single-table: task 1.2) ---
    this.batchTable = new Table(this, "BatchTable", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "ttl",
    });

    // GSI1: バッチ一覧・ステータス検索 (STATUS#{status}#{yyyymm} / createdAt)
    // META アイテムのみが GSI1PK を持つスパースインデックス。KEYS_ONLY で余分な属性複製を防ぐ。
    this.batchTable.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });

    // GSI2: 再解析親子参照 (PARENT#{parentBatchJobId} / createdAt)
    // META アイテムのみが GSI2PK を持つスパースインデックス。KEYS_ONLY で余分な属性複製を防ぐ。
    this.batchTable.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "GSI2PK", type: AttributeType.STRING },
      sortKey: { name: "GSI2SK", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });

    NagSuppressions.addResourceSuppressions(this.batchTable, [
      {
        id: "AwsSolutions-DDB3",
        reason:
          "PITR is explicitly enabled via pointInTimeRecoverySpecification.",
      },
    ]);

    // --- Outputs ---
    new CfnOutput(this, "BucketName", {
      value: this.bucket.bucketName,
      description: "S3 bucket for batch inputs and outputs",
    });

    new CfnOutput(this, "ControlTableName", {
      value: this.controlTable.tableName,
      description: "DynamoDB endpoint control table name",
    });

    new CfnOutput(this, "BatchTableName", {
      value: this.batchTable.tableName,
      description: "DynamoDB single-table for batch and file state",
    });
  }
}
