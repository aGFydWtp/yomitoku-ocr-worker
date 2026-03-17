import { StartExecutionCommand } from "@aws-sdk/client-sfn";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { docClient } from "../lib/dynamodb";
import { handleError } from "../lib/errors";
import { sfnClient } from "../lib/sfn";
import { assertValidStateMachineArn } from "../lib/validate";
import type { EndpointState } from "../schemas";
import {
  ENDPOINT_STATES,
  ErrorResponseSchema,
  StartEndpointResponseSchema,
} from "../schemas";

export const upRoutes = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      return c.json({ error: firstIssue.message }, 400);
    }
    return undefined;
  },
});

upRoutes.onError(handleError);

const startEndpointRoute = createRoute({
  method: "post",
  path: "/",
  summary: "エンドポイント起動",
  description:
    "SageMaker エンドポイントの起動を要求します。IDLE/DELETING なら Step Functions を起動し、CREATING なら起動中として返します。IN_SERVICE なら既に稼働中として 200 を返します。",
  responses: {
    200: {
      description: "エンドポイント稼働中",
      content: {
        "application/json": { schema: StartEndpointResponseSchema },
      },
    },
    202: {
      description: "エンドポイント起動を受け付け",
      content: {
        "application/json": { schema: StartEndpointResponseSchema },
      },
    },
    500: {
      description: "サーバーエラー",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

function toEndpointState(raw: unknown): EndpointState {
  if (
    typeof raw === "string" &&
    (ENDPOINT_STATES as readonly string[]).includes(raw)
  ) {
    return raw as EndpointState;
  }
  return "IDLE";
}

upRoutes.openapi(startEndpointRoute, async (c) => {
  const controlTableName = process.env.CONTROL_TABLE_NAME;
  const stateMachineArn = process.env.STATE_MACHINE_ARN;
  if (!controlTableName || !stateMachineArn) {
    throw new Error("CONTROL_TABLE_NAME and STATE_MACHINE_ARN must be set");
  }
  assertValidStateMachineArn(stateMachineArn);

  const result = await docClient.send(
    new GetCommand({
      TableName: controlTableName,
      Key: { lock_key: "endpoint_control" },
      ConsistentRead: true,
    }),
  );

  const endpointState = toEndpointState(result.Item?.endpoint_state);

  if (endpointState === "IN_SERVICE") {
    return c.json(
      {
        message: "Endpoint is already running.",
        endpointState,
      },
      200 as const,
    );
  }

  if (endpointState === "CREATING") {
    return c.json(
      {
        message: "Endpoint is already starting.",
        endpointState,
      },
      202 as const,
    );
  }

  // IDLE or DELETING → start Step Functions
  // NOTE: DELETING 中に起動を要求するとステートマシン側で制御される。
  // ステートマシンは同一名での重複実行を拒否するため、実質的に冪等。
  await sfnClient.send(
    new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify({ trigger: "api_request" }),
    }),
  );

  return c.json(
    {
      message: "Endpoint start requested.",
      endpointState,
    },
    202 as const,
  );
});
