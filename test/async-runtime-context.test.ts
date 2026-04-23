/**
 * Task 1.1: Async 運用パラメータの context 解決テスト
 *
 * - `cdk.json` に 4 つの既定値が存在する
 * - `resolveAsyncRuntimeContext` が既定値を返す
 * - context override (`--context key=value` 相当) を反映する
 * - 異常値 (非整数・0 以下) をエラーにする
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib/core";
import {
  DEFAULT_ASYNC_RUNTIME_CONTEXT,
  resolveAsyncRuntimeContext,
} from "../lib/async-runtime-context";

describe("cdk.json Async runtime defaults", () => {
  const cdkJson = JSON.parse(
    readFileSync(resolve(__dirname, "../cdk.json"), "utf8"),
  ) as { context: Record<string, unknown> };

  it("asyncMaxCapacity 既定値が 1", () => {
    expect(cdkJson.context.asyncMaxCapacity).toBe(1);
  });
  it("maxConcurrentInvocationsPerInstance 既定値が 4", () => {
    expect(cdkJson.context.maxConcurrentInvocationsPerInstance).toBe(4);
  });
  it("invocationTimeoutSeconds 既定値が 3600", () => {
    expect(cdkJson.context.invocationTimeoutSeconds).toBe(3600);
  });
  it("scaleInCooldownSeconds 既定値が 900", () => {
    expect(cdkJson.context.scaleInCooldownSeconds).toBe(900);
  });
});

describe("resolveAsyncRuntimeContext", () => {
  it("context 未指定時は既定値を返す", () => {
    const app = new App();
    const ctx = resolveAsyncRuntimeContext(app.node);
    expect(ctx).toEqual(DEFAULT_ASYNC_RUNTIME_CONTEXT);
    expect(ctx.asyncMaxCapacity).toBe(1);
    expect(ctx.maxConcurrentInvocationsPerInstance).toBe(4);
    expect(ctx.invocationTimeoutSeconds).toBe(3600);
    expect(ctx.scaleInCooldownSeconds).toBe(900);
  });

  it("asyncMaxCapacity override (number) が反映される", () => {
    const app = new App({ context: { asyncMaxCapacity: 3 } });
    const ctx = resolveAsyncRuntimeContext(app.node);
    expect(ctx.asyncMaxCapacity).toBe(3);
  });

  it("maxConcurrentInvocationsPerInstance override が反映される", () => {
    const app = new App({
      context: { maxConcurrentInvocationsPerInstance: 8 },
    });
    const ctx = resolveAsyncRuntimeContext(app.node);
    expect(ctx.maxConcurrentInvocationsPerInstance).toBe(8);
  });

  it("CLI 由来の文字列値 (`--context key=value`) を数値として解釈する", () => {
    const app = new App({
      context: {
        asyncMaxCapacity: "2",
        invocationTimeoutSeconds: "1800",
      },
    });
    const ctx = resolveAsyncRuntimeContext(app.node);
    expect(ctx.asyncMaxCapacity).toBe(2);
    expect(ctx.invocationTimeoutSeconds).toBe(1800);
  });

  it("非整数値は即座にエラーにする", () => {
    const app = new App({ context: { asyncMaxCapacity: "abc" } });
    expect(() => resolveAsyncRuntimeContext(app.node)).toThrow(
      /asyncMaxCapacity/,
    );
  });

  it("0 以下の値は即座にエラーにする", () => {
    const app = new App({ context: { scaleInCooldownSeconds: 0 } });
    expect(() => resolveAsyncRuntimeContext(app.node)).toThrow(
      /scaleInCooldownSeconds/,
    );
  });

  it("負の値は即座にエラーにする", () => {
    const app = new App({ context: { invocationTimeoutSeconds: -1 } });
    expect(() => resolveAsyncRuntimeContext(app.node)).toThrow(
      /invocationTimeoutSeconds/,
    );
  });
});
