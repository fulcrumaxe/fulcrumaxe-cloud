import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["../test-guard/src/setup.ts", "../db/test/support/bind-test-env.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // The [pg] tests share one throwaway database (test/globalSetup.ts); files must not run in parallel.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    restoreMocks: true,
  },
});
