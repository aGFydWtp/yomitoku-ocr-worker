import { describe, expect, it } from "vitest";
import { ValidationError } from "../../lib/errors";
import { sanitizeFilename } from "../../lib/sanitize";

describe("sanitizeFilename", () => {
  it("正常なPDFファイル名はそのまま返す", () => {
    expect(sanitizeFilename("請求書.pdf")).toBe("請求書.pdf");
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

  it("空文字はdocument.pdfにフォールバックする", () => {
    expect(sanitizeFilename("")).toBe("document.pdf");
  });

  it("非PDFファイルはValidationErrorを投げる", () => {
    expect(() => sanitizeFilename("test.txt")).toThrow(
      new ValidationError("Filename must end with .pdf"),
    );
  });

  it("Windows禁止文字を除去する", () => {
    expect(sanitizeFilename('test<>:".pdf')).toBe("test.pdf");
  });

  it("先頭・末尾の空白をトリムする", () => {
    expect(sanitizeFilename("  test.pdf  ")).toBe("test.pdf");
  });

  it("拡張子のみ(.pdf)の場合はdocument.pdfにフォールバックする", () => {
    expect(sanitizeFilename(".pdf")).toBe("document.pdf");
  });

  it("混合パス区切り文字を処理する", () => {
    expect(sanitizeFilename("path/to\\file.pdf")).toBe("file.pdf");
  });

  it("Unicode パス区切り文字 U+2215 を除去する", () => {
    expect(sanitizeFilename("path\u2215to\u2215file.pdf")).toBe("file.pdf");
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
