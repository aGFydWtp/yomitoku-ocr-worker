import { randomUUID } from "node:crypto";
import { StartExecutionCommand } from "@aws-sdk/client-sfn";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OpenAPIHono } from "@hono/zod-openapi";
import { BatchPresign, RESULT_EXPIRES_IN } from "../lib/batch-presign";
import { BatchQuery } from "../lib/batch-query";
import { BatchStore } from "../lib/batch-store";
import { docClient } from "../lib/dynamodb";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  handleError,
} from "../lib/errors";
import { headObject } from "../lib/s3";
import { sfnClient } from "../lib/sfn";
import { assertValidStateMachineArn } from "../lib/validate";
import type { BatchStatus, EndpointState } from "../schemas";
import { BATCH_STATUSES, ENDPOINT_STATES } from "../schemas";
import {
  cancelBatchRoute,
  createBatchRoute,
  getBatchRoute,
  getProcessLogRoute,
  listBatchFilesRoute,
  listBatchesRoute,
  reanalyzeBatchRoute,
} from "./batches.routes";

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

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function toEndpointState(raw: unknown): EndpointState {
  if (
    typeof raw === "string" &&
    (ENDPOINT_STATES as readonly string[]).includes(raw)
  ) {
    return raw as EndpointState;
  }
  return "IDLE";
}

function currentYYYYMM(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

const TERMINAL_STATUSES: ReadonlyArray<BatchStatus> = [
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
];

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} must be set`);
  return val;
}

// ---------------------------------------------------------------------------
// POST / — バッチ作成
// ---------------------------------------------------------------------------
batchesRoutes.openapi(createBatchRoute, async (c) => {
  const batchTableName = requireEnv("BATCH_TABLE_NAME");
  const bucketName = requireEnv("BUCKET_NAME");
  const controlTableName = requireEnv("CONTROL_TABLE_NAME");
  const stateMachineArn = requireEnv("STATE_MACHINE_ARN");
  assertValidStateMachineArn(stateMachineArn);

  const controlResult = await docClient.send(
    new GetCommand({
      TableName: controlTableName,
      Key: { lock_key: "endpoint_control" },
      ConsistentRead: true,
    }),
  );
  const endpointState = toEndpointState(controlResult.Item?.endpoint_state);

  if (endpointState !== "IN_SERVICE") {
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

// ---------------------------------------------------------------------------
// GET / — バッチ一覧
// ---------------------------------------------------------------------------
batchesRoutes.openapi(listBatchesRoute, async (c) => {
  const batchTableName = requireEnv("BATCH_TABLE_NAME");
  const { status, month, cursor } = c.req.valid("query");

  const query = new BatchQuery(batchTableName);
  const result = await query.listBatchesByStatus(
    status as BatchStatus,
    month ?? currentYYYYMM(),
    cursor,
  );

  return c.json(result, 200);
});

// ---------------------------------------------------------------------------
// GET /:batchJobId — バッチ詳細
// ---------------------------------------------------------------------------
batchesRoutes.openapi(getBatchRoute, async (c) => {
  const batchTableName = requireEnv("BATCH_TABLE_NAME");
  const { batchJobId } = c.req.valid("param");

  const query = new BatchQuery(batchTableName);
  const result = await query.getBatchWithFiles(batchJobId);

  if (!result) throw new NotFoundError(`Batch ${batchJobId} not found`);

  // files は /files エンドポイントで提供するため除外
  const { files: _files, ...meta } = result;
  return c.json(meta, 200);
});

// ---------------------------------------------------------------------------
// GET /:batchJobId/files — ファイル一覧（完了ファイルに署名付き URL を付与）
// ---------------------------------------------------------------------------
batchesRoutes.openapi(listBatchFilesRoute, async (c) => {
  const batchTableName = requireEnv("BATCH_TABLE_NAME");
  const bucketName = requireEnv("BUCKET_NAME");
  const { batchJobId } = c.req.valid("param");

  const query = new BatchQuery(batchTableName);
  const batch = await query.getBatchWithFiles(batchJobId);

  if (!batch) throw new NotFoundError(`Batch ${batchJobId} not found`);

  const presign = new BatchPresign(bucketName);

  const items = await Promise.all(
    batch.files.map(async (f) => {
      if (f.status === "COMPLETED" && f.resultKey) {
        const resultUrl = await presign.createResultUrl(f.resultKey);
        return { ...f, resultUrl };
      }
      return f;
    }),
  );

  return c.json({ items, cursor: null }, 200);
});

// ---------------------------------------------------------------------------
// GET /:batchJobId/process-log — process_log.jsonl 署名付き URL
// ---------------------------------------------------------------------------
batchesRoutes.openapi(getProcessLogRoute, async (c) => {
  const batchTableName = requireEnv("BATCH_TABLE_NAME");
  const bucketName = requireEnv("BUCKET_NAME");
  const { batchJobId } = c.req.valid("param");

  const query = new BatchQuery(batchTableName);
  const batch = await query.getBatchWithFiles(batchJobId);

  if (!batch) throw new NotFoundError(`Batch ${batchJobId} not found`);

  if (!(TERMINAL_STATUSES as readonly string[]).includes(batch.status)) {
    throw new ConflictError(
      `Batch ${batchJobId} is not in a terminal state (current: ${batch.status})`,
    );
  }

  const presign = new BatchPresign(bucketName);
  const url = await presign.createProcessLogUrl(batchJobId);

  return c.json({ url, expiresIn: RESULT_EXPIRES_IN }, 200);
});

// ---------------------------------------------------------------------------
// DELETE /:batchJobId — バッチキャンセル
// ---------------------------------------------------------------------------
batchesRoutes.openapi(cancelBatchRoute, async (c) => {
  const batchTableName = requireEnv("BATCH_TABLE_NAME");
  const { batchJobId } = c.req.valid("param");

  const query = new BatchQuery(batchTableName);
  const batch = await query.getBatchWithFiles(batchJobId);

  if (!batch) throw new NotFoundError(`Batch ${batchJobId} not found`);

  if (batch.status !== "PENDING") {
    throw new ConflictError(
      `Cannot cancel batch ${batchJobId} in status ${batch.status}. Only PENDING batches can be cancelled.`,
    );
  }

  const store = new BatchStore(batchTableName);
  await store.transitionBatchStatus({
    batchJobId,
    newStatus: "CANCELLED",
    expectedCurrent: "PENDING",
  });

  return c.json({ batchJobId, status: "CANCELLED" as const }, 200);
});

// ---------------------------------------------------------------------------
// POST /:batchJobId/reanalyze — 失敗ファイルの再解析
// ---------------------------------------------------------------------------
batchesRoutes.openapi(reanalyzeBatchRoute, async (c) => {
  const batchTableName = requireEnv("BATCH_TABLE_NAME");
  const bucketName = requireEnv("BUCKET_NAME");
  const { batchJobId } = c.req.valid("param");

  const query = new BatchQuery(batchTableName);
  const parentBatch = await query.getBatchWithFiles(batchJobId);

  if (!parentBatch) throw new NotFoundError(`Batch ${batchJobId} not found`);

  const reanalyzableStatuses: ReadonlyArray<BatchStatus> = [
    "COMPLETED",
    "PARTIAL",
    "FAILED",
  ];
  if (!(reanalyzableStatuses as readonly string[]).includes(parentBatch.status)) {
    throw new ConflictError(
      `Cannot reanalyze batch ${batchJobId} in status ${parentBatch.status}. Only COMPLETED/PARTIAL/FAILED batches can be reanalyzed.`,
    );
  }

  // process_log.jsonl の存在確認
  const logKey = `batches/${batchJobId}/logs/process_log.jsonl`;
  const logExists = await headObject(bucketName, logKey);
  if (!logExists) {
    throw new NotFoundError(
      `process_log.jsonl not found for batch ${batchJobId}`,
    );
  }

  // 失敗ファイルを取得
  const failedFiles = await query.listFailedFiles(batchJobId);
  if (failedFiles.length === 0) {
    throw new ConflictError(
      `No failed files to reanalyze in batch ${batchJobId}`,
    );
  }

  // 新バッチを作成
  const newBatchJobId = randomUUID();
  const filesToReanalyze = failedFiles.map((f) => ({ filename: f.filename }));

  const store = new BatchStore(batchTableName);
  await store.putBatchWithFiles({
    batchJobId: newBatchJobId,
    basePath: parentBatch.basePath,
    files: filesToReanalyze,
    bucket: bucketName,
    parentBatchJobId: batchJobId,
  });

  const presign = new BatchPresign(bucketName);
  const uploads = await presign.createUploadUrls({
    batchJobId: newBatchJobId,
    files: filesToReanalyze,
  });

  return c.json({ batchJobId: newBatchJobId, uploads }, 201);
});
