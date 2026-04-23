import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Task 9.2: PR テンプレートに Async 移行のエビデンス要求
// (Req 11.5) が含まれていることを CI で担保する。

const UPPER_PATH = resolve(__dirname, "../.github/PULL_REQUEST_TEMPLATE.md");
const LOWER_PATH = resolve(__dirname, "../.github/pull_request_template.md");

function loadTemplate(): string {
  if (existsSync(UPPER_PATH)) return readFileSync(UPPER_PATH, "utf8");
  if (existsSync(LOWER_PATH)) return readFileSync(LOWER_PATH, "utf8");
  throw new Error(
    "PR テンプレートが存在しない: .github/PULL_REQUEST_TEMPLATE.md または .github/pull_request_template.md",
  );
}

describe("PR Template: Async 移行エビデンス要求 (Task 9.2)", () => {
  it("テンプレートファイルが存在する", () => {
    expect(existsSync(UPPER_PATH) || existsSync(LOWER_PATH)).toBe(true);
  });

  describe("グリーン確認チェックボックスが存在する", () => {
    const content = loadTemplate();

    it.each([
      ["pnpm test", "pnpm test"],
      ["pnpm lint", "pnpm lint"],
      ["pnpm cdk synth --all", "pnpm cdk synth --all"],
      ["pnpm cdk deploy --all", "pnpm cdk deploy --all"],
    ])("%s のチェックボックスが存在する", (_label, command) => {
      // GitHub Task list の未チェック形式 `- [ ]` と合わせて検証
      const pattern = new RegExp(
        `- \\[ \\].*${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      );
      expect(content).toMatch(pattern);
    });
  });

  it("カットオーバー Runbook への参照チェックボックスが存在する", () => {
    const content = loadTemplate();
    expect(content).toMatch(
      /- \[ \].*docs\/runbooks\/sagemaker-async-cutover\.md/,
    );
  });
});
