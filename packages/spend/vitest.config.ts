import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['../test-guard/src/setup.ts', '../db/test/support/bind-test-env.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Every test file shares one throwaway Postgres database (spun up by
    // ./test/globalSetup.ts). The concurrency test (reserve-concurrency)
    // deliberately races many connections against ONE seeded account from
    // inside a single file -- running test FILES in parallel on top of
    // that would let two files' fixtures interleave on the same database
    // with no isolation between them.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
