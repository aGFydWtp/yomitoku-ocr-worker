import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { BatchStatus } from "../schemas";
import { docClient } from "./dynamodb";
import {
  decodeBatchCursor,
  encodeBatchCursor,
} from "./validate";
import type { BatchMeta, BatchWithFiles, FileItem } from "./batch-store";
import { QUERY_LIMIT } from "./batch-store";

// ---------------------------------------------------------------------------
// BatchQuery — 読み取り専用クラス
//
// 書き込み操作は BatchStore (batch-store.ts) を使用してください。
// ---------------------------------------------------------------------------

export class BatchQuery {
  constructor(private readonly tableName: string) {}

  // -------------------------------------------------------------------------
  // getBatchWithFiles — Query(PK=BATCH#id) で META + FILE を取得
  // -------------------------------------------------------------------------
  async getBatchWithFiles(batchJobId: string): Promise<BatchWithFiles | null> {
    const res = await docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "PK" },
        ExpressionAttributeValues: { ":pk": `BATCH#${batchJobId}` },
        Limit: QUERY_LIMIT,
      }),
    );

    const items = res.Items ?? [];
    const meta = items.find(
      (i) => i.entityType === "BATCH",
    ) as Record<string, unknown> | undefined;

    if (!meta) return null;

    const files: FileItem[] = items
      .filter((i) => i.entityType === "FILE")
      .map((i) => ({
        fileKey: i.fileKey as string,
        filename: i.filename as string,
        status: i.status as FileItem["status"],
        dpi: i.dpi as number | undefined,
        processingTimeMs: i.processingTimeMs as number | undefined,
        resultKey: i.resultKey as string | undefined,
        errorMessage: i.errorMessage as string | undefined,
        updatedAt: i.updatedAt as string,
      }));

    return {
      batchJobId: meta.batchJobId as string,
      status: meta.status as BatchStatus,
      totals: meta.totals as BatchMeta["totals"],
      basePath: meta.basePath as string,
      createdAt: meta.createdAt as string,
      startedAt: (meta.startedAt as string | null) ?? null,
      updatedAt: meta.updatedAt as string,
      parentBatchJobId: (meta.parentBatchJobId as string | null) ?? null,
      files,
    };
  }

  // -------------------------------------------------------------------------
  // listFailedFiles — FILE アイテムのうち status=FAILED を返す
  // -------------------------------------------------------------------------
  async listFailedFiles(batchJobId: string): Promise<ReadonlyArray<FileItem>> {
    const res = await docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        FilterExpression: "#status = :failed",
        ExpressionAttributeNames: {
          "#pk": "PK",
          "#sk": "SK",
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":pk": `BATCH#${batchJobId}`,
          ":prefix": "FILE#",
          ":failed": "FAILED",
        },
        // FilterExpression はサーバー側読取数に作用するため、QUERY_LIMIT 件スキャン後にフィルタされる
        Limit: QUERY_LIMIT,
      }),
    );

    return (res.Items ?? []).map((i) => ({
      fileKey: i.fileKey as string,
      filename: i.filename as string,
      status: "FAILED" as const,
      errorMessage: i.errorMessage as string | undefined,
      updatedAt: i.updatedAt as string,
    }));
  }

  // -------------------------------------------------------------------------
  // listBatchesByStatus — GSI1 を使ったページング
  // -------------------------------------------------------------------------
  async listBatchesByStatus(
    status: BatchStatus,
    month: string,
    cursor?: string,
  ): Promise<{ items: BatchMeta[]; cursor: string | null }> {
    const gsi1pkVal = `STATUS#${status}#${month}`;
    const exclusiveStartKey = decodeBatchCursor(cursor);

    const res = await docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "#gsi1pk = :gsi1pk",
        ExpressionAttributeNames: { "#gsi1pk": "GSI1PK" },
        ExpressionAttributeValues: { ":gsi1pk": gsi1pkVal },
        Limit: 50,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );

    const items: BatchMeta[] = (res.Items ?? []).map((i) => ({
      batchJobId: i.batchJobId as string,
      status: i.status as BatchStatus,
      totals: i.totals as BatchMeta["totals"],
      basePath: i.basePath as string,
      createdAt: i.createdAt as string,
      startedAt: (i.startedAt as string | null) ?? null,
      updatedAt: i.updatedAt as string,
      parentBatchJobId: (i.parentBatchJobId as string | null) ?? null,
    }));

    const nextCursor = res.LastEvaluatedKey
      ? encodeBatchCursor(res.LastEvaluatedKey as Record<string, unknown>)
      : null;

    return { items, cursor: nextCursor };
  }

  // -------------------------------------------------------------------------
  // listChildBatches — GSI2 を使った親子参照
  // -------------------------------------------------------------------------
  async listChildBatches(
    parentBatchJobId: string,
  ): Promise<ReadonlyArray<BatchMeta>> {
    const res = await docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI2",
        KeyConditionExpression: "#gsi2pk = :gsi2pk",
        ExpressionAttributeNames: { "#gsi2pk": "GSI2PK" },
        ExpressionAttributeValues: {
          ":gsi2pk": `PARENT#${parentBatchJobId}`,
        },
        Limit: 50,
      }),
    );

    return (res.Items ?? []).map((i) => ({
      batchJobId: i.batchJobId as string,
      status: i.status as BatchStatus,
      totals: i.totals as BatchMeta["totals"],
      basePath: i.basePath as string,
      createdAt: i.createdAt as string,
      startedAt: (i.startedAt as string | null) ?? null,
      updatedAt: i.updatedAt as string,
      parentBatchJobId: parentBatchJobId,
    }));
  }
}
