import { ValidationError } from "./errors";

const MAX_FILENAME_BYTES = 255;

export function sanitizeFilename(raw: string): string {
  // Unicode のスラッシュ類 (U+2215 DIVISION SLASH, U+FF0F FULLWIDTH SOLIDUS) と
  // 全角逆スラッシュ (U+FF3C FULLWIDTH REVERSE SOLIDUS) を ASCII に正規化した上で、
  // `/` → `\\` の順に basename 抽出を行う。いずれも視覚的にパス区切りに見える文字で、
  // そのまま basename として扱うとパストラバーサル回避策の盲点になる (L2)。
  const basename =
    raw
      .replace(/[\u2215\uFF0F]/g, "/")
      .replace(/\uFF3C/g, "\\")
      .split("/")
      .pop()
      ?.split("\\")
      .pop()
      ?.trim() || "document.pdf";

  // biome-ignore lint/suspicious/noControlCharactersInRegex: セキュリティ上制御文字の除去が必要
  const cleaned = basename.replace(/[\x00-\x1f<>:"|?*]/g, "");

  if (!cleaned || cleaned === ".pdf") {
    return "document.pdf";
  }

  if (!cleaned.toLowerCase().endsWith(".pdf")) {
    throw new ValidationError("Filename must end with .pdf");
  }

  if (Buffer.byteLength(cleaned, "utf8") > MAX_FILENAME_BYTES) {
    throw new ValidationError("Filename too long");
  }

  return cleaned;
}
