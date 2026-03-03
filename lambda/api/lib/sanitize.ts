import { ValidationError } from "./errors";

const MAX_FILENAME_BYTES = 255;

export function sanitizeFilename(raw: string): string {
  const basename =
    raw
      .replace(/\u2215/g, "/")
      .split("/")
      .pop()
      ?.split("\\")
      .pop()
      ?.trim() || "document.pdf";

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
