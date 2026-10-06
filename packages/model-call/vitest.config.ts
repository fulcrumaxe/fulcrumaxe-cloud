import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Reuses model-connection's ephemeral-Postgres bootstrap (D#56): this package only needs the same migrated schema.
    globalSetup: ['../model-connection/test/globalSetup.ts'],
    setupFiles: ['../test-guard/src/setup.ts', '../db/test/support/bind-test-env.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
