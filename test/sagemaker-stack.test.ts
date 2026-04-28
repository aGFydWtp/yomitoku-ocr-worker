import {
  Annotations as AssertionAnnotations,
  Match,
  Template,
} from "aws-cdk-lib/assertions";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { App, Stack } from "aws-cdk-lib/core";
import { describe, expect, it } from "vitest";
import {
  type AsyncRuntimeContext,
  DEFAULT_ASYNC_RUNTIME_CONTEXT,
} from "../lib/async-runtime-context";
import { SagemakerStack } from "../lib/sagemaker-stack";

const TEST_MODEL_PACKAGE_ARN =
  "arn:aws:sagemaker:ap-northeast-1:123456789012:model-package/test-model";
const TEST_REGION = "ap-northeast-1";
const TEST_ACCOUNT = "123456789012";
const TEST_ENDPOINT_CONFIG_NAME = "yomitoku-pro-config";
const TEST_ENDPOINT_NAME = "yomitoku-pro-endpoint";
// AsyncInferenceConfig は旧 Realtime EndpointConfig と名前衝突しない別名で作る
// (Task 2.1: `新 EndpointConfig 名は旧名と異なる命名スキーム`)。
const EXPECTED_ASYNC_CONFIG_NAME = `${TEST_ENDPOINT_CONFIG_NAME}-async`;

function createStack(overrides?: {
  context?: Record<string, unknown>;
  asyncRuntime?: Partial<AsyncRuntimeContext>;
}): {
  app: App;
  stack: SagemakerStack;
  template: Template;
} {
  const app = new App({
    context: {
      modelPackageArn: TEST_MODEL_PACKAGE_ARN,
      endpointConfigName: TEST_ENDPOINT_CONFIG_NAME,
      endpointName: TEST_ENDPOINT_NAME,
      ...(overrides?.context ?? {}),
    },
  });

  // Bucket は別スタック (ProcessingStack 相当) から props で注入する構成。
  // SagemakerStack は bucket.bucketName を AsyncInferenceConfig.S3OutputPath /
  // S3FailurePath に embed するだけで、バケット自体は所有しない。
  const depStack = new Stack(app, "DepStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
  });
  const bucket = new Bucket(depStack, "DataBucket");

  const stack = new SagemakerStack(app, "TestSagemakerStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
    bucket,
    endpointName: TEST_ENDPOINT_NAME,
    asyncRuntime: {
      ...DEFAULT_ASYNC_RUNTIME_CONTEXT,
      ...(overrides?.asyncRuntime ?? {}),
    },
  });
  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("SagemakerStack", () => {
  describe("context validation", () => {
    it("modelPackageArn 未設定時にエラーをスローする", () => {
      const app = new App({
        context: {
          endpointConfigName: TEST_ENDPOINT_CONFIG_NAME,
          endpointName: TEST_ENDPOINT_NAME,
        },
      });
      const depStack = new Stack(app, "DepStack", {
        env: { region: TEST_REGION, account: TEST_ACCOUNT },
      });
      const bucket = new Bucket(depStack, "DataBucket");
      expect(
        () =>
          new SagemakerStack(app, "Bad", {
            env: { region: TEST_REGION, account: TEST_ACCOUNT },
            bucket,
            endpointName: TEST_ENDPOINT_NAME,
            asyncRuntime: DEFAULT_ASYNC_RUNTIME_CONTEXT,
          }),
      ).toThrow("modelPackageArn must be set");
    });

    it("endpointConfigName 未設定時にエラーをスローする", () => {
      const app = new App({
        context: {
          modelPackageArn: TEST_MODEL_PACKAGE_ARN,
          endpointName: TEST_ENDPOINT_NAME,
        },
      });
      const depStack = new Stack(app, "DepStack", {
        env: { region: TEST_REGION, account: TEST_ACCOUNT },
      });
      const bucket = new Bucket(depStack, "DataBucket");
      expect(
        () =>
          new SagemakerStack(app, "Bad", {
            env: { region: TEST_REGION, account: TEST_ACCOUNT },
            bucket,
            endpointName: TEST_ENDPOINT_NAME,
            asyncRuntime: DEFAULT_ASYNC_RUNTIME_CONTEXT,
          }),
      ).toThrow("endpointConfigName must be set");
    });
  });

  describe("CfnModel", () => {
    it("Marketplace モデルパッケージ ARN を参照する", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SageMaker::Model", {
        Containers: [{ ModelPackageName: TEST_MODEL_PACKAGE_ARN }],
      });
    });

    it("実行ロール ARN を設定する", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SageMaker::Model", {
        ExecutionRoleArn: Match.anyValue(),
      });
    });
  });

  // -------------------------------------------------------------------------
  // Task 2.1: AsyncInferenceConfig 付き CfnEndpointConfig
  // -------------------------------------------------------------------------
  describe("CfnEndpointConfig (Async)", () => {
    it("旧名と異なる命名スキーム (endpointConfigName-async) を使う", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SageMaker::EndpointConfig", {
        EndpointConfigName: EXPECTED_ASYNC_CONFIG_NAME,
      });
    });

    it("Async `InitialInstanceCount=1` + MinCapacity=0 で初期 scale-in 前提", () => {
      // CloudFormation の AWS::SageMaker::EndpointConfig スキーマは
      // `InitialInstanceCount >= 1` を強制するため 0 不可。
      // `MinCapacity=0` の CfnScalableTarget と ApproximateBacklogSizePerInstance
      // ターゲット追跡で InService 直後に 0 へ scale-in する運用。
      const { template } = createStack();
      template.hasResourceProperties("AWS::SageMaker::EndpointConfig", {
        ProductionVariants: [
          Match.objectLike({
            VariantName: "AllTraffic",
            InstanceType: "ml.g5.xlarge",
            InitialInstanceCount: 1,
          }),
        ],
      });

      // MinCapacity=0 が ScalableTarget 側に配線されていること
      template.hasResourceProperties(
        "AWS::ApplicationAutoScaling::ScalableTarget",
        {
          MinCapacity: 0,
        },
      );
    });

    it("AsyncInferenceConfig.OutputConfig.S3OutputPath が batches/_async/outputs/ prefix", () => {
      // Match.anyValue() は Match.arrayWith() 内部にネストできないため、
      // 3 要素のリテラル配列形 (["s3://", <ref>, "/batches/_async/outputs/"]) を期待する。
      const { template } = createStack();
      template.hasResourceProperties("AWS::SageMaker::EndpointConfig", {
        AsyncInferenceConfig: Match.objectLike({
          OutputConfig: Match.objectLike({
            S3OutputPath: {
              "Fn::Join": [
                "",
                ["s3://", Match.anyValue(), "/batches/_async/outputs/"],
              ],
            },
          }),
        }),
      });
    });

    it("AsyncInferenceConfig.OutputConfig.S3FailurePath が batches/_async/errors/ prefix", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SageMaker::EndpointConfig", {
        AsyncInferenceConfig: Match.objectLike({
          OutputConfig: Match.objectLike({
            S3FailurePath: {
              "Fn::Join": [
                "",
                ["s3://", Match.anyValue(), "/batches/_async/errors/"],
              ],
            },
          }),
        }),
      });
    });

    it("S3OutputPath / S3FailurePath が batches/ 配下であること (安全弁)", () => {
      const { template } = createStack();
      const configs = template.findResources("AWS::SageMaker::EndpointConfig");
      for (const resource of Object.values(configs)) {
        const out = (
          resource.Properties as {
            AsyncInferenceConfig?: {
              OutputConfig?: {
                S3OutputPath?: unknown;
                S3FailurePath?: unknown;
              };
            };
          }
        ).AsyncInferenceConfig?.OutputConfig;

        // Fn::Join の 2 要素目 (文字列配列) を stringify し `/batches/_async/` が含まれるか
        // を検査する。prefix が意図せず `/input/` 等に逃げていないことへの安全弁。
        const asJson = JSON.stringify(out);
        expect(asJson).toMatch(/batches\/_async\/outputs\//);
        expect(asJson).toMatch(/batches\/_async\/errors\//);
      }
    });

    it("ClientConfig.MaxConcurrentInvocationsPerInstance が context 値", () => {
      const { template } = createStack({
        asyncRuntime: { maxConcurrentInvocationsPerInstance: 8 },
      });
      template.hasResourceProperties("AWS::SageMaker::EndpointConfig", {
        AsyncInferenceConfig: Match.objectLike({
          ClientConfig: Match.objectLike({
            MaxConcurrentInvocationsPerInstance: 8,
          }),
        }),
      });
    });

    it("NotificationConfig が SuccessTopic / ErrorTopic を参照で配線", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SageMaker::EndpointConfig", {
        AsyncInferenceConfig: Match.objectLike({
          OutputConfig: Match.objectLike({
            NotificationConfig: {
              SuccessTopic: Match.objectLike({ Ref: Match.anyValue() }),
              ErrorTopic: Match.objectLike({ Ref: Match.anyValue() }),
            },
          }),
        }),
      });
    });
  });

  // -------------------------------------------------------------------------
  // Task 2.2: SNS SuccessTopic / ErrorTopic
  // -------------------------------------------------------------------------
  describe("SNS Topics", () => {
    it("SuccessTopic と ErrorTopic の 2 本が AWS::SNS::Topic として存在", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::SNS::Topic", 2);
    });

    it("両 Topic が AWS 管理 KMS (alias/aws/sns) で SSE 暗号化されている", () => {
      const { template } = createStack();
      const topics = template.findResources("AWS::SNS::Topic");
      expect(Object.values(topics).length).toBe(2);
      for (const resource of Object.values(topics)) {
        const props = resource.Properties as {
          KmsMasterKeyId?: unknown;
        };
        expect(props.KmsMasterKeyId).toBeDefined();
      }
    });

    it("TopicPolicy が sagemaker service principal に限定された Publish を許可", () => {
      const { template } = createStack();
      // 各 Topic に対して 1 本ずつ TopicPolicy があり、sagemaker.amazonaws.com の
      // sns:Publish を SourceArn=<endpoint arn> 条件付きで許可していることを確認。
      template.resourceCountIs("AWS::SNS::TopicPolicy", 2);
      const policies = template.findResources("AWS::SNS::TopicPolicy");
      for (const resource of Object.values(policies)) {
        const doc = (
          resource.Properties as {
            PolicyDocument: {
              Statement: Array<{
                Principal?: { Service?: string };
                Action?: string | string[];
                Condition?: Record<string, Record<string, string>>;
              }>;
            };
          }
        ).PolicyDocument;
        const sagemakerStmt = doc.Statement.find(
          (s) => s.Principal?.Service === "sagemaker.amazonaws.com",
        );
        expect(sagemakerStmt).toBeDefined();
        expect(sagemakerStmt?.Action).toBe("sns:Publish");
        expect(sagemakerStmt?.Condition?.ArnEquals?.["aws:SourceArn"]).toMatch(
          /:endpoint\/yomitoku-pro-endpoint$/,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // Task 2.3: SQS Queue + SNS Subscription
  // -------------------------------------------------------------------------
  describe("SQS Queues", () => {
    it("AsyncCompletionQueue / AsyncFailureQueue + 各 DLQ の計 4 本", () => {
      // SNS から受信する主 Queue 2 本 + 処理失敗を退避する DLQ 2 本 = 計 4 本。
      // DLQ は cdk-nag AwsSolutions-SQS3 対策であると同時に、batch-runner 側の
      // 処理失敗 (message visibility timeout 超過など) を保全する運用要件。
      const { template } = createStack();
      template.resourceCountIs("AWS::SQS::Queue", 4);
    });

    it("主 Queue 2 本が 20 秒 long-poll + RedrivePolicy、全 4 本 が SSE-SQS 有効 + SSL 強制", () => {
      // SNS (alias/aws/sns) から subscribe する都合で SQS 側は KMS ではなく
      // SSE-SQS (SqsManagedSseEnabled=true) を採用している。
      // 主 Queue には maxReceiveCount=5 の RedrivePolicy が必要、DLQ 側は不要。
      const { template } = createStack();
      const queues = template.findResources("AWS::SQS::Queue");
      expect(Object.values(queues).length).toBe(4);

      let longPollQueueCount = 0;
      let redriveQueueCount = 0;
      for (const resource of Object.values(queues)) {
        const props = resource.Properties as {
          ReceiveMessageWaitTimeSeconds?: number;
          SqsManagedSseEnabled?: boolean;
          RedrivePolicy?: {
            maxReceiveCount?: number;
            deadLetterTargetArn?: unknown;
          };
        };
        expect(props.SqsManagedSseEnabled).toBe(true);
        if (props.ReceiveMessageWaitTimeSeconds === 20) {
          longPollQueueCount += 1;
        }
        if (props.RedrivePolicy !== undefined) {
          expect(props.RedrivePolicy.maxReceiveCount).toBe(5);
          expect(props.RedrivePolicy.deadLetterTargetArn).toBeDefined();
          redriveQueueCount += 1;
        }
      }
      expect(longPollQueueCount).toBe(2);
      expect(redriveQueueCount).toBe(2);

      // SSL 強制 Queue policy (AwsSolutions-SQS4) が 4 本すべてに付与されていること
      const queuePolicies = template.findResources("AWS::SQS::QueuePolicy");
      expect(Object.values(queuePolicies).length).toBeGreaterThanOrEqual(4);
      const sslStatementRegex = /aws:SecureTransport/;
      let sslDenyCount = 0;
      for (const policy of Object.values(queuePolicies)) {
        const doc = JSON.stringify(
          (policy.Properties as { PolicyDocument: unknown }).PolicyDocument,
        );
        if (sslStatementRegex.test(doc)) {
          sslDenyCount += 1;
        }
      }
      expect(sslDenyCount).toBe(4);
    });

    it("SNS → SQS Subscription が 2 本配線されている (SuccessTopic / ErrorTopic)", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::SNS::Subscription", 2);
      const subs = template.findResources("AWS::SNS::Subscription");
      for (const resource of Object.values(subs)) {
        const props = resource.Properties as {
          Protocol?: string;
          Endpoint?: unknown;
          TopicArn?: unknown;
        };
        expect(props.Protocol).toBe("sqs");
        expect(props.Endpoint).toBeDefined();
        expect(props.TopicArn).toBeDefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Task 2.4: Application Auto Scaling ScalableTarget / ScalingPolicy
  // -------------------------------------------------------------------------
  describe("Application Auto Scaling", () => {
    it("ScalableTarget が MinCapacity=0 / MaxCapacity=asyncMaxCapacity で登録される", () => {
      const { template } = createStack({
        asyncRuntime: { asyncMaxCapacity: 3 },
      });
      template.hasResourceProperties(
        "AWS::ApplicationAutoScaling::ScalableTarget",
        {
          MinCapacity: 0,
          MaxCapacity: 3,
          ServiceNamespace: "sagemaker",
          ScalableDimension: "sagemaker:variant:DesiredInstanceCount",
          ResourceId: `endpoint/${TEST_ENDPOINT_NAME}/variant/AllTraffic`,
        },
      );
    });

    it("ScalableTarget が Endpoint に DependsOn", () => {
      const { template } = createStack();
      const targets = template.findResources(
        "AWS::ApplicationAutoScaling::ScalableTarget",
      );
      const values = Object.values(targets);
      expect(values.length).toBe(1);
      const dependsOn = values[0].DependsOn as string[] | undefined;
      expect(dependsOn).toBeDefined();
      // 少なくとも 1 件が SageMaker::Endpoint を指していることを確認
      const endpoints = template.findResources("AWS::SageMaker::Endpoint");
      const endpointLogicalIds = Object.keys(endpoints);
      expect(dependsOn?.some((d) => endpointLogicalIds.includes(d))).toBe(true);
    });

    it("AsyncBacklogScalingPolicy が backlog + inflight の metric math 式を使う", () => {
      const { template } = createStack({
        asyncRuntime: { scaleInCooldownSeconds: 900 },
      });
      template.hasResourceProperties(
        "AWS::ApplicationAutoScaling::ScalingPolicy",
        {
          PolicyName: "AsyncBacklogTargetTracking",
          PolicyType: "TargetTrackingScaling",
          TargetTrackingScalingPolicyConfiguration: Match.objectLike({
            CustomizedMetricSpecification: Match.objectLike({
              Metrics: Match.arrayWith([
                Match.objectLike({
                  Id: "m1",
                  ReturnData: false,
                  MetricStat: Match.objectLike({
                    Stat: "Average",
                    Metric: Match.objectLike({
                      Namespace: "AWS/SageMaker",
                      MetricName: "ApproximateBacklogSize",
                      Dimensions: [
                        { Name: "EndpointName", Value: TEST_ENDPOINT_NAME },
                      ],
                    }),
                  }),
                }),
                Match.objectLike({
                  Id: "m2",
                  ReturnData: false,
                  MetricStat: Match.objectLike({
                    Stat: "Sum",
                    Metric: Match.objectLike({
                      Namespace: "Yomitoku/AsyncEndpoint",
                      MetricName: "InflightInvocations",
                      Dimensions: [
                        { Name: "EndpointName", Value: TEST_ENDPOINT_NAME },
                      ],
                    }),
                  }),
                }),
                Match.objectLike({
                  Id: "e1",
                  Expression: "FILL(m1, 0) + IF(FILL(m2, 0) > 0, 5, 0)",
                  Label: "BacklogPlusInflightFloor",
                  ReturnData: true,
                }),
              ]),
            }),
            TargetValue: 5,
            ScaleInCooldown: 900,
            ScaleOutCooldown: 60,
          }),
        },
      );
    });

    it("AsyncBacklogScalingPolicy の MetricStat に CFN 非対応の Period を出力しない", () => {
      const { template } = createStack();
      const policies = template.findResources(
        "AWS::ApplicationAutoScaling::ScalingPolicy",
      );
      const targetTrackingPolicy = Object.values(policies).find(
        (resource) =>
          (
            resource.Properties as {
              PolicyName?: string;
            }
          ).PolicyName === "AsyncBacklogTargetTracking",
      );
      expect(targetTrackingPolicy).toBeDefined();

      const metrics = (
        targetTrackingPolicy?.Properties as {
          TargetTrackingScalingPolicyConfiguration: {
            CustomizedMetricSpecification: {
              Metrics: Array<{
                Id?: string;
                MetricStat?: Record<string, unknown>;
              }>;
            };
          };
        }
      ).TargetTrackingScalingPolicyConfiguration.CustomizedMetricSpecification
        .Metrics;
      for (const metric of metrics.filter((item) => item.MetricStat)) {
        expect(metric.MetricStat).not.toHaveProperty("Period");
      }
    });

    it("AsyncBacklogScalingPolicy の targetValue と metric math 閾値が同期している", () => {
      const { template } = createStack();
      const policies = template.findResources(
        "AWS::ApplicationAutoScaling::ScalingPolicy",
      );
      const targetTrackingPolicy = Object.values(policies).find(
        (resource) =>
          (
            resource.Properties as {
              PolicyName?: string;
            }
          ).PolicyName === "AsyncBacklogTargetTracking",
      );
      expect(targetTrackingPolicy).toBeDefined();

      const config = (
        targetTrackingPolicy?.Properties as {
          TargetTrackingScalingPolicyConfiguration: {
            TargetValue: number;
            CustomizedMetricSpecification: {
              Metrics: Array<{
                Id?: string;
                Expression?: string;
              }>;
            };
          };
        }
      ).TargetTrackingScalingPolicyConfiguration;
      const expression = config.CustomizedMetricSpecification.Metrics.find(
        (metric) => metric.Id === "e1",
      )?.Expression;
      expect(config.TargetValue).toBe(5);
      expect(expression).toContain(`> 0, ${config.TargetValue}, 0`);
    });

    it("asyncMaxCapacity=1 では MaxCapacity=1 かつ前提崩れ警告なし", () => {
      const { stack, template } = createStack({
        asyncRuntime: { asyncMaxCapacity: 1 },
      });

      template.hasResourceProperties(
        "AWS::ApplicationAutoScaling::ScalableTarget",
        {
          MaxCapacity: 1,
        },
      );
      AssertionAnnotations.fromStack(stack).hasNoWarning(
        "*",
        Match.stringLikeRegexp("async-endpoint-scale-in-protection"),
      );
    });

    it("asyncMaxCapacity=2 では前提崩れ警告を synth annotation として出す", () => {
      const { stack, template } = createStack({
        asyncRuntime: { asyncMaxCapacity: 2 },
      });

      template.hasResourceProperties(
        "AWS::ApplicationAutoScaling::ScalableTarget",
        {
          MaxCapacity: 2,
        },
      );
      AssertionAnnotations.fromStack(stack).hasWarning(
        "*",
        Match.stringLikeRegexp("async-endpoint-scale-in-protection"),
      );
    });

    it("scale-from-zero の StepScaling policy と HasBacklogWithoutCapacity alarm を維持する", () => {
      const { template } = createStack();

      template.hasResourceProperties(
        "AWS::ApplicationAutoScaling::ScalingPolicy",
        {
          PolicyName: "AsyncScaleOutOnBacklogWithoutCapacity",
          PolicyType: "StepScaling",
          StepScalingPolicyConfiguration: Match.objectLike({
            AdjustmentType: "ChangeInCapacity",
            Cooldown: 60,
            MetricAggregationType: "Maximum",
            StepAdjustments: [
              {
                MetricIntervalLowerBound: 0,
                ScalingAdjustment: 1,
              },
            ],
          }),
        },
      );
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "HasBacklogWithoutCapacity",
        Namespace: "AWS/SageMaker",
        Statistic: "Maximum",
        Period: 60,
        EvaluationPeriods: 2,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
        Dimensions: [{ Name: "EndpointName", Value: TEST_ENDPOINT_NAME }],
      });
    });
  });

  // -------------------------------------------------------------------------
  // Task 2.5: CfnEndpoint を SagemakerStack が所有
  // -------------------------------------------------------------------------
  describe("CfnEndpoint", () => {
    it("SagemakerStack が AWS::SageMaker::Endpoint を 1 本所有する", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::SageMaker::Endpoint", 1);
      template.hasResourceProperties("AWS::SageMaker::Endpoint", {
        EndpointName: TEST_ENDPOINT_NAME,
      });
    });

    it("Endpoint が 新 Async EndpointConfig を参照する", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SageMaker::Endpoint", {
        EndpointConfigName: Match.anyValue(),
      });
    });
  });

  // -------------------------------------------------------------------------
  // Task 2.6: SageMaker 実行ロール S3 権限最小化
  // -------------------------------------------------------------------------
  describe("SageMaker ExecutionRole S3 permissions", () => {
    it("s3:GetObject が batches/_async/inputs/* prefix に限定", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: "S3AsyncInputGet",
              Action: "s3:GetObject",
              Resource: Match.objectLike({
                "Fn::Join": ["", Match.arrayWith(["/batches/_async/inputs/*"])],
              }),
            }),
          ]),
        },
      });
    });

    it("s3:PutObject が batches/_async/outputs/* と batches/_async/errors/* に限定", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: "S3AsyncOutputPut",
              Action: "s3:PutObject",
              Resource: [
                Match.objectLike({
                  "Fn::Join": [
                    "",
                    Match.arrayWith(["/batches/_async/outputs/*"]),
                  ],
                }),
                Match.objectLike({
                  "Fn::Join": [
                    "",
                    Match.arrayWith(["/batches/_async/errors/*"]),
                  ],
                }),
              ],
            }),
          ]),
        },
      });
    });

    it("s3:* (bucket-wide) がどの実行ロールにも付与されていない", () => {
      const { template } = createStack();
      const policies = template.findResources("AWS::IAM::Policy");
      for (const resource of Object.values(policies)) {
        const doc = (
          resource.Properties as {
            PolicyDocument: {
              Statement: Array<{ Action?: string | string[] }>;
            };
          }
        ).PolicyDocument;
        for (const stmt of doc.Statement) {
          const actions = Array.isArray(stmt.Action)
            ? stmt.Action
            : stmt.Action
              ? [stmt.Action]
              : [];
          for (const action of actions) {
            expect(action).not.toBe("s3:*");
          }
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Public properties (Task 2.5 export contract)
  // -------------------------------------------------------------------------
  describe("public properties", () => {
    it("endpointConfigName / endpointName / modelName を公開する", () => {
      const { stack } = createStack();
      expect(stack.endpointConfigName).toBe(EXPECTED_ASYNC_CONFIG_NAME);
      expect(stack.endpointName).toBe(TEST_ENDPOINT_NAME);
      expect(stack.modelName).toBeDefined();
    });

    it("successTopic / errorTopic / successQueue / failureQueue を公開する", () => {
      const { stack } = createStack();
      expect(stack.successTopic).toBeDefined();
      expect(stack.errorTopic).toBeDefined();
      expect(stack.successQueue).toBeDefined();
      expect(stack.failureQueue).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Cost Explorer タグ戦略 (Task 7.4, Req 9.2)
  // -------------------------------------------------------------------------
  describe("Cost Explorer タグ戦略 (Task 7.4)", () => {
    const hasTag = (tags: unknown, key: string, value: string): boolean => {
      if (!Array.isArray(tags)) return false;
      return tags.some(
        (t) =>
          typeof t === "object" &&
          t !== null &&
          (t as { Key?: unknown }).Key === key &&
          (t as { Value?: unknown }).Value === value,
      );
    };

    it("SNS Topic に yomitoku:stack=sagemaker-async と yomitoku:component=sns が付く", () => {
      const { template } = createStack();
      const topics = template.findResources("AWS::SNS::Topic");
      const topicList = Object.values(topics);
      expect(topicList.length).toBe(2);
      for (const topic of topicList) {
        const tags = (topic as { Properties?: { Tags?: unknown } }).Properties
          ?.Tags;
        expect(hasTag(tags, "yomitoku:stack", "sagemaker-async")).toBe(true);
        expect(hasTag(tags, "yomitoku:component", "sns")).toBe(true);
      }
    });

    it("SQS Queue (DLQ 含む) に yomitoku:stack=sagemaker-async と yomitoku:component=sqs が付く", () => {
      const { template } = createStack();
      const queues = template.findResources("AWS::SQS::Queue");
      const queueList = Object.values(queues);
      expect(queueList.length).toBe(4);
      for (const queue of queueList) {
        const tags = (queue as { Properties?: { Tags?: unknown } }).Properties
          ?.Tags;
        expect(hasTag(tags, "yomitoku:stack", "sagemaker-async")).toBe(true);
        expect(hasTag(tags, "yomitoku:component", "sqs")).toBe(true);
      }
    });

    it("SageMaker Endpoint は component=endpoint (スタック既定) を継承", () => {
      const { template } = createStack();
      const endpoints = template.findResources("AWS::SageMaker::Endpoint");
      const endpointList = Object.values(endpoints);
      expect(endpointList.length).toBe(1);
      const tags = (endpointList[0] as { Properties?: { Tags?: unknown } })
        .Properties?.Tags;
      expect(hasTag(tags, "yomitoku:stack", "sagemaker-async")).toBe(true);
      expect(hasTag(tags, "yomitoku:component", "endpoint")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Stack Outputs
  // -------------------------------------------------------------------------
  describe("Stack Outputs", () => {
    it("EndpointConfigName / EndpointName / SuccessTopicArn / ErrorTopicArn / SuccessQueueUrl / FailureQueueUrl を出力", () => {
      const { template } = createStack();
      template.hasOutput("EndpointConfigName", {
        Value: EXPECTED_ASYNC_CONFIG_NAME,
      });
      template.hasOutput("EndpointName", { Value: TEST_ENDPOINT_NAME });
      template.hasOutput("SuccessTopicArn", Match.anyValue());
      template.hasOutput("ErrorTopicArn", Match.anyValue());
      template.hasOutput("SuccessQueueUrl", Match.anyValue());
      template.hasOutput("FailureQueueUrl", Match.anyValue());
    });
  });
});
