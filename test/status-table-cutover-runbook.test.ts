import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Task 6.4: StatusTable カットオーバー削除 Runbook の完全性を担保する構造テスト。
// Runbook 自体は手動実行が完了条件（Requirement 1.2 / 9.3 / 9.5）だが、
// CI 上ではファイル存在と必須章節の欠落を検出することで、ドキュメント劣化を防ぐ。

const RUNBOOK_PATH = resolve(
  __dirname,
  "../docs/runbooks/status-table-cutover.md",
);

describe("Runbook: status-table-cutover.md (Task 6.4)", () => {
  it("Runbook ファイルが存在する", () => {
    expect(existsSync(RUNBOOK_PATH)).toBe(true);
  });

  describe("必須章節が網羅されている", () => {
    const content = readFileSync(RUNBOOK_PATH, "utf8");

    it.each([
      ["目的", "## 目的"],
      ["適用範囲", "## 適用範囲"],
      ["事前条件", "## 事前条件"],
      ["事前通知", "### 1. 事前通知"],
      ["レガシー参照ガード", "### 2. レガシー参照ガード"],
      ["新スタックのデプロイ", "### 3. 新スタックのデプロイ"],
      ["StatusTable 特定", "### 4. 旧 `StatusTable` の特定"],
      ["バックアップ取得", "### 5. バックアップ取得"],
      ["削除", "### 6. 削除"],
      ["事後検証", "### 7. 事後検証"],
      ["ロールバック制約", "## ロールバック制約"],
    ])("%s セクションが存在する", (_label, heading) => {
      expect(content).toContain(heading);
    });
  });

  describe("手動削除手順の必須キーワードが含まれる", () => {
    const content = readFileSync(RUNBOOK_PATH, "utf8");

    it("scripts/check-legacy-refs.sh が参照されている", () => {
      expect(content).toContain("scripts/check-legacy-refs.sh");
    });

    it("cdk deploy --all 手順が記載されている", () => {
      expect(content).toContain("cdk deploy --all");
    });

    it("aws dynamodb delete-table 手順が記載されている", () => {
      expect(content).toContain("aws dynamodb delete-table");
    });

    it("on-demand バックアップ (create-backup) が記載されている", () => {
      expect(content).toContain("aws dynamodb create-backup");
    });

    it("ロールバック不可である旨が明記されている", () => {
      expect(content).toMatch(/不可逆|戻せない/);
    });
  });
});
