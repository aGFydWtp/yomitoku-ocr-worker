import {
  AccessLogFormat,
  CfnAccount,
  EndpointType,
  LambdaRestApi,
  LogGroupLogDestination,
  MethodLoggingLevel,
} from "aws-cdk-lib/aws-apigateway";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { RestApiOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import {
  AnyPrincipal,
  Effect,
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { IStateMachine } from "aws-cdk-lib/aws-stepfunctions";
import type { StackProps } from "aws-cdk-lib/core";
import { CfnOutput, Duration, Stack } from "aws-cdk-lib/core";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";

/**
 * ApiStack: バッチ API のエントリポイント。
 *
 * Task 7.3 で旧エンドポイント lifecycle スタック依存を撤去:
 *   - EndpointControl 由来の `stateMachine` prop を削除し、
 *     `batchExecutionStateMachine` のみを受け取る
 *   - `STATE_MACHINE_ARN` 環境変数を撤廃 (Async Inference + AutoScaling 化で
 *     エンドポイント自動起動フローが不要になったため)
 *   - ControlTable は Fargate 側 heartbeat / last_batch_completed_at の
 *     参照用として read 権限のみ維持
 *
 * 既存 `/batches` API 契約 (パス / スキーマ / HTTP ステータス) は不変。
 *   - `/batches` POST は 503 (endpoint 未起動) 経路を持たなくなるが、
 *     SageMaker AsyncInvoke が自動スケールで吸収するため問題なし。
 */
export interface ApiStackProps extends StackProps {
  bucket: Bucket;
  controlTable: ITable;
  batchTable: ITable;
  /** BatchExecutionStateMachine — /batches/:id/start 実行用 */
  batchExecutionStateMachine: IStateMachine;
}

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { bucket, controlTable, batchTable, batchExecutionStateMachine } =
      props;

    const fn = new NodejsFunction(this, "ApiFunction", {
      entry: "lambda/api/index.ts",
      runtime: Runtime.NODEJS_24_X,
      handler: "handler",
      memorySize: 256,
      timeout: Duration.seconds(29),
      bundling: {
        minify: true,
      },
      environment: {
        BUCKET_NAME: bucket.bucketName,
        CONTROL_TABLE_NAME: controlTable.tableName,
        BATCH_TABLE_NAME: batchTable.tableName,
        BATCH_EXECUTION_STATE_MACHINE_ARN:
          batchExecutionStateMachine.stateMachineArn,
      },
    });

    // --- IAM 権限 (Task 6.2: batch-first scope / Task 7.3: orchestration 剥離) ---
    controlTable.grantReadData(fn);
    batchExecutionStateMachine.grantStartExecution(fn);

    // BatchTable: META/FILE アイテムの CRUD + GSI1/GSI2 の Query + 反解析時の
    // 原子的コピーに必要な TransactWriteItems。
    // ``BatchGetItem`` は GSI1/GSI2 が KEYS_ONLY projection のため、Query の
    // 返り keys から META 本体を引き直すのに必要 (``BatchQuery.fetchMetasByKeys``)。
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "dynamodb:GetItem",
          "dynamodb:BatchGetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:TransactWriteItems",
        ],
        resources: [batchTable.tableArn, `${batchTable.tableArn}/index/*`],
      }),
    );

    // S3: `batches/*` プレフィックスのみ。署名付き URL 発行のため Put/Get/Delete
    // と List（prefix 条件付き）を付与。ListBucket は bucket ルートを対象に
    // し、`s3:prefix` 条件で batches/* に限定する。
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [`${bucket.bucketArn}/batches/*`],
      }),
    );
    fn.addToRolePolicy(
      new PolicyStatement({
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

    // --- API Gateway アカウント設定（CloudWatch ログ用） ---
    const apiGatewayRole = new Role(this, "ApiGatewayCloudWatchRole", {
      assumedBy: new ServicePrincipal("apigateway.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonAPIGatewayPushToCloudWatchLogs",
        ),
      ],
    });
    const apigwAccount = new CfnAccount(this, "ApiGatewayAccount", {
      cloudWatchRoleArn: apiGatewayRole.roleArn,
    });

    const accessLogGroup = new LogGroup(this, "ApiAccessLog", {
      retention: RetentionDays.ONE_MONTH,
    });

    const api = new LambdaRestApi(this, "ApiGateway", {
      handler: fn,
      proxy: true,
      endpointTypes: [EndpointType.REGIONAL],
      deployOptions: {
        accessLogDestination: new LogGroupLogDestination(accessLogGroup),
        accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: MethodLoggingLevel.INFO,
      },
    });
    // デプロイステージが CfnAccount（CloudWatch ロール設定）に依存
    api.deploymentStage.node.addDependency(apigwAccount);

    new CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "API Gateway URL",
    });

    // --- Origin Verify Secret (H1) ---
    // CloudFront → API Gateway 間の共有シークレット。スタック名由来のハッシュだと
    // スタック名が既知であれば誰でも再現可能になるため、Secrets Manager で
    // 高エントロピーな値を生成し、CFN 動的参照でデプロイ時に解決する。
    const originVerifySecretResource = new Secret(this, "OriginVerifySecret", {
      description: `Origin verify secret for ${this.stackName} CloudFront → API Gateway auth`,
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
    });
    const originVerifySecret =
      originVerifySecretResource.secretValue.unsafeUnwrap();

    const wafWebAclId = this.node.tryGetContext("wafWebAclId") as
      | string
      | undefined;
    if (
      wafWebAclId &&
      !/^arn:aws:wafv2:us-east-1:\d{12}:global\/webacl\/.+$/.test(wafWebAclId)
    ) {
      throw new Error(
        `Invalid wafWebAclId format: "${wafWebAclId}". ` +
          "Must be a WAFv2 Web ACL ARN in us-east-1 (CLOUDFRONT scope).",
      );
    }

    // enableIpv6: false — WAF の IPv4 IP Set によるアクセス制限を確実にするため
    const distribution = new Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: new RestApiOrigin(api, {
          customHeaders: {
            "x-origin-verify": originVerifySecret,
            Referer: originVerifySecret,
          },
        }),
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      enableIpv6: false,
      ...(wafWebAclId && { webAclId: wafWebAclId }),
    });

    // --- API Gateway リソースポリシー（CloudFront 経由のみ許可） ---
    // arnForExecuteApi() を使うと循環参照になるためリテラル文字列を使用
    api.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        principals: [new AnyPrincipal()],
        actions: ["execute-api:Invoke"],
        resources: ["execute-api:/*"],
      }),
    );
    api.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ["execute-api:Invoke"],
        resources: ["execute-api:/*"],
        conditions: {
          StringNotEquals: {
            "aws:Referer": originVerifySecret,
          },
        },
      }),
    );

    new CfnOutput(this, "DistributionDomainName", {
      value: distribution.distributionDomainName,
      description: "CloudFront Distribution domain name",
    });

    // --- CDK Nag Suppressions ---
    NagSuppressions.addResourceSuppressions(apiGatewayRole, [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "AmazonAPIGatewayPushToCloudWatchLogs is the AWS-recommended managed policy " +
          "for API Gateway CloudWatch logging at the account level.",
        appliesTo: [
          "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs",
        ],
      },
    ]);

    NagSuppressions.addResourceSuppressions(
      fn,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "AWSLambdaBasicExecutionRole is required for CloudWatch Logs. " +
            "This is a CDK-managed Lambda execution role.",
          appliesTo: [
            "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Wildcard usages are intentional and bounded: " +
            "(a) BatchTable index/* for GSI1/GSI2 Query access, " +
            "(b) S3 batches/* prefix for scoped object CRUD + presign, " +
            "(c) ListBucket is restricted via s3:prefix condition to batches/*, " +
            "(d) stateMachine.grantStartExecution uses CDK L2 minimum permissions.",
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      api,
      [
        {
          id: "AwsSolutions-APIG2",
          reason:
            "This is a proxy-mode REST API backed by Hono framework. " +
            "Input validation is handled at the application layer.",
        },
        {
          id: "AwsSolutions-APIG4",
          reason:
            "Access control is enforced by CloudFront origin verify header + WAF IP restriction. " +
            "Cognito/IAM authorizers are not required for this use case.",
        },
        {
          id: "AwsSolutions-COG4",
          reason:
            "CloudFront origin verify header + WAF is the chosen auth strategy. " +
            "Cognito user pool authorizer is not required.",
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(api.deploymentStage, [
      {
        id: "AwsSolutions-APIG3",
        reason:
          "WAFv2 association is deferred to a later phase. " +
          "CloudFront resource policy restricts direct API access.",
      },
    ]);

    const cfDistributionSuppressions = [
      {
        id: "AwsSolutions-CFR1",
        reason:
          "Geo restrictions are not required at initial launch phase. " +
          "Will be reviewed based on usage patterns.",
      },
      ...(!wafWebAclId
        ? [
            {
              id: "AwsSolutions-CFR2",
              reason:
                "WAFv2 integration is deferred to a later phase. " +
                "API Gateway resource policy provides access control.",
            },
          ]
        : []),
      {
        id: "AwsSolutions-CFR3",
        reason:
          "CloudFront access logging will be enabled in a later phase " +
          "when an S3 logging bucket is provisioned.",
      },
      {
        id: "AwsSolutions-CFR4",
        reason:
          "Using default CloudFront viewer certificate which enforces TLSv1. " +
          "Custom domain with ACM certificate (TLSv1.2) will be added later.",
      },
    ];
    NagSuppressions.addResourceSuppressions(
      distribution,
      cfDistributionSuppressions,
    );

    // Origin verify secret は CloudFront/API Gateway 両方に static に埋め込まれる
    // ため自動ローテーションは不可。ローテーションにはスタック再デプロイが必要。
    NagSuppressions.addResourceSuppressions(originVerifySecretResource, [
      {
        id: "AwsSolutions-SMG4",
        reason:
          "This secret is injected into CloudFront origin custom headers and " +
          "API Gateway resource policy at synth time. Rotation requires full " +
          "stack redeploy and will be handled manually when needed.",
      },
    ]);
  }
}
