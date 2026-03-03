import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { CfnEndpointConfig, CfnModel } from "aws-cdk-lib/aws-sagemaker";
import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib/core";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";

export class SagemakerStack extends Stack {
  public readonly endpointConfigName: string;
  public readonly modelName: string;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const modelPackageArn = this.node.tryGetContext("modelPackageArn") as
      | string
      | undefined;
    if (!modelPackageArn) {
      throw new Error(
        "modelPackageArn must be set in cdk.context.json or via --context",
      );
    }

    const endpointConfigName = this.node.tryGetContext("endpointConfigName") as
      | string
      | undefined;
    if (!endpointConfigName) {
      throw new Error(
        "endpointConfigName must be set in cdk.json context or via --context",
      );
    }

    // --- 1.1 SageMaker execution IAM role ---
    const executionRole = new Role(this, "SageMakerExecutionRole", {
      assumedBy: new ServicePrincipal("sagemaker.amazonaws.com"),
      description: "Execution role for YomiToku-Pro SageMaker model",
    });

    // ECR image pull (required for Marketplace models)
    executionRole.addToPolicy(
      new PolicyStatement({
        sid: "EcrImagePull",
        effect: Effect.ALLOW,
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );

    executionRole.addToPolicy(
      new PolicyStatement({
        sid: "EcrImageGet",
        effect: Effect.ALLOW,
        actions: [
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchCheckLayerAvailability",
        ],
        resources: [`arn:aws:ecr:${this.region}:*:repository/*`],
      }),
    );

    // CloudWatch Logs for model container
    executionRole.addToPolicy(
      new PolicyStatement({
        sid: "CloudWatchLogs",
        effect: Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/sagemaker/*`,
        ],
      }),
    );

    // Suppress CDK Nag wildcards
    NagSuppressions.addResourceSuppressions(
      executionRole,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "ecr:GetAuthorizationToken requires resource '*'. " +
            "ECR BatchGetImage/GetDownloadUrlForLayer use arn:aws:ecr:<region>:*:repository/* " +
            "because Marketplace model images are in AWS-managed ECR repositories " +
            "whose account is not known at deploy time.",
          appliesTo: [
            "Resource::*",
            `Resource::arn:aws:ecr:${this.region}:*:repository/*`,
          ],
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "CloudWatch Logs resource uses /aws/sagemaker/* because SageMaker " +
            "creates log groups with dynamic names based on endpoint/model names.",
          appliesTo: [
            `Resource::arn:aws:logs:${this.region}:${this.account}:log-group:/aws/sagemaker/*`,
          ],
        },
      ],
      true,
    );

    // --- 1.2 CfnModel ---
    const model = new CfnModel(this, "YomitokuProModel", {
      executionRoleArn: executionRole.roleArn,
      enableNetworkIsolation: true,
      containers: [
        {
          modelPackageName: modelPackageArn,
        },
      ],
    });

    // --- 1.3 CfnEndpointConfig ---
    new CfnEndpointConfig(this, "YomitokuProEndpointConfig", {
      endpointConfigName,
      productionVariants: [
        {
          variantName: "AllTraffic",
          modelName: model.attrModelName,
          instanceType: "ml.g5.xlarge",
          initialInstanceCount: 1,
        },
      ],
    });

    this.endpointConfigName = endpointConfigName;
    this.modelName = model.attrModelName;

    // --- Outputs ---
    new CfnOutput(this, "EndpointConfigName", {
      value: this.endpointConfigName,
      description:
        "SageMaker EndpointConfig name (used by Step Functions in Phase 4)",
    });

    new CfnOutput(this, "ModelName", {
      value: this.modelName,
      description: "SageMaker Model name",
    });
  }
}
