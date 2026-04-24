import { BatchGetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { BatchStatus } from "../schemas";
import type { BatchMeta, BatchWithFiles, FileItem } from "./batch-store";
import { BATCH_LIST_LIMIT, QUERY_LIMIT } from "./batch-store";
import { docClient } from "./dynamodb";
import { decodeBatchCursor, encodeBatchCursor } from "./validate";

/**
 * Raw DDB META アイテム (docClient unmarshalled) から ``batchLabel`` を取り出す。
 * 新属性 ``batchLabel`` が無い場合、レガシー名 ``basePath`` にフォールバック
 * する (Q2: read-time coalesce)。どちらも未設定なら ``null`` を返す。
 *
 * basePath → batchLabel リネーム前に作成された META は ``basePath`` のみを
 * 保持しており、PITR を保ったまま属性名を書き換えるコストと TTL/自然消滅で
 * やがて消える性質を踏まえ、読み出し時の互換に倒している。
 */
function resolveBatchLabel(i: Record<string, unknown>): string | null {
  const modern = i.batchLabel;
  if (typeof modern === "string" && modern.length > 0) return modern;
  const legacy = i.basePath;
  if (typeof legacy === "string" && legacy.length > 0) return legacy;
  return null;
}

/**
 * Raw DDB META アイテム (docClient unmarshalled) から型付き ``BatchMeta`` を
 * 抽出する。``listBatchesByStatus`` (GSI1 経由) と ``listChildBatches``
 * (GSI2 経由) で共有する。
 */
function metaItemToBatchMeta(i: Record<string, unknown>): BatchMeta {
  return {
    batchJobId: i.batchJobId as string,
    status: i.status as BatchStatus,
    totals: i.totals as BatchMeta["totals"],
    batchLabel: resolveBatchLabel(i),
    createdAt: i.createdAt as string,
    startedAt: (i.startedAt as string | null) ?? null,
    updatedAt: i.updatedAt as string,
    parentBatchJobId: (i.parentBatchJobId as string | null) ?? null,
  };
}

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
    const meta = items.find((i) => i.entityType === "BATCH") as
      | Record<string, unknown>
      | undefined;

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
      batchLabel: resolveBatchLabel(meta),
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
  // fetchMetasByKeys — GSI1/GSI2 Query の戻り keys から BatchGetItem で本体解決
  //
  // ``processing-stack.ts`` の GSI1/GSI2 は ``projectionType: KEYS_ONLY`` で、
  // Query レスポンスは PK/SK (+ GSI*PK / GSI*SK) のみを返す。
  // ``batchJobId`` / ``status`` / ``totals`` 等の META 属性を解決するには
  // ``BatchGetItem`` で base table を引き直す必要がある。
  //
  // BATCH_LIST_LIMIT <= 50 <= BatchGetItem 上限 100 key/call のため常に 1 回で完了。
  // GSI の結果順序は BatchGetItem の結果順序と必ずしも一致しないため、
  // 最後に PK で戻って GSI の順序を保つ。
  // -------------------------------------------------------------------------
  private async fetchMetasByKeys(
    keys: Array<{ PK: string; SK: string }>,
  ): Promise<BatchMeta[]> {
    if (keys.length === 0) return [];
    const res = await docClient.send(
      new BatchGetCommand({
        RequestItems: {
          [this.tableName]: { Keys: keys },
        },
      }),
    );
    const responses = (res.Responses?.[this.tableName] ?? []) as Array<
      Record<string, unknown>
    >;
    // BatchGetItem の返却順は保証されないため、入力 keys の PK 順で並べ直す
    const byPk = new Map<string, Record<string, unknown>>();
    for (const r of responses) byPk.set(r.PK as string, r);
    return keys
      .map((k) => byPk.get(k.PK))
      .filter((r): r is Record<string, unknown> => r !== undefined)
      .map(metaItemToBatchMeta);
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
        Limit: BATCH_LIST_LIMIT,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );

    const keys = (res.Items ?? []).map((i) => ({
      PK: i.PK as string,
      SK: i.SK as string,
    }));
    const items = await this.fetchMetasByKeys(keys);

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
        Limit: BATCH_LIST_LIMIT,
      }),
    );

    const keys = (res.Items ?? []).map((i) => ({
      PK: i.PK as string,
      SK: i.SK as string,
    }));
    return this.fetchMetasByKeys(keys);
  }
}
