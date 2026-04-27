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

  it("MAX_FILES_PER_BATCH + 1 META item が DynamoDB TransactWriteItems 上限 100 items を超えない", () => {
    // putBatchWithFiles は ``[1 META, ...N FILE]`` を 1 回の TransactWriteItems
    // で送るため、N+1 が 100 を超えないことを強制する。AWS DynamoDB の
    // TransactWriteItems は 100 items/call が上限 (2022-03 までは 25)。
    const META_ITEM = 1;
    const TRANSACT_WRITE_ITEMS_LIMIT = 100;
    expect(MAX_FILES_PER_BATCH + META_ITEM).toBeLessThanOrEqual(
      TRANSACT_WRITE_ITEMS_LIMIT,
    );
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

  it("ALLOWED_EXTENSIONS に Office 形式 (.pptx / .docx / .xlsx) が含まれる", () => {
    // R1.1, R1.5: API は Office 形式を直接受理する
    expect(ALLOWED_EXTENSIONS).toContain(".pptx");
    expect(ALLOWED_EXTENSIONS).toContain(".docx");
    expect(ALLOWED_EXTENSIONS).toContain(".xlsx");
  });
});

describe("CreateBatchBodySchema", () => {
  const validInput = {
    batchLabel: "project/2026/doc",
    files: [{ filename: "sample.pdf" }, { filename: "other.pdf" }],
  };

  it("正常系: 有効な入力を受け付ける", () => {
    const result = CreateBatchBodySchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("正常系: batchLabel 省略でも受け付ける (optional フィールド)", () => {
    const { batchLabel: _omitted, ...withoutLabel } = validInput;
    const result = CreateBatchBodySchema.safeParse(withoutLabel);
    expect(result.success).toBe(true);
  });

  it("正常系: extraFormats オプションを受け付ける", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      extraFormats: ["markdown", "csv"],
    });
    expect(result.success).toBe(true);
  });

  it("異常系: batchLabel が空文字は拒否される", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      batchLabel: "",
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

  it("正常系: .pptx ファイルを受け付ける (R1.1)", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      files: [{ filename: "slides.pptx" }],
    });
    expect(result.success).toBe(true);
  });

  it("正常系: .docx ファイルを受け付ける (R1.1)", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      files: [{ filename: "document.docx" }],
    });
    expect(result.success).toBe(true);
  });

  it("正常系: .xlsx ファイルを受け付ける (R1.1)", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      files: [{ filename: "spreadsheet.xlsx" }],
    });
    expect(result.success).toBe(true);
  });

  it("正常系: PDF と Office 形式の混在を受け付ける (R1.1)", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      files: [
        { filename: "report.pdf" },
        { filename: "slides.pptx" },
        { filename: "memo.docx" },
        { filename: "data.xlsx" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("正常系: contentType に PPTX OOXML MIME を指定できる (R1.4)", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      files: [
        {
          filename: "slides.pptx",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("正常系: contentType に DOCX OOXML MIME を指定できる (R1.4)", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      files: [
        {
          filename: "document.docx",
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("正常系: contentType に XLSX OOXML MIME を指定できる (R1.4)", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      files: [
        {
          filename: "spreadsheet.xlsx",
          contentType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("異常系: contentType enum に列挙されていない値は拒否される", () => {
    const result = CreateBatchBodySchema.safeParse({
      ...validInput,
      files: [
        {
          filename: "image.pdf",
          // 画像系 MIME は enum に未登録
          contentType: "image/png" as unknown as "application/pdf",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
