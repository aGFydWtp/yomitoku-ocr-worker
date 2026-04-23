#!/usr/bin/env node
import { App, Aspects } from "aws-cdk-lib/core";
import { AwsSolutionsChecks } from "cdk-nag";
import { ApiStack } from "../lib/api-stack";
import { resolveAsyncRuntimeContext } from "../lib/async-runtime-context";
import { BatchExecutionStack } from "../lib/batch-execution-stack";
import { MonitoringStack } from "../lib/monitoring-stack";
import { ProcessingStack } from "../lib/processing-stack";
import { resolveRegionContext } from "../lib/region-context";
import { SagemakerStack } from "../lib/sagemaker-stack";

const app = new App();

// 既定は `ap-northeast-1` (東京)。Async Endpoint の ml.g5.xlarge が提供され、
// 国内運用 (CloudFront / S3 / DynamoDB と同一リージョン) を前提とする。
// `-c region=us-east-1` は capacity 逼迫時の退避用オプション (Req 8.4)。
// 退避時は全 AWS リソースが別リージョンに新設され、既存 `ap-northeast-1`
// スタックのデータは共有されない点に注意 (詳細は lib/region-context.ts)。
const region = resolveRegionContext(app.node);

const account =
  (app.node.tryGetContext("account") as string | undefined) ??
  process.env.CDK_DEFAULT_ACCOUNT;

const AWS_ACCOUNT_PATTERN = /^\d{12}$/;
if (account && !AWS_ACCOUNT_PATTERN.test(account)) {
  throw new Error(`Invalid AWS account ID format: "${account}"`);
}

// SageMaker エンドポイント名は SagemakerStack / BatchExecutionStack /
// MonitoringStack で共有する必要があるため、app レベルで 1 度だけ解決して
// 各スタックに typed prop で渡す。
// Task 7.1 で旧エンドポイント lifecycle スタックを撤去したため
// `endpointConfigName` は不要になり、context からは読まない。
const endpointName = app.node.tryGetContext("endpointName") as
  | string
  | undefined;
if (!endpointName) {
  throw new Error(
    "endpointName must be set in cdk.json context or via --context",
  );
}

// SageMaker Async 運用パラメータは 3 スタック (Sagemaker / BatchExecution / Monitoring)
// で共有する必要があるため、app レベルで 1 度だけ解決する。
const asyncRuntime = resolveAsyncRuntimeContext(app.node);

// Async 移行に伴い SagemakerStack は S3 bucket (AsyncInferenceConfig の
// S3OutputPath/S3FailurePath に bucket ARN を埋め込む) と endpointName
// (CfnEndpoint / ScalableTarget の ResourceId) を props で要求するため、
// ProcessingStack を先に構築してから SagemakerStack に値を注入する。
const processingStack = new ProcessingStack(app, "ProcessingStack", {
  env: { region, account },
});

const sagemakerStack = new SagemakerStack(app, "SagemakerStack", {
  env: { region, account },
  asyncRuntime,
  bucket: processingStack.bucket,
  endpointName,
});

const batchExecutionStack = new BatchExecutionStack(
  app,
  "BatchExecutionStack",
  {
    env: { region, account },
    batchTable: processingStack.batchTable,
    controlTable: processingStack.controlTable,
    bucket: processingStack.bucket,
    endpointName,
    successQueue: sagemakerStack.successQueue,
    failureQueue: sagemakerStack.failureQueue,
    asyncRuntime,
  },
);

new ApiStack(app, "ApiStack", {
  env: { region, account },
  bucket: processingStack.bucket,
  controlTable: processingStack.controlTable,
  batchTable: processingStack.batchTable,
  batchExecutionStateMachine: batchExecutionStack.stateMachine,
});

new MonitoringStack(app, "MonitoringStack", {
  env: { region, account },
  endpointName,
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
