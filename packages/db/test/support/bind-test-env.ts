import { inject } from 'vitest';
import type {} from './ephemeral-pg.js';

/**
 * D#56 worker-side half of the fix: a `setupFiles` entry (added to every
 * DB-backed project's `vitest.config.ts`, next to the test-guard entry)
 * that runs inside THIS project's own forked worker and sets
 * `process.env.DATABASE_URL*` (or `SPEND_DATABASE_URL*` for packages/spend)
 * from the value its own globalSetup `provide()`d.
 *
 * This is what lets ~30 existing test files under packages/*\/test keep
 * reading `process.env.DATABASE_URL*` completely unchanged: each project
 * uses `pool: 'forks'`, so a worker's `process.env` belongs to that worker
 * alone -- setting it here, inside the fork, can't be raced or overwritten
 * by another project's globalSetup the way writing it in globalSetup itself
 * (inside the shared orchestrator process) could be.
 */
const env = inject('testDbEnv');

process.env[`${env.prefix}DATABASE_URL`] = env.url;
process.env[`${env.prefix}DATABASE_URL_APP_USER`] = env.appUserUrl;
process.env[`${env.prefix}DATABASE_URL_PLATFORM_OPS`] = env.platformOpsUrl;
if (env.runWriterUrl) {
  process.env[`${env.prefix}DATABASE_URL_RUN_WRITER`] = env.runWriterUrl;
}
if (env.partnerUserUrl) {
  process.env[`${env.prefix}DATABASE_URL_PARTNER_USER`] = env.partnerUserUrl;
}
