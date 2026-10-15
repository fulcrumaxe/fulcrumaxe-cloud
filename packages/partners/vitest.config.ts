import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The same throwaway-Postgres setup as packages/core (provide/inject, D#56); test/pg/** is the only part that uses it.
    globalSetup: ["../core/test/globalSetup.ts"],
    setupFiles: ["../test-guard/src/setup.ts", "../db/test/support/bind-test-env.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // test/pg/** shares one throwaway Postgres database (provisioned by core's globalSetup); running files in parallel would
    // race on it (see packages/db/vitest.config.ts).
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // A later row may add a feature folder before it has tests; an empty suite must still exit 0.
    passWithNoTests: true,
  },
});
