import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MAX_FILES_PER_BATCH } from "../schemas";
import { sanitizeFilename } from "./sanitize"; // HIGH-1: filename サニタイズ

export const UPLOAD_EXPIRES_IN = 900; // 15 分
export const RESULT_EXPIRES_IN = 3600; // 60 分

// R1.2: 拡張子別の既定 Content-Type マッピング
// 呼び出し元が contentType を省略した場合、ここから導出した MIME が presigned PUT URL に
// 署名対象として埋め込まれる (X-Amz-SignedHeaders に content-type が含まれる)。
// マップに無い拡張子は defaultContentType() が application/octet-stream にフォールバックする。
// schemas.ts の ALLOWED_EXTENSIONS / contentType enum と整合させること。
export const EXTENSION_TO_CONTENT_TYPE: Record<string, string> = {
  ".pdf": "application/pdf",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function defaultContentType(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0) return "application/octet-stream";
  const ext = filename.slice(idx).toLowerCase();
  return EXTENSION_TO_CONTENT_TYPE[ext] ?? "application/octet-stream";
}

export class FileLimitError extends Error {
  constructor(count: number) {
    super(
      `File count ${count} exceeds MAX_FILES_PER_BATCH (${MAX_FILES_PER_BATCH})`,
    );
    this.name = "FileLimitError";
  }
}

export interface UploadUrlItem {
  filename: string;
  fileKey: string;
  uploadUrl: string;
  expiresIn: number;
}

export interface CreateUploadUrlsInput {
  batchJobId: string;
  files: ReadonlyArray<{ filename: string; contentType?: string }>;
}

export class BatchPresign {
  private readonly s3: S3Client;

  constructor(private readonly bucket: string) {
    this.s3 = new S3Client({});
  }

  // -----------------------------------------------------------------------
  // createUploadUrls — 複数ファイル向け署名付き PUT URL を一括発行
  // -----------------------------------------------------------------------
  async createUploadUrls(
    input: CreateUploadUrlsInput,
  ): Promise<UploadUrlItem[]> {
    const { batchJobId, files } = input;

    if (files.length > MAX_FILES_PER_BATCH) {
      throw new FileLimitError(files.length);
    }

    const results = await Promise.all(
      files.map(async (f) => {
        // HIGH-1: パストラバーサル・制御文字を除去してから S3 キーを構築
        const safeFilename = sanitizeFilename(f.filename);
        const key = `batches/${batchJobId}/input/${safeFilename}`;

        // MEDIUM-2 / R1.2: 呼び出し元が指定した contentType を尊重 (省略時は拡張子から導出)
        const contentType = f.contentType ?? defaultContentType(safeFilename);

        const url = await getSignedUrl(
          this.s3,
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            ContentType: contentType,
          }),
          { expiresIn: UPLOAD_EXPIRES_IN },
        );
        return {
          filename: safeFilename,
          fileKey: key,
          uploadUrl: url,
          expiresIn: UPLOAD_EXPIRES_IN,
        };
      }),
    );

    return results;
  }

  // -----------------------------------------------------------------------
  // createResultUrl — 結果 JSON / 可視化向け署名付き GET URL (60 分)
  // -----------------------------------------------------------------------
  async createResultUrl(key: string): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: RESULT_EXPIRES_IN },
    );
  }

  // -----------------------------------------------------------------------
  // createProcessLogUrl — process_log.jsonl 向け署名付き GET URL
  // -----------------------------------------------------------------------
  async createProcessLogUrl(batchJobId: string): Promise<string> {
    const key = `batches/${batchJobId}/logs/process_log.jsonl`;
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: RESULT_EXPIRES_IN },
    );
  }
}
