import { Hono } from "hono";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/dynamodb";
import {
  createResultUrl,
  createUploadUrl,
  RESULT_URL_EXPIRES_IN,
  UPLOAD_URL_EXPIRES_IN,
} from "../lib/s3";
import { sanitizeFilename } from "../lib/sanitize";
import { NotFoundError, ValidationError } from "../lib/errors";

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

jobsRoutes.get("/:jobId", async (c) => {
  const tableName = process.env.STATUS_TABLE_NAME;
  const bucketName = process.env.BUCKET_NAME;
  if (!tableName || !bucketName) {
    throw new Error("STATUS_TABLE_NAME and BUCKET_NAME must be set");
  }

  const jobId = c.req.param("jobId");
  if (!UUID_RE.test(jobId)) {
    throw new ValidationError("jobId must be a valid UUID");
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { job_id: jobId },
      ConsistentRead: true,
    }),
  );

  if (!result.Item) {
    throw new NotFoundError("Job not found");
  }

  const item = result.Item;

  interface JobResponse {
    jobId: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    resultUrl?: string;
    resultExpiresIn?: number;
    processingTimeMs?: number;
    errorMessage?: string;
  }

  const response: JobResponse = {
    jobId: item.job_id as string,
    status: item.status as string,
    createdAt: item.created_at as string,
    updatedAt: item.updated_at as string,
  };

  if (item.status === "COMPLETED" && item.result_key) {
    response.resultUrl = await createResultUrl(
      bucketName,
      item.result_key as string,
    );
    response.resultExpiresIn = RESULT_URL_EXPIRES_IN;
    if (item.processing_time_ms !== undefined) {
      response.processingTimeMs = item.processing_time_ms as number;
    }
  }

  if (item.status === "FAILED" && item.error_message) {
    response.errorMessage = item.error_message as string;
  }

  return c.json(response);
});
