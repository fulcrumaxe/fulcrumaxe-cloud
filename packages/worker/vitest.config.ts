import { defineConfig } from "vitest/config";

/**
 * Most tests use fake pools and a fake sandbox SDK. `*.pg.test.ts` runs the
 * run-action facade against a throwaway Postgres (test/globalSetup.ts), so the
 * files share one database and must not run in parallel.
 */
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
