import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['../test-guard/src/setup.ts', '../db/test/support/bind-test-env.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // The claim/SKIP LOCKED concurrency test (test/sweep.test.ts) shares
    // one throwaway Postgres database across the whole file and asserts on
    // exact row counts/claims -- running test FILES in parallel would let
    // an unrelated file's fixtures interleave against the same database.
    // Same rationale as packages/db, packages/spend and
    // packages/model-connection.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
