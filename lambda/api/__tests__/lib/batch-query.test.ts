import { beforeEach, describe, expect, it, vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: DynamoDB コマンド引数の動的検証のため
type AnyRecord = any;

const mockSend = vi.fn();
vi.mock("../../lib/dynamodb", () => ({
  docClient: { send: (...args: unknown[]) => mockSend(...args) },
}));

import { BatchQuery } from "../../lib/batch-query";

const TABLE = "BatchTable";

describe("BatchQuery", () => {
  let query: BatchQuery;

  beforeEach(() => {
    vi.clearAllMocks();
    query = new BatchQuery(TABLE);
  });

  // --- getBatchWithFiles ---
  describe("getBatchWithFiles", () => {
    it("PK=BATCH#id で META + FILE 全件を Query する", async () => {
      mockSend.mockResolvedValue({
        Items: [
          {
            PK: "BATCH#batch-001",
            SK: "META",
            entityType: "BATCH",
            batchJobId: "batch-001",
            status: "COMPLETED",
            totals: { total: 1, succeeded: 1, failed: 0, inProgress: 0 },
            basePath: "project",
            createdAt: "2026-04-22T00:00:00Z",
            startedAt: "2026-04-22T00:01:00Z",
            updatedAt: "2026-04-22T00:10:00Z",
            parentBatchJobId: null,
          },
          {
            PK: "BATCH#batch-001",
            SK: "FILE#batches/batch-001/input/a.pdf",
            entityType: "FILE",
            batchJobId: "batch-001",
            fileKey: "batches/batch-001/input/a.pdf",
            filename: "a.pdf",
            status: "COMPLETED",
            updatedAt: "2026-04-22T00:10:00Z",
          },
        ],
      });

      const result = await query.getBatchWithFiles("batch-001");

      expect(result).not.toBeNull();
      expect(result?.batchJobId).toBe("batch-001");
      expect(result?.files).toHaveLength(1);
      expect(result?.files[0].filename).toBe("a.pdf");

      const cmd: AnyRecord = mockSend.mock.calls[0][0];
      expect(cmd.input.KeyConditionExpression).toContain("#pk");
      expect(cmd.input.ExpressionAttributeValues[":pk"]).toBe(
        "BATCH#batch-001",
      );
    });

    it("存在しないバッチは null を返す", async () => {
      mockSend.mockResolvedValue({ Items: [] });

      const result = await query.getBatchWithFiles("nonexistent");
      expect(result).toBeNull();
    });

    it("Limit が設定されている", async () => {
      mockSend.mockResolvedValue({ Items: [] });

      await query.getBatchWithFiles("batch-001");

      const cmd: AnyRecord = mockSend.mock.calls[0][0];
      expect(cmd.input.Limit).toBeGreaterThan(0);
    });
  });

  // --- listFailedFiles ---
  describe("listFailedFiles", () => {
    it("失敗した FILE アイテムのみを返す", async () => {
      mockSend.mockResolvedValue({
        Items: [
          {
            PK: "BATCH#batch-001",
            SK: "FILE#batches/batch-001/input/fail.pdf",
            entityType: "FILE",
            fileKey: "batches/batch-001/input/fail.pdf",
            filename: "fail.pdf",
            status: "FAILED",
            errorMessage: "OCR error",
            updatedAt: "2026-04-22T00:10:00Z",
          },
        ],
      });

      const result = await query.listFailedFiles("batch-001");
      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe("fail.pdf");
      expect(result[0].status).toBe("FAILED");
    });
  });

  // --- listBatchesByStatus ---
  describe("listBatchesByStatus", () => {
    it("GSI1 を使って PENDING バッチを取得する", async () => {
      mockSend.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });

      await query.listBatchesByStatus("PENDING", "202604");

      const cmd: AnyRecord = mockSend.mock.calls[0][0];
      expect(cmd.input.IndexName).toBe("GSI1");
      expect(cmd.input.ExpressionAttributeValues[":gsi1pk"]).toBe(
        "STATUS#PENDING#202604",
      );
    });

    it("LastEvaluatedKey があれば base64url エンコードされた cursor を返す", async () => {
      mockSend.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: {
          PK: "BATCH#batch-001",
          SK: "META",
          GSI1PK: "STATUS#PENDING#202604",
          GSI1SK: "2026-04-22T00:00:00Z",
        },
      });

      const result = await query.listBatchesByStatus("PENDING", "202604");
      expect(result.cursor).not.toBeNull();
      // base64url でデコードできること
      expect(() =>
        JSON.parse(Buffer.from(result.cursor!, "base64url").toString()),
      ).not.toThrow();
    });
  });

  // --- listChildBatches ---
  describe("listChildBatches", () => {
    it("GSI2 を使って子バッチを取得する", async () => {
      mockSend.mockResolvedValue({ Items: [] });

      await query.listChildBatches("parent-batch-001");

      const cmd: AnyRecord = mockSend.mock.calls[0][0];
      expect(cmd.input.IndexName).toBe("GSI2");
      expect(cmd.input.ExpressionAttributeValues[":gsi2pk"]).toBe(
        "PARENT#parent-batch-001",
      );
    });
  });
});
