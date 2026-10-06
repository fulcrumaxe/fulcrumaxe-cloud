import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['../test-guard/src/setup.ts', './test/support/bind-test-env.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // All test files share one throwaway Postgres database (spun up by
    // ./test/globalSetup.ts); running files in parallel would race the
    // schema migration and the two seeded tenant accounts.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
