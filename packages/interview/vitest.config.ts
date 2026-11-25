import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['../test-guard/src/setup.ts', '../db/test/support/bind-test-env.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Files share one migrated database; the concurrency tests hold row locks across a second connection.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
