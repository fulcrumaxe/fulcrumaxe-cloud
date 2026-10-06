import { defineConfig } from "vitest/config";

/** Pure data: no Postgres, no network. Guard wired in like every project. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["../test-guard/src/setup.ts"],
  },
});
