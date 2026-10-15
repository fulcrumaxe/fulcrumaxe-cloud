import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["../../packages/test-guard/src/setup.ts", "./test/support/bindEnv.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // One throwaway Postgres for the whole run; the built-output test runs a real `next build`.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
