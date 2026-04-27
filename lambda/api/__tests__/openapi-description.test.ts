import { describe, expect, it, vi } from "vitest";

// AWS SDK clients are mocked so that index.ts can be imported in unit tests
// without triggering real AWS connections.
vi.mock("../lib/dynamodb", () => ({
  docClient: { send: vi.fn() },
}));

vi.mock("../lib/sfn", () => ({
  sfnClient: { send: vi.fn() },
}));

vi.mock("../lib/s3", () => ({
  headObject: vi.fn(),
  listObjectKeys: vi.fn(),
}));

/**
 * Task 2.4 要件:
 *   `lambda/api/index.ts` の OpenAPI `info.description` から PDF 専用の文言を
 *   Office 形式 (PPTX / DOCX / XLSX) 対応に書き換える。
 *
 * design.md `Components and Interfaces > index.ts > Implementation Notes` に列挙
 * された 5 箇所すべてが反映されていることを `/doc` の JSON ペイロードから
 * 検証する (R1.5)。
 */

async function fetchOpenApiDescription(): Promise<string> {
  const mod = await import("../index");
  const app = (mod as { app?: { fetch: (req: Request) => Promise<Response> } })
    .app;
  if (!app) {
    throw new Error(
      "index.ts must export the OpenAPIHono `app` instance for unit tests",
    );
  }
  const res = await app.fetch(new Request("http://localhost/doc"));
  expect(res.status).toBe(200);
  const doc = (await res.json()) as { info?: { description?: string } };
  const description = doc.info?.description;
  if (typeof description !== "string") {
    throw new Error("info.description was not a string");
  }
  return description;
}

describe("Task 2.4 — OpenAPI info.description の Office 形式対応", () => {
  it("PUT 説明 (:37) に Office 形式 4 種と OOXML MIME を併記している", async () => {
    const description = await fetchOpenApiDescription();
    expect(description).toContain("PDF / PPTX / DOCX / XLSX");
    // PDF MIME と OOXML MIME prefix のいずれにも触れる
    expect(description).toContain("application/pdf");
    expect(description).toContain(
      "application/vnd.openxmlformats-officedocument",
    );
  });

  it("利用例 body (:48) に PPTX のサンプル filename が含まれる", async () => {
    const description = await fetchOpenApiDescription();
    expect(description).toContain("slides.pptx");
    // PDF と PPTX の混在 body であること (a.pdf も維持)
    expect(description).toContain("a.pdf");
  });

  it("curl サンプル (:52) に PPTX 用の content-type 行が追加されている", async () => {
    const description = await fetchOpenApiDescription();
    expect(description).toContain(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(description).toContain("--data-binary @slides.pptx");
  });

  it("smoke 文言 (:82) に Office 形式の +1–3 秒オーバーヘッド注記が併記されている", async () => {
    const description = await fetchOpenApiDescription();
    // 既存 PDF 2 ページ smoke の文言は維持
    expect(description).toContain("PDF 2 ページの smoke");
    // Office 形式の追加オーバーヘッド注記
    expect(description).toMatch(/Office 形式.*PPTX.*DOCX.*XLSX/);
    expect(description).toMatch(/\+1[–-]3 秒/);
  });

  it("拡張子説明 (:101) に 4 種の拡張子と LibreOffice 経由の PDF 化が併記されている", async () => {
    const description = await fetchOpenApiDescription();
    // 4 種の拡張子が同一行に列挙されていること (記号は ` で囲む現行スタイル)
    expect(description).toMatch(
      /`\.pdf`\s*\/\s*`\.pptx`\s*\/\s*`\.docx`\s*\/\s*`\.xlsx`/,
    );
    expect(description).toContain("LibreOffice");
    // 旧文言「拡張子は **`.pdf`** のみ」が残っていないこと
    expect(description).not.toMatch(/拡張子は\s*\*\*`\.pdf`\*\*\s*のみ/);
  });
});
