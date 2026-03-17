#!/usr/bin/env node
import { App, Aspects } from "aws-cdk-lib/core";
import { AwsSolutionsChecks } from "cdk-nag";
import { ApiStack } from "../lib/api-stack";
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

new SagemakerStack(app, "SagemakerStack", {
  env: { region, account },
});

const processingStack = new ProcessingStack(app, "ProcessingStack", {
  env: { region, account },
});

const orchestrationStack = new OrchestrationStack(app, "OrchestrationStack", {
  env: { region, account },
  mainQueue: processingStack.mainQueue,
  controlTable: processingStack.controlTable,
  bucket: processingStack.bucket,
});

new ApiStack(app, "ApiStack", {
  env: { region, account },
  bucket: processingStack.bucket,
  statusTable: processingStack.statusTable,
  controlTable: processingStack.controlTable,
  stateMachine: orchestrationStack.stateMachine,
});

new MonitoringStack(app, "MonitoringStack", {
  env: { region, account },
  mainQueue: processingStack.mainQueue,
  deadLetterQueue: processingStack.deadLetterQueue,
  processorFunction: processingStack.processorFunction,
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
