import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Jest 互換のグローバル (describe/it/expect/beforeAll/...) を有効化し、
    // 既存の test/*.test.ts を import 追加なしに動作させる。
    // `lambda/api` 側は明示 import 派 (vitest.config.ts で globals=false) で
    // 運用方針が分かれているが、ルート (CDK stack テスト) は歴史的に Jest
    // global 前提で書かれていたためそれに合わせる。
    globals: true,
  },
});
