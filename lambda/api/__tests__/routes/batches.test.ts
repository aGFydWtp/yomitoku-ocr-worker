import { beforeEach, describe, expect, it, vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: テストでHonoレスポンスの動的JSONを扱うため
type AnyJson = any;

// --- vi.hoisted() でモック関数を事前宣言（vi.mock ホイスティング対策） ---
const {
  mockDynamoSend,
  mockSfnSend,
  mockPutBatchWithFiles,
  mockCreateUploadUrls,
} = vi.hoisted(() => ({
  mockDynamoSend: vi.fn(),
  mockSfnSend: vi.fn(),
  mockPutBatchWithFiles: vi.fn(),
  mockCreateUploadUrls: vi.fn(),
}));

vi.mock("../../lib/dynamodb", () => ({
  docClient: { send: (...args: unknown[]) => mockDynamoSend(...args) },
}));

vi.mock("../../lib/sfn", () => ({
  sfnClient: { send: (...args: unknown[]) => mockSfnSend(...args) },
}));

vi.mock("../../lib/batch-store", () => ({
  BatchStore: vi.fn().mockReturnValue({
    putBatchWithFiles: mockPutBatchWithFiles,
  }),
}));

vi.mock("../../lib/batch-presign", () => ({
  BatchPresign: vi.fn().mockReturnValue({
    createUploadUrls: mockCreateUploadUrls,
  }),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { handleError } from "../../lib/errors";
import { batchesRoutes } from "../../routes/batches";

function createApp() {
  const app = new OpenAPIHono();
  app.route("/batches", batchesRoutes);
  app.onError(handleError);
  return app;
}

const VALID_BODY = {
  basePath: "project/2026/test",
  files: [{ filename: "a.pdf" }, { filename: "b.pdf" }],
};

const IN_SERVICE_ITEM = {
  lock_key: "endpoint_control",
  endpoint_state: "IN_SERVICE",
};

const UPLOAD_RESULTS = [
  {
    filename: "a.pdf",
    fileKey: "batches/test-id/input/a.pdf",
    uploadUrl: "https://s3.example.com/a.pdf",
    expiresIn: 900,
  },
  {
    filename: "b.pdf",
    fileKey: "batches/test-id/input/b.pdf",
    uploadUrl: "https://s3.example.com/b.pdf",
    expiresIn: 900,
  },
];

describe("POST /batches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BATCH_TABLE_NAME = "BatchTable";
    process.env.BUCKET_NAME = "test-bucket";
    process.env.CONTROL_TABLE_NAME = "ControlTable";
    process.env.STATE_MACHINE_ARN =
      "arn:aws:states:ap-northeast-1:123456789012:stateMachine:test";
  });

  // --- 正常系 ---
  it("正常系: IN_SERVICE なら 201 と batchJobId・uploads を返す", async () => {
    mockDynamoSend.mockResolvedValue({ Item: IN_SERVICE_ITEM });
    mockPutBatchWithFiles.mockResolvedValue(undefined);
    mockCreateUploadUrls.mockResolvedValue(UPLOAD_RESULTS);

    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(201);
    const body: AnyJson = await res.json();
    expect(body.batchJobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.uploads).toHaveLength(2);
    expect(body.uploads[0]).toMatchObject({
      filename: expect.any(String),
      fileKey: expect.stringContaining("batches/"),
      uploadUrl: expect.stringContaining("https://"),
      expiresIn: expect.any(Number),
    });
  });

  it("正常系: BatchStore.putBatchWithFiles が正しい引数で呼ばれる", async () => {
    mockDynamoSend.mockResolvedValue({ Item: IN_SERVICE_ITEM });
    mockPutBatchWithFiles.mockResolvedValue(undefined);
    mockCreateUploadUrls.mockResolvedValue(UPLOAD_RESULTS);

    const app = createApp();
    await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(mockPutBatchWithFiles).toHaveBeenCalledOnce();
    const args = mockPutBatchWithFiles.mock.calls[0][0];
    expect(args.basePath).toBe("project/2026/test");
    expect(args.files).toHaveLength(2);
    expect(args.bucket).toBe("test-bucket");
    expect(args.batchJobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("正常系: extraFormats が指定されると BatchStore に渡される", async () => {
    mockDynamoSend.mockResolvedValue({ Item: IN_SERVICE_ITEM });
    mockPutBatchWithFiles.mockResolvedValue(undefined);
    mockCreateUploadUrls.mockResolvedValue([UPLOAD_RESULTS[0]]);

    const app = createApp();
    await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        basePath: "project",
        files: [{ filename: "a.pdf" }],
        extraFormats: ["markdown", "csv"],
      }),
    });

    const args = mockPutBatchWithFiles.mock.calls[0][0];
    expect(args.extraFormats).toEqual(["markdown", "csv"]);
  });

  // --- 503 系（エンドポイント未起動） ---
  it("503: IDLE 状態なら 503 を返し SFN を起動する", async () => {
    mockDynamoSend.mockResolvedValue({
      Item: { lock_key: "endpoint_control", endpoint_state: "IDLE" },
    });
    mockSfnSend.mockResolvedValue({});

    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(503);
    const body: AnyJson = await res.json();
    expect(body.endpointState).toBe("IDLE");
    expect(mockSfnSend).toHaveBeenCalledOnce();
    expect(mockPutBatchWithFiles).not.toHaveBeenCalled();
  });

  it("503: CREATING 状態なら 503 を返すが SFN は起動しない（既に起動中）", async () => {
    mockDynamoSend.mockResolvedValue({
      Item: { lock_key: "endpoint_control", endpoint_state: "CREATING" },
    });

    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(503);
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it("503: DELETING 状態なら 503 を返し SFN を起動する", async () => {
    mockDynamoSend.mockResolvedValue({
      Item: { lock_key: "endpoint_control", endpoint_state: "DELETING" },
    });
    mockSfnSend.mockResolvedValue({});

    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(503);
    expect(mockSfnSend).toHaveBeenCalledOnce();
  });

  // --- バリデーション ---
  it("400: files が空配列は拒否される", async () => {
    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ basePath: "project", files: [] }),
    });

    expect(res.status).toBe(400);
  });

  it("400: 許可されていない拡張子のファイルは拒否される", async () => {
    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        basePath: "project",
        files: [{ filename: "malware.exe" }],
      }),
    });

    expect(res.status).toBe(400);
  });

  it("400: basePath が空文字は拒否される", async () => {
    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ basePath: "", files: [{ filename: "a.pdf" }] }),
    });

    expect(res.status).toBe(400);
  });

  it("400: 許可されていない contentType は拒否される", async () => {
    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        basePath: "project",
        files: [{ filename: "a.pdf", contentType: "application/x-msdownload" }],
      }),
    });

    expect(res.status).toBe(400);
  });

  it("正常系: 許可された contentType は通過する", async () => {
    mockDynamoSend.mockResolvedValue({ Item: IN_SERVICE_ITEM });
    mockPutBatchWithFiles.mockResolvedValue(undefined);
    mockCreateUploadUrls.mockResolvedValue([UPLOAD_RESULTS[0]]);

    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        basePath: "project",
        files: [{ filename: "a.pdf", contentType: "application/octet-stream" }],
      }),
    });

    expect(res.status).toBe(201);
  });

  // --- エラーハンドリング ---
  it("500: BatchStore がエラーを throw すると 500 を返す", async () => {
    mockDynamoSend.mockResolvedValue({ Item: IN_SERVICE_ITEM });
    mockPutBatchWithFiles.mockRejectedValue(new Error("DynamoDB error"));

    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(500);
  });

  it("500: BatchPresign がエラーを throw すると 500 を返す（部分失敗）", async () => {
    mockDynamoSend.mockResolvedValue({ Item: IN_SERVICE_ITEM });
    mockPutBatchWithFiles.mockResolvedValue(undefined);
    mockCreateUploadUrls.mockRejectedValue(new Error("S3 presign error"));

    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(500);
    // BatchStore は呼ばれたが BatchPresign が失敗
    expect(mockPutBatchWithFiles).toHaveBeenCalledOnce();
  });

  it("500: 必須環境変数が未設定なら 500 を返す", async () => {
    delete process.env.BATCH_TABLE_NAME;

    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(500);
  });
});
