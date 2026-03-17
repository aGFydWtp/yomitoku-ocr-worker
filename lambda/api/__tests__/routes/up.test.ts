import { beforeEach, describe, expect, it, vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: テストでDynamoDB/Honoレスポンスの動的JSONを扱うため
type AnyJson = any;

const mockDynamoSend = vi.fn();
vi.mock("../../lib/dynamodb", () => ({
  docClient: { send: (...args: unknown[]) => mockDynamoSend(...args) },
}));

const mockSfnSend = vi.fn();
vi.mock("../../lib/sfn", () => ({
  sfnClient: { send: (...args: unknown[]) => mockSfnSend(...args) },
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { handleError } from "../../lib/errors";
import { upRoutes } from "../../routes/up";

function createApp() {
  const app = new OpenAPIHono();
  app.route("/up", upRoutes);
  app.onError(handleError);
  return app;
}

describe("POST /up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONTROL_TABLE_NAME = "control-table";
    process.env.STATE_MACHINE_ARN =
      "arn:aws:states:ap-northeast-1:123456789012:stateMachine:test";
  });

  it("正常系: IDLE状態ならSFNを起動し202を返す", async () => {
    mockDynamoSend.mockResolvedValue({
      Item: {
        lock_key: "endpoint_control",
        endpoint_state: "IDLE",
        updated_at: "2026-03-17T00:00:00.000Z",
      },
    });
    mockSfnSend.mockResolvedValue({});

    const app = createApp();
    const res = await app.request("/up", { method: "POST" });

    expect(res.status).toBe(202);
    const body: AnyJson = await res.json();
    expect(body.message).toBeDefined();
    expect(body.endpointState).toBe("IDLE");
    expect(mockSfnSend).toHaveBeenCalledTimes(1);
  });

  it("正常系: DELETING状態ならSFNを起動し202を返す", async () => {
    mockDynamoSend.mockResolvedValue({
      Item: {
        lock_key: "endpoint_control",
        endpoint_state: "DELETING",
      },
    });
    mockSfnSend.mockResolvedValue({});

    const app = createApp();
    const res = await app.request("/up", { method: "POST" });

    expect(res.status).toBe(202);
    expect(mockSfnSend).toHaveBeenCalledTimes(1);
  });

  it("正常系: CREATING状態ならSFNを起動せず202を返す（冪等）", async () => {
    mockDynamoSend.mockResolvedValue({
      Item: {
        lock_key: "endpoint_control",
        endpoint_state: "CREATING",
      },
    });

    const app = createApp();
    const res = await app.request("/up", { method: "POST" });

    expect(res.status).toBe(202);
    const body: AnyJson = await res.json();
    expect(body.endpointState).toBe("CREATING");
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it("正常系: IN_SERVICE状態ならSFNを起動せず200を返す", async () => {
    mockDynamoSend.mockResolvedValue({
      Item: {
        lock_key: "endpoint_control",
        endpoint_state: "IN_SERVICE",
      },
    });

    const app = createApp();
    const res = await app.request("/up", { method: "POST" });

    expect(res.status).toBe(200);
    const body: AnyJson = await res.json();
    expect(body.endpointState).toBe("IN_SERVICE");
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it("正常系: レコードが存在しない場合はIDLEとしてSFNを起動", async () => {
    mockDynamoSend.mockResolvedValue({});
    mockSfnSend.mockResolvedValue({});

    const app = createApp();
    const res = await app.request("/up", { method: "POST" });

    expect(res.status).toBe(202);
    expect(mockSfnSend).toHaveBeenCalledTimes(1);
  });

  it("正常系: StartExecutionCommandに正しいARNとinputが渡される", async () => {
    mockDynamoSend.mockResolvedValue({
      Item: { lock_key: "endpoint_control", endpoint_state: "IDLE" },
    });
    mockSfnSend.mockResolvedValue({});

    const app = createApp();
    await app.request("/up", { method: "POST" });

    const sfnCommand = mockSfnSend.mock.calls[0][0];
    expect(sfnCommand.input).toEqual(
      expect.objectContaining({
        stateMachineArn:
          "arn:aws:states:ap-northeast-1:123456789012:stateMachine:test",
        input: JSON.stringify({ trigger: "api_request" }),
      }),
    );
  });

  it("異常系: SFN起動失敗は500を返す", async () => {
    mockDynamoSend.mockResolvedValue({
      Item: { lock_key: "endpoint_control", endpoint_state: "IDLE" },
    });
    mockSfnSend.mockRejectedValue(new Error("SFN unavailable"));

    const app = createApp();
    const res = await app.request("/up", { method: "POST" });

    expect(res.status).toBe(500);
  });

  it("異常系: DynamoDB読み取り失敗は500を返す", async () => {
    mockDynamoSend.mockRejectedValue(new Error("DynamoDB unavailable"));

    const app = createApp();
    const res = await app.request("/up", { method: "POST" });

    expect(res.status).toBe(500);
  });

  it("異常系: STATE_MACHINE_ARNが未設定は500を返す", async () => {
    delete process.env.STATE_MACHINE_ARN;
    mockDynamoSend.mockResolvedValue({
      Item: { lock_key: "endpoint_control", endpoint_state: "IDLE" },
    });

    const app = createApp();
    const res = await app.request("/up", { method: "POST" });

    expect(res.status).toBe(500);
  });

  it("異常系: CONTROL_TABLE_NAMEが未設定は500を返す", async () => {
    delete process.env.CONTROL_TABLE_NAME;

    const app = createApp();
    const res = await app.request("/up", { method: "POST" });

    expect(res.status).toBe(500);
  });
});
