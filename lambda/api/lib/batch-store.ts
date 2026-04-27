import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { BatchStatus, ErrorCategory } from "../schemas";
import { MAX_FILES_PER_BATCH } from "../schemas";
import { docClient } from "./dynamodb";
import { ConflictError } from "./errors";
import { sanitizeFilename } from "./sanitize";
import { validateBatchLabel } from "./validate";

// ---------------------------------------------------------------------------
// 定数（batch-query.ts と共有）
// ---------------------------------------------------------------------------

/** PENDING バッチの TTL（秒）: 24 時間 */
export const BATCH_PENDING_TTL_SECONDS = 24 * 60 * 60;

/** 1 バッチあたりのクエリ上限（META 1 件 + FILE 最大 N 件）*/
export const QUERY_LIMIT = MAX_FILES_PER_BATCH + 2;

/**
 * GSI1 (status+月) / GSI2 (親バッチ参照) 経由のバッチ一覧 API 上限。
 * ページサイズ兼 1 回あたりの DynamoDB Query Limit として使う (L4)。
 */
export const BATCH_LIST_LIMIT = 50;

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
  /**
   * `status === "FAILED"` の場合のみ意味を持つ失敗カテゴリ。
   * 詳細は ``schemas.ts::ERROR_CATEGORIES`` を参照。
   * 旧データ (本フィールド導入前の FILE アイテム) は読み出し時 ``undefined``。
   */
  errorCategory?: ErrorCategory;
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
  /**
   * 任意の表示用ラベル。省略されたバッチや ``batchLabel`` 導入前に作成された
   * 古い META (``basePath`` 属性のみ保持) では ``null``。
   * legacy ``basePath`` は batch-query.ts::metaItemToBatchMeta で coalesce する。
   */
  batchLabel: string | null;
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
  /**
   * 任意の表示用ラベル。省略または undefined の場合は META から属性を書き込まない。
   * ``BatchMeta.batchLabel`` は ``string | null`` だが、呼び出し側 (reanalyze 等)
   * は ``?? undefined`` で渡すことで「未設定」の意図を明示する。
   */
  batchLabel?: string;
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
  /**
   * 省略 (undefined) の場合は DDB の `errorCategory` 属性を一切更新しない
   * (UpdateExpression の SET 句に含めない)。明示的に値を渡したときのみ
   * `SET` で書き込まれる。これにより既存 FILE アイテムの旧データを
   * 意図せず上書きするリスクを避ける。
   */
  errorCategory?: ErrorCategory;
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
      batchLabel,
      files,
      extraFormats,
      parentBatchJobId = null,
    } = input;

    // batchLabel 検証（optional）: undefined/省略時は undefined のまま通過。
    // 明示的な空文字・path traversal・無効文字は ValidationError (400)。
    const safeLabel = validateBatchLabel(batchLabel);

    const now = new Date();
    const iso = now.toISOString();
    const ttl = Math.floor(now.getTime() / 1000) + BATCH_PENDING_TTL_SECONDS;

    const metaItem: Record<string, unknown> = {
      PK: `BATCH#${batchJobId}`,
      SK: "META",
      entityType: "BATCH",
      batchJobId,
      status: "PENDING",
      totals: { total: files.length, succeeded: 0, failed: 0, inProgress: 0 },
      createdAt: iso,
      updatedAt: iso,
      startedAt: null,
      parentBatchJobId,
      ttl,
      GSI1PK: gsi1pk("PENDING", now),
      GSI1SK: iso,
    };

    // batchLabel は省略時 DDB に属性自体を書かない (Q3: null 許容)。
    if (safeLabel !== undefined) {
      metaItem.batchLabel = safeLabel;
    }

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
      errorCategory,
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
    // errorCategory: 明示時のみ SET (省略時は属性を触らない)。
    // attribute 名 ``errorCategory`` は Py 側 (`batch_store.py`) と共有 (R4.2 / R4.3)。
    if (errorCategory !== undefined) {
      ean["#errorCategory"] = "errorCategory";
      eav[":errorCategory"] = errorCategory;
      setExprs.push("#errorCategory = :errorCategory");
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
