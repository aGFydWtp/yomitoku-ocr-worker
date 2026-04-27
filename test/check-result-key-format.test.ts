/**
 * check-result-key-format.sh CI guard の動作テスト (Task 5.1)
 *
 * - スクリプトの存在・実行可能権限を確認
 * - package.json に lint:result-key が登録されていることを確認
 * - クリーンなリポジトリで exit 0 を確認
 * - 旧フォーマット { stem }.json の取り残しを検出する設計であることを assert
 *
 * ref: .kiro/specs/result-filename-extension-preservation/design.md
 *      Testing Strategy > Contract Test (Legacy Reference Guard)
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../scripts/check-result-key-format.sh");
const REPO_ROOT = resolve(__dirname, "..");

describe("check-result-key-format.sh CI guard (Task 5.1)", () => {
  it("scripts/check-result-key-format.sh が存在する", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it("スクリプトが実行可能権限を持つ", () => {
    expect(() => accessSync(SCRIPT, constants.X_OK)).not.toThrow();
  });

  it("package.json に lint:result-key スクリプトが登録されている", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../package.json") as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["lint:result-key"]).toBeDefined();
    expect(pkg.scripts["lint:result-key"]).toContain("check-result-key-format");
  });

  it("package.json の lint チェーンに check-result-key-format.sh が組み込まれている", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../package.json") as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.lint).toContain("check-result-key-format.sh");
  });

  it("クリーンなリポジトリでは exit 0 する (Task 4.1 / 4.2 fixture 移行完了の検証)", () => {
    const result = spawnSync("bash", [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `check-result-key-format.sh exited ${result.status}.\n` +
          `stdout:\n${result.stdout ?? ""}\n` +
          `stderr:\n${result.stderr ?? ""}`,
      );
    }
    expect(result.status).toBe(0);
  });

  it("クリーン時の成功メッセージが stdout に出力される", () => {
    const result = spawnSync("bash", [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    expect(output).toContain("No legacy {stem}.json references found");
  });
});
