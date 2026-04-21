#!/usr/bin/env node
import { App, Aspects } from "aws-cdk-lib/core";
import { AwsSolutionsChecks } from "cdk-nag";
import { ApiStack } from "../lib/api-stack";
import { BatchExecutionStack } from "../lib/batch-execution-stack";
import { MonitoringStack } from "../lib/monitoring-stack";
import { OrchestrationStack } from "../lib/orchestration-stack";
import { ProcessingStack } from "../lib/processing-stack";
import { SagemakerStack } from "../lib/sagemaker-stack";

const app = new App();

const region =
  (app.node.tryGetContext("region") as string | undefined) ?? "ap-northeast-1";

const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d$/;
if (!AWS_REGION_PATTERN.test(region)) {
  throw new Error(`Invalid AWS region format: "${region}"`);
}

const account =
  (app.node.tryGetContext("account") as string | undefined) ??
  process.env.CDK_DEFAULT_ACCOUNT;

const AWS_ACCOUNT_PATTERN = /^\d{12}$/;
if (account && !AWS_ACCOUNT_PATTERN.test(account)) {
  throw new Error(`Invalid AWS account ID format: "${account}"`);
}

// SageMaker エンドポイント関連の context は orchestration / batch 両スタックで
// 使用するため、app レベルで 1 度だけ解決し、各スタックに typed prop で渡す。
const endpointName = app.node.tryGetContext("endpointName") as
  | string
  | undefined;
if (!endpointName) {
  throw new Error(
    "endpointName must be set in cdk.json context or via --context",
  );
}
const endpointConfigName = app.node.tryGetContext("endpointConfigName") as
  | string
  | undefined;
if (!endpointConfigName) {
  throw new Error(
    "endpointConfigName must be set in cdk.json context or via --context",
  );
}

new SagemakerStack(app, "SagemakerStack", {
  env: { region, account },
});

const processingStack = new ProcessingStack(app, "ProcessingStack", {
  env: { region, account },
});

const orchestrationStack = new OrchestrationStack(app, "OrchestrationStack", {
  env: { region, account },
  controlTable: processingStack.controlTable,
  bucket: processingStack.bucket,
  endpointName,
  endpointConfigName,
});

new BatchExecutionStack(app, "BatchExecutionStack", {
  env: { region, account },
  batchTable: processingStack.batchTable,
  controlTable: processingStack.controlTable,
  bucket: processingStack.bucket,
  endpointName,
});

new ApiStack(app, "ApiStack", {
  env: { region, account },
  bucket: processingStack.bucket,
  controlTable: processingStack.controlTable,
  stateMachine: orchestrationStack.stateMachine,
});

new MonitoringStack(app, "MonitoringStack", {
  env: { region, account },
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
