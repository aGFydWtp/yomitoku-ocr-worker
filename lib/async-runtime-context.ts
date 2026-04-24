import type { Node } from "constructs";

/**
 * SageMaker Asynchronous Inference 運用パラメータ。
 *
 * すべてのスタック (SagemakerStack / BatchExecutionStack / MonitoringStack) が
 * 同一の値を参照する必要があるため、app レベル (`bin/app.ts`) で一度だけ
 * 解決し、各スタックに typed props として伝搬する。
 *
 * 既定値は設計書 (design.md §3 / tasks.md 1.1) に基づく:
 *   - `asyncMaxCapacity = 1`                  : Application Auto Scaling MaxCapacity (MinCapacity=0)
 *   - `maxConcurrentInvocationsPerInstance=4` : Async Endpoint の同時呼び出し上限 (context から注入)
 *   - `invocationTimeoutSeconds = 3600`       : `AsyncInferenceConfig.ClientConfig.InvocationTimeoutSeconds`
 *   - `scaleInCooldownSeconds = 900`          : TargetTracking の ScaleInCooldown
 */
export interface AsyncRuntimeContext {
  readonly asyncMaxCapacity: number;
  readonly maxConcurrentInvocationsPerInstance: number;
  readonly invocationTimeoutSeconds: number;
  readonly scaleInCooldownSeconds: number;
}

export const DEFAULT_ASYNC_RUNTIME_CONTEXT: AsyncRuntimeContext = {
  asyncMaxCapacity: 1,
  maxConcurrentInvocationsPerInstance: 4,
  invocationTimeoutSeconds: 3600,
  scaleInCooldownSeconds: 900,
};

/**
 * `AsyncRuntimeContext` を CDK の context から解決する。
 *
 * `cdk.json` / `cdk.context.json` / `--context key=value` の順に
 * 上書きされた値を読み取り、未指定のキーには `DEFAULT_ASYNC_RUNTIME_CONTEXT`
 * の値を適用する。CLI 由来の値は文字列として渡るため、整数化と範囲検証を
 * 合わせて実施する。
 */
export function resolveAsyncRuntimeContext(node: Node): AsyncRuntimeContext {
  return {
    asyncMaxCapacity: readPositiveInt(
      node,
      "asyncMaxCapacity",
      DEFAULT_ASYNC_RUNTIME_CONTEXT.asyncMaxCapacity,
    ),
    maxConcurrentInvocationsPerInstance: readPositiveInt(
      node,
      "maxConcurrentInvocationsPerInstance",
      DEFAULT_ASYNC_RUNTIME_CONTEXT.maxConcurrentInvocationsPerInstance,
    ),
    invocationTimeoutSeconds: readPositiveInt(
      node,
      "invocationTimeoutSeconds",
      DEFAULT_ASYNC_RUNTIME_CONTEXT.invocationTimeoutSeconds,
    ),
    scaleInCooldownSeconds: readPositiveInt(
      node,
      "scaleInCooldownSeconds",
      DEFAULT_ASYNC_RUNTIME_CONTEXT.scaleInCooldownSeconds,
    ),
  };
}

function readPositiveInt(node: Node, key: string, fallback: number): number {
  const raw = node.tryGetContext(key);
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Context '${key}' must be a positive integer, got: ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}
