import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // ``globals`` は既定の false のまま運用する。``describe`` / ``it`` /
    // ``expect`` / ``beforeAll`` 等は各 test ファイルで ``vitest`` から明示
    // import する方針で ``lambda/api`` 側と統一している。
  },
});
