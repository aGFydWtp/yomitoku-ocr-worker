import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    environment: "node",
    // ルート ``vitest.config.ts`` と同じく ``globals: false`` で明示 import
    // 派に統一する。``pnpm --filter yomitoku-api test`` をサブディレクトリ
    // から実行した際、vitest が親ディレクトリの config を拾って
    // ``test/**/*.test.ts`` を検索してしまうのを明示的に抑止する目的もある。
  },
});
