import { describe, expect, it } from "vitest";
import {
  ALLOWED_EXTENSIONS,
  BATCH_STATUSES,
  CreateBatchBodySchema,
  MAX_FILE_BYTES,
  MAX_FILES_PER_BATCH,
  MAX_TOTAL_BYTES,
} from "../schemas";

describe("BATCH_STATUSES", () => {
  it("6 種類のステータスを定義している", () => {
    expect(BATCH_STATUSES).toEqual([
      "PENDING",
      "PROCESSING",
      "COMPLETED",
      "PARTIAL",
      "FAILED",
      "CANCELLED",
    ]);
  });
});

describe("上限定数", () => {
  it("MAX_FILES_PER_BATCH が正の整数である", () => {
    expect(MAX_FILES_PER_BATCH).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_FILES_PER_BATCH)).toBe(true);
  });

  it("MAX_TOTAL_BYTES が正の整数である", () => {
    expect(MAX_TOTAL_BYTES).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_TOTAL_BYTES)).toBe(true);
  });

  it("MAX_FILE_BYTES が正の整数である", () => {
    expect(MAX_FILE_BYTES).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_FILE_BYTES)).toBe(true);
  });

  it("ALLOWED_EXTENSIONS に .pdf が含まれる", () => {
    expect(ALLOWED_EXTENSIONS).toContain(".pdf");
  });
});

describe("CreateBatchBodySchema", () => {
  const validInput = {
    basePath: "project/2026/doc",
    files: [{ filename: "sample.pdf" }, { filename: "other.pdf" }],
  };

  it("正常系: 有効な入力を受け付ける", () => {
    const result = CreateBatchBodySchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("正常系: extraFormats オプションを受け付ける", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      extraFormats: ["markdown", "csv"],
    });
    expect(result.success).toBe(true);
  });

  it("異常系: basePath が空文字は拒否される", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      basePath: "",
    });
    expect(result.success).toBe(false);
  });

  it("異常系: files が空配列は拒否される", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      files: [],
    });
    expect(result.success).toBe(false);
  });

  it("異常系: files が MAX_FILES_PER_BATCH を超えると拒否される", () => {
    const tooMany = Array.from({ length: MAX_FILES_PER_BATCH + 1 }, (_, i) => ({
      filename: `file${i}.pdf`,
    }));
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      files: tooMany,
    });
    expect(result.success).toBe(false);
  });

  it("異常系: 許可されていない拡張子のファイルは拒否される", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      files: [{ filename: "malware.exe" }],
    });
    expect(result.success).toBe(false);
  });

  it("異常系: filename が空文字は拒否される", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      files: [{ filename: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("異常系: extraFormats に無効な値は拒否される", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      extraFormats: ["excel"],
    });
    expect(result.success).toBe(false);
  });

  it("正常系: MAX_FILES_PER_BATCH ちょうどは受け付ける", () => {
    const exact = Array.from({ length: MAX_FILES_PER_BATCH }, (_, i) => ({
      filename: `file${i}.pdf`,
    }));
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      files: exact,
    });
    expect(result.success).toBe(true);
  });
});
