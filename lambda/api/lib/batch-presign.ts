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

        // MEDIUM-2: 呼び出し元が指定した contentType を尊重（省略時は application/pdf）
        const contentType = f.contentType ?? "application/pdf";

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
