import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["../test-guard/src/setup.ts", "../db/test/support/bind-test-env.ts"],
    // The commit-order settle window (sse/poller.ts) holds fresh events back in production; the suites
    // insert-then-read immediately, so they run with it off. The tests that exercise the hold-back pass
    // `settleMs` explicitly.
    env: { FX_EVENTS_SETTLE_MS: "0" },
    testTimeout: 20000,
    hookTimeout: 20000,
    // Every test file shares one throwaway Postgres database (provisioned
    // by ./test/globalSetup.ts); running files in parallel would race the
    // schema migration.
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
