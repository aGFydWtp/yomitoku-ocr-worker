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
import {
  BatchPresign,
  defaultContentType,
  EXTENSION_TO_CONTENT_TYPE,
} from "../../lib/batch-presign";
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

    // R1.2: 拡張子別の既定 Content-Type マッピング
    it("contentType 省略 + .pptx の場合は OOXML PPTX MIME を署名対象にする", async () => {
      await presign.createUploadUrls({
        batchJobId: "batch-001",
        files: [{ filename: "deck.pptx" }],
      });

      const [[, cmd]] = (getSignedUrl as ReturnType<typeof vi.fn>).mock.calls;
      expect(cmd.input.ContentType).toBe(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      );
    });

    it("contentType 省略 + .docx の場合は OOXML DOCX MIME を署名対象にする", async () => {
      await presign.createUploadUrls({
        batchJobId: "batch-001",
        files: [{ filename: "report.docx" }],
      });

      const [[, cmd]] = (getSignedUrl as ReturnType<typeof vi.fn>).mock.calls;
      expect(cmd.input.ContentType).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    });

    it("contentType 省略 + .xlsx の場合は OOXML XLSX MIME を署名対象にする", async () => {
      await presign.createUploadUrls({
        batchJobId: "batch-001",
        files: [{ filename: "data.xlsx" }],
      });

      const [[, cmd]] = (getSignedUrl as ReturnType<typeof vi.fn>).mock.calls;
      expect(cmd.input.ContentType).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    });

    it("拡張子が大文字の場合も case-insensitive で OOXML MIME に解決する", async () => {
      await presign.createUploadUrls({
        batchJobId: "batch-001",
        files: [{ filename: "Deck.PPTX" }],
      });

      const [[, cmd]] = (getSignedUrl as ReturnType<typeof vi.fn>).mock.calls;
      expect(cmd.input.ContentType).toBe(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      );
    });
  });

  // R1.2: defaultContentType ヘルパの単体検証 (sanitizeFilename gate を経由しない経路)
  describe("defaultContentType", () => {
    it("拡張子 → MIME マップが design.md で定義された 4 形式を網羅する", () => {
      expect(EXTENSION_TO_CONTENT_TYPE).toEqual({
        ".pdf": "application/pdf",
        ".pptx":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".docx":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    });

    it(".pdf を application/pdf に解決する", () => {
      expect(defaultContentType("doc.pdf")).toBe("application/pdf");
    });

    it(".pptx を OOXML PPTX MIME に解決する", () => {
      expect(defaultContentType("deck.pptx")).toBe(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      );
    });

    it(".docx を OOXML DOCX MIME に解決する", () => {
      expect(defaultContentType("report.docx")).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    });

    it(".xlsx を OOXML XLSX MIME に解決する", () => {
      expect(defaultContentType("data.xlsx")).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    });

    it("マップに無い拡張子は application/octet-stream にフォールバックする", () => {
      expect(defaultContentType("notes.txt")).toBe("application/octet-stream");
    });

    it("拡張子のないファイル名は application/octet-stream にフォールバックする", () => {
      expect(defaultContentType("README")).toBe("application/octet-stream");
    });

    it("大文字混じり拡張子も case-insensitive で解決する", () => {
      expect(defaultContentType("Deck.PPTX")).toBe(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      );
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
