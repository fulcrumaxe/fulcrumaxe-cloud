import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['../test-guard/src/setup.ts', '../db/test/support/bind-test-env.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // The TOCTOU test (test/toctou.test.ts) deliberately holds a real
    // Postgres row lock open across a concurrent write from a second
    // connection -- running test FILES in parallel would let an unrelated
    // file's fixtures interleave on the same shared database while that
    // lock is held. Same rationale as packages/db and packages/spend.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
