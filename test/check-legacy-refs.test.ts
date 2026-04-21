/**
 * check-legacy-refs.sh CI guard の動作テスト
 *
 * - スクリプトの存在・実行可能権限を確認
 * - package.json に lint:legacy が登録されていることを確認
 * - 旧参照を含む現リポジトリで非ゼロ終了することを確認
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = resolve(__dirname, "../scripts/check-legacy-refs.sh");
const REPO_ROOT = resolve(__dirname, "..");

describe("check-legacy-refs.sh CI guard", () => {
  it("scripts/check-legacy-refs.sh が存在する", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it("スクリプトが実行可能権限を持つ", () => {
    expect(() => accessSync(SCRIPT, constants.X_OK)).not.toThrow();
  });

  it("package.json に lint:legacy スクリプトが登録されている", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../package.json") as { scripts: Record<string, string> };
    expect(pkg.scripts["lint:legacy"]).toBeDefined();
    expect(pkg.scripts["lint:legacy"]).toContain("check-legacy-refs");
  });

  it("旧参照が存在するリポジトリ上で非ゼロ終了する", () => {
    // 現時点では lambda/api/routes/jobs.ts 等に旧参照が残っているため非ゼロを期待する
    // (Task 6.1/6.3 でソースを clean にした後はゼロ終了に変わる)
    const result = spawnSync("bash", [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
  });

  it("禁止語のチェック項目が stdout に出力される", () => {
    const result = spawnSync("bash", [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    // 何らかの出力があることを確認（具体的な禁止語またはサマリーメッセージ）
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    expect(output.length).toBeGreaterThan(0);
  });
});
