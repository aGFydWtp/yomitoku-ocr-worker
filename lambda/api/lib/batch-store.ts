import {
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { BatchStatus } from "../schemas";
import { MAX_FILES_PER_BATCH } from "../schemas";
import { docClient } from "./dynamodb";
import { ConflictError } from "./errors"; // HIGH-2: 共通クラスを使用
import { sanitizeFilename } from "./sanitize"; // HIGH-1: filename サニタイズ
import {
  decodeBatchCursor, // HIGH-3: 検証済みデコーダーを使用
  encodeBatchCursor,
  validateBasePath, // HIGH-1: basePath 検証
} from "./validate";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** PENDING バッチの TTL（秒）: 24 時間 */
const BATCH_PENDING_TTL_SECONDS = 24 * 60 * 60; // MEDIUM-3

/** 1 バッチあたりのアイテム上限（META 1 件 + FILE 最大 N 件）*/
const QUERY_LIMIT = MAX_FILES_PER_BATCH + 2;

// ---------------------------------------------------------------------------
// 入力型
// ---------------------------------------------------------------------------

export interface PutBatchWithFilesInput {
  batchJobId: string;
  basePath: string;
  files: ReadonlyArray<{ filename: string }>;
  bucket: string;
  extraFormats?: ReadonlyArray<string>;
  parentBatchJobId?: string | null;
}

export interface TransitionBatchStatusInput {
  batchJobId: string;
  newStatus: BatchStatus;
  expectedCurrent: BatchStatus;
  /** PROCESSING 遷移時のみ必須 */
  startedAt?: string;
}

export interface UpdateFileResultInput {
  batchJobId: string;
  fileKey: string;
  status: "COMPLETED" | "FAILED";
  dpi?: number;
  processingTimeMs?: number;
  resultKey?: string;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// 出力型
// ---------------------------------------------------------------------------

export interface FileItem {
  fileKey: string;
  filename: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  dpi?: number;
  processingTimeMs?: number;
  resultKey?: string;
  errorMessage?: string;
  updatedAt: string;
}

export interface BatchMeta {
  batchJobId: string;
  status: BatchStatus;
  totals: {
    total: number;
    succeeded: number;
    failed: number;
    inProgress: number;
  };
  basePath: string;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  parentBatchJobId: string | null;
}

export interface BatchWithFiles extends BatchMeta {
  files: FileItem[];
}

// ---------------------------------------------------------------------------
// プライベートヘルパー
// ---------------------------------------------------------------------------

function gsi1pk(status: BatchStatus, now: Date): string {
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `STATUS#${status}#${yyyymm}`;
}

function buildFileKey(batchJobId: string, safeFilename: string): string {
  return `batches/${batchJobId}/input/${safeFilename}`;
}

// ---------------------------------------------------------------------------
// BatchStore クラス
// ---------------------------------------------------------------------------

export class BatchStore {
  constructor(private readonly tableName: string) {}

  // -------------------------------------------------------------------------
  // putBatchWithFiles — META + FILE×N を TransactWriteItems で原子的に作成
  // -------------------------------------------------------------------------
  async putBatchWithFiles(input: PutBatchWithFilesInput): Promise<void> {
    const {
      batchJobId,
      basePath,
      files,
      extraFormats,
      parentBatchJobId = null,
    } = input;

    // HIGH-1: basePath 検証（パストラバーサル・無効文字を弾く）
    const safeBasePath = validateBasePath(basePath) ?? basePath;

    const now = new Date();
    const iso = now.toISOString();
    const ttl = Math.floor(now.getTime() / 1000) + BATCH_PENDING_TTL_SECONDS;

    const metaItem: Record<string, unknown> = {
      PK: `BATCH#${batchJobId}`,
      SK: "META",
      entityType: "BATCH",
      batchJobId,
      status: "PENDING",
      basePath: safeBasePath,
      totals: { total: files.length, succeeded: 0, failed: 0, inProgress: 0 },
      createdAt: iso,
      updatedAt: iso,
      startedAt: null,
      parentBatchJobId,
      ttl,
      GSI1PK: gsi1pk("PENDING", now),
      GSI1SK: iso,
    };

    if (extraFormats && extraFormats.length > 0) {
      metaItem.extraFormats = extraFormats;
    }

    if (parentBatchJobId) {
      metaItem.GSI2PK = `PARENT#${parentBatchJobId}`;
      metaItem.GSI2SK = iso;
    }

    const fileItems = files.map((f) => {
      // HIGH-1: filename サニタイズ（パストラバーサル除去）
      const safeFilename = sanitizeFilename(f.filename);
      const fk = buildFileKey(batchJobId, safeFilename);
      return {
        Put: {
          TableName: this.tableName,
          Item: {
            PK: `BATCH#${batchJobId}`,
            SK: `FILE#${fk}`,
            entityType: "FILE",
            batchJobId,
            fileKey: fk,
            filename: safeFilename,
            status: "PENDING",
            updatedAt: iso,
          },
        },
      };
    });

    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.tableName, Item: metaItem } },
          ...fileItems,
        ],
      }),
    );
  }

  // -------------------------------------------------------------------------
  // transitionBatchStatus — expectedCurrent による条件付き更新
  // -------------------------------------------------------------------------
  async transitionBatchStatus(
    input: TransitionBatchStatusInput,
  ): Promise<void> {
    const { batchJobId, newStatus, expectedCurrent, startedAt } = input;

    const now = new Date();
    const iso = now.toISOString();

    let updateExpr =
      "SET #status = :new, #updatedAt = :now, #GSI1PK = :newGSI1PK";
    const eavMap: Record<string, unknown> = {
      ":new": newStatus,
      ":expected": expectedCurrent,
      ":now": iso,
      ":newGSI1PK": gsi1pk(newStatus, now),
    };

    if (startedAt) {
      updateExpr += ", #startedAt = :startedAt";
      eavMap[":startedAt"] = startedAt;
    }

    // PENDING 以外では TTL を削除
    if (newStatus !== "PENDING") {
      updateExpr += " REMOVE #ttl";
    }

    try {
      await docClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: `BATCH#${batchJobId}`, SK: "META" },
          UpdateExpression: updateExpr,
          ConditionExpression: "#status = :expected",
          ExpressionAttributeNames: {
            "#status": "status",
            "#updatedAt": "updatedAt",
            "#GSI1PK": "GSI1PK",
            "#startedAt": "startedAt",
            "#ttl": "ttl",
          },
          ExpressionAttributeValues: eavMap,
        }),
      );
    } catch (err) {
      if ((err as Error).name === "ConditionalCheckFailedException") {
        throw new ConflictError(
          `Batch ${batchJobId} is not in status ${expectedCurrent}`,
        );
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // updateFileResult — status != COMPLETED の条件付き更新
  // -------------------------------------------------------------------------
  async updateFileResult(input: UpdateFileResultInput): Promise<void> {
    const {
      batchJobId,
      fileKey: fk,
      status,
      dpi,
      processingTimeMs,
      resultKey,
      errorMessage,
    } = input;

    const iso = new Date().toISOString();

    const ean: Record<string, string> = {
      "#status": "status",
      "#updatedAt": "updatedAt",
    };
    const eav: Record<string, unknown> = {
      ":new": status,
      ":now": iso,
      ":completed": "COMPLETED",
    };

    const setExprs = ["#status = :new", "#updatedAt = :now"];

    if (dpi !== undefined) {
      ean["#dpi"] = "dpi";
      eav[":dpi"] = dpi;
      setExprs.push("#dpi = :dpi");
    }
    if (processingTimeMs !== undefined) {
      ean["#proc"] = "processingTimeMs";
      eav[":proc"] = processingTimeMs;
      setExprs.push("#proc = :proc");
    }
    if (resultKey !== undefined) {
      ean["#resultKey"] = "resultKey";
      eav[":resultKey"] = resultKey;
      setExprs.push("#resultKey = :resultKey");
    }
    if (errorMessage !== undefined) {
      ean["#errMsg"] = "errorMessage";
      eav[":errMsg"] = errorMessage;
      setExprs.push("#errMsg = :errMsg");
    }

    await docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: `BATCH#${batchJobId}`, SK: `FILE#${fk}` },
        UpdateExpression: `SET ${setExprs.join(", ")}`,
        ConditionExpression: "#status <> :completed",
        ExpressionAttributeNames: ean,
        ExpressionAttributeValues: eav,
      }),
    );
  }

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
        Limit: QUERY_LIMIT, // MEDIUM-1: 無制限スキャンを防止
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
        Limit: QUERY_LIMIT, // MEDIUM-1: FilterExpression はサーバー側適用後の数ではなく読取数に作用する点に注意
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

    // HIGH-3: 検証済みデコーダーを使用（base64url + キー許可リスト）
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

    // HIGH-3: base64url エンコードで返す
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
        Limit: 50, // MEDIUM-1: 再解析回数は有限と想定（最大 50 世代）
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
