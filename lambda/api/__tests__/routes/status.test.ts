import { beforeEach, describe, expect, it, vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: テストでDynamoDB/Honoレスポンスの動的JSONを扱うため
type AnyJson = any;

const mockSend = vi.fn();
vi.mock("../../lib/dynamodb", () => ({
  docClient: { send: (...args: unknown[]) => mockSend(...args) },
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { handleError } from "../../lib/errors";
import { statusRoutes } from "../../routes/status";

function createApp() {
  const app = new OpenAPIHono();
  app.route("/status", statusRoutes);
  app.onError(handleError);
  return app;
}

describe("GET /status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONTROL_TABLE_NAME = "control-table";
  });

  it("正常系: IN_SERVICE状態を返す", async () => {
    mockSend.mockResolvedValue({
      Item: {
        lock_key: "endpoint_control",
        endpoint_state: "IN_SERVICE",
        updated_at: "2026-03-17T00:00:00.000Z",
      },
    });

    const app = createApp();
    const res = await app.request("/status");

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.endpointState).toBe("IN_SERVICE");
    expect(body.updatedAt).toBe("2026-03-17T00:00:00.000Z");
  });

  it("正常系: CREATING状態を返す", async () => {
    mockSend.mockResolvedValue({
      Item: {
        lock_key: "endpoint_control",
        endpoint_state: "CREATING",
        updated_at: "2026-03-17T00:00:00.000Z",
      },
    });

    const app = createApp();
    const res = await app.request("/status");

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.endpointState).toBe("CREATING");
  });

  it("正常系: レコードが存在しない場合はIDLE", async () => {
    mockSend.mockResolvedValue({});

    const app = createApp();
    const res = await app.request("/status");

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.endpointState).toBe("IDLE");
    expect(body.updatedAt).toBeNull();
  });

  it("正常系: DynamoDB GetItemが正しいキーで呼ばれる", async () => {
    mockSend.mockResolvedValue({});

    const app = createApp();
    await app.request("/status");

    const getCommand = mockSend.mock.calls[0][0];
    expect(getCommand.input).toEqual(
      expect.objectContaining({
        TableName: "control-table",
        Key: { lock_key: "endpoint_control" },
        ConsistentRead: true,
      }),
    );
  });

  it("異常系: DynamoDB読み取り失敗は500を返す", async () => {
    mockSend.mockRejectedValue(new Error("DynamoDB unavailable"));

    const app = createApp();
    const res = await app.request("/status");

    expect(res.status).toBe(500);
  });
});
