import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['../test-guard/src/setup.ts', '../db/test/support/bind-test-env.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Several test files here mutate the shared routing_tables/routing_rows
    // state (route.live.pg.test.ts, proposal.pg.test.ts) against one
    // Postgres instance -- same rationale as packages/model-connection and
    // packages/spend: running test FILES in parallel would let one file's
    // fixture interleave with another's assertions on the same rows.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
