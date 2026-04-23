import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Task 9.1: SageMaker Realtime → Async カットオーバー Runbook の
// 完全性を担保する構造テスト。Runbook 自体は手動実行が完了条件
// (Req 7.3, 7.4, 7.5, 8.2, 8.3, 9.1, 9.3, 9.4, 11.1, 11.2, 11.3)
// だが、CI 上ではファイル存在と必須章節の欠落を検出する。

const RUNBOOK_PATH = resolve(
  __dirname,
  "../docs/runbooks/sagemaker-async-cutover.md",
);

describe("Runbook: sagemaker-async-cutover.md (Task 9.1)", () => {
  it("Runbook ファイルが存在する", () => {
    expect(existsSync(RUNBOOK_PATH)).toBe(true);
  });

  describe("必須章節が網羅されている", () => {
    const content = readFileSync(RUNBOOK_PATH, "utf8");

    it.each([
      ["目的", "## 目的"],
      ["適用範囲", "## 適用範囲"],
      ["事前条件", "## 事前条件 (Pre-flight)"],
      ["7 ステップ カットオーバー手順", "## 7 ステップ カットオーバー手順"],
      ["Step 1 SagemakerStack deploy", "### Step 1 — 新 `SagemakerStack`"],
      ["Step 2 smoke PoC", "### Step 2 — smoke PoC"],
      ["Step 3 BatchExecutionStack", "### Step 3 — `BatchExecutionStack`"],
      ["Step 4 MonitoringStack", "### Step 4 — `MonitoringStack`"],
      ["Step 5 ApiStack", "### Step 5 — `ApiStack`"],
      ["Step 6 旧 Endpoint 削除", "### Step 6 — 旧 Realtime Endpoint を削除"],
      [
        "Step 7 旧 EndpointConfig 削除",
        "### Step 7 — 旧 EndpointConfig を削除",
      ],
      ["503 運用", "## カットオーバー中の `/batches` 503 運用"],
      [
        "退避 region 判定",
        "## 退避用リージョン (`us-east-1`) への切替判定基準",
      ],
      ["月次コスト実測", "## 月次コスト実測記録テンプレ"],
      ["トラブルシュート", "## トラブルシュート"],
      ["参照", "## 参照"],
      ["ロールバック可否", "## ロールバック可否サマリ"],
    ])("%s セクションが存在する", (_label, heading) => {
      expect(content).toContain(heading);
    });
  });

  describe("必須キーワード・検証コマンドが含まれる", () => {
    const content = readFileSync(RUNBOOK_PATH, "utf8");

    it("in-flight バッチ 0 確認の DynamoDB 検索コマンドが記載されている", () => {
      // GSI1PK は月パーティション化されているため単月 query で見逃しが
      // 発生する恐れがある。Pre-flight/Step 6 では META 行を scan で横断
      // 検索し RUNNING / PENDING 両方を同時にカウントする運用とした。
      expect(content).toContain("dynamodb scan");
      expect(content).toContain("RUNNING");
      expect(content).toContain("PENDING");
      expect(content).toContain("SK = :meta");
    });

    it("smoke PoC 成功基準 (SuccessQueue, ApproximateAgeOfOldestRequest) が記載されている", () => {
      expect(content).toContain("SuccessQueue");
      expect(content).toContain("ApproximateAgeOfOldestRequest");
    });

    it("cdk deploy SagemakerStack / BatchExecutionStack / MonitoringStack / ApiStack の各コマンドが記載されている", () => {
      expect(content).toContain("cdk deploy SagemakerStack");
      expect(content).toContain("cdk deploy BatchExecutionStack");
      expect(content).toContain("cdk deploy MonitoringStack");
      expect(content).toContain("cdk deploy ApiStack");
    });

    it("旧 Endpoint / EndpointConfig 削除用 AWS CLI が記載されている", () => {
      expect(content).toContain("delete-endpoint-config");
      expect(content).toContain("ResourceNotFound");
    });

    it("退避判定基準 (95%, 1 週間 3 回) と退避コマンドが記載されている", () => {
      expect(content).toMatch(/95\s*%/);
      expect(content).toContain("1 週間に 3 回");
      expect(content).toContain("region=us-east-1");
    });

    it("月次コスト乖離 20% 超過時の是正手順 (MaxCapacity, InvocationTimeoutSeconds, バッチ集約) が記載されている", () => {
      expect(content).toContain("20%");
      expect(content).toContain("MaxCapacity");
      expect(content).toContain("InvocationTimeoutSeconds");
    });

    it("トラブルシュート 3 項目 (S3 出力が来ない / HasBacklogWithoutCapacity / scale-out 遅延) が記載されている", () => {
      expect(content).toContain("S3 出力が来ない");
      expect(content).toContain("HasBacklogWithoutCapacity");
      expect(content).toContain("scale-out");
    });

    it("ロールバック不能 (Step 3 以降) が明記されている", () => {
      expect(content).toMatch(/ロールバック不能|不可/);
      expect(content).toContain("Step 3");
    });

    it("design.md への参照 (Realtime → Async 選定理由) がある", () => {
      expect(content).toContain("design.md");
    });

    it("ap-northeast-1 が既定リージョンとして明記されている", () => {
      expect(content).toContain("ap-northeast-1");
    });
  });
});
