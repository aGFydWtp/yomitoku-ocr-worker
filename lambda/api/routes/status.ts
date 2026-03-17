import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { Hono } from "hono";
import { docClient } from "../lib/dynamodb";

export const statusRoutes = new Hono();

statusRoutes.get("/", async (c) => {
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

  const item = result.Item;
  return c.json({
    endpointState: (item?.endpoint_state as string) ?? "IDLE",
    updatedAt: (item?.updated_at as string) ?? null,
  });
});
