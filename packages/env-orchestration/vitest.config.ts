import { defineConfig } from "vitest/config";

/** No Postgres, no network: every effect is a fake port. Guard wired in like every project. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["../test-guard/src/setup.ts"],
  },
});
