import { App } from "aws-cdk-lib/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_REGION, resolveRegionContext } from "../lib/region-context";

describe("resolveRegionContext (Task 8.1, Req 8.1/8.4)", () => {
  it("context 未指定時は既定 ap-northeast-1 を返す", () => {
    const app = new App();
    expect(resolveRegionContext(app.node)).toBe("ap-northeast-1");
    expect(DEFAULT_REGION).toBe("ap-northeast-1");
  });

  it("`-c region=us-east-1` (退避用オプション) を受け入れる", () => {
    const app = new App({ context: { region: "us-east-1" } });
    expect(resolveRegionContext(app.node)).toBe("us-east-1");
  });

  it("不正な region 形式は Error を throw する", () => {
    const app = new App({ context: { region: "not-a-region" } });
    expect(() => resolveRegionContext(app.node)).toThrow(
      /Invalid AWS region format/,
    );
  });
});
