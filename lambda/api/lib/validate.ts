import { ValidationError } from "./errors";

const STATE_MACHINE_ARN_RE =
  /^arn:aws[\w-]*:states:[a-z0-9-]+:\d{12}:stateMachine:.+$/;

/**
 * STATE_MACHINE_ARN のフォーマットを検証する。
 * 不正な場合は Error を throw する。
 */
export function assertValidStateMachineArn(arn: string): void {
  if (!STATE_MACHINE_ARN_RE.test(arn)) {
    throw new Error(`Invalid STATE_MACHINE_ARN format: ${arn}`);
  }
}

/**
 * basePath をトリム・検証し、正規化された文字列を返す。
 * null/undefined の場合は undefined を返す。
 */
export function validateBasePath(
  rawBasePath: string | null | undefined,
): string | undefined {
  if (rawBasePath == null) {
    return undefined;
  }

  const trimmed = rawBasePath.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    throw new ValidationError("basePath must not be empty");
  }
  if (!/^[a-zA-Z0-9\u3000-\u9FFF\u{20000}-\u{2FA1F}\-_./]+$/u.test(trimmed)) {
    throw new ValidationError("basePath contains invalid characters");
  }
  if (/(^|\/)\.\.($|\/)/.test(trimmed)) {
    throw new ValidationError("basePath must not contain path traversal (..)");
  }
  if (Buffer.byteLength(trimmed, "utf8") > 512) {
    throw new ValidationError("basePath is too long");
  }
  return trimmed;
}

/** BatchTable GSI1 クエリの LastEvaluatedKey に現れるキー */
const BATCH_GSI1_CURSOR_KEYS = new Set(["PK", "SK", "GSI1PK", "GSI1SK"]);

/**
 * BatchTable GSI1 クエリ用のカーソルをデコード・検証する。
 * base64url エンコードされた JSON を DynamoDB の ExclusiveStartKey として返す。
 */
export function decodeBatchCursor(
  cursorParam: string | undefined,
): Record<string, unknown> | undefined {
  if (!cursorParam) return undefined;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursorParam, "base64url").toString("utf8"),
    );
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded)
    ) {
      throw new Error("not an object");
    }
    const keys = Object.keys(decoded as Record<string, unknown>);
    if (keys.length === 0 || keys.some((k) => !BATCH_GSI1_CURSOR_KEYS.has(k))) {
      throw new Error("invalid keys");
    }
    return decoded as Record<string, unknown>;
  } catch {
    throw new ValidationError("cursor is invalid");
  }
}

/**
 * DynamoDB の LastEvaluatedKey を base64url エンコードしたカーソル文字列に変換する。
 */
export function encodeBatchCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}
