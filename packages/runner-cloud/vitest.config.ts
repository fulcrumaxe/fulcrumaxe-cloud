import { defineConfig } from "vitest/config";

// The [pg] tests share one throwaway Postgres (test/globalSetup.ts), so files run one at a time.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["../test-guard/src/setup.ts", "../db/test/support/bind-test-env.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
