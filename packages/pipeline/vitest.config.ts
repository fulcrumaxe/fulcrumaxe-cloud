import { defineConfig } from "vitest/config";

/**
 * D#2 H14a: mirrors packages/runner/vitest.config.ts exactly (same D#56
 * provide/inject globalSetup pattern, same `PIPELINE_`-prefixed env var
 * namespace and own throwaway cluster). `fileParallelism: false` + a
 * single forked worker: every [pg] file here shares one throwaway
 * database, so they must not run concurrently against it.
 */
export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["../test-guard/src/setup.ts", "../db/test/support/bind-test-env.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
