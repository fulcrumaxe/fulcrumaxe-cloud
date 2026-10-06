import { defineConfig } from "vitest/config";

/**
 * H09b1 adds the first Postgres-backed tests here -- `globalSetup`/
 * `bind-test-env.ts` follow the same D#56 provide/inject pattern
 * packages/spend and packages/core use, with `RUNNER_`-prefixed env var
 * names (own namespace, own throwaway cluster). `fileParallelism: false`
 * + a single forked worker: every [pg] file shares one throwaway
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
