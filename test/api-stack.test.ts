import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Bucket } from "aws-cdk-lib/aws-s3";
import {
  DefinitionBody,
  Pass,
  StateMachine,
} from "aws-cdk-lib/aws-stepfunctions";
import { App, Stack } from "aws-cdk-lib/core";
import { describe, expect, it } from "vitest";
import { ApiStack } from "../lib/api-stack";

const TEST_REGION = "us-east-1";
const TEST_ACCOUNT = "123456789012";

function createStack(): {
  app: App;
  stack: ApiStack;
  template: Template;
} {
  const app = new App();
  const depStack = new Stack(app, "DepStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
  });

  const bucket = new Bucket(depStack, "TestBucket");
  const controlTable = new Table(depStack, "TestControlTable", {
    partitionKey: { name: "lock_key", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });
  const batchTable = new Table(depStack, "TestBatchTable", {
    partitionKey: { name: "PK", type: AttributeType.STRING },
    sortKey: { name: "SK", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });
  batchTable.addGlobalSecondaryIndex({
    indexName: "GSI1",
    partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
    sortKey: { name: "GSI1SK", type: AttributeType.STRING },
  });
  batchTable.addGlobalSecondaryIndex({
    indexName: "GSI2",
    partitionKey: { name: "GSI2PK", type: AttributeType.STRING },
    sortKey: { name: "GSI2SK", type: AttributeType.STRING },
  });
  const batchExecutionStateMachine = new StateMachine(
    depStack,
    "TestBatchExecutionStateMachine",
    {
      definitionBody: DefinitionBody.fromChainable(
        new Pass(depStack, "BatchStart"),
      ),
    },
  );

  const stack = new ApiStack(app, "TestApiStack", {
    env: { region: TEST_REGION, account: TEST_ACCOUNT },
    bucket,
    controlTable,
    batchTable,
    batchExecutionStateMachine,
  });

  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe("ApiStack (batch-first IAM / env wiring, Task 6.2)", () => {
  // --- NodejsFunction ---
  describe("NodejsFunction", () => {
    it("ランタイムが Node.js 24.x である", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Runtime: "nodejs24.x",
      });
    });

    it("タイムアウトが 29 秒", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Timeout: 29,
      });
    });

    it("メモリサイズが 256 MB", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        MemorySize: 256,
      });
    });

    it("環境変数に BUCKET_NAME / CONTROL_TABLE_NAME / BATCH_TABLE_NAME / BATCH_EXECUTION_STATE_MACHINE_ARN が設定されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: {
            BUCKET_NAME: Match.anyValue(),
            CONTROL_TABLE_NAME: Match.anyValue(),
            BATCH_TABLE_NAME: Match.anyValue(),
            BATCH_EXECUTION_STATE_MACHINE_ARN: Match.anyValue(),
          },
        },
      });
    });

    it("STATUS_TABLE_NAME 環境変数が存在しない", () => {
      const { template } = createStack();
      const fns = template.findResources("AWS::Lambda::Function");
      const serialized = JSON.stringify(fns);
      expect(serialized).not.toContain("STATUS_TABLE_NAME");
    });

    it("STATE_MACHINE_ARN 環境変数 (EndpointControl 由来) が存在しない (Task 7.3: orchestration 剥離)", () => {
      const { template } = createStack();
      const fns = template.findResources("AWS::Lambda::Function");
      // Environment.Variables のキー集合を走査し、BATCH_EXECUTION_STATE_MACHINE_ARN
      // とは別に `STATE_MACHINE_ARN` というキーが残っていないことを確認する。
      // 単純な substring match では BATCH_EXECUTION_STATE_MACHINE_ARN に部分一致して
      // 偽陽性になるため、キー名の完全一致で検査する。
      const keys = new Set<string>();
      for (const fn of Object.values(fns)) {
        const vars = (
          fn as {
            Properties?: {
              Environment?: { Variables?: Record<string, unknown> };
            };
          }
        ).Properties?.Environment?.Variables;
        if (vars) for (const k of Object.keys(vars)) keys.add(k);
      }
      expect(keys.has("STATE_MACHINE_ARN")).toBe(false);
      expect(keys.has("BATCH_EXECUTION_STATE_MACHINE_ARN")).toBe(true);
    });
  });

  // --- API Gateway ---
  describe("API Gateway", () => {
    it("LambdaRestApi が REGIONAL エンドポイントで作成されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        EndpointConfiguration: {
          Types: ["REGIONAL"],
        },
      });
    });
  });

  // --- API Key は不要（CloudFront + WAF で制御） ---
  describe("API Key が存在しないこと", () => {
    it("ApiKey リソースが作成されていない", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::ApiGateway::ApiKey", 0);
    });

    it("UsagePlan が作成されていない", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::ApiGateway::UsagePlan", 0);
    });
  });

  // --- Secrets Manager (H1: origin verify secret) ---
  describe("Origin Verify Secret (H1)", () => {
    it("Secrets Manager シークレットリソースが 1 つ作成されている", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::SecretsManager::Secret", 1);
    });

    it("GenerateSecretString で 64 文字の高エントロピー値を自動生成する", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::SecretsManager::Secret", {
        GenerateSecretString: Match.objectLike({
          PasswordLength: 64,
          ExcludePunctuation: true,
        }),
      });
    });
  });

  // --- CloudFront Distribution ---
  describe("CloudFront Distribution", () => {
    it("CloudFront Distribution が作成されている", () => {
      const { template } = createStack();
      template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    });

    it("Origin Custom Header x-origin-verify が設定されている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          Origins: Match.arrayWith([
            Match.objectLike({
              OriginCustomHeaders: Match.arrayWith([
                Match.objectLike({
                  HeaderName: "x-origin-verify",
                  HeaderValue: Match.anyValue(),
                }),
              ]),
            }),
          ]),
        },
      });
    });

    it("customHeaders が Secrets Manager 動的参照を使用する (H1: ハードコード撤去)", () => {
      const { template } = createStack();
      const distributions = template.findResources(
        "AWS::CloudFront::Distribution",
      );
      const serialized = JSON.stringify(distributions);
      // CFN の Secrets Manager dynamic reference が含まれている
      expect(serialized).toContain("{{resolve:secretsmanager:");
    });

    it("ViewerProtocolPolicy が redirect-to-https である", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          DefaultCacheBehavior: Match.objectLike({
            ViewerProtocolPolicy: "redirect-to-https",
          }),
        },
      });
    });

    it("AllowedMethods が全メソッド許可である", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          DefaultCacheBehavior: Match.objectLike({
            AllowedMethods: Match.arrayWith([
              "GET",
              "HEAD",
              "OPTIONS",
              "PUT",
              "PATCH",
              "POST",
              "DELETE",
            ]),
          }),
        },
      });
    });
  });

  // --- API Gateway リソースポリシー ---
  describe("API Gateway Resource Policy", () => {
    it("リソースポリシーに DENY ステートメントが含まれている（Referer 不一致時）", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        Policy: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Action: "execute-api:Invoke",
              Condition: {
                StringNotEquals: {
                  "aws:Referer": Match.anyValue(),
                },
              },
            }),
          ]),
        }),
      });
    });

    it("リソースポリシーに ALLOW ステートメントが含まれている", () => {
      const { template } = createStack();
      template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        Policy: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "execute-api:Invoke",
            }),
          ]),
        }),
      });
    });
  });

  // --- IAM 権限（Task 6.2: batch-first 再スコープ） ---
  describe("IAM Permissions (batch-first)", () => {
    // PolicyDocument 群だけを抽出した上で Match ベースで判定する (L3)。
    // JSON.stringify(全 Policies) は論理 ID・メタデータまで拾って偽陽性/偽陰性を起こし得るため、
    // Statement 配列のみをフラット化し Action/Resource の所在を構造的に検査する。
    function extractStatements(
      template: Template,
    ): ReadonlyArray<Record<string, unknown>> {
      const policies = template.findResources("AWS::IAM::Policy");
      const stmts: Record<string, unknown>[] = [];
      for (const policy of Object.values(policies)) {
        const doc = (policy as { Properties?: { PolicyDocument?: unknown } })
          .Properties?.PolicyDocument as
          | { Statement?: Record<string, unknown>[] }
          | undefined;
        if (doc?.Statement) stmts.push(...doc.Statement);
      }
      return stmts;
    }

    function hasAction(
      stmts: ReadonlyArray<Record<string, unknown>>,
      action: string,
    ): boolean {
      return stmts.some((s) => {
        const a = s.Action;
        return (
          a === action ||
          (Array.isArray(a) && (a as unknown[]).includes(action))
        );
      });
    }

    it("StatusTable への DynamoDB 書き込み権限が存在しない (legacy)", () => {
      const { template } = createStack();
      // StatusTable を論理 ID に含む DynamoDB::Table は生成されないことを直接検査する
      const tables = template.findResources("AWS::DynamoDB::Table");
      const tableLogicalIds = Object.keys(tables);
      expect(tableLogicalIds.some((id) => id.includes("StatusTable"))).toBe(
        false,
      );
    });

    it("旧 input/* / output/* / visualizations/* への S3 grants が存在しない (legacy)", () => {
      const { template } = createStack();
      // PolicyDocument 範囲に限定して旧 prefix の Resource 指定がないことを確認する
      const serialized = JSON.stringify(extractStatements(template));
      expect(serialized).not.toContain("input/*");
      expect(serialized).not.toContain("output/*");
      expect(serialized).not.toContain("visualizations/*");
    });

    it("S3 `batches/*` プレフィックスに対する GetObject/PutObject/DeleteObject 権限を付与している", () => {
      const { template } = createStack();
      template.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Effect: "Allow",
                Action: Match.arrayWith([
                  "s3:GetObject",
                  "s3:PutObject",
                  "s3:DeleteObject",
                ]),
              }),
            ]),
          }),
        }),
      );
      // Resource が batches/* スコープに限定されていることを構造的に確認する
      const stmts = extractStatements(template);
      const s3Resources = stmts.flatMap((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        const hasS3 = (actions as unknown[]).some(
          (a) => typeof a === "string" && a.startsWith("s3:"),
        );
        if (!hasS3) return [] as unknown[];
        const res = s.Resource;
        return Array.isArray(res) ? res : [res];
      });
      expect(JSON.stringify(s3Resources)).toContain("batches/*");
    });

    it("BatchTable への PutItem / UpdateItem / GetItem / Query / TransactWriteItems 権限を付与している", () => {
      const { template } = createStack();
      const stmts = extractStatements(template);
      expect(hasAction(stmts, "dynamodb:PutItem")).toBe(true);
      expect(hasAction(stmts, "dynamodb:UpdateItem")).toBe(true);
      expect(hasAction(stmts, "dynamodb:GetItem")).toBe(true);
      expect(hasAction(stmts, "dynamodb:Query")).toBe(true);
      expect(hasAction(stmts, "dynamodb:TransactWriteItems")).toBe(true);
    });

    // StartExecution の Resource は dep stack からの Fn::ImportValue で解決されるため、
    // Ref 固定の構造一致ではなく「states:StartExecution を含む Statement のうち、
    // Resource のシリアライズに特定の論理 ID が含まれているか」で検査する。
    function hasStartExecutionFor(
      template: Template,
      logicalIdSubstring: string,
    ): boolean {
      return extractStatements(template).some((s) => {
        if (s.Action !== "states:StartExecution") return false;
        if (s.Effect !== "Allow") return false;
        return JSON.stringify(s.Resource ?? "").includes(logicalIdSubstring);
      });
    }

    it("BatchExecutionStateMachine への StartExecution 権限を付与している", () => {
      const { template } = createStack();
      expect(
        hasStartExecutionFor(template, "TestBatchExecutionStateMachine"),
      ).toBe(true);
    });

    it("ControlTable への読み取り権限 (GetItem) が維持されている", () => {
      const { template } = createStack();
      template.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Effect: "Allow",
                Action: Match.arrayWith(["dynamodb:GetItem"]),
              }),
            ]),
          }),
        }),
      );
    });

    it("EndpointControl StateMachine への StartExecution は付与されない (Task 7.3: orchestration 剥離)", () => {
      const { template } = createStack();
      // StartExecution は BatchExecution SM 以外に残っていないことを確認する。
      const stmts = extractStatements(template);
      const nonBatchStarts = stmts.filter((s) => {
        if (s.Action !== "states:StartExecution") return false;
        if (s.Effect !== "Allow") return false;
        const resourceJson = JSON.stringify(s.Resource ?? "");
        return !resourceJson.includes("TestBatchExecutionStateMachine");
      });
      expect(nonBatchStarts).toHaveLength(0);
    });
  });

  // --- Stack Outputs ---
  describe("Stack Outputs", () => {
    it("ApiUrl を出力する", () => {
      const { template } = createStack();
      template.hasOutput("ApiUrl", { Value: Match.anyValue() });
    });

    it("DistributionDomainName を出力する", () => {
      const { template } = createStack();
      template.hasOutput("DistributionDomainName", {
        Value: Match.anyValue(),
      });
    });
  });
});
