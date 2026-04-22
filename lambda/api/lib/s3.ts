import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({});

export const UPLOAD_URL_EXPIRES_IN = 900;
export const RESULT_URL_EXPIRES_IN = 3600;

export async function createUploadUrl(
  bucket: string,
  key: string,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: "application/pdf",
  });
  return getSignedUrl(s3Client, command, { expiresIn: UPLOAD_URL_EXPIRES_IN });
}

export async function createResultUrl(
  bucket: string,
  key: string,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  return getSignedUrl(s3Client, command, { expiresIn: RESULT_URL_EXPIRES_IN });
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
}

/**
 * S3 オブジェクトの存在確認。存在すれば true、存在しなければ false を返す。
 */
export async function headObject(
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 指定プレフィックス配下のキー一覧を取得する（ページング完結まで走査）。
 * /batches/:id/start で欠損入力ファイルを判定するための参照系ユーティリティ。
 */
export async function listObjectKeys(
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}
