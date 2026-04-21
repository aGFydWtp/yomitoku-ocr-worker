import { randomUUID } from "node:crypto";
import { StartExecutionCommand } from "@aws-sdk/client-sfn";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { BatchPresign } from "../lib/batch-presign";
import { BatchStore } from "../lib/batch-store";
import { docClient } from "../lib/dynamodb";
import { ServiceUnavailableError, handleError } from "../lib/errors";
import { sfnClient } from "../lib/sfn";
import { assertValidStateMachineArn } from "../lib/validate";
import type { EndpointState } from "../schemas";
import { ENDPOINT_STATES } from "../schemas";
import { createBatchRoute } from "./batches.routes";

export const batchesRoutes = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      return c.json({ error: firstIssue.message }, 400);
    }
    return undefined;
  },
});

batchesRoutes.onError(handleError);

function toEndpointState(raw: unknown): EndpointState {
  if (
    typeof raw === "string" &&
    (ENDPOINT_STATES as readonly string[]).includes(raw)
  ) {
    return raw as EndpointState;
  }
  return "IDLE";
}

// --- POST /batches ---

batchesRoutes.openapi(createBatchRoute, async (c) => {
  const batchTableName = process.env.BATCH_TABLE_NAME;
  const bucketName = process.env.BUCKET_NAME;
  const controlTableName = process.env.CONTROL_TABLE_NAME;
  const stateMachineArn = process.env.STATE_MACHINE_ARN;

  if (!batchTableName || !bucketName || !controlTableName || !stateMachineArn) {
    throw new Error(
      "BATCH_TABLE_NAME, BUCKET_NAME, CONTROL_TABLE_NAME, and STATE_MACHINE_ARN must be set",
    );
  }
  assertValidStateMachineArn(stateMachineArn);

  // エンドポイント状態チェック（CloudFront → API GW 経路を前提とし、アプリ層で再確認）
  const controlResult = await docClient.send(
    new GetCommand({
      TableName: controlTableName,
      Key: { lock_key: "endpoint_control" },
      ConsistentRead: true,
    }),
  );
  const endpointState = toEndpointState(controlResult.Item?.endpoint_state);

  if (endpointState !== "IN_SERVICE") {
    // CREATING 中は既に起動リクエスト済みのためキック不要
    if (endpointState !== "CREATING") {
      await sfnClient.send(
        new StartExecutionCommand({
          stateMachineArn,
          input: JSON.stringify({ trigger: "batch_api_request" }),
        }),
      );
    }
    throw new ServiceUnavailableError(
      "SageMaker endpoint is not in service. Please retry after the endpoint becomes IN_SERVICE.",
      { endpointState },
    );
  }

  const body = c.req.valid("json");
  const batchJobId = randomUUID();

  const store = new BatchStore(batchTableName);
  const presign = new BatchPresign(bucketName);

  await store.putBatchWithFiles({
    batchJobId,
    basePath: body.basePath,
    files: body.files,
    bucket: bucketName,
    extraFormats: body.extraFormats,
  });

  const uploads = await presign.createUploadUrls({
    batchJobId,
    files: body.files,
  });

  return c.json({ batchJobId, uploads }, 201);
});
