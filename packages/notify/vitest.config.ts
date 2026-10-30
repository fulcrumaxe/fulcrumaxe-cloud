import { defineConfig } from "vitest/config";

/** No Postgres here: the transport, the text and the config are pure or run against the strict local Resend fake. The database-backed notifyAsks tests live in packages/worker/test. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["../test-guard/src/setup.ts"],
  },
});
