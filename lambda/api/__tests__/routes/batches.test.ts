import { beforeEach, describe, expect, it, vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: テストでHonoレスポンスの動的JSONを扱うため
type AnyJson = any;

// --- vi.hoisted() でモック関数を事前宣言（vi.mock ホイスティング対策） ---
const {
  mockSfnSend,
  mockPutBatchWithFiles,
  mockTransitionBatchStatus,
  mockCreateUploadUrls,
  mockCreateResultUrl,
  mockCreateProcessLogUrl,
  mockGetBatchWithFiles,
  mockListBatchesByStatus,
  mockListFailedFiles,
  mockHeadObject,
  mockListObjectKeys,
} = vi.hoisted(() => ({
  mockSfnSend: vi.fn(),
  mockPutBatchWithFiles: vi.fn(),
  mockTransitionBatchStatus: vi.fn(),
  mockCreateUploadUrls: vi.fn(),
  mockCreateResultUrl: vi.fn(),
  mockCreateProcessLogUrl: vi.fn(),
  mockGetBatchWithFiles: vi.fn(),
  mockListBatchesByStatus: vi.fn(),
  mockListFailedFiles: vi.fn(),
  mockHeadObject: vi.fn(),
  mockListObjectKeys: vi.fn(),
}));

vi.mock("../../lib/sfn", () => ({
  sfnClient: { send: (...args: unknown[]) => mockSfnSend(...args) },
}));

vi.mock("../../lib/batch-store", () => ({
  BatchStore: vi.fn().mockReturnValue({
    putBatchWithFiles: mockPutBatchWithFiles,
    transitionBatchStatus: mockTransitionBatchStatus,
  }),
}));

vi.mock("../../lib/batch-presign", () => ({
  BatchPresign: vi.fn().mockReturnValue({
    createUploadUrls: mockCreateUploadUrls,
    createResultUrl: mockCreateResultUrl,
    createProcessLogUrl: mockCreateProcessLogUrl,
  }),
  RESULT_EXPIRES_IN: 3600,
}));

vi.mock("../../lib/batch-query", () => ({
  BatchQuery: vi.fn().mockReturnValue({
    getBatchWithFiles: mockGetBatchWithFiles,
    listBatchesByStatus: mockListBatchesByStatus,
    listFailedFiles: mockListFailedFiles,
  }),
}));

vi.mock("../../lib/s3", () => ({
  headObject: mockHeadObject,
  listObjectKeys: mockListObjectKeys,
  RESULT_URL_EXPIRES_IN: 3600,
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
  batchLabel: "project/2026/test",
  files: [{ filename: "a.pdf" }, { filename: "b.pdf" }],
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

const MOCK_BATCH_META = {
  batchJobId: "00000000-0000-4000-8000-000000000001",
  status: "COMPLETED" as const,
  totals: { total: 2, succeeded: 2, failed: 0, inProgress: 0 },
  batchLabel: "project/2026/test",
  createdAt: "2026-04-22T00:00:00Z",
  startedAt: "2026-04-22T00:01:00Z",
  updatedAt: "2026-04-22T00:10:00Z",
  parentBatchJobId: null,
};

const MOCK_BATCH_WITH_FILES = {
  ...MOCK_BATCH_META,
  files: [
    {
      fileKey: "batches/00000000-0000-4000-8000-000000000001/input/a.pdf",
      filename: "a.pdf",
      status: "COMPLETED" as const,
      resultKey: "batches/00000000-0000-4000-8000-000000000001/output/a.json",
      updatedAt: "2026-04-22T00:10:00Z",
    },
    {
      fileKey: "batches/00000000-0000-4000-8000-000000000001/input/b.pdf",
      filename: "b.pdf",
      status: "FAILED" as const,
      errorMessage: "OCR error",
      updatedAt: "2026-04-22T00:10:00Z",
    },
  ],
};

describe("POST /batches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BATCH_TABLE_NAME = "BatchTable";
    process.env.BUCKET_NAME = "test-bucket";
    process.env.CONTROL_TABLE_NAME = "ControlTable";
  });

  it("正常系: 201 と batchJobId・uploads を返す (Task 7.3: endpoint_state gate 撤去)", async () => {
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
  });

  it("正常系: BatchStore.putBatchWithFiles が正しい引数で呼ばれる", async () => {
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
    expect(args.batchLabel).toBe("project/2026/test");
    expect(args.files).toHaveLength(2);
    expect(args.bucket).toBe("test-bucket");
  });

  it("正常系: batchLabel 省略でも 201 を返す (optional フィールド)", async () => {
    mockPutBatchWithFiles.mockResolvedValue(undefined);
    mockCreateUploadUrls.mockResolvedValue([UPLOAD_RESULTS[0]]);

    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [{ filename: "a.pdf" }] }),
    });

    expect(res.status).toBe(201);
    const args = mockPutBatchWithFiles.mock.calls[0][0];
    expect(args.batchLabel).toBeUndefined();
  });

  it("正常系: extraFormats が指定されると BatchStore に渡される", async () => {
    mockPutBatchWithFiles.mockResolvedValue(undefined);
    mockCreateUploadUrls.mockResolvedValue([UPLOAD_RESULTS[0]]);

    const app = createApp();
    await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchLabel: "project",
        files: [{ filename: "a.pdf" }],
        extraFormats: ["markdown", "csv"],
      }),
    });

    const args = mockPutBatchWithFiles.mock.calls[0][0];
    expect(args.extraFormats).toEqual(["markdown", "csv"]);
  });

  it("Task 7.3: endpoint_state によらず 201 を返し、SFN 起動は発生しない", async () => {
    mockPutBatchWithFiles.mockResolvedValue(undefined);
    mockCreateUploadUrls.mockResolvedValue(UPLOAD_RESULTS);

    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(201);
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it("400: files が空配列は拒否される", async () => {
    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchLabel: "project", files: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("400: 許可されていない拡張子のファイルは拒否される", async () => {
    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchLabel: "project",
        files: [{ filename: "malware.exe" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400: batchLabel が空文字は拒否される", async () => {
    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchLabel: "", files: [{ filename: "a.pdf" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("400: 許可されていない contentType は拒否される", async () => {
    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchLabel: "project",
        files: [{ filename: "a.pdf", contentType: "application/x-msdownload" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("正常系: 許可された contentType は通過する", async () => {
    mockPutBatchWithFiles.mockResolvedValue(undefined);
    mockCreateUploadUrls.mockResolvedValue([UPLOAD_RESULTS[0]]);

    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchLabel: "project",
        files: [{ filename: "a.pdf", contentType: "application/octet-stream" }],
      }),
    });
    expect(res.status).toBe(201);
  });

  it("500: BatchStore がエラーを throw すると 500 を返す", async () => {
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
    mockPutBatchWithFiles.mockResolvedValue(undefined);
    mockCreateUploadUrls.mockRejectedValue(new Error("S3 presign error"));

    const app = createApp();
    const res = await app.request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(500);
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

// ============================================================
// Task 2.6: GET /batches と GET /batches/:batchJobId
// ============================================================

describe("GET /batches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BATCH_TABLE_NAME = "BatchTable";
    process.env.BUCKET_NAME = "test-bucket";
  });

  it("正常系: status + month でバッチ一覧を返す", async () => {
    mockListBatchesByStatus.mockResolvedValue({
      items: [MOCK_BATCH_META],
      cursor: null,
    });

    const app = createApp();
    const res = await app.request("/batches?status=COMPLETED&month=202604");
    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].batchJobId).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(body.cursor).toBeNull();
  });

  it("正常系: month 省略時は現在月を使用する", async () => {
    mockListBatchesByStatus.mockResolvedValue({ items: [], cursor: null });

    const app = createApp();
    const res = await app.request("/batches?status=PENDING");
    expect(res.status).toBe(200);
    expect(mockListBatchesByStatus).toHaveBeenCalledWith(
      "PENDING",
      expect.stringMatching(/^\d{6}$/),
      undefined,
    );
  });

  it("正常系: cursor を渡すとページング継続", async () => {
    mockListBatchesByStatus.mockResolvedValue({ items: [], cursor: null });

    const app = createApp();
    await app.request("/batches?status=COMPLETED&month=202604&cursor=abc123");
    expect(mockListBatchesByStatus).toHaveBeenCalledWith(
      "COMPLETED",
      "202604",
      "abc123",
    );
  });

  it("400: 無効な status は拒否される", async () => {
    const app = createApp();
    const res = await app.request("/batches?status=INVALID");
    expect(res.status).toBe(400);
  });
});

describe("GET /batches/:batchJobId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BATCH_TABLE_NAME = "BatchTable";
    process.env.BUCKET_NAME = "test-bucket";
  });

  it("正常系: バッチ詳細を返す（files は含まない）", async () => {
    mockGetBatchWithFiles.mockResolvedValue(MOCK_BATCH_WITH_FILES);

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000001",
    );
    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.batchJobId).toBe("00000000-0000-4000-8000-000000000001");
    expect(body.status).toBe("COMPLETED");
    expect(body.totals).toBeDefined();
    expect(body.createdAt).toBeDefined();
    expect(body.files).toBeUndefined(); // files は含まない
  });

  it("404: 存在しないバッチは 404 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000999",
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Task 2.7: GET /files と GET /process-log
// ============================================================

describe("GET /batches/:batchJobId/files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BATCH_TABLE_NAME = "BatchTable";
    process.env.BUCKET_NAME = "test-bucket";
  });

  it("正常系: ファイル一覧を返し COMPLETED ファイルには resultUrl を付与する", async () => {
    mockGetBatchWithFiles.mockResolvedValue(MOCK_BATCH_WITH_FILES);
    mockCreateResultUrl.mockResolvedValue("https://s3.example.com/result.json");

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000001/files",
    );
    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.items).toHaveLength(2);
    // COMPLETED ファイルには resultUrl が付与される
    const completedFile = body.items.find(
      (f: AnyJson) => f.status === "COMPLETED",
    );
    expect(completedFile.resultUrl).toBe("https://s3.example.com/result.json");
    // FAILED ファイルには resultUrl がない
    const failedFile = body.items.find((f: AnyJson) => f.status === "FAILED");
    expect(failedFile.resultUrl).toBeUndefined();
  });

  it("404: 存在しないバッチは 404 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000999/files",
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /batches/:batchJobId/process-log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BATCH_TABLE_NAME = "BatchTable";
    process.env.BUCKET_NAME = "test-bucket";
  });

  it("正常系: 終端状態なら process_log.jsonl の署名付き URL を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue(MOCK_BATCH_WITH_FILES);
    mockCreateProcessLogUrl.mockResolvedValue(
      "https://s3.example.com/log.jsonl",
    );

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000001/process-log",
    );
    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.url).toBe("https://s3.example.com/log.jsonl");
    expect(body.expiresIn).toBe(3600);
  });

  it("409: PROCESSING 状態では 409 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue({
      ...MOCK_BATCH_WITH_FILES,
      status: "PROCESSING",
    });

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000001/process-log",
    );
    expect(res.status).toBe(409);
  });

  it("409: PENDING 状態では 409 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue({
      ...MOCK_BATCH_WITH_FILES,
      status: "PENDING",
    });

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000001/process-log",
    );
    expect(res.status).toBe(409);
  });

  it("404: 存在しないバッチは 404 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000999/process-log",
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Task 2.8: DELETE /batches/:batchJobId と POST /reanalyze
// ============================================================

describe("DELETE /batches/:batchJobId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BATCH_TABLE_NAME = "BatchTable";
    process.env.BUCKET_NAME = "test-bucket";
  });

  it("正常系: PENDING バッチをキャンセルして 200 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue({
      ...MOCK_BATCH_WITH_FILES,
      status: "PENDING",
    });
    mockTransitionBatchStatus.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000001",
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.status).toBe("CANCELLED");
    expect(mockTransitionBatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        newStatus: "CANCELLED",
        expectedCurrent: "PENDING",
      }),
    );
  });

  it("404: 存在しないバッチは 404 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000999",
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  it("409: PROCESSING バッチはキャンセル不可で 409 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue({
      ...MOCK_BATCH_WITH_FILES,
      status: "PROCESSING",
    });

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000001",
      { method: "DELETE" },
    );
    expect(res.status).toBe(409);
    expect(mockTransitionBatchStatus).not.toHaveBeenCalled();
  });

  it("409: COMPLETED バッチはキャンセル不可で 409 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue(MOCK_BATCH_WITH_FILES);

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000001",
      { method: "DELETE" },
    );
    expect(res.status).toBe(409);
  });
});

describe("POST /batches/:batchJobId/reanalyze", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BATCH_TABLE_NAME = "BatchTable";
    process.env.BUCKET_NAME = "test-bucket";
  });

  const FAILED_FILES = [
    {
      fileKey: "batches/00000000-0000-4000-8000-000000000001/input/b.pdf",
      filename: "b.pdf",
      status: "FAILED" as const,
      errorMessage: "OCR error",
      updatedAt: "2026-04-22T00:10:00Z",
    },
  ];

  it("正常系: 失敗ファイルを対象に新バッチを作成し 201 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue(MOCK_BATCH_WITH_FILES);
    mockHeadObject.mockResolvedValue(true);
    mockListFailedFiles.mockResolvedValue(FAILED_FILES);
    mockPutBatchWithFiles.mockResolvedValue(undefined);
    mockCreateUploadUrls.mockResolvedValue([UPLOAD_RESULTS[1]]);

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000001/reanalyze",
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(201);
    const body: AnyJson = await res.json();
    expect(body.batchJobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.uploads).toHaveLength(1);
    // parentBatchJobId が設定されていること
    const storeArgs = mockPutBatchWithFiles.mock.calls[0][0];
    expect(storeArgs.parentBatchJobId).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("404: 存在しないバッチは 404 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000999/reanalyze",
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(404);
  });

  it("409: 終端状態でないバッチは再解析不可で 409 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue({
      ...MOCK_BATCH_WITH_FILES,
      status: "PROCESSING",
    });

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000001/reanalyze",
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(409);
  });

  it("404: process_log.jsonl が存在しない場合は 404 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue(MOCK_BATCH_WITH_FILES);
    mockHeadObject.mockResolvedValue(false);

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000001/reanalyze",
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(404);
  });

  it("409: 失敗ファイルがない場合は 409 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue(MOCK_BATCH_WITH_FILES);
    mockHeadObject.mockResolvedValue(true);
    mockListFailedFiles.mockResolvedValue([]);

    const app = createApp();
    const res = await app.request(
      "/batches/00000000-0000-4000-8000-000000000001/reanalyze",
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(409);
  });
});

// ============================================================
// Task 2.5: POST /batches/:batchJobId/start
// ============================================================

describe("POST /batches/:batchJobId/start", () => {
  const VALID_BATCH_JOB_ID = "11111111-1111-4111-8111-111111111111";
  const VALID_EXEC_ARN =
    "arn:aws:states:ap-northeast-1:123456789012:execution:BatchExec:run1";
  const VALID_BATCH_SM_ARN =
    "arn:aws:states:ap-northeast-1:123456789012:stateMachine:BatchExec";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BATCH_TABLE_NAME = "BatchTable";
    process.env.BUCKET_NAME = "test-bucket";
    process.env.BATCH_EXECUTION_STATE_MACHINE_ARN = VALID_BATCH_SM_ARN;
    // デフォルトで期待入力キー 2 件をすべて S3 に存在する状態にする
    mockListObjectKeys.mockResolvedValue([
      `batches/${VALID_BATCH_JOB_ID}/input/a.pdf`,
      `batches/${VALID_BATCH_JOB_ID}/input/b.pdf`,
    ]);
  });

  it("正常系: PENDING バッチを PROCESSING へ遷移させて SFN を起動する", async () => {
    mockGetBatchWithFiles.mockResolvedValue({
      ...MOCK_BATCH_WITH_FILES,
      batchJobId: VALID_BATCH_JOB_ID,
      status: "PENDING",
      files: [
        {
          fileKey: `batches/${VALID_BATCH_JOB_ID}/input/a.pdf`,
          filename: "a.pdf",
          status: "PENDING" as const,
          updatedAt: "2026-04-22T00:00:00Z",
        },
        {
          fileKey: `batches/${VALID_BATCH_JOB_ID}/input/b.pdf`,
          filename: "b.pdf",
          status: "PENDING" as const,
          updatedAt: "2026-04-22T00:00:00Z",
        },
      ],
    });
    mockTransitionBatchStatus.mockResolvedValue(undefined);
    mockSfnSend.mockResolvedValue({ executionArn: VALID_EXEC_ARN });

    const app = createApp();
    const res = await app.request(`/batches/${VALID_BATCH_JOB_ID}/start`, {
      method: "POST",
    });

    expect(res.status).toBe(202);
    const body: AnyJson = await res.json();
    expect(body.batchJobId).toBe(VALID_BATCH_JOB_ID);
    expect(body.status).toBe("PROCESSING");
    expect(body.executionArn).toBe(VALID_EXEC_ARN);

    expect(mockTransitionBatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        batchJobId: VALID_BATCH_JOB_ID,
        newStatus: "PROCESSING",
        expectedCurrent: "PENDING",
        startedAt: expect.any(String),
      }),
    );
    expect(mockSfnSend).toHaveBeenCalledOnce();
  });

  it("404: 存在しないバッチは 404 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(`/batches/${VALID_BATCH_JOB_ID}/start`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(mockTransitionBatchStatus).not.toHaveBeenCalled();
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it("409: PROCESSING バッチは起動不可で 409 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue({
      ...MOCK_BATCH_WITH_FILES,
      batchJobId: VALID_BATCH_JOB_ID,
      status: "PROCESSING",
    });

    const app = createApp();
    const res = await app.request(`/batches/${VALID_BATCH_JOB_ID}/start`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(mockTransitionBatchStatus).not.toHaveBeenCalled();
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it("409: COMPLETED バッチは起動不可で 409 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue({
      ...MOCK_BATCH_WITH_FILES,
      batchJobId: VALID_BATCH_JOB_ID,
      status: "COMPLETED",
    });

    const app = createApp();
    const res = await app.request(`/batches/${VALID_BATCH_JOB_ID}/start`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("409: CANCELLED バッチは起動不可で 409 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue({
      ...MOCK_BATCH_WITH_FILES,
      batchJobId: VALID_BATCH_JOB_ID,
      status: "CANCELLED",
    });

    const app = createApp();
    const res = await app.request(`/batches/${VALID_BATCH_JOB_ID}/start`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("409: ステータス遷移競合時 (ConflictError) は 409 を返す", async () => {
    mockGetBatchWithFiles.mockResolvedValue({
      ...MOCK_BATCH_WITH_FILES,
      batchJobId: VALID_BATCH_JOB_ID,
      status: "PENDING",
      files: [
        {
          fileKey: `batches/${VALID_BATCH_JOB_ID}/input/a.pdf`,
          filename: "a.pdf",
          status: "PENDING" as const,
          updatedAt: "2026-04-22T00:00:00Z",
        },
        {
          fileKey: `batches/${VALID_BATCH_JOB_ID}/input/b.pdf`,
          filename: "b.pdf",
          status: "PENDING" as const,
          updatedAt: "2026-04-22T00:00:00Z",
        },
      ],
    });
    // transitionBatchStatus が ConflictError を投げるケース
    const { ConflictError } = await import("../../lib/errors");
    mockTransitionBatchStatus.mockRejectedValue(
      new ConflictError("race condition"),
    );

    const app = createApp();
    const res = await app.request(`/batches/${VALID_BATCH_JOB_ID}/start`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it("500: 必須環境変数 BATCH_EXECUTION_STATE_MACHINE_ARN が未設定なら 500 を返す", async () => {
    delete process.env.BATCH_EXECUTION_STATE_MACHINE_ARN;
    mockGetBatchWithFiles.mockResolvedValue({
      ...MOCK_BATCH_WITH_FILES,
      batchJobId: VALID_BATCH_JOB_ID,
      status: "PENDING",
    });

    const app = createApp();
    const res = await app.request(`/batches/${VALID_BATCH_JOB_ID}/start`, {
      method: "POST",
    });
    expect(res.status).toBe(500);
  });

  it("500: 不正な ARN 形式なら 500 を返す (assertValidStateMachineArn)", async () => {
    process.env.BATCH_EXECUTION_STATE_MACHINE_ARN = "not-a-valid-arn";
    mockGetBatchWithFiles.mockResolvedValue({
      ...MOCK_BATCH_WITH_FILES,
      batchJobId: VALID_BATCH_JOB_ID,
      status: "PENDING",
    });

    const app = createApp();
    const res = await app.request(`/batches/${VALID_BATCH_JOB_ID}/start`, {
      method: "POST",
    });
    expect(res.status).toBe(500);
  });

  it("400: 未アップロードの入力ファイルがある場合は 400 を返し状態遷移も SFN 起動もしない", async () => {
    mockGetBatchWithFiles.mockResolvedValue({
      ...MOCK_BATCH_WITH_FILES,
      batchJobId: VALID_BATCH_JOB_ID,
      status: "PENDING",
      files: [
        {
          fileKey: `batches/${VALID_BATCH_JOB_ID}/input/a.pdf`,
          filename: "a.pdf",
          status: "PENDING" as const,
          updatedAt: "2026-04-22T00:00:00Z",
        },
        {
          fileKey: `batches/${VALID_BATCH_JOB_ID}/input/b.pdf`,
          filename: "b.pdf",
          status: "PENDING" as const,
          updatedAt: "2026-04-22T00:00:00Z",
        },
      ],
    });
    // b.pdf だけ S3 に存在しない
    mockListObjectKeys.mockResolvedValue([
      `batches/${VALID_BATCH_JOB_ID}/input/a.pdf`,
    ]);

    const app = createApp();
    const res = await app.request(`/batches/${VALID_BATCH_JOB_ID}/start`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body: AnyJson = await res.json();
    expect(body.error).toMatch(/missing|欠損|upload/i);
    expect(mockTransitionBatchStatus).not.toHaveBeenCalled();
    expect(mockSfnSend).not.toHaveBeenCalled();
  });
});
