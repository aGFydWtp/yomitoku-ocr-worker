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
 * batchLabel をトリム・検証し、正規化された文字列を返す。
 * null/undefined の場合は undefined を返す (optional フィールド)。
 * 明示的に空文字 / "//" 等が渡された場合は malformed input として throw する。
 *
 * 履歴: 旧 API では ``basePath`` 必須フィールドだった (S3 キー prefix として
 * 使う設計)。バッチ移行で ``batches/{batchJobId}/...`` レイアウトに統一した
 * 結果、現在は「人間可読なバッチラベル」としての任意フィールドに降格した。
 * path traversal / 無効文字 / 長さの防御は過剰防衛として残す (将来 key
 * prefix 用途に昇格しても安全なように)。
 */
export function validateBatchLabel(
  rawLabel: string | null | undefined,
): string | undefined {
  if (rawLabel == null) {
    return undefined;
  }

  const trimmed = rawLabel.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    throw new ValidationError("batchLabel must not be empty");
  }
  if (!/^[a-zA-Z0-9\u3000-\u9FFF\u{20000}-\u{2FA1F}\-_./]+$/u.test(trimmed)) {
    throw new ValidationError("batchLabel contains invalid characters");
  }
  // `..` / `.` をパスセグメントとして含めることを禁止する (M4)。
  // 単独の `.` はカレントディレクトリ参照として S3 キーの意味を変え得るため弾く。
  if (/(^|\/)\.{1,2}($|\/)/.test(trimmed)) {
    throw new ValidationError(
      "batchLabel must not contain path segments '.' or '..'",
    );
  }
  if (Buffer.byteLength(trimmed, "utf8") > 512) {
    throw new ValidationError("batchLabel is too long");
  }
  return trimmed;
}

/** BatchTable GSI1 クエリの LastEvaluatedKey に現れるキー */
const BATCH_GSI1_CURSOR_KEYS = new Set(["PK", "SK", "GSI1PK", "GSI1SK"]);
/** 1 つの cursor 値の最大バイト数 (DDB キー 1024 バイト制限に合わせる) */
const CURSOR_VALUE_MAX_BYTES = 1024;

/**
 * BatchTable GSI1 クエリ用のカーソルをデコード・検証する。
 * base64url エンコードされた JSON を DynamoDB の ExclusiveStartKey として返す。
 *
 * 攻撃者が任意の JSON を差し込むのを防ぐため、キーのホワイトリストに加えて
 * 値の型 (非空文字列) とバイト長も厳しく検証する (M2)。
 * DocumentClient が自動マーシャルする都合で値はプレーンな文字列である必要がある。
 */
export function decodeBatchCursor(
  cursorParam: string | undefined,
): Record<string, string> | undefined {
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
    const entries = Object.entries(decoded as Record<string, unknown>);
    if (entries.length === 0) {
      throw new Error("empty cursor");
    }
    const result: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (!BATCH_GSI1_CURSOR_KEYS.has(k)) {
        throw new Error(`invalid key: ${k}`);
      }
      if (typeof v !== "string" || v.length === 0) {
        throw new Error(`non-string or empty value for key: ${k}`);
      }
      if (Buffer.byteLength(v, "utf8") > CURSOR_VALUE_MAX_BYTES) {
        throw new Error(`value too long for key: ${k}`);
      }
      result[k] = v;
    }
    return result;
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
