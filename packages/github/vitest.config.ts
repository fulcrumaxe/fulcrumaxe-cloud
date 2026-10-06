import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['../test-guard/src/setup.ts', '../db/test/support/bind-test-env.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Same reasoning as packages/core/vitest.config.ts and
    // packages/billing/vitest.config.ts: test/eventMapper.pg.test.ts shares
    // one throwaway Postgres database (provisioned by ./test/globalSetup.ts)
    // -- running test files in parallel would race the schema migration.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
