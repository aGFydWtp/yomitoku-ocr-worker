import type { Table } from "aws-cdk-lib/aws-dynamodb";
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  Code,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { CfnPipe } from "aws-cdk-lib/aws-pipes";
import type { Queue } from "aws-cdk-lib/aws-sqs";
import {
  Choice,
  Condition,
  DefinitionBody,
  Fail,
  Pass,
  StateMachine,
  Succeed,
  TaskInput,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";

export interface OrchestrationStackProps extends StackProps {
  mainQueue: Queue;
  controlTable: Table;
}

export class OrchestrationStack extends Stack {
  public readonly stateMachine: StateMachine;
  public readonly endpointControlFunction: LambdaFunction;

  constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    super(scope, id, props);

    const { mainQueue, controlTable } = props;

    const endpointName = this.node.tryGetContext("endpointName") as
      | string
      | undefined;
    if (!endpointName) {
      throw new Error(
        "endpointName must be set in cdk.json context or via --context",
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

    // --- エンドポイント制御 Lambda ---
    this.endpointControlFunction = new LambdaFunction(
      this,
      "EndpointControlFunction",
      {
        runtime: Runtime.PYTHON_3_12,
        handler: "index.handler",
        code: Code.fromAsset("lambda/endpoint-control"),
        timeout: Duration.seconds(30),
        environment: {
          ENDPOINT_NAME: endpointName,
          ENDPOINT_CONFIG_NAME: endpointConfigName,
          QUEUE_URL: mainQueue.queueUrl,
          CONTROL_TABLE_NAME: controlTable.tableName,
        },
      },
    );

    // --- 4.4 IAM Permissions ---
    // 4.4.1 SageMaker endpoint operations
    this.endpointControlFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "SageMakerEndpointControl",
        effect: Effect.ALLOW,
        actions: [
          "sagemaker:CreateEndpoint",
          "sagemaker:DeleteEndpoint",
          "sagemaker:DescribeEndpoint",
        ],
        resources: [
          `arn:aws:sagemaker:${this.region}:${this.account}:endpoint/${endpointName}`,
        ],
      }),
    );

    // 4.4.2 DynamoDB control table read/write
    controlTable.grantReadWriteData(this.endpointControlFunction);

    // 4.4.3 SQS GetQueueAttributes
    this.endpointControlFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "SqsGetQueueAttributes",
        effect: Effect.ALLOW,
        actions: ["sqs:GetQueueAttributes"],
        resources: [mainQueue.queueArn],
      }),
    );

    // --- 4.2 Step Functions ステートマシン ---
    const definition = this.buildStateMachineDefinition(
      this.endpointControlFunction,
    );

    this.stateMachine = new StateMachine(this, "EndpointOrchestrator", {
      definitionBody: DefinitionBody.fromChainable(definition),
      timeout: Duration.hours(2),
    });

    // --- 4.3 EventBridge Pipes ---
    const pipeRole = new Role(this, "PipeRole", {
      assumedBy: new ServicePrincipal("pipes.amazonaws.com"),
    });

    // SQS source permissions
    pipeRole.addToPolicy(
      new PolicyStatement({
        sid: "SqsSourcePermissions",
        effect: Effect.ALLOW,
        actions: [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ],
        resources: [mainQueue.queueArn],
      }),
    );

    // Step Functions target permissions
    pipeRole.addToPolicy(
      new PolicyStatement({
        sid: "StepFunctionsTargetPermission",
        effect: Effect.ALLOW,
        actions: ["states:StartExecution"],
        resources: [this.stateMachine.stateMachineArn],
      }),
    );

    new CfnPipe(this, "SqsToStepFunctionsPipe", {
      roleArn: pipeRole.roleArn,
      source: mainQueue.queueArn,
      target: this.stateMachine.stateMachineArn,
      sourceParameters: {
        sqsQueueParameters: {
          batchSize: 1,
        },
      },
      targetParameters: {
        stepFunctionStateMachineParameters: {
          invocationType: "FIRE_AND_FORGET",
        },
      },
    });

    // CDK Nag suppressions
    NagSuppressions.addResourceSuppressions(
      this.endpointControlFunction,
      [
        {
          id: "AwsSolutions-L1",
          reason:
            "Python 3.12 is used for compatibility with yomitoku-client " +
            "which requires Python < 3.13.",
        },
        {
          id: "AwsSolutions-IAM4",
          reason:
            "AWSLambdaBasicExecutionRole is required for CloudWatch Logs. " +
            "This managed policy is the minimum for Lambda execution.",
          appliesTo: [
            "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "DynamoDB grantReadWriteData generates index/* wildcard for GSI access. " +
            "This is the minimum permission generated by CDK L2 grant methods.",
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      this.stateMachine,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Step Functions execution role wildcards are generated by CDK " +
            "for Lambda invoke permissions.",
        },
        {
          id: "AwsSolutions-SF1",
          reason:
            "CloudWatch Logs for Step Functions will be added in monitoring phase (Phase 5).",
        },
        {
          id: "AwsSolutions-SF2",
          reason:
            "X-Ray tracing for Step Functions will be evaluated in monitoring phase (Phase 5).",
        },
      ],
      true,
    );

    // --- Outputs ---
    new CfnOutput(this, "StateMachineArn", {
      value: this.stateMachine.stateMachineArn,
      description: "Step Functions state machine ARN",
    });

    new CfnOutput(this, "EndpointControlFunctionName", {
      value: this.endpointControlFunction.functionName,
      description: "Endpoint control Lambda function name",
    });
  }

  private buildStateMachineDefinition(controlFn: LambdaFunction) {
    // --- Lambda Invoke tasks ---
    const acquireLock = new LambdaInvoke(this, "AcquireLock", {
      lambdaFunction: controlFn,
      payload: TaskInput.fromObject({
        action: "acquire_lock",
        "execution_id.$": "$$.Execution.Id",
      }),
      resultSelector: { "result.$": "$.Payload" },
      resultPath: "$.lockResult",
    });

    const checkEndpointStatus = new LambdaInvoke(this, "CheckEndpointStatus", {
      lambdaFunction: controlFn,
      payload: TaskInput.fromObject({ action: "check_endpoint_status" }),
      resultSelector: { "result.$": "$.Payload" },
      resultPath: "$.endpointResult",
    });

    const createEndpoint = new LambdaInvoke(this, "CreateEndpoint", {
      lambdaFunction: controlFn,
      payload: TaskInput.fromObject({ action: "create_endpoint" }),
      resultSelector: { "result.$": "$.Payload" },
      resultPath: "$.createResult",
    });

    const waitForEndpoint = new Wait(this, "WaitForEndpoint", {
      time: WaitTime.duration(Duration.seconds(60)),
    });

    const checkEndpointStatusLoop = new LambdaInvoke(
      this,
      "CheckEndpointStatusLoop",
      {
        lambdaFunction: controlFn,
        payload: TaskInput.fromObject({ action: "check_endpoint_status" }),
        resultSelector: { "result.$": "$.Payload" },
        resultPath: "$.endpointResult",
      },
    );

    const checkQueueStatus = new LambdaInvoke(this, "CheckQueueStatus", {
      lambdaFunction: controlFn,
      payload: TaskInput.fromObject({ action: "check_queue_status" }),
      resultSelector: { "result.$": "$.Payload" },
      resultPath: "$.queueResult",
    });

    const cooldownWait = new Wait(this, "CooldownWait", {
      time: WaitTime.duration(Duration.minutes(15)),
    });

    const recheckQueueStatus = new LambdaInvoke(this, "RecheckQueueStatus", {
      lambdaFunction: controlFn,
      payload: TaskInput.fromObject({ action: "check_queue_status" }),
      resultSelector: { "result.$": "$.Payload" },
      resultPath: "$.queueResult",
    });

    const deleteEndpoint = new LambdaInvoke(this, "DeleteEndpoint", {
      lambdaFunction: controlFn,
      payload: TaskInput.fromObject({ action: "delete_endpoint" }),
      resultSelector: { "result.$": "$.Payload" },
      resultPath: "$.deleteResult",
    });

    const releaseLock = new LambdaInvoke(this, "ReleaseLock", {
      lambdaFunction: controlFn,
      payload: TaskInput.fromObject({ action: "release_lock" }),
      resultSelector: { "result.$": "$.Payload" },
      resultPath: "$.releaseResult",
    });

    const releaseLockOnError = new LambdaInvoke(this, "ReleaseLockOnError", {
      lambdaFunction: controlFn,
      payload: TaskInput.fromObject({ action: "release_lock" }),
      resultSelector: { "result.$": "$.Payload" },
      resultPath: "$.releaseResult",
    });

    // --- Terminal states ---
    const lockNotAcquired = new Succeed(this, "LockNotAcquired", {
      comment: "Another execution is already controlling the endpoint",
    });

    const done = new Succeed(this, "Done", {
      comment: "Endpoint lifecycle complete",
    });

    const failState = new Fail(this, "ExecutionFailed", {
      cause: "Endpoint orchestration failed after lock release",
    });

    // --- Wait loop counter ---
    const initCounter = new Pass(this, "InitWaitCounter", {
      result: { value: 0 },
      resultPath: "$.waitCount",
    });

    const incrementCounter = new Pass(this, "IncrementWaitCounter", {
      inputPath: "$.waitCount",
      resultPath: "$.waitCount",
      parameters: {
        "value.$": "States.MathAdd($.waitCount.value, 1)",
      },
    });

    // --- Flow construction ---

    // [1] Acquire lock → check result
    const lockChoice = new Choice(this, "LockAcquired?")
      .when(
        Condition.booleanEquals("$.lockResult.result.lock_acquired", true),
        checkEndpointStatus,
      )
      .otherwise(lockNotAcquired);

    acquireLock.next(lockChoice);

    // [2] Check endpoint status → branch
    const endpointStatusChoice = new Choice(this, "EndpointStatusBranch")
      .when(
        Condition.stringEquals(
          "$.endpointResult.result.endpoint_status",
          "InService",
        ),
        checkQueueStatus,
      )
      .when(
        Condition.stringEquals(
          "$.endpointResult.result.endpoint_status",
          "Creating",
        ),
        initCounter,
      )
      .when(
        Condition.stringEquals(
          "$.endpointResult.result.endpoint_status",
          "NOT_FOUND",
        ),
        createEndpoint,
      )
      .otherwise(initCounter);

    checkEndpointStatus.next(endpointStatusChoice);

    // [3] Create endpoint → init counter → wait loop
    createEndpoint.next(initCounter);

    // [4] Wait loop: wait → check → if InService, go to queue check
    initCounter.next(waitForEndpoint);
    waitForEndpoint.next(checkEndpointStatusLoop);

    const waitLoopChoice = new Choice(this, "EndpointReady?")
      .when(
        Condition.stringEquals(
          "$.endpointResult.result.endpoint_status",
          "InService",
        ),
        checkQueueStatus,
      )
      .when(
        Condition.numberGreaterThanEquals("$.waitCount.value", 20),
        releaseLockOnError.next(failState),
      )
      .otherwise(incrementCounter);

    checkEndpointStatusLoop.next(waitLoopChoice);
    incrementCounter.next(waitForEndpoint);

    // [5-6] Queue check loop
    const waitForQueue = new Wait(this, "WaitForQueueDrain", {
      time: WaitTime.duration(Duration.seconds(60)),
    });

    const queueChoice = new Choice(this, "QueueEmpty?")
      .when(
        Condition.booleanEquals("$.queueResult.result.queue_empty", true),
        cooldownWait,
      )
      .otherwise(waitForQueue);

    checkQueueStatus.next(queueChoice);
    waitForQueue.next(checkQueueStatus);

    // [7] Cooldown → recheck
    cooldownWait.next(recheckQueueStatus);

    // [8] Recheck queue
    const recheckChoice = new Choice(this, "QueueStillEmpty?")
      .when(
        Condition.booleanEquals("$.queueResult.result.queue_empty", true),
        deleteEndpoint,
      )
      .otherwise(checkQueueStatus);

    recheckQueueStatus.next(recheckChoice);

    // [9] Delete endpoint → release lock → done
    deleteEndpoint.next(releaseLock);
    releaseLock.next(done);

    // Error handling: add catch to all Lambda invokes
    const errorHandler = releaseLockOnError;

    for (const task of [
      checkEndpointStatus,
      createEndpoint,
      checkEndpointStatusLoop,
      checkQueueStatus,
      recheckQueueStatus,
      deleteEndpoint,
      releaseLock,
    ]) {
      task.addCatch(errorHandler, {
        resultPath: "$.error",
      });
    }

    return acquireLock;
  }
}
