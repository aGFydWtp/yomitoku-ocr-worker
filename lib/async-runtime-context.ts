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
  /**
   * Application Auto Scaling MaxCapacity (MinCapacity=0)。
   *
   * **本値を 2 以上に変更すると `async-endpoint-scale-in-protection` spec の
   * math 式前提 (`FILL(m1, 0) + IF(FILL(m2, 0) > 0, 5, 0)` を per-instance
   * utilization と等価とみなす) が崩れるため、当該 spec の TargetTracking
   * ポリシーおよび scale-in 抑止ロジックを per-instance 化された設計へ
   * 再設計する必要がある** (要件 4.2 / design.md "Revalidation Triggers")。
   *
   * 引き上げを伴う変更時は `.kiro/specs/async-endpoint-scale-in-protection/`
   * の design / tests を再評価し、`batch-scale-out` spec 等で per-instance
   * scale-in 保護を再設計してから合わせて変更すること。
   */
  readonly asyncMaxCapacity: number;
  readonly maxConcurrentInvocationsPerInstance: number;
  readonly invocationTimeoutSeconds: number;
  readonly scaleInCooldownSeconds: number;
}

export const DEFAULT_ASYNC_RUNTIME_CONTEXT: AsyncRuntimeContext = {
  // NOTE: 1 固定前提。2 以上に上げる場合は
  // `async-endpoint-scale-in-protection` spec のポリシー再設計が必要
  // (要件 4.2 / 上記 interface のコメント参照)。
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
