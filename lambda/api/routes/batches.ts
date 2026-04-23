import { randomUUID } from "node:crypto";
import { StartExecutionCommand } from "@aws-sdk/client-sfn";
import { OpenAPIHono } from "@hono/zod-openapi";
import { BatchPresign, RESULT_EXPIRES_IN } from "../lib/batch-presign";
import { BatchQuery } from "../lib/batch-query";
import { BatchStore } from "../lib/batch-store";
import {
  ConflictError,
  handleError,
  NotFoundError,
  ValidationError,
} from "../lib/errors";
import { headObject, listObjectKeys } from "../lib/s3";
import { sfnClient } from "../lib/sfn";
import { assertValidStateMachineArn } from "../lib/validate";
import type { BatchStatus } from "../schemas";
import {
  cancelBatchRoute,
  createBatchRoute,
  getBatchRoute,
  getProcessLogRoute,
  listBatchesRoute,
  listBatchFilesRoute,
  reanalyzeBatchRoute,
  startBatchRoute,
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

  // Task 7.3: Async Inference + AutoScaling 化により endpoint_state gate は撤去。
  // エンドポイント起動待機は SageMaker 側 (`InvokeEndpointAsync` が自動的に
  // スケールアウトを誘発) に委譲し、ここでは単純にバッチレコードと署名付き URL を
  // 発行する。

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
  if (
    !(reanalyzableStatuses as readonly string[]).includes(parentBatch.status)
  ) {
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

// ---------------------------------------------------------------------------
// POST /:batchJobId/start — バッチ実行開始 (Task 2.5 / H2)
// ---------------------------------------------------------------------------
batchesRoutes.openapi(startBatchRoute, async (c) => {
  const batchTableName = requireEnv("BATCH_TABLE_NAME");
  const bucketName = requireEnv("BUCKET_NAME");
  const batchExecStateMachineArn = requireEnv(
    "BATCH_EXECUTION_STATE_MACHINE_ARN",
  );
  assertValidStateMachineArn(batchExecStateMachineArn);

  const { batchJobId } = c.req.valid("param");

  const query = new BatchQuery(batchTableName);
  const batch = await query.getBatchWithFiles(batchJobId);

  if (!batch) throw new NotFoundError(`Batch ${batchJobId} not found`);

  if (batch.status !== "PENDING") {
    throw new ConflictError(
      `Cannot start batch ${batchJobId} in status ${batch.status}. Only PENDING batches can be started.`,
    );
  }

  // S3 に実ファイルが揃っているかを検証。DDB の FILE 期待集合 (fileKey)
  // と ListObjectsV2 で列挙した batches/{id}/input/ 配下の実在キーを突合
  // し、欠損があれば 400 で拒否して状態遷移も SFN 起動も行わない。
  const expectedKeys = new Set(batch.files.map((f) => f.fileKey));
  const actualKeys = new Set(
    await listObjectKeys(bucketName, `batches/${batchJobId}/input/`),
  );
  const missing = [...expectedKeys].filter((k) => !actualKeys.has(k));
  if (missing.length > 0) {
    throw new ValidationError(
      `Missing uploaded files for batch ${batchJobId}: ${missing.join(", ")}`,
    );
  }

  // PENDING → PROCESSING を原子的に遷移。並行起動時は ConditionalCheckFailed を
  // ConflictError にマップして 409 を返す（transitionBatchStatus 内で実装済み）。
  const startedAt = new Date().toISOString();
  const store = new BatchStore(batchTableName);
  await store.transitionBatchStatus({
    batchJobId,
    newStatus: "PROCESSING",
    expectedCurrent: "PENDING",
    startedAt,
  });

  // SFN 起動。入力には batchJobId のみを渡す（BatchExecution 側で BatchTable
  // から basePath/extraFormats/files を参照する設計）。
  const result = await sfnClient.send(
    new StartExecutionCommand({
      stateMachineArn: batchExecStateMachineArn,
      input: JSON.stringify({ batchJobId }),
    }),
  );

  return c.json(
    {
      batchJobId,
      status: "PROCESSING" as const,
      executionArn: result.executionArn ?? "",
    },
    202,
  );
});
