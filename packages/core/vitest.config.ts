import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['../test-guard/src/setup.ts', '../db/test/support/bind-test-env.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // test/pg/** shares one throwaway Postgres database (provisioned by
    // ./test/globalSetup.ts) across two seeded tenant accounts per file;
    // running files in parallel would race the schema migration and
    // those seeded accounts (see packages/db/vitest.config.ts).
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
