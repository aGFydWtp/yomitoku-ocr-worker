import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { docClient } from "../lib/dynamodb";
import { EndpointStatusResponseSchema } from "../schemas";

export const statusRoutes = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      return c.json({ error: firstIssue.message }, 400);
    }
    return undefined;
  },
});

const getStatusRoute = createRoute({
  method: "get",
  path: "/",
  summary: "エンドポイント状態取得",
  description: "SageMaker エンドポイントの現在の状態を取得します。",
  responses: {
    200: {
      description: "エンドポイント状態",
      content: {
        "application/json": { schema: EndpointStatusResponseSchema },
      },
    },
  },
});

statusRoutes.openapi(getStatusRoute, async (c) => {
  const controlTableName = process.env.CONTROL_TABLE_NAME;
  if (!controlTableName) {
    throw new Error("CONTROL_TABLE_NAME must be set");
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: controlTableName,
      Key: { lock_key: "endpoint_control" },
      ConsistentRead: true,
    }),
  );

  const VALID_STATES = ["IDLE", "CREATING", "IN_SERVICE", "DELETING"] as const;
  type EndpointState = (typeof VALID_STATES)[number];

  const item = result.Item;
  const raw = (item?.endpoint_state as string) ?? "IDLE";
  const endpointState: EndpointState = (
    VALID_STATES as readonly string[]
  ).includes(raw)
    ? (raw as EndpointState)
    : "IDLE";

  return c.json({
    endpointState,
    updatedAt: (item?.updated_at as string) ?? null,
  });
});
