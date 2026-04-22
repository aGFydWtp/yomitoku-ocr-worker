import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { BatchStatus } from "../schemas";
import { MAX_FILES_PER_BATCH } from "../schemas";
import { docClient } from "./dynamodb";
import { ConflictError, ValidationError } from "./errors";
import { sanitizeFilename } from "./sanitize";
import { validateBasePath } from "./validate";

// ---------------------------------------------------------------------------
// 定数（batch-query.ts と共有）
// ---------------------------------------------------------------------------

/** PENDING バッチの TTL（秒）: 24 時間 */
export const BATCH_PENDING_TTL_SECONDS = 24 * 60 * 60;

/** 1 バッチあたりのクエリ上限（META 1 件 + FILE 最大 N 件）*/
export const QUERY_LIMIT = MAX_FILES_PER_BATCH + 2;

// ---------------------------------------------------------------------------
// 共有型（batch-query.ts から再 export して使用）
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
// 書き込み系入力型
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
// プライベートヘルパー
// ---------------------------------------------------------------------------

export function gsi1pk(status: BatchStatus, now: Date): string {
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `STATUS#${status}#${yyyymm}`;
}

export function buildFileKey(batchJobId: string, safeFilename: string): string {
  return `batches/${batchJobId}/input/${safeFilename}`;
}

// ---------------------------------------------------------------------------
// BatchStore — 書き込み専用クラス
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

    // basePath 検証（パストラバーサル・無効文字を弾く）
    // validateBasePath は null/undefined のみ undefined を返す。string 入力では trimmed string か例外
    const safeBasePath = validateBasePath(basePath);
    if (safeBasePath === undefined) {
      throw new ValidationError("basePath must not be empty");
    }

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
}
