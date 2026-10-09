import { configDefaults, defineConfig } from "vitest/config";

/**
 * Most tests use fake pools and a fake sandbox SDK. `*.pg.test.ts` runs the
 * run-action facade against a throwaway Postgres (test/globalSetup.ts), so the
 * files share one database and must not run in parallel.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // D#6 R4d-6: the end-to-end runner test has its own CI job (`pnpm test:e2e-runner`, which uses vitest.e2e.config.ts) and runs a real mirror, a real agent process
    // and three loopback servers, so it is left out of the ordinary run to keep one run of it per CI run, not two. Its own tsconfig is test/e2e/tsconfig.json.
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["../test-guard/src/setup.ts", "../db/test/support/bind-test-env.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
