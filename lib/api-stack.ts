import {
  ApiKeySourceType,
  EndpointType,
  LambdaRestApi,
  Period,
} from "aws-cdk-lib/aws-apigateway";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { RestApiOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { CfnOutput, Duration, Stack } from "aws-cdk-lib/core";
import type { StackProps } from "aws-cdk-lib/core";
import { createHash } from "node:crypto";
import type { Construct } from "constructs";

export interface ApiStackProps extends StackProps {
  bucket: Bucket;
  statusTable: Table;
}

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { bucket, statusTable } = props;

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
      },
    });

    // --- IAM 権限 ---
    statusTable.grantReadWriteData(fn);
    bucket.grantPut(fn, "input/*");
    bucket.grantRead(fn, "output/*");
    bucket.grantDelete(fn, "input/*");

    const api = new LambdaRestApi(this, "ApiGateway", {
      handler: fn,
      proxy: true,
      endpointTypes: [EndpointType.REGIONAL],
      apiKeySourceType: ApiKeySourceType.HEADER,
      defaultMethodOptions: { apiKeyRequired: true },
    });

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
  }
}
