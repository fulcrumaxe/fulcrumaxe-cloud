import { defineConfig } from "vitest/config";

/**
 * D#71 DS-2: mirrors packages/pipeline/vitest.config.ts exactly (same
 * D#56 provide/inject globalSetup pattern, own throwaway cluster under
 * the `DISCUSSIONS_` prefix). `fileParallelism: false` + a single forked
 * worker: every [pg] file here shares one throwaway database.
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
