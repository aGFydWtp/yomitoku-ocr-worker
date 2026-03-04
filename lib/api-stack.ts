import {
  ApiKeySourceType,
  EndpointType,
  LambdaRestApi,
  Period,
} from "aws-cdk-lib/aws-apigateway";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { CfnOutput, Duration, Stack } from "aws-cdk-lib/core";
import type { StackProps } from "aws-cdk-lib/core";
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
  }
}
