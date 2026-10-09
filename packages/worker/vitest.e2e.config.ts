import { defineConfig } from "vitest/config";

/**
 * D#6 R4d-6: the config of `pnpm test:e2e-runner`, which runs only packages/worker/test/e2e (the end-to-end runner test) and is what the CI job
 * `e2e-runner` runs. vitest.config.ts leaves that folder out of the ordinary run, so it runs once per CI run. Everything else matches that file: the same
 * throwaway Postgres, the same model-call guard and database bindings, one process, files one after another. The folder has its own tsconfig.json.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["../test-guard/src/setup.ts", "../db/test/support/bind-test-env.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
