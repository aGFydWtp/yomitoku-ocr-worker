import { Hono } from "hono";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/dynamodb";
import { createUploadUrl, UPLOAD_URL_EXPIRES_IN } from "../lib/s3";
import { sanitizeFilename } from "../lib/sanitize";
import { ValidationError } from "../lib/errors";

export const jobsRoutes = new Hono();

jobsRoutes.post("/", async (c) => {
  const tableName = process.env.STATUS_TABLE_NAME;
  const bucketName = process.env.BUCKET_NAME;
  if (!tableName || !bucketName) {
    throw new Error("STATUS_TABLE_NAME and BUCKET_NAME must be set");
  }

  let body: { filename?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }

  if (body.filename === undefined || body.filename === null) {
    throw new ValidationError("filename is required");
  }
  if (typeof body.filename !== "string") {
    throw new ValidationError("filename must be a string");
  }

  const sanitized = sanitizeFilename(body.filename);
  const jobId = crypto.randomUUID();
  const fileKey = `input/${jobId}/${sanitized}`;
  const now = new Date().toISOString();

  const uploadUrl = await createUploadUrl(bucketName, fileKey);

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        job_id: jobId,
        file_key: fileKey,
        status: "PENDING",
        created_at: now,
        updated_at: now,
        original_filename: body.filename,
      },
    }),
  );

  return c.json(
    {
      jobId,
      fileKey,
      uploadUrl,
      expiresIn: UPLOAD_URL_EXPIRES_IN,
    },
    201,
  );
});
