import { beforeEach, describe, expect, it, vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: DynamoDB コマンド引数の動的検証のため
type AnyRecord = any;

const mockSend = vi.fn();
vi.mock("../../lib/dynamodb", () => ({
  docClient: { send: (...args: unknown[]) => mockSend(...args) },
}));

import { BatchStore } from "../../lib/batch-store";

const TABLE = "BatchTable";
const BUCKET = "test-bucket";

describe("BatchStore (write-path)", () => {
  let store: BatchStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new BatchStore(TABLE);
  });

  // --- putBatchWithFiles ---
  describe("putBatchWithFiles", () => {
    it("TransactWriteItems で META と FILE×N を原子的に作成する", async () => {
      mockSend.mockResolvedValue({});

      await store.putBatchWithFiles({
        batchJobId: "batch-001",
        batchLabel: "project/2026",
        files: [{ filename: "a.pdf" }, { filename: "b.pdf" }],
        bucket: BUCKET,
      });

      expect(mockSend).toHaveBeenCalledOnce();
      const cmd: AnyRecord = mockSend.mock.calls[0][0];
      expect(cmd.input.TransactItems).toHaveLength(3); // 1 META + 2 FILE
    });

    it("META アイテムに status=PENDING・totals・GSI1PK が設定される", async () => {
      mockSend.mockResolvedValue({});

      await store.putBatchWithFiles({
        batchJobId: "batch-001",
        batchLabel: "project/2026",
        files: [{ filename: "a.pdf" }],
        bucket: BUCKET,
      });

      const cmd: AnyRecord = mockSend.mock.calls[0][0];
      const metaItem = cmd.input.TransactItems[0].Put.Item;
      expect(metaItem.PK).toBe("BATCH#batch-001");
      expect(metaItem.SK).toBe("META");
      expect(metaItem.status).toBe("PENDING");
      expect(metaItem.totals).toEqual({
        total: 1,
        succeeded: 0,
        failed: 0,
        inProgress: 0,
      });
      expect(metaItem.GSI1PK).toMatch(/^STATUS#PENDING#\d{6}$/);
      expect(metaItem.ttl).toBeTypeOf("number");
    });

    it("FILE アイテムに正しい S3 キーが設定される", async () => {
      mockSend.mockResolvedValue({});

      await store.putBatchWithFiles({
        batchJobId: "batch-001",
        batchLabel: "project/2026",
        files: [{ filename: "sample.pdf" }],
        bucket: BUCKET,
      });

      const cmd: AnyRecord = mockSend.mock.calls[0][0];
      const fileItem = cmd.input.TransactItems[1].Put.Item;
      expect(fileItem.PK).toBe("BATCH#batch-001");
      expect(fileItem.SK).toBe("FILE#batches/batch-001/input/sample.pdf");
      expect(fileItem.fileKey).toBe("batches/batch-001/input/sample.pdf");
      expect(fileItem.filename).toBe("sample.pdf");
      expect(fileItem.status).toBe("PENDING");
    });

    it("parentBatchJobId が指定されると GSI2PK が設定される", async () => {
      mockSend.mockResolvedValue({});

      await store.putBatchWithFiles({
        batchJobId: "batch-002",
        batchLabel: "project/2026",
        files: [{ filename: "a.pdf" }],
        bucket: BUCKET,
        parentBatchJobId: "batch-001",
      });

      const cmd: AnyRecord = mockSend.mock.calls[0][0];
      const metaItem = cmd.input.TransactItems[0].Put.Item;
      expect(metaItem.parentBatchJobId).toBe("batch-001");
      expect(metaItem.GSI2PK).toBe("PARENT#batch-001");
    });

    it("batchLabel 省略時は META に batchLabel 属性を書き込まない (optional, Q3: null 許容)", async () => {
      mockSend.mockResolvedValue({});

      await store.putBatchWithFiles({
        batchJobId: "batch-003",
        files: [{ filename: "a.pdf" }],
        bucket: BUCKET,
      });

      const cmd: AnyRecord = mockSend.mock.calls[0][0];
      const metaItem = cmd.input.TransactItems[0].Put.Item;
      expect(metaItem).not.toHaveProperty("batchLabel");
      // 後方互換用の legacy 名でも書き込まないこと
      expect(metaItem).not.toHaveProperty("basePath");
    });

    it("batchLabel 明示的な空文字は ValidationError (malformed input)", async () => {
      await expect(
        store.putBatchWithFiles({
          batchJobId: "batch-004",
          batchLabel: "",
          files: [{ filename: "a.pdf" }],
          bucket: BUCKET,
        }),
      ).rejects.toThrow("batchLabel must not be empty");
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // --- transitionBatchStatus ---
  describe("transitionBatchStatus", () => {
    it("ConditionExpression で expectedCurrent を検証する", async () => {
      mockSend.mockResolvedValue({});

      await store.transitionBatchStatus({
        batchJobId: "batch-001",
        newStatus: "PROCESSING",
        expectedCurrent: "PENDING",
        startedAt: new Date().toISOString(),
      });

      const cmd: AnyRecord = mockSend.mock.calls[0][0];
      expect(cmd.input.ConditionExpression).toContain("#status");
      expect(cmd.input.ExpressionAttributeValues[":expected"]).toBe("PENDING");
      expect(cmd.input.ExpressionAttributeValues[":new"]).toBe("PROCESSING");
    });

    it("ConditionalCheckFailedException を ConflictError に変換する", async () => {
      const err = new Error("ConditionalCheckFailed");
      err.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValue(err);

      await expect(
        store.transitionBatchStatus({
          batchJobId: "batch-001",
          newStatus: "PROCESSING",
          expectedCurrent: "PENDING",
          startedAt: new Date().toISOString(),
        }),
      ).rejects.toMatchObject({ name: "ConflictError" });
    });
  });

  // --- updateFileResult ---
  describe("updateFileResult", () => {
    it("status != COMPLETED の条件付き更新でファイル結果を反映する", async () => {
      mockSend.mockResolvedValue({});

      await store.updateFileResult({
        batchJobId: "batch-001",
        fileKey: "batches/batch-001/input/a.pdf",
        status: "COMPLETED",
        processingTimeMs: 1200,
        resultKey: "batches/batch-001/output/a.json",
      });

      const cmd: AnyRecord = mockSend.mock.calls[0][0];
      expect(cmd.input.Key).toEqual({
        PK: "BATCH#batch-001",
        SK: "FILE#batches/batch-001/input/a.pdf",
      });
      expect(cmd.input.ConditionExpression).toBeDefined();
    });
  });
});
