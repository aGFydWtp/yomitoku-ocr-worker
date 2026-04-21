import { beforeEach, describe, expect, it, vi } from "vitest";

// getSignedUrl をモック
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn((_client, cmd: { input?: { Key?: string } }) =>
    Promise.resolve(`https://s3.example.com/${cmd.input?.Key ?? "unknown"}`),
  ),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => ({})),
  PutObjectCommand: vi.fn((input) => ({ input })),
  GetObjectCommand: vi.fn((input) => ({ input })),
}));

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BatchPresign } from "../../lib/batch-presign";
import { MAX_FILES_PER_BATCH } from "../../schemas";

const BUCKET = "test-bucket";

describe("BatchPresign", () => {
  let presign: BatchPresign;

  beforeEach(() => {
    vi.clearAllMocks();
    presign = new BatchPresign(BUCKET);
  });

  // --- createUploadUrls ---
  describe("createUploadUrls", () => {
    it("ファイルごとに署名付き PUT URL を発行する", async () => {
      const result = await presign.createUploadUrls({
        batchJobId: "batch-001",
        files: [{ filename: "a.pdf" }, { filename: "b.pdf" }],
      });

      expect(result).toHaveLength(2);
      expect(getSignedUrl).toHaveBeenCalledTimes(2);
    });

    it("S3 キーが batches/{batchJobId}/input/{filename} 形式になる", async () => {
      const result = await presign.createUploadUrls({
        batchJobId: "batch-001",
        files: [{ filename: "sample.pdf" }],
      });

      expect(result[0].fileKey).toBe("batches/batch-001/input/sample.pdf");
      expect(result[0].filename).toBe("sample.pdf");
    });

    it("応答に uploadUrl と expiresIn が含まれる", async () => {
      const result = await presign.createUploadUrls({
        batchJobId: "batch-001",
        files: [{ filename: "a.pdf" }],
      });

      expect(result[0].uploadUrl).toContain("https://");
      expect(result[0].expiresIn).toBeTypeOf("number");
      expect(result[0].expiresIn).toBeGreaterThan(0);
    });

    it("MAX_FILES_PER_BATCH を超えるとエラーを投げる", async () => {
      const tooMany = Array.from(
        { length: MAX_FILES_PER_BATCH + 1 },
        (_, i) => ({
          filename: `file${i}.pdf`,
        }),
      );

      await expect(
        presign.createUploadUrls({ batchJobId: "batch-001", files: tooMany }),
      ).rejects.toThrow();
    });

    it("パストラバーサルを含む filename は無害化されたキーになる", async () => {
      const result = await presign.createUploadUrls({
        batchJobId: "batch-001",
        files: [{ filename: "../../etc/passwd.pdf" }],
      });

      // sanitizeFilename により "passwd.pdf" に無害化される
      expect(result[0].filename).toBe("passwd.pdf");
      expect(result[0].fileKey).toBe("batches/batch-001/input/passwd.pdf");
      // キーに ".." が含まれないことを確認
      expect(result[0].fileKey).not.toContain("..");
    });

    it("contentType が指定されている場合はそれを使用する", async () => {
      await presign.createUploadUrls({
        batchJobId: "batch-001",
        files: [
          { filename: "doc.pdf", contentType: "application/octet-stream" },
        ],
      });

      const [[, cmd]] = (getSignedUrl as ReturnType<typeof vi.fn>).mock.calls;
      expect(cmd.input.ContentType).toBe("application/octet-stream");
    });

    it("contentType 省略時は application/pdf を使用する", async () => {
      await presign.createUploadUrls({
        batchJobId: "batch-001",
        files: [{ filename: "doc.pdf" }],
      });

      const [[, cmd]] = (getSignedUrl as ReturnType<typeof vi.fn>).mock.calls;
      expect(cmd.input.ContentType).toBe("application/pdf");
    });
  });

  // --- createResultUrl ---
  describe("createResultUrl", () => {
    it("結果 JSON 向け署名付き GET URL を発行する（有効期限 60 分）", async () => {
      const url = await presign.createResultUrl(
        "batches/batch-001/output/sample.json",
      );

      expect(url).toContain("https://");
      // expiresIn が 3600 秒で呼ばれていることをモック引数から検証
      const [, , opts] = (getSignedUrl as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(opts?.expiresIn).toBe(3600);
    });
  });

  // --- createProcessLogUrl ---
  describe("createProcessLogUrl", () => {
    it("process_log.jsonl 向け署名付き GET URL を発行する", async () => {
      const url = await presign.createProcessLogUrl("batch-001");

      expect(url).toContain("https://");
      // key が batches/{batchJobId}/logs/process_log.jsonl であることを確認
      const [[, cmd]] = (getSignedUrl as ReturnType<typeof vi.fn>).mock.calls;
      expect(cmd.input.Key).toBe("batches/batch-001/logs/process_log.jsonl");
    });
  });
});
