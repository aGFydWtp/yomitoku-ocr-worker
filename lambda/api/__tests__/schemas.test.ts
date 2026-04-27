import { describe, expect, it } from "vitest";
import {
  ALLOWED_EXTENSIONS,
  BATCH_STATUSES,
  BatchFileSchema,
  CreateBatchBodySchema,
  ERROR_CATEGORIES,
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

  describe("stem 一意性 validation (R3.4 / R3.5)", () => {
    it("異常系: 同一 stem の異拡張子の組合せ (report.pdf + report.pptx) は 400 で拒否される", () => {
      // R3.4: case-insensitive stem 比較で重複検出
      const result = CreateBatchBodySchema.safeParse({
        ...validInput,
        files: [{ filename: "report.pdf" }, { filename: "report.pptx" }],
      });
      expect(result.success).toBe(false);
    });

    it("異常系: エラーメッセージに重複した stem 値と該当ファイル名が含まれる (R3.5)", () => {
      // R3.5: 重複 stem 値 (`report`) と該当ファイル名 (`report.pdf` / `report.pptx`)
      // をエラー本文に含めて利用者が修正方針を判断できるようにする
      const result = CreateBatchBodySchema.safeParse({
        ...validInput,
        files: [{ filename: "report.pdf" }, { filename: "report.pptx" }],
      });
      expect(result.success).toBe(false);
      if (result.success) return; // type narrowing
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toContain("Duplicate stem detected");
      // 重複 stem 値そのもの (`report`) もエラー本文に含まれる (R3.5)
      expect(messages).toMatch(/\breport\b/);
      expect(messages).toContain("report.pdf");
      expect(messages).toContain("report.pptx");
    });

    it("異常系: case-insensitive で stem 重複を検出する (Report.pdf + report.pptx)", () => {
      // 大文字小文字違いも衝突扱い (R3.4)
      const result = CreateBatchBodySchema.safeParse({
        ...validInput,
        files: [{ filename: "Report.pdf" }, { filename: "report.pptx" }],
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toContain("Report.pdf");
      expect(messages).toContain("report.pptx");
    });

    it("異常系: 3 件以上の stem 重複もすべて該当ファイル名がエラー本文に含まれる", () => {
      const result = CreateBatchBodySchema.safeParse({
        ...validInput,
        files: [
          { filename: "report.pdf" },
          { filename: "report.pptx" },
          { filename: "report.docx" },
        ],
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toContain("report.pdf");
      expect(messages).toContain("report.pptx");
      expect(messages).toContain("report.docx");
    });

    it("正常系: stem が異なれば同拡張子でも受け付ける (report.pdf + summary.pdf)", () => {
      const result = CreateBatchBodySchema.safeParse({
        ...validInput,
        files: [{ filename: "report.pdf" }, { filename: "summary.pdf" }],
      });
      expect(result.success).toBe(true);
    });

    it("正常系: 同一 stem が無ければ Office と PDF の混在を受け付ける", () => {
      const result = CreateBatchBodySchema.safeParse({
        ...validInput,
        files: [
          { filename: "report.pdf" },
          { filename: "slides.pptx" },
          { filename: "memo.docx" },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("異常系: 同一 stem 重複と別の stem 重複が混在しても両方検出される", () => {
      const result = CreateBatchBodySchema.safeParse({
        ...validInput,
        files: [
          { filename: "a.pdf" },
          { filename: "a.pptx" },
          { filename: "b.docx" },
          { filename: "b.xlsx" },
        ],
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      // 両 stem 重複の関連ファイル名がメッセージに含まれる
      expect(messages).toContain("a.pdf");
      expect(messages).toContain("a.pptx");
      expect(messages).toContain("b.docx");
      expect(messages).toContain("b.xlsx");
    });
  });
});

// ---------------------------------------------------------------------------
// errorCategory (R4.2 / R4.3, office-format-ingestion task 2.3)
// ---------------------------------------------------------------------------

describe("ERROR_CATEGORIES", () => {
  it("CONVERSION_FAILED と OCR_FAILED の 2 値を定義している", () => {
    // R4.2 (CONVERSION_FAILED) / R4.3 (OCR_FAILED) と TS↔Py 共通の attribute 値。
    expect(ERROR_CATEGORIES).toEqual(["CONVERSION_FAILED", "OCR_FAILED"]);
  });
});

describe("BatchFileSchema.errorCategory", () => {
  const baseFile = {
    fileKey: "batches/abc/input/a.pdf",
    filename: "a.pdf",
    status: "FAILED" as const,
    updatedAt: "2026-04-22T00:10:00Z",
  };

  it("errorCategory='CONVERSION_FAILED' を受理する", () => {
    const result = BatchFileSchema.safeParse({
      ...baseFile,
      errorCategory: "CONVERSION_FAILED",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.errorCategory).toBe("CONVERSION_FAILED");
    }
  });

  it("errorCategory='OCR_FAILED' を受理する", () => {
    const result = BatchFileSchema.safeParse({
      ...baseFile,
      errorCategory: "OCR_FAILED",
    });
    expect(result.success).toBe(true);
  });

  it("errorCategory 省略時も受理する (optional, 後方互換)", () => {
    // R4.4: 旧データ (errorCategory 属性なし) は読み出し時 undefined のまま
    // BatchFileSchema を通過し、レスポンス JSON からはキーごと省略される。
    const result = BatchFileSchema.safeParse(baseFile);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.errorCategory).toBeUndefined();
    }
  });

  it("errorCategory に enum 外の値を渡すと validation error", () => {
    const result = BatchFileSchema.safeParse({
      ...baseFile,
      errorCategory: "UNKNOWN",
    });
    expect(result.success).toBe(false);
  });
});
