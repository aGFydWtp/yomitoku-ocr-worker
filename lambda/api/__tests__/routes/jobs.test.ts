import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJson = any;

const mockSend = vi.fn();
vi.mock("../../lib/dynamodb", () => ({
  docClient: { send: (...args: unknown[]) => mockSend(...args) },
}));

const mockCreateUploadUrl = vi.fn();
vi.mock("../../lib/s3", () => ({
  createUploadUrl: (...args: unknown[]) => mockCreateUploadUrl(...args),
  createResultUrl: vi.fn(),
  UPLOAD_URL_EXPIRES_IN: 900,
  RESULT_URL_EXPIRES_IN: 3600,
}));

const FIXED_UUID = "550e8400-e29b-41d4-a716-446655440000";
vi.stubGlobal("crypto", {
  randomUUID: () => FIXED_UUID,
});

import { jobsRoutes } from "../../routes/jobs";
import { handleError } from "../../lib/errors";

function createApp() {
  const app = new Hono();
  app.route("/jobs", jobsRoutes);
  app.onError(handleError);
  return app;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("POST /jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STATUS_TABLE_NAME = "test-table";
    process.env.BUCKET_NAME = "test-bucket";
    mockSend.mockResolvedValue({});
    mockCreateUploadUrl.mockResolvedValue("https://s3.example.com/presigned");
  });

  it("正常系: 201を返しjobId, fileKey, uploadUrl, expiresInを含む", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(res.status).toBe(201);
    const body: AnyJson = await res.json();
    expect(body.jobId).toBe(FIXED_UUID);
    expect(body.fileKey).toBe(`input/${FIXED_UUID}/test.pdf`);
    expect(body.uploadUrl).toBe("https://s3.example.com/presigned");
    expect(body.expiresIn).toBe(900);
  });

  it("正常系: DynamoDBにPENDINGレコードが保存される", async () => {
    const app = createApp();
    await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const putCommand = mockSend.mock.calls[0][0];
    expect(putCommand.input).toEqual(
      expect.objectContaining({
        TableName: "test-table",
        Item: expect.objectContaining({
          job_id: FIXED_UUID,
          file_key: `input/${FIXED_UUID}/test.pdf`,
          status: "PENDING",
          original_filename: "test.pdf",
        }),
      }),
    );
    expect(putCommand.input.Item.created_at).toMatch(ISO_DATE_RE);
    expect(putCommand.input.Item.updated_at).toMatch(ISO_DATE_RE);
  });

  it("正常系: original_filenameにユーザー入力の生値が保存される", async () => {
    const app = createApp();
    await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "../../secret.pdf" }),
    });

    const putCommand = mockSend.mock.calls[0][0];
    expect(putCommand.input.Item.original_filename).toBe("../../secret.pdf");
    expect(putCommand.input.Item.file_key).toBe(
      `input/${FIXED_UUID}/secret.pdf`,
    );
  });

  it("正常系: S3 Presigned URLが正しいバケットとキーで発行される", async () => {
    const app = createApp();
    await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(mockCreateUploadUrl).toHaveBeenCalledWith(
      "test-bucket",
      `input/${FIXED_UUID}/test.pdf`,
    );
  });

  it("正常系: Presigned URL発行がDynamoDB書き込みより先に実行される", async () => {
    const callOrder: string[] = [];
    mockCreateUploadUrl.mockImplementation(async () => {
      callOrder.push("s3");
      return "https://s3.example.com/presigned";
    });
    mockSend.mockImplementation(async () => {
      callOrder.push("dynamodb");
      return {};
    });

    const app = createApp();
    await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(callOrder).toEqual(["s3", "dynamodb"]);
  });

  it("バリデーション: filename未指定は400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toBeDefined();
  });

  it("バリデーション: filenameが.pdfでない場合は400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.txt" }),
    });

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain(".pdf");
  });

  it("バリデーション: filenameが空文字の場合はdocument.pdfにフォールバックし201を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "" }),
    });

    expect(res.status).toBe(201);
    const body: AnyJson = await res.json();
    expect(body.fileKey).toBe(`input/${FIXED_UUID}/document.pdf`);
  });

  it("バリデーション: filenameが文字列でない場合は400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: 123 }),
    });

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("string");
  });

  it("バリデーション: 不正なJSONボディは400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("JSON");
  });

  it("正常系: 日本語ファイル名が正しく処理される", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "請求書_2026年3月.pdf" }),
    });

    expect(res.status).toBe(201);
    const body: AnyJson = await res.json();
    expect(body.fileKey).toBe(
      `input/${FIXED_UUID}/請求書_2026年3月.pdf`,
    );
  });

  it("異常系: DynamoDB書き込み失敗は500を返す", async () => {
    mockSend.mockRejectedValue(new Error("DynamoDB unavailable"));

    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(res.status).toBe(500);
  });
});
