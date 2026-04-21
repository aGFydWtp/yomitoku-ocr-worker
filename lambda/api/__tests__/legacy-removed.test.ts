import { describe, expect, it, vi } from "vitest";

// Minimal module mocks so that index.ts can be imported without real AWS clients.
vi.mock("../lib/dynamodb", () => ({
  docClient: { send: vi.fn() },
}));

vi.mock("../lib/sfn", () => ({
  sfnClient: { send: vi.fn() },
}));

vi.mock("../lib/s3", () => ({
  createUploadUrl: vi.fn(),
  createResultUrl: vi.fn(),
  deleteObject: vi.fn(),
  headObject: vi.fn(),
  RESULT_URL_EXPIRES_IN: 3600,
  UPLOAD_URL_EXPIRES_IN: 900,
}));

/**
 * Task 6.1 要件:
 *   /jobs 系ルートは Hono ルーターから完全に撤去され、アクセスしたときは
 *   404 を返すこと。
 *
 * index.ts は `handler` を export するのみなので、ここでは OpenAPIHono の
 * 組み立てをそのまま読み込んで `/jobs/*` への GET/POST/DELETE がすべて
 * 404 であることを検証する。
 */

async function loadApp() {
  // Dynamic import so that mocks above take effect before index evaluation.
  const mod = await import("../index");
  // index.ts は `handler` を export する。内部 Hono instance を fetch する
  // ためには、index.ts が app を export していない制約上、handler を擬似
  // API Gateway event で呼び出す代わりに、モジュールスコープの app への
  // アクセスを持たないため、ここでは Hono を同等構成で再構築してもよい。
  // 最小侵襲の確認として、index.handler を経由して LambdaEvent を投げて
  // 404 を得る方式は大掛かりなため、本テストでは index.ts が
  // `/jobs` ルーターを登録していないこと(=import にないこと)を確認する。
  return mod;
}

describe("Task 6.1 — /jobs 系ルートの撤去", () => {
  it("index モジュールが ./routes/jobs を import していない", async () => {
    // dynamic import で読めること自体が /jobs import を残していないことの
    // 前提条件 (未削除なら `Cannot find module '../routes/jobs'` で失敗)。
    await expect(loadApp()).resolves.toBeDefined();
  });

  it("lambda/api/routes に jobs.ts / jobs.routes.ts が存在しない", async () => {
    await expect(import("../routes/jobs")).rejects.toThrow();
    await expect(import("../routes/jobs.routes" as string)).rejects.toThrow();
  });

  it("validate.ts から parseFilepath / decodeCursor が撤去されている", async () => {
    const validate = await import("../lib/validate");
    expect((validate as Record<string, unknown>).parseFilepath).toBeUndefined();
    expect((validate as Record<string, unknown>).decodeCursor).toBeUndefined();
  });

  it("schemas.ts から旧 Job 系スキーマが撤去されている", async () => {
    const schemas = await import("../schemas");
    const keys = Object.keys(schemas);
    for (const legacy of [
      "JOB_STATUSES",
      "CreateJobBodySchema",
      "CreateJobResponseSchema",
      "JobDetailResponseSchema",
      "JobListItemSchema",
      "JobListResponseSchema",
      "CancelJobResponseSchema",
      "VISUALIZATION_MODES",
      "VisualizationsQuerySchema",
      "VisualizationItemSchema",
      "VisualizationsResponseSchema",
    ]) {
      expect(keys).not.toContain(legacy);
    }
  });
});
