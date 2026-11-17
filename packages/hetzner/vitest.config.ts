import { defineConfig } from "vitest/config";

/** No Postgres, no network: every test talks to the strict local Hetzner fake over real TLS. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["../test-guard/src/setup.ts"],
  },
});
