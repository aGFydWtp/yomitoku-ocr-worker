import { createHash } from "node:crypto";
import {
  AccessLogFormat,
  ApiKeySourceType,
  CfnAccount,
  EndpointType,
  LambdaRestApi,
  LogGroupLogDestination,
  MethodLoggingLevel,
  Period,
} from "aws-cdk-lib/aws-apigateway";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { RestApiOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import type { ITable, Table } from "aws-cdk-lib/aws-dynamodb";
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

export interface ApiStackProps extends StackProps {
  bucket: Bucket;
  statusTable: Table;
  controlTable: ITable;
  stateMachine: IStateMachine;
}

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { bucket, statusTable, controlTable, stateMachine } = props;

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
        STATUS_TABLE_NAME: statusTable.tableName,
        BUCKET_NAME: bucket.bucketName,
        CONTROL_TABLE_NAME: controlTable.tableName,
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      },
    });

    // --- IAM 権限 ---
    statusTable.grantReadWriteData(fn);
    controlTable.grantReadData(fn);
    stateMachine.grantStartExecution(fn);
    bucket.grantPut(fn, "input/*");
    bucket.grantRead(fn, "output/*");
    bucket.grantRead(fn, "visualizations/*");
    bucket.grantDelete(fn, "input/*");

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
      apiKeySourceType: ApiKeySourceType.HEADER,
      defaultMethodOptions: { apiKeyRequired: true },
      deployOptions: {
        accessLogDestination: new LogGroupLogDestination(accessLogGroup),
        accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: MethodLoggingLevel.INFO,
      },
    });
    // デプロイステージが CfnAccount（CloudWatch ロール設定）に依存
    api.deploymentStage.node.addDependency(apigwAccount);

    const plan = api.addUsagePlan("UsagePlan", {
      throttle: { rateLimit: 100, burstLimit: 200 },
      quota: { limit: 10000, period: Period.DAY },
    });

    const apiKey = api.addApiKey("ApiKey");
    plan.addApiKey(apiKey);
    plan.addApiStage({ stage: api.deploymentStage });

    new CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "API Gateway URL",
    });

    new CfnOutput(this, "ApiKeyId", {
      value: apiKey.keyId,
      description:
        "API Key ID (run: aws apigateway get-api-key --api-key <ID> --include-value)",
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
            "S3 grantPut/grantRead/grantDelete use wildcard actions " +
            "(s3:GetObject*, s3:GetBucket*, s3:List*, s3:Abort*, s3:DeleteObject*) " +
            "scoped to specific prefixes (input/*, output/*). " +
            "DynamoDB grantReadWriteData includes index/* for GSI access. " +
            "controlTable.grantReadData and stateMachine.grantStartExecution " +
            "generate minimum CDK L2 grant permissions.",
          appliesTo: [
            "Action::s3:Abort*",
            "Action::s3:DeleteObject*",
            "Action::s3:GetBucket*",
            "Action::s3:GetObject*",
            "Action::s3:List*",
            "Resource::<DataBucketE3889A50.Arn>/input/*",
            "Resource::<DataBucketE3889A50.Arn>/output/*",
            "Resource::<DataBucketE3889A50.Arn>/visualizations/*",
            "Resource::<StatusTable0F76785B.Arn>/index/*",
            "Resource::<ControlTableB3A8D1BC.Arn>/index/*",
          ],
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
            "API Key authentication is used via apiKeyRequired: true. " +
            "Cognito/IAM authorizers are not required for this use case.",
        },
        {
          id: "AwsSolutions-COG4",
          reason:
            "API Key + CloudFront origin verify header is the chosen auth strategy. " +
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
