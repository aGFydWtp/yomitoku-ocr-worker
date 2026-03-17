import { beforeEach, describe, expect, it, vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: テストでDynamoDB/Honoレスポンスの動的JSONを扱うため
type AnyJson = any;

const mockSend = vi.fn();
vi.mock("../../lib/dynamodb", () => ({
  docClient: { send: (...args: unknown[]) => mockSend(...args) },
}));

const mockCreateUploadUrl = vi.fn();
const mockCreateResultUrl = vi.fn();
const mockDeleteObject = vi.fn();
vi.mock("../../lib/s3", () => ({
  createUploadUrl: (...args: unknown[]) => mockCreateUploadUrl(...args),
  createResultUrl: (...args: unknown[]) => mockCreateResultUrl(...args),
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
  UPLOAD_URL_EXPIRES_IN: 900,
  RESULT_URL_EXPIRES_IN: 3600,
}));

const mockSfnSend = vi.fn();
vi.mock("../../lib/sfn", () => ({
  sfnClient: { send: (...args: unknown[]) => mockSfnSend(...args) },
}));

const FIXED_UUID = "550e8400-e29b-41d4-a716-446655440000";
vi.stubGlobal("crypto", {
  randomUUID: () => FIXED_UUID,
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { handleError } from "../../lib/errors";
import { jobsRoutes } from "../../routes/jobs";

function createApp() {
  const app = new OpenAPIHono();
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
    process.env.CONTROL_TABLE_NAME = "control-table";
    process.env.STATE_MACHINE_ARN =
      "arn:aws:states:ap-northeast-1:123456789012:stateMachine:test";
    // 1st call: Control Table (endpoint_state check) → IN_SERVICE
    // 2nd call: Status Table (PutCommand)
    mockSend
      .mockResolvedValueOnce({
        Item: { lock_key: "endpoint_control", endpoint_state: "IN_SERVICE" },
      })
      .mockResolvedValue({});
    mockCreateUploadUrl.mockResolvedValue("https://s3.example.com/presigned");
    mockSfnSend.mockResolvedValue({});
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

    // calls[0] = Control Table read, calls[1] = Status Table write
    expect(mockSend).toHaveBeenCalledTimes(2);
    const putCommand = mockSend.mock.calls[1][0];
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

    // calls[0] = Control Table read, calls[1] = Status Table write
    const putCommand = mockSend.mock.calls[1][0];
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

  it("正常系: Control読み取り→Presigned URL発行→DynamoDB書き込みの順で実行される", async () => {
    const callOrder: string[] = [];
    mockCreateUploadUrl.mockImplementation(async () => {
      callOrder.push("s3-presign");
      return "https://s3.example.com/presigned";
    });
    mockSend.mockReset();
    mockSend
      .mockImplementationOnce(async () => {
        callOrder.push("control-read");
        return {
          Item: { lock_key: "endpoint_control", endpoint_state: "IN_SERVICE" },
        };
      })
      .mockImplementation(async () => {
        callOrder.push("status-write");
        return {};
      });

    const app = createApp();
    await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(callOrder).toEqual(["control-read", "s3-presign", "status-write"]);
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
    expect(body.fileKey).toBe(`input/${FIXED_UUID}/請求書_2026年3月.pdf`);
  });

  it("正常系: basePath指定時にfileKeyが input/{basePath}/{jobId}/{filename} になる", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "test.pdf",
        basePath: "myProject/2026031701",
      }),
    });

    expect(res.status).toBe(201);
    const body: AnyJson = await res.json();
    expect(body.fileKey).toBe(
      `input/myProject/2026031701/${FIXED_UUID}/test.pdf`,
    );
  });

  it("正常系: basePath指定時にS3 Presigned URLが正しいキーで発行される", async () => {
    const app = createApp();
    await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "test.pdf",
        basePath: "myProject/2026031701",
      }),
    });

    expect(mockCreateUploadUrl).toHaveBeenCalledWith(
      "test-bucket",
      `input/myProject/2026031701/${FIXED_UUID}/test.pdf`,
    );
  });

  it("正常系: basePath指定時にDynamoDBにbase_pathが保存される", async () => {
    const app = createApp();
    await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "test.pdf",
        basePath: "myProject/2026031701",
      }),
    });

    // calls[0] = Control Table read, calls[1] = Status Table write
    const putCommand = mockSend.mock.calls[1][0];
    expect(putCommand.input.Item.file_key).toBe(
      `input/myProject/2026031701/${FIXED_UUID}/test.pdf`,
    );
    expect(putCommand.input.Item.base_path).toBe("myProject/2026031701");
  });

  it("正常系: basePath未指定時は従来通り input/{jobId}/{filename}", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(res.status).toBe(201);
    const body: AnyJson = await res.json();
    expect(body.fileKey).toBe(`input/${FIXED_UUID}/test.pdf`);
  });

  it("正常系: basePath未指定時にDynamoDBにbase_pathが保存されない", async () => {
    const app = createApp();
    await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    // calls[0] = Control Table read, calls[1] = Status Table write
    const putCommand = mockSend.mock.calls[1][0];
    expect(putCommand.input.Item.base_path).toBeUndefined();
  });

  it("バリデーション: basePathが文字列でない場合は400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf", basePath: 123 }),
    });

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("string");
  });

  it("バリデーション: basePathに先頭パストラバーサル(../)が含まれる場合は400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf", basePath: "../escape" }),
    });

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toBeDefined();
  });

  it("バリデーション: basePathに中間パストラバーサル(a/../b)が含まれる場合は400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf", basePath: "legit/../escape" }),
    });

    expect(res.status).toBe(400);
  });

  it("バリデーション: basePathに末尾パストラバーサル(a/..)が含まれる場合は400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf", basePath: "legit/subdir/.." }),
    });

    expect(res.status).toBe(400);
  });

  it("バリデーション: basePathが長すぎる場合は400を返す", async () => {
    const app = createApp();
    const longPath = "a".repeat(513);
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf", basePath: longPath }),
    });

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("long");
  });

  it("バリデーション: basePathに制御文字が含まれる場合は400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf", basePath: "path\x00name" }),
    });

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("invalid");
  });

  it("正常系: basePath=nullは未指定と同じ扱いになる", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf", basePath: null }),
    });

    expect(res.status).toBe(201);
    const body: AnyJson = await res.json();
    expect(body.fileKey).toBe(`input/${FIXED_UUID}/test.pdf`);
  });

  it("バリデーション: basePathが空文字の場合は400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf", basePath: "" }),
    });

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("basePath");
  });

  it("バリデーション: basePathの先頭/末尾スラッシュは正規化される", async () => {
    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "test.pdf",
        basePath: "/myProject/2026031701/",
      }),
    });

    expect(res.status).toBe(201);
    const body: AnyJson = await res.json();
    expect(body.fileKey).toBe(
      `input/myProject/2026031701/${FIXED_UUID}/test.pdf`,
    );

    const putCommand = mockSend.mock.calls[1][0];
    expect(putCommand.input.Item.base_path).toBe("myProject/2026031701");
  });

  it("異常系: DynamoDB書き込み失敗は500を返す", async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({
        Item: { lock_key: "endpoint_control", endpoint_state: "IN_SERVICE" },
      })
      .mockRejectedValue(new Error("DynamoDB unavailable"));

    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(res.status).toBe(500);
  });

  it("異常系: エンドポイントがIN_SERVICEでない場合は503を返す", async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({
      Item: { lock_key: "endpoint_control", endpoint_state: "IDLE" },
    });

    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(res.status).toBe(503);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("Endpoint");
    expect(body.endpointState).toBe("IDLE");
  });

  it("異常系: エンドポイントがCREATING中は503を返しendpointStateを含む", async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({
      Item: { lock_key: "endpoint_control", endpoint_state: "CREATING" },
    });

    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(res.status).toBe(503);
    const body: AnyJson = await res.json();
    expect(body.endpointState).toBe("CREATING");
  });

  it("正常系: エンドポイントIDLE時にStep Functionsが起動される", async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({
      Item: { lock_key: "endpoint_control", endpoint_state: "IDLE" },
    });

    const app = createApp();
    await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(mockSfnSend).toHaveBeenCalledOnce();
    const startCommand = mockSfnSend.mock.calls[0][0];
    expect(startCommand.input.stateMachineArn).toBe(
      "arn:aws:states:ap-northeast-1:123456789012:stateMachine:test",
    );
  });

  it("正常系: エンドポイントCREATING中はStep Functionsを起動しない", async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({
      Item: { lock_key: "endpoint_control", endpoint_state: "CREATING" },
    });

    const app = createApp();
    await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it("正常系: Control Tableにレコードがない場合はIDLE扱いで503を返しStep Functionsを起動", async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({});

    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(res.status).toBe(503);
    const body: AnyJson = await res.json();
    expect(body.endpointState).toBe("IDLE");
    expect(mockSfnSend).toHaveBeenCalledOnce();
  });

  it("正常系: Step Functions起動失敗でも503レスポンスは返る", async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({
      Item: { lock_key: "endpoint_control", endpoint_state: "IDLE" },
    });
    mockSfnSend.mockRejectedValue(new Error("SFN unavailable"));

    const app = createApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.pdf" }),
    });

    expect(res.status).toBe(503);
  });
});

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    job_id: FIXED_UUID,
    file_key: `input/${FIXED_UUID}/test.pdf`,
    status: "PENDING",
    created_at: "2026-03-04T00:00:00.000Z",
    updated_at: "2026-03-04T00:01:00.000Z",
    original_filename: "test.pdf",
    ...overrides,
  };
}

describe("GET /jobs/:jobId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STATUS_TABLE_NAME = "test-table";
    process.env.BUCKET_NAME = "test-bucket";
  });

  it("正常系(PENDING): 200を返しstatus=PENDINGでresultUrlなし", async () => {
    mockSend.mockResolvedValue({ Item: makeItem({ status: "PENDING" }) });

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`);

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.jobId).toBe(FIXED_UUID);
    expect(body.status).toBe("PENDING");
    expect(body.createdAt).toBe("2026-03-04T00:00:00.000Z");
    expect(body.updatedAt).toBe("2026-03-04T00:01:00.000Z");
    expect(body.resultUrl).toBeUndefined();
    expect(body.resultExpiresIn).toBeUndefined();
  });

  it("正常系(PROCESSING): 200を返しstatus=PROCESSINGでresultUrlなし", async () => {
    mockSend.mockResolvedValue({
      Item: makeItem({ status: "PROCESSING" }),
    });

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`);

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.status).toBe("PROCESSING");
    expect(body.resultUrl).toBeUndefined();
  });

  it("正常系(COMPLETED): 200を返しresultUrlとresultExpiresInとprocessingTimeMsが含まれる", async () => {
    mockSend.mockResolvedValue({
      Item: makeItem({
        status: "COMPLETED",
        output_key: `output/${FIXED_UUID}/result.json`,
        processing_time_ms: 12345,
      }),
    });
    mockCreateResultUrl.mockResolvedValue(
      "https://s3.example.com/result-presigned",
    );

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`);

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.status).toBe("COMPLETED");
    expect(body.resultUrl).toBe("https://s3.example.com/result-presigned");
    expect(body.resultExpiresIn).toBe(3600);
    expect(body.processingTimeMs).toBe(12345);
    expect(mockCreateResultUrl).toHaveBeenCalledWith(
      "test-bucket",
      `output/${FIXED_UUID}/result.json`,
    );
  });

  it("正常系(FAILED): 200を返しerrorMessageが含まれる", async () => {
    mockSend.mockResolvedValue({
      Item: makeItem({
        status: "FAILED",
        error_message: "PDF parsing failed",
      }),
    });

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`);

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.status).toBe("FAILED");
    expect(body.errorMessage).toBe("PDF parsing failed");
    expect(body.resultUrl).toBeUndefined();
  });

  it("正常系(CANCELLED): 200を返しstatus=CANCELLED", async () => {
    mockSend.mockResolvedValue({
      Item: makeItem({ status: "CANCELLED" }),
    });

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`);

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.status).toBe("CANCELLED");
  });

  it("異常系: 存在しないjobIdは404を返す", async () => {
    mockSend.mockResolvedValue({});

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`);

    expect(res.status).toBe(404);
    const body: AnyJson = await res.json();
    expect(body.error).toBeDefined();
  });

  it("異常系: UUID形式でないjobIdは400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs/not-a-uuid");

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("UUID");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("異常系: COMPLETED状態でS3 Presigned URL生成失敗は500を返す", async () => {
    mockSend.mockResolvedValue({
      Item: makeItem({
        status: "COMPLETED",
        output_key: `output/${FIXED_UUID}/result.json`,
      }),
    });
    mockCreateResultUrl.mockRejectedValue(new Error("S3 unavailable"));

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`);

    expect(res.status).toBe(500);
  });

  it("異常系: DynamoDB読み取り失敗は500を返す", async () => {
    mockSend.mockRejectedValue(new Error("DynamoDB unavailable"));

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`);

    expect(res.status).toBe(500);
  });

  it("正常系: DynamoDB GetItemが強整合性読み取りで呼ばれる", async () => {
    mockSend.mockResolvedValue({ Item: makeItem() });

    const app = createApp();
    await app.request(`/jobs/${FIXED_UUID}`);

    const getCommand = mockSend.mock.calls[0][0];
    expect(getCommand.input).toEqual(
      expect.objectContaining({
        TableName: "test-table",
        Key: { job_id: FIXED_UUID },
        ConsistentRead: true,
      }),
    );
  });
});

function makeListItems(count: number, status = "COMPLETED") {
  return Array.from({ length: count }, (_, i) => ({
    job_id: `job-${i}`,
    file_key: `input/job-${i}/test.pdf`,
    status,
    created_at: `2026-03-04T${String(i).padStart(2, "0")}:00:00.000Z`,
    updated_at: `2026-03-04T${String(i).padStart(2, "0")}:00:30.000Z`,
    original_filename: `test-${i}.pdf`,
  }));
}

describe("GET /jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STATUS_TABLE_NAME = "test-table";
    process.env.BUCKET_NAME = "test-bucket";
  });

  it("正常系: ?status=COMPLETEDで200を返しitems, count, cursorを含む", async () => {
    const items = makeListItems(3);
    mockSend.mockResolvedValue({ Items: items, Count: 3 });

    const app = createApp();
    const res = await app.request("/jobs?status=COMPLETED");

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.items).toHaveLength(3);
    expect(body.count).toBe(3);
    expect(body.cursor).toBeNull();
    expect(body.items[0].jobId).toBe("job-0");
    expect(body.items[0].status).toBe("COMPLETED");
    expect(body.items[0].createdAt).toBeDefined();
    expect(body.items[0].updatedAt).toBeDefined();
  });

  it("正常系: ?status=PENDING&limit=5で最大5件を返す", async () => {
    const items = makeListItems(5, "PENDING");
    mockSend.mockResolvedValue({ Items: items, Count: 5 });

    const app = createApp();
    const res = await app.request("/jobs?status=PENDING&limit=5");

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.items).toHaveLength(5);

    const queryCommand = mockSend.mock.calls[0][0];
    expect(queryCommand.input.Limit).toBe(5);
  });

  it("正常系: ページネーション - cursorを使って次ページ取得", async () => {
    const lastKey = {
      job_id: "job-2",
      status: "COMPLETED",
      created_at: "2026-03-04T00:02:00.000Z",
    };
    mockSend.mockResolvedValue({
      Items: makeListItems(2),
      Count: 2,
      LastEvaluatedKey: lastKey,
    });

    const app = createApp();
    const res = await app.request("/jobs?status=COMPLETED&limit=2");

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.cursor).not.toBeNull();
    expect(typeof body.cursor).toBe("string");

    // cursorをデコードしてLastEvaluatedKeyと一致するか検証
    const decoded = JSON.parse(
      Buffer.from(body.cursor, "base64url").toString("utf8"),
    );
    expect(decoded).toEqual(lastKey);
  });

  it("正常系: cursorを渡して次ページを取得できる", async () => {
    const lastKey = {
      job_id: "job-2",
      status: "COMPLETED",
      created_at: "2026-03-04T00:02:00.000Z",
    };
    const cursor = Buffer.from(JSON.stringify(lastKey)).toString("base64url");

    mockSend.mockResolvedValue({ Items: makeListItems(1), Count: 1 });

    const app = createApp();
    const res = await app.request(`/jobs?status=COMPLETED&cursor=${cursor}`);

    expect(res.status).toBe(200);
    const queryCommand = mockSend.mock.calls[0][0];
    expect(queryCommand.input.ExclusiveStartKey).toEqual(lastKey);
  });

  it("正常系: 最終ページではcursorがnull", async () => {
    mockSend.mockResolvedValue({ Items: makeListItems(1), Count: 1 });

    const app = createApp();
    const res = await app.request("/jobs?status=COMPLETED");

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.cursor).toBeNull();
  });

  it("正常系: 一覧にresultUrlが含まれない", async () => {
    const items = makeListItems(1);
    items[0] = {
      ...items[0],
      output_key: "output/job-0/result.json",
    } as AnyJson;
    mockSend.mockResolvedValue({ Items: items, Count: 1 });

    const app = createApp();
    const res = await app.request("/jobs?status=COMPLETED");

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.items[0].resultUrl).toBeUndefined();
  });

  it("正常系: GSI status-created_at-indexでQueryが呼ばれる", async () => {
    mockSend.mockResolvedValue({ Items: [], Count: 0 });

    const app = createApp();
    await app.request("/jobs?status=PENDING");

    const queryCommand = mockSend.mock.calls[0][0];
    expect(queryCommand.input).toEqual(
      expect.objectContaining({
        TableName: "test-table",
        IndexName: "status-created_at-index",
        KeyConditionExpression: "#s = :status",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":status": "PENDING" },
        Limit: 20,
        ScanIndexForward: false,
      }),
    );
  });

  it("バリデーション: status未指定は400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs");

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("status");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("バリデーション: limitが0以下は400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs?status=COMPLETED&limit=0");

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("limit");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("バリデーション: limitが100超は400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs?status=COMPLETED&limit=101");

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("limit");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("バリデーション: 不正なcursorは400を返す", async () => {
    const app = createApp();
    const res = await app.request(
      "/jobs?status=COMPLETED&cursor=not-valid-base64url",
    );

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("cursor");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("バリデーション: cursorが非オブジェクトJSONの場合は400を返す", async () => {
    const cursor = Buffer.from(JSON.stringify("a string")).toString(
      "base64url",
    );
    const app = createApp();
    const res = await app.request(`/jobs?status=COMPLETED&cursor=${cursor}`);

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("cursor");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("異常系: DynamoDBクエリ失敗は500を返す", async () => {
    mockSend.mockRejectedValue(new Error("DynamoDB unavailable"));

    const app = createApp();
    const res = await app.request("/jobs?status=COMPLETED");

    expect(res.status).toBe(500);
  });

  it("バリデーション: 不正なstatusは400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs?status=INVALID");

    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toContain("status");
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("DELETE /jobs/:jobId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STATUS_TABLE_NAME = "test-table";
    process.env.BUCKET_NAME = "test-bucket";
    mockDeleteObject.mockResolvedValue(undefined);
  });

  it("正常系: PENDINGジョブを200でCANCELLEDに遷移", async () => {
    // UpdateCommand succeeds (ConditionExpression met)
    mockSend.mockResolvedValueOnce({
      Attributes: {
        ...makeItem({ status: "CANCELLED" }),
        file_key: `input/${FIXED_UUID}/test.pdf`,
      },
    });

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.status).toBe("CANCELLED");
  });

  it("正常系: S3 inputファイルのベストエフォート削除が呼ばれる", async () => {
    mockSend.mockResolvedValueOnce({
      Attributes: makeItem({
        status: "CANCELLED",
        file_key: `input/${FIXED_UUID}/test.pdf`,
      }),
    });

    const app = createApp();
    await app.request(`/jobs/${FIXED_UUID}`, { method: "DELETE" });

    expect(mockDeleteObject).toHaveBeenCalledWith(
      "test-bucket",
      `input/${FIXED_UUID}/test.pdf`,
    );
  });

  it("異常系: PROCESSINGジョブは409を返す", async () => {
    // UpdateCommand fails with ConditionalCheckFailedException
    const err = new Error("Condition not met");
    err.name = "ConditionalCheckFailedException";
    mockSend.mockRejectedValueOnce(err);

    // GetItem returns existing PROCESSING item
    mockSend.mockResolvedValueOnce({
      Item: makeItem({ status: "PROCESSING" }),
    });

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
    const body: AnyJson = await res.json();
    expect(body.error).toBeDefined();
  });

  it("異常系: COMPLETEDジョブは409を返す", async () => {
    const err = new Error("Condition not met");
    err.name = "ConditionalCheckFailedException";
    mockSend.mockRejectedValueOnce(err);

    mockSend.mockResolvedValueOnce({
      Item: makeItem({ status: "COMPLETED" }),
    });

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
  });

  it("異常系: 存在しないjobIdは404を返す", async () => {
    const err = new Error("Condition not met");
    err.name = "ConditionalCheckFailedException";
    mockSend.mockRejectedValueOnce(err);

    // GetItem returns no item
    mockSend.mockResolvedValueOnce({});

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });

  it("競合安全性: S3削除が失敗してもレスポンスは200", async () => {
    mockSend.mockResolvedValueOnce({
      Attributes: makeItem({
        status: "CANCELLED",
        file_key: `input/${FIXED_UUID}/test.pdf`,
      }),
    });
    mockDeleteObject.mockRejectedValue(new Error("S3 unavailable"));

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
  });

  it("異常系: UUID形式でないjobIdは400を返す", async () => {
    const app = createApp();
    const res = await app.request("/jobs/not-a-uuid", {
      method: "DELETE",
    });

    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("異常系: DynamoDB UpdateCommand失敗(非ConditionalCheck)は500を返す", async () => {
    mockSend.mockRejectedValueOnce(new Error("DynamoDB unavailable"));

    const app = createApp();
    const res = await app.request(`/jobs/${FIXED_UUID}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(500);
  });
});
