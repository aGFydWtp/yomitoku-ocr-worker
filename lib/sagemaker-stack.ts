import {
  CfnScalableTarget,
  CfnScalingPolicy,
} from "aws-cdk-lib/aws-applicationautoscaling";
import { CfnAlarm } from "aws-cdk-lib/aws-cloudwatch";
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Alias } from "aws-cdk-lib/aws-kms";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import {
  CfnEndpoint,
  CfnEndpointConfig,
  CfnModel,
} from "aws-cdk-lib/aws-sagemaker";
import { type ITopic, Topic } from "aws-cdk-lib/aws-sns";
import { SqsSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { type IQueue, Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import {
  Annotations,
  CfnOutput,
  Duration,
  Stack,
  type StackProps,
  Tags,
} from "aws-cdk-lib/core";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";
import type { AsyncRuntimeContext } from "./async-runtime-context";

/**
 * `SagemakerStack` 向け props。Async 移行 (Task 2.x) 以降は、
 *   - `bucket`        : S3 入出力 prefix を AsyncInferenceConfig に埋め込むため必須
 *   - `endpointName`  : CfnEndpoint の physical name / ScalableTarget ResourceId 共有
 *   - `asyncRuntime`  : Auto Scaling / ClientConfig のパラメータ一括注入
 * を要求する。`bin/app.ts` 側で ProcessingStack と context からそれぞれ解決済み
 * の値を必ず渡す。
 */
export interface SagemakerStackProps extends StackProps {
  readonly asyncRuntime: AsyncRuntimeContext;
  readonly bucket: IBucket;
  readonly endpointName: string;
}

/**
 * SageMaker Asynchronous Inference 一式を所有するスタック。
 *
 *   - `CfnModel`                       : Marketplace model package を参照 (Realtime 時代と不変)
 *   - `CfnEndpointConfig` (Async)      : AsyncInferenceConfig 付き、旧名 + `-async` サフィックス
 *   - `CfnEndpoint`                    : 旧 Realtime 時代の動的な create/delete 制御を廃止し本スタックが所有
 *   - SNS Success/Error Topic          : AWS 管理 KMS で SSE、sagemaker service principal に publish 限定
 *   - SQS Async Completion/Failure     : KMS_MANAGED、20 秒 long-poll、SNS→SQS 1:1 subscription
 *   - Application Auto Scaling         : 0 ↔ asyncMaxCapacity、ApproximateBacklogSizePerInstance ターゲット追跡
 */
export class SagemakerStack extends Stack {
  public readonly endpointConfigName: string;
  public readonly endpointName: string;
  public readonly modelName: string;
  public readonly successTopic: ITopic;
  public readonly errorTopic: ITopic;
  public readonly successQueue: IQueue;
  public readonly failureQueue: IQueue;

  constructor(scope: Construct, id: string, props: SagemakerStackProps) {
    super(scope, id, props);

    // Cost Explorer 用タグ戦略 (Task 7.4, Req 9.2)
    // スタック既定 = `yomitoku:component=endpoint`。子 construct (SNS/SQS/AutoScaling)
    // 側で個別に上書きする。
    Tags.of(this).add("yomitoku:stack", "sagemaker-async");
    Tags.of(this).add("yomitoku:component", "endpoint");

    const { bucket, endpointName, asyncRuntime } = props;

    const modelPackageArn = this.node.tryGetContext("modelPackageArn") as
      | string
      | undefined;
    if (!modelPackageArn) {
      throw new Error(
        "modelPackageArn must be set in cdk.context.json or via --context",
      );
    }

    const endpointConfigNameBase = this.node.tryGetContext(
      "endpointConfigName",
    ) as string | undefined;
    if (!endpointConfigNameBase) {
      throw new Error(
        "endpointConfigName must be set in cdk.json context or via --context",
      );
    }
    // 旧 Realtime EndpointConfig と物理名衝突を避けるため `-async` サフィックスを付与。
    // Runbook のカットオーバー中、旧/新 2 つの EndpointConfig が短期間共存できる。
    const asyncEndpointConfigName = `${endpointConfigNameBase}-async`;

    // -----------------------------------------------------------------------
    // 1. SageMaker execution IAM role
    // -----------------------------------------------------------------------
    const executionRole = new Role(this, "SageMakerExecutionRole", {
      assumedBy: new ServicePrincipal("sagemaker.amazonaws.com"),
      description: "Execution role for YomiToku-Pro SageMaker Async model",
    });

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

    // Task 2.6: S3 権限を `batches/_async/*` prefix に最小化
    // SageMaker Endpoint 作成時のロール検証 (CreateEndpoint の事前チェック) は
    // バケット本体への `s3:ListBucket` とバケット配下への `s3:PutObject` を要求する。
    // `s3:ListBucket` はオブジェクトではなくバケット ARN を対象にするため別ステートメント。
    // 最小化のため Condition で prefix (`batches/_async/*`) を限定する。
    executionRole.addToPolicy(
      new PolicyStatement({
        sid: "S3AsyncListBucket",
        effect: Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [bucket.bucketArn],
        // NOTE: `s3:prefix` Condition は意図的に付与しない。SageMaker の
        // CreateEndpoint 事前検証は `iam:SimulatePrincipalPolicy` を
        // prefix context key 無しで実行するため、Condition 付き ListBucket は
        // 検証に落ちて "role is invalid" で Endpoint 作成が失敗する。
        // 読み書きの prefix 限定は GetObject/PutObject の Resource 側で維持する。
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        sid: "S3AsyncInputGet",
        effect: Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [`${bucket.bucketArn}/batches/_async/inputs/*`],
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        sid: "S3AsyncOutputPut",
        effect: Effect.ALLOW,
        actions: ["s3:PutObject"],
        resources: [
          `${bucket.bucketArn}/batches/_async/outputs/*`,
          `${bucket.bucketArn}/batches/_async/errors/*`,
        ],
      }),
    );

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
        {
          id: "AwsSolutions-IAM5",
          reason:
            "SageMaker Async writes per-inference objects under " +
            "batches/_async/{inputs,outputs,errors}/*; wildcards within these " +
            "fixed prefixes are required (per-object scoping is not possible " +
            "since object keys are only known at invocation time), and the " +
            "bucket-wide s3:* access is explicitly denied — no statement uses " +
            "`s3:*` on `arn:aws:s3:::bucket/*` (enforced by test " +
            "`test/sagemaker-stack.test.ts::s3:* が付与されていない`).",
        },
      ],
      true,
    );

    // -----------------------------------------------------------------------
    // 2. CfnModel (Marketplace) — 不変
    // -----------------------------------------------------------------------
    const model = new CfnModel(this, "YomitokuProModel", {
      executionRoleArn: executionRole.roleArn,
      enableNetworkIsolation: true,
      containers: [{ modelPackageName: modelPackageArn }],
    });

    // -----------------------------------------------------------------------
    // 3. SNS SuccessTopic / ErrorTopic (Task 2.2)
    //    AWS 管理 KMS (alias/aws/sns) で SSE 暗号化し、
    //    Publish を sagemaker.amazonaws.com + SourceArn 条件で限定する。
    // -----------------------------------------------------------------------
    const snsManagedKey = Alias.fromAliasName(
      this,
      "AwsManagedSnsKey",
      "alias/aws/sns",
    );

    const successTopic = new Topic(this, "AsyncSuccessTopic", {
      displayName: "YomiToku Async Success",
      masterKey: snsManagedKey,
    });
    const errorTopic = new Topic(this, "AsyncErrorTopic", {
      displayName: "YomiToku Async Error",
      masterKey: snsManagedKey,
    });
    // Cost Explorer 分類: SNS Topic 個別 component
    for (const topic of [successTopic, errorTopic]) {
      Tags.of(topic).add("yomitoku:component", "sns");
    }

    const endpointArn = `arn:aws:sagemaker:${this.region}:${this.account}:endpoint/${endpointName}`;
    for (const topic of [successTopic, errorTopic]) {
      topic.addToResourcePolicy(
        new PolicyStatement({
          sid: "AllowSagemakerPublish",
          effect: Effect.ALLOW,
          principals: [new ServicePrincipal("sagemaker.amazonaws.com")],
          actions: ["sns:Publish"],
          resources: [topic.topicArn],
          conditions: {
            ArnEquals: { "aws:SourceArn": endpointArn },
          },
        }),
      );
    }

    // SageMaker CreateEndpoint の事前検証は、Topic 側の resource policy ではなく
    // 実行ロールの IdentityPolicy に `sns:Publish` が付いているかを
    // `iam:SimulatePrincipalPolicy` で確認する。resource policy だけでは
    // "role is invalid: sns:Publish permission missing" で Endpoint 作成が失敗する。
    // 付与先を 2 Topic ARN に限定して最小化。
    executionRole.addToPolicy(
      new PolicyStatement({
        sid: "SnsPublishAsyncNotifications",
        effect: Effect.ALLOW,
        actions: ["sns:Publish"],
        resources: [successTopic.topicArn, errorTopic.topicArn],
      }),
    );

    // -----------------------------------------------------------------------
    // 4. SQS AsyncCompletionQueue / AsyncFailureQueue (Task 2.3)
    //    AWS 管理 KMS (`alias/aws/sqs`) はキーポリシーを書き換えられず、
    //    SNS からの cross-service publish が許可できない (CDK が事前に拒否)。
    //    customer-managed KMS 新設はコスト増を招くため、SNS 側は AWS 管理 KMS、
    //    SQS 側は SSE-SQS (`SQS_MANAGED`) でエンドツーエンド暗号化を担保する。
    //    batch-runner 側の処理失敗に備え、両 Queue に DLQ (maxReceiveCount=5) を付与する。
    // -----------------------------------------------------------------------
    const successDlq = new Queue(this, "AsyncCompletionDlq", {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    const failureDlq = new Queue(this, "AsyncFailureDlq", {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    const successQueue = new Queue(this, "AsyncCompletionQueue", {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      receiveMessageWaitTime: Duration.seconds(20),
      deadLetterQueue: { queue: successDlq, maxReceiveCount: 5 },
    });
    const failureQueue = new Queue(this, "AsyncFailureQueue", {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      receiveMessageWaitTime: Duration.seconds(20),
      deadLetterQueue: { queue: failureDlq, maxReceiveCount: 5 },
    });

    // SNS → SQS 1:1 subscription。`SqsSubscription` は Queue 側の
    // resource policy (SendMessage を Topic ARN 条件付きで許可) を自動で配線する。
    successTopic.addSubscription(new SqsSubscription(successQueue));
    errorTopic.addSubscription(new SqsSubscription(failureQueue));

    // Cost Explorer 分類: SQS Queue 個別 component (DLQ も sqs 扱い)
    for (const queue of [successQueue, failureQueue, successDlq, failureDlq]) {
      Tags.of(queue).add("yomitoku:component", "sqs");
    }

    // -----------------------------------------------------------------------
    // 5. CfnEndpointConfig with AsyncInferenceConfig (Task 2.1)
    // -----------------------------------------------------------------------
    const endpointConfig = new CfnEndpointConfig(this, "AsyncEndpointConfig", {
      endpointConfigName: asyncEndpointConfigName,
      productionVariants: [
        {
          variantName: "AllTraffic",
          modelName: model.attrModelName,
          instanceType: "ml.g5.xlarge",
          // CloudFormation の `AWS::SageMaker::EndpointConfig` スキーマは
          // `InitialInstanceCount >= 1` を強制するため 0 を宣言できない
          // (SageMaker API 単体では 0 可)。そのため初期値は 1 に置き、
          // CfnScalableTarget の MinCapacity=0 と
          // ApproximateBacklogSizePerInstance ターゲット追跡で、
          // InService 直後の backlog=0 を検知して速やかに 0 へ scale-in する。
          initialInstanceCount: 1,
        },
      ],
      asyncInferenceConfig: {
        clientConfig: {
          maxConcurrentInvocationsPerInstance:
            asyncRuntime.maxConcurrentInvocationsPerInstance,
          // NOTE: InvocationTimeoutSeconds は EndpointConfig 側には存在せず、
          // `invoke_endpoint_async` 呼び出し時のパラメータ。batch-runner 側
          // (AsyncInvoker) で asyncRuntime.invocationTimeoutSeconds を注入する。
        },
        outputConfig: {
          s3OutputPath: `s3://${bucket.bucketName}/batches/_async/outputs/`,
          s3FailurePath: `s3://${bucket.bucketName}/batches/_async/errors/`,
          notificationConfig: {
            successTopic: successTopic.topicArn,
            errorTopic: errorTopic.topicArn,
          },
        },
      },
    });

    // -----------------------------------------------------------------------
    // 6. CfnEndpoint (Task 2.5) — Realtime 時代の動的な create/delete 制御を廃止し、常設の CFN リソースとして宣言
    // -----------------------------------------------------------------------
    const endpoint = new CfnEndpoint(this, "AsyncEndpoint", {
      endpointName,
      endpointConfigName: endpointConfig.attrEndpointConfigName,
    });
    // `endpointConfig.attrEndpointConfigName` 経由の参照 token から CloudFormation
    // は自動で DependsOn を生成するが、意図を文書化するため明示的にも宣言する。
    endpoint.addDependency(endpointConfig);

    // CDK は ExecutionRoleArn 経由で Model → Role の依存を自動配線するが、
    // Role に addToPolicy で紐付ける inline `DefaultPolicy` (AWS::IAM::Policy)
    // への依存は作らない。SageMaker の CreateEndpoint 事前検証は IAM::Policy の
    // 付与完了より前に走り得るため、明示的に Endpoint → DefaultPolicy への
    // DependsOn を配線して "role is invalid" (ListBucket/PutObject 不足) を防ぐ。
    const defaultPolicy = executionRole.node.tryFindChild("DefaultPolicy");
    if (defaultPolicy) {
      endpoint.node.addDependency(defaultPolicy);
    }

    // -----------------------------------------------------------------------
    // 7. Application Auto Scaling (Task 2.4)
    //    MinCapacity=0 / MaxCapacity=asyncMaxCapacity、
    //    ApproximateBacklogSizePerInstance ターゲット追跡。
    //    Service-linked role `AWSServiceRoleForApplicationAutoScaling_SageMakerEndpoint`
    //    はアカウント初回利用時に AWS 側で自動作成される前提 (CDK 宣言は不要)。
    // -----------------------------------------------------------------------
    // async-endpoint-scale-in-protection spec の前提崩れガード:
    // `asyncMaxCapacity = 1` 前提下では (m1 + IF(m2>0, target, 0)) を per-instance
    // utilization と等価とみなす設計。2 以上に引き上げる場合は per-instance 化された
    // scale-in 保護に再設計する必要がある。CI 等で見落とさないよう synth 時に warning
    // で表面化する (要件 4.4)。
    if (asyncRuntime.asyncMaxCapacity > 1) {
      Annotations.of(this).addWarning(
        `async-endpoint-scale-in-protection: asyncMaxCapacity = ${asyncRuntime.asyncMaxCapacity} (>1) ` +
          "では本 spec の TargetTracking math 式 (FILL(m1, 0) + IF(FILL(m2, 0) > 0, 5, 0)) が " +
          "per-instance utilization と等価でなくなり scale-in 抑止が誤動作する。" +
          ".kiro/specs/async-endpoint-scale-in-protection/ の design / tests を再評価し、" +
          "per-instance 化されたポリシーへの再設計が必要。",
      );
    }

    const scalableTarget = new CfnScalableTarget(this, "AsyncScalableTarget", {
      serviceNamespace: "sagemaker",
      resourceId: `endpoint/${endpointName}/variant/AllTraffic`,
      scalableDimension: "sagemaker:variant:DesiredInstanceCount",
      minCapacity: 0,
      maxCapacity: asyncRuntime.asyncMaxCapacity,
    });
    // Endpoint InService 後に登録する (Task 2.4 観測可能条件)。
    scalableTarget.addDependency(endpoint);
    // Cost Explorer 分類: AutoScaling 個別 component (CfnScalableTarget /
    // CfnScalingPolicy は `AWS::CloudFormation::Tag` を Properties.Tags に
    // 持たないため、ここで Tags.of() を呼んでも CFN テンプレートには出ない。
    // ただし CDK の Aspect 走査で Node metadata としては記録され、将来
    // Tags をサポートする Resource が子に追加された場合にも一貫して伝搬する。
    Tags.of(scalableTarget).add("yomitoku:component", "autoscaling");

    const scalingPolicy = new CfnScalingPolicy(
      this,
      "AsyncBacklogScalingPolicy",
      {
        policyName: "AsyncBacklogTargetTracking",
        policyType: "TargetTrackingScaling",
        scalingTargetId: scalableTarget.ref,
        targetTrackingScalingPolicyConfiguration: {
          // backlog per instance = 5 を越えたら scale-out。小さすぎると flapping、
          // 大きすぎると待ち時間悪化。PoC で調整する前提で保守的な初期値を設定。
          targetValue: 5,
          scaleInCooldown: asyncRuntime.scaleInCooldownSeconds,
          scaleOutCooldown: 60,
          customizedMetricSpecification: {
            // 重要: 本 spec は asyncMaxCapacity = 1 前提で正しさが成立する。
            // 2 以上に引き上げると (m1 + m2 floor saturation) が per-instance utilization と等価でなくなり
            // scale-in 抑止が誤動作するため、async-endpoint-scale-in-protection spec を
            // 再設計する必要がある (Revalidation Trigger)。
            // NOTE: Application Auto Scaling の TargetTrackingMetricStat は
            // CloudFormation 仕様上 Period を持たない。評価粒度はサービス既定の
            // 60 秒に委ね、publisher 側の 60 秒周期と合わせる。
            metrics: [
              {
                id: "m1",
                metricStat: {
                  metric: {
                    namespace: "AWS/SageMaker",
                    metricName: "ApproximateBacklogSize",
                    dimensions: [{ name: "EndpointName", value: endpointName }],
                  },
                  // SageMaker Async 系メトリクスは Sum を受理しない (公式: Average/Max/Min のみ)。
                  // SageMaker が 1 分粒度で publish するため Average は Maximum と等価。
                  stat: "Average",
                },
                returnData: false,
              },
              {
                id: "m2",
                metricStat: {
                  metric: {
                    namespace: "Yomitoku/AsyncEndpoint",
                    metricName: "InflightInvocations",
                    dimensions: [{ name: "EndpointName", value: endpointName }],
                  },
                  // 複数 batch-runner task 並走時に同一 EndpointName dimension に
                  // publish された値を合算する必要があるため Sum を採用 (R2.4)。
                  stat: "Sum",
                },
                returnData: false,
              },
              {
                id: "e1",
                // floor saturation: inflight>0 の間は出力を target=5 と同値以上に保つ。
                // これにより in-flight 残存中の scale-in 判定を確実に阻止しつつ、
                // scale-out は backlog 増加のみが駆動する。
                // 注意: 式中の定数 5 は targetValue と同期している必要がある。
                // `targetValue` を変更する場合はこの式の閾値も同時更新すること。
                expression: "FILL(m1, 0) + IF(FILL(m2, 0) > 0, 5, 0)",
                label: "BacklogPlusInflightFloor",
                returnData: true,
              },
            ],
          },
        },
      },
    );
    Tags.of(scalingPolicy).add("yomitoku:component", "autoscaling");

    // --------------------------------------------------------------
    // 7b. Scale-from-Zero bootstrap
    //
    // `AsyncBacklogScalingPolicy` (TargetTracking) は
    // `ApproximateBacklogSizePerInstance = backlog / instances` が定義される
    // `instances >= 1` 状態でのみ機能する。MinCapacity=0 の構成では
    // `instances=0` で backlog が積まれても目的関数が未定義なので scale-up
    // が起こらない。
    //
    // AWS 公式推奨パターン:
    //   `HasBacklogWithoutCapacity` (backlog>0 かつ capacity=0 で 1) をウォッチし、
    //   StepScalingPolicy で +1 する。以後の負荷分散は TargetTracking 側が担当。
    // --------------------------------------------------------------
    const scaleOutOnBacklogPolicy = new CfnScalingPolicy(
      this,
      "AsyncScaleOutOnBacklogPolicy",
      {
        policyName: "AsyncScaleOutOnBacklogWithoutCapacity",
        policyType: "StepScaling",
        scalingTargetId: scalableTarget.ref,
        stepScalingPolicyConfiguration: {
          adjustmentType: "ChangeInCapacity",
          cooldown: 60,
          metricAggregationType: "Maximum",
          stepAdjustments: [
            {
              metricIntervalLowerBound: 0,
              scalingAdjustment: 1,
            },
          ],
        },
      },
    );
    Tags.of(scaleOutOnBacklogPolicy).add("yomitoku:component", "autoscaling");

    const hasBacklogWithoutCapacityAlarm = new CfnAlarm(
      this,
      "AsyncHasBacklogWithoutCapacityAlarm",
      {
        alarmDescription:
          "Trigger scale-out of SageMaker Async endpoint when backlog exists but capacity is 0",
        metricName: "HasBacklogWithoutCapacity",
        namespace: "AWS/SageMaker",
        statistic: "Maximum",
        period: 60,
        evaluationPeriods: 2,
        threshold: 1,
        comparisonOperator: "GreaterThanOrEqualToThreshold",
        treatMissingData: "notBreaching",
        dimensions: [{ name: "EndpointName", value: endpointName }],
        alarmActions: [scaleOutOnBacklogPolicy.ref],
      },
    );
    Tags.of(hasBacklogWithoutCapacityAlarm).add(
      "yomitoku:component",
      "autoscaling",
    );

    // -----------------------------------------------------------------------
    // Public exports
    // -----------------------------------------------------------------------
    this.endpointConfigName = asyncEndpointConfigName;
    this.endpointName = endpointName;
    this.modelName = model.attrModelName;
    this.successTopic = successTopic;
    this.errorTopic = errorTopic;
    this.successQueue = successQueue;
    this.failureQueue = failureQueue;

    // -----------------------------------------------------------------------
    // Outputs (CfnOutput) — BatchExecutionStack / MonitoringStack / Runbook
    // が参照する値をすべて明示。
    // -----------------------------------------------------------------------
    new CfnOutput(this, "EndpointConfigName", {
      value: this.endpointConfigName,
      description:
        "SageMaker Async EndpointConfig name (used by BatchExecutionStack)",
    });
    new CfnOutput(this, "EndpointName", {
      value: this.endpointName,
      description: "SageMaker Async Endpoint name",
    });
    new CfnOutput(this, "ModelName", {
      value: this.modelName,
      description: "SageMaker Model name",
    });
    new CfnOutput(this, "SuccessTopicArn", {
      value: successTopic.topicArn,
      description: "SNS topic ARN for Async success notifications",
    });
    new CfnOutput(this, "ErrorTopicArn", {
      value: errorTopic.topicArn,
      description: "SNS topic ARN for Async error notifications",
    });
    new CfnOutput(this, "SuccessQueueUrl", {
      value: successQueue.queueUrl,
      description:
        "SQS queue URL subscribed to SuccessTopic (batch-runner long-poll target)",
    });
    new CfnOutput(this, "FailureQueueUrl", {
      value: failureQueue.queueUrl,
      description:
        "SQS queue URL subscribed to ErrorTopic (batch-runner long-poll target)",
    });
  }
}
