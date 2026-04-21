import { createHash } from "node:crypto";
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
import type { IStateMachine } from "aws-cdk-lib/aws-stepfunctions";
import type { StackProps } from "aws-cdk-lib/core";
import { CfnOutput, Duration, Stack } from "aws-cdk-lib/core";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";

/**
 * ApiStack: バッチ API のエントリポイント。
 *
 * 旧単一ジョブ方式の `StatusTable` 依存と `input/` / `output/` /
 * `visualizations/` プレフィックス専用 IAM 付与は task 1.1 で撤去済み。
 * バッチ方式用の `BatchTable` と S3 `batches/*` プレフィックスへの IAM は
 * 後続 task 1.2 / 2.* / 6.2 で再整備する。
 */
export interface ApiStackProps extends StackProps {
  bucket: Bucket;
  controlTable: ITable;
  stateMachine: IStateMachine;
}

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { bucket, controlTable, stateMachine } = props;

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
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      },
    });

    // --- IAM 権限 ---
    controlTable.grantReadData(fn);
    stateMachine.grantStartExecution(fn);
    // NOTE: S3 prefix 別 (input/* / output/* / visualizations/*) の権限は
    //       legacy のため削除。batch 用 `batches/*` プレフィックスの IAM は
    //       task 2.* / 6.2 で再付与する。

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

    // --- CloudFront Distribution ---
    const originVerifySecret = createHash("sha256")
      .update(`${this.stackName}-origin-verify`)
      .digest("hex");

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
            "DynamoDB grantReadData includes index/* for GSI access, and " +
            "stateMachine.grantStartExecution generates minimum CDK L2 permissions.",
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
  }
}
