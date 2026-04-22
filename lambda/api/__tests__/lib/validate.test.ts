import { describe, expect, it } from "vitest";
import {
  decodeBatchCursor,
  encodeBatchCursor,
  validateBasePath,
} from "../../lib/validate";

describe("decodeBatchCursor (M2)", () => {
  const VALID_KEY = {
    PK: "BATCH#abc",
    SK: "META",
    GSI1PK: "STATUS#COMPLETED#202604",
    GSI1SK: "CREATED_AT#2026-04-01T00:00:00.000Z",
  };

  it("undefined/空文字は undefined を返す", () => {
    expect(decodeBatchCursor(undefined)).toBeUndefined();
    expect(decodeBatchCursor("")).toBeUndefined();
  });

  it("正しい base64url JSON はデコードされる", () => {
    const cursor = encodeBatchCursor(VALID_KEY);
    expect(decodeBatchCursor(cursor)).toEqual(VALID_KEY);
  });

  it("不正な base64url は ValidationError", () => {
    expect(() => decodeBatchCursor("@@@not_base64@@@")).toThrow(
      "cursor is invalid",
    );
  });

  it("オブジェクト以外 (array/primitive) は ValidationError", () => {
    const arrCursor = Buffer.from(JSON.stringify([1, 2, 3])).toString(
      "base64url",
    );
    expect(() => decodeBatchCursor(arrCursor)).toThrow("cursor is invalid");
    const strCursor = Buffer.from(JSON.stringify("oops")).toString("base64url");
    expect(() => decodeBatchCursor(strCursor)).toThrow("cursor is invalid");
  });

  it("ホワイトリスト外のキーを含むと ValidationError", () => {
    const bad = Buffer.from(
      JSON.stringify({ ...VALID_KEY, evil: "payload" }),
    ).toString("base64url");
    expect(() => decodeBatchCursor(bad)).toThrow("cursor is invalid");
  });

  it("空オブジェクトは ValidationError", () => {
    const empty = Buffer.from("{}").toString("base64url");
    expect(() => decodeBatchCursor(empty)).toThrow("cursor is invalid");
  });

  it("値が文字列でない (DDB 生 AttributeValue 形式等) 場合は ValidationError (M2)", () => {
    const raw = Buffer.from(
      JSON.stringify({ PK: { S: "BATCH#abc" }, SK: { S: "META" } }),
    ).toString("base64url");
    expect(() => decodeBatchCursor(raw)).toThrow("cursor is invalid");

    const numeric = Buffer.from(
      JSON.stringify({ PK: 123, SK: "META" }),
    ).toString("base64url");
    expect(() => decodeBatchCursor(numeric)).toThrow("cursor is invalid");
  });

  it("空文字値は ValidationError (M2)", () => {
    const empty = Buffer.from(JSON.stringify({ PK: "", SK: "META" })).toString(
      "base64url",
    );
    expect(() => decodeBatchCursor(empty)).toThrow("cursor is invalid");
  });

  it("1024 バイトを超える値は ValidationError (M2)", () => {
    const huge = "x".repeat(1025);
    const oversized = Buffer.from(
      JSON.stringify({ PK: huge, SK: "META" }),
    ).toString("base64url");
    expect(() => decodeBatchCursor(oversized)).toThrow("cursor is invalid");
  });
});

describe("validateBasePath", () => {
  it("undefined/null はそのまま undefined を返す", () => {
    expect(validateBasePath(undefined)).toBeUndefined();
    expect(validateBasePath(null)).toBeUndefined();
  });

  it("先頭・末尾のスラッシュをトリムする", () => {
    expect(validateBasePath("/foo/bar/")).toBe("foo/bar");
    expect(validateBasePath("///a/b///")).toBe("a/b");
  });

  it("空文字はエラー", () => {
    expect(() => validateBasePath("")).toThrow("basePath must not be empty");
    expect(() => validateBasePath("///")).toThrow("basePath must not be empty");
  });

  it("`..` セグメントを拒否する", () => {
    expect(() => validateBasePath("foo/../bar")).toThrow(
      "basePath must not contain path segments",
    );
    expect(() => validateBasePath("../evil")).toThrow();
    expect(() => validateBasePath("foo/..")).toThrow();
  });

  it("単独 `.` セグメントを拒否する (M4)", () => {
    expect(() => validateBasePath("foo/./bar")).toThrow(
      "basePath must not contain path segments",
    );
    expect(() => validateBasePath("./foo")).toThrow();
    expect(() => validateBasePath("foo/.")).toThrow();
  });

  it("拡張子ドットは許可する (先頭/中間/末尾セグメント単独でない)", () => {
    expect(validateBasePath("foo.txt")).toBe("foo.txt");
    expect(validateBasePath("docs/v1.2/readme.md")).toBe("docs/v1.2/readme.md");
  });

  it("許可外文字はエラー", () => {
    expect(() => validateBasePath("foo bar")).toThrow(
      "basePath contains invalid characters",
    );
    expect(() => validateBasePath("foo<script>")).toThrow();
  });

  it("日本語 (CJK) は許可する", () => {
    expect(validateBasePath("資料/2026年")).toBe("資料/2026年");
  });
});
