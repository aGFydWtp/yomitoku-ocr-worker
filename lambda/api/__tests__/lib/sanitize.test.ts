import { describe, expect, it } from "vitest";
import { ValidationError } from "../../lib/errors";
import { sanitizeFilename } from "../../lib/sanitize";

describe("sanitizeFilename", () => {
  it("正常なPDFファイル名はそのまま返す", () => {
    expect(sanitizeFilename("請求書.pdf")).toBe("請求書.pdf");
  });

  it("正常な.pptxファイル名はそのまま返す", () => {
    expect(sanitizeFilename("slides.pptx")).toBe("slides.pptx");
  });

  it("正常な.docxファイル名はそのまま返す", () => {
    expect(sanitizeFilename("report.docx")).toBe("report.docx");
  });

  it("正常な.xlsxファイル名はそのまま返す", () => {
    expect(sanitizeFilename("data.xlsx")).toBe("data.xlsx");
  });

  it("Office 拡張子の大文字も許容する", () => {
    expect(sanitizeFilename("SLIDES.PPTX")).toBe("SLIDES.PPTX");
  });

  it("パストラバーサルを除去する", () => {
    expect(sanitizeFilename("../../etc/passwd.pdf")).toBe("passwd.pdf");
  });

  it("Windowsパスを除去する", () => {
    expect(sanitizeFilename("C:\\Users\\test.pdf")).toBe("test.pdf");
  });

  it("制御文字を除去する", () => {
    expect(sanitizeFilename("test\x00file.pdf")).toBe("testfile.pdf");
  });

  it("大文字拡張子を許容する", () => {
    expect(sanitizeFilename("TEST.PDF")).toBe("TEST.PDF");
  });

  it("空文字はValidationErrorを投げる", () => {
    expect(() => sanitizeFilename("")).toThrow(
      new ValidationError("Filename is empty after sanitization"),
    );
  });

  it("空白のみの文字列はValidationErrorを投げる", () => {
    expect(() => sanitizeFilename("   ")).toThrow(
      new ValidationError("Filename is empty after sanitization"),
    );
  });

  it("制御文字のみの文字列はValidationErrorを投げる", () => {
    expect(() => sanitizeFilename("\x00\x01\x02")).toThrow(
      new ValidationError("Filename is empty after sanitization"),
    );
  });

  it("非許可拡張子はValidationErrorを投げる (新メッセージ)", () => {
    expect(() => sanitizeFilename("test.txt")).toThrow(
      new ValidationError(
        "Filename must end with one of: .pdf, .pptx, .docx, .xlsx",
      ),
    );
  });

  it("非許可拡張子 .zip もValidationErrorを投げる", () => {
    expect(() => sanitizeFilename("archive.zip")).toThrow(
      new ValidationError(
        "Filename must end with one of: .pdf, .pptx, .docx, .xlsx",
      ),
    );
  });

  it("Windows禁止文字を除去する", () => {
    expect(sanitizeFilename('test<>:".pdf')).toBe("test.pdf");
  });

  it("先頭・末尾の空白をトリムする", () => {
    expect(sanitizeFilename("  test.pdf  ")).toBe("test.pdf");
  });

  it("拡張子のみ(.pdf)はValidationErrorを投げる", () => {
    expect(() => sanitizeFilename(".pdf")).toThrow(
      new ValidationError("Filename has no basename (only extension)"),
    );
  });

  it("拡張子のみ(.pptx)はValidationErrorを投げる", () => {
    expect(() => sanitizeFilename(".pptx")).toThrow(
      new ValidationError("Filename has no basename (only extension)"),
    );
  });

  it("拡張子のみ(.docx)はValidationErrorを投げる", () => {
    expect(() => sanitizeFilename(".docx")).toThrow(
      new ValidationError("Filename has no basename (only extension)"),
    );
  });

  it("拡張子のみ(.xlsx)はValidationErrorを投げる", () => {
    expect(() => sanitizeFilename(".xlsx")).toThrow(
      new ValidationError("Filename has no basename (only extension)"),
    );
  });

  it("拡張子のみ大文字(.PPTX)もValidationErrorを投げる", () => {
    expect(() => sanitizeFilename(".PPTX")).toThrow(
      new ValidationError("Filename has no basename (only extension)"),
    );
  });

  it("混合パス区切り文字を処理する", () => {
    expect(sanitizeFilename("path/to\\file.pdf")).toBe("file.pdf");
  });

  it("Unicode パス区切り文字 U+2215 を除去する", () => {
    expect(sanitizeFilename("path∕to∕file.pdf")).toBe("file.pdf");
  });

  it("全角スラッシュ U+FF0F をパス区切り文字として除去する (L2)", () => {
    expect(sanitizeFilename("path／to／file.pdf")).toBe("file.pdf");
  });

  it("全角逆スラッシュ U+FF3C をパス区切り文字として除去する (L2)", () => {
    expect(sanitizeFilename("path＼to＼file.pdf")).toBe("file.pdf");
  });

  it("Office 形式でもパストラバーサル除去が機能する", () => {
    expect(sanitizeFilename("../../etc/slides.pptx")).toBe("slides.pptx");
  });

  it("255バイトを超えるファイル名はValidationErrorを投げる", () => {
    const longName = `${"a".repeat(252)}.pdf`;
    expect(() => sanitizeFilename(longName)).toThrow(
      new ValidationError("Filename too long"),
    );
  });

  it("255バイトちょうどのファイル名は許容する", () => {
    const name = `${"a".repeat(251)}.pdf`;
    expect(sanitizeFilename(name)).toBe(name);
  });

  it("マルチバイト文字で255バイトを超える場合はValidationErrorを投げる", () => {
    const name = `${"あ".repeat(85)}.pdf`;
    expect(Buffer.byteLength(name, "utf8")).toBeGreaterThan(255);
    expect(() => sanitizeFilename(name)).toThrow(
      new ValidationError("Filename too long"),
    );
  });
});
