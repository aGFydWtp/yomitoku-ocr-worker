import {
  DeleteObjectCommand,
  GetObjectCommand,
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
