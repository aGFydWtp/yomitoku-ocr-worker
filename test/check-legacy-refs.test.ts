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
import { describe, expect, it } from "vitest";

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
    const pkg = require("../package.json") as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["lint:legacy"]).toBeDefined();
    expect(pkg.scripts["lint:legacy"]).toContain("check-legacy-refs");
  });

  it("クリーンなリポジトリではゼロ終了する (Task 6.3 完了条件)", () => {
    // Task 6.3 で /jobs 系・StatusTable・MainQueue・ProcessorFunction・
    // 旧 S3 プレフィックス参照をソースとドキュメントから除去した後は、
    // この CI ガードが clean-exit することを保証する。
    const result = spawnSync("bash", [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      // 失敗時は stdout を添えて診断しやすくする
      throw new Error(
        `check-legacy-refs.sh exited ${result.status}.\n` +
          `stdout:\n${result.stdout ?? ""}\n` +
          `stderr:\n${result.stderr ?? ""}`,
      );
    }
    expect(result.status).toBe(0);
  });

  it("クリーン時も成功メッセージが stdout に出力される", () => {
    const result = spawnSync("bash", [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    expect(output).toContain("No legacy references found");
  });
});
