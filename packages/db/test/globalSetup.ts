import type { GlobalSetupContext } from 'vitest/node';
import { createPool } from '../src/pool.js';
import { runMigrations } from '../src/migrate.js';
import { provisionEphemeralPostgres, type TestDbEnv } from './support/ephemeral-pg.js';
import { createRunWriterTestLogin, runWriterUrlFrom } from './support/run-writer-login.js';

/**
 * Runs once for the whole vitest process, before any test file. Test files
 * assume migrations are already applied and just open their own pools --
 * running this per-file instead would race multiple files against the same
 * database (see vitest.config.ts's fileParallelism note too).
 *
 * D#56: this used to write `process.env.DATABASE_URL*` directly. With
 * `vitest.workspace.ts` running every project's globalSetup in one
 * orchestrator process, `process.env` is that process's single shared
 * object -- another project's globalSetup writing the SAME bare name (or
 * this project's own value being read by a worker forked at the wrong
 * moment) meant one project's tests could end up talking to another
 * project's database. Provisioning now goes through the shared
 * ephemeral-pg.ts helper (also OS-assigned free ports, not a pseudo-random
 * offset), and the result is handed to THIS project only
 * via `provide()` -- bind-test-env.ts (a setupFiles entry) puts it back
 * into `process.env` inside this project's own worker fork, where nothing
 * else can overwrite it. Existing test files keep reading
 * `process.env.DATABASE_URL*` completely unchanged.
 *
 * If `DATABASE_URL_TEST` is set, that database is used as-is (a
 * developer's own Postgres, or CI-provided) -- `DATABASE_URL_APP_USER`,
 * `DATABASE_URL_PLATFORM_OPS` and `DATABASE_URL_PARTNER_USER` must also be
 * set in that case, same host/port/db, connecting as role app_user /
 * platform_ops / partner_user respectively (the third added by D#2607 P01).
 * Otherwise an ephemeral cluster is provisioned and torn down afterward.
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  let url: string;
  let testDbEnv: TestDbEnv;
  let cleanup: (() => void) | undefined;

  if (process.env.DATABASE_URL_TEST) {
    url = process.env.DATABASE_URL_TEST;
    const appUserUrl = process.env.DATABASE_URL_APP_USER;
    const platformOpsUrl = process.env.DATABASE_URL_PLATFORM_OPS;
    const partnerUserUrl = process.env.DATABASE_URL_PARTNER_USER;
    if (!appUserUrl || !platformOpsUrl || !partnerUserUrl) {
      throw new Error(
        'DATABASE_URL_APP_USER, DATABASE_URL_PLATFORM_OPS and DATABASE_URL_PARTNER_USER must all be set alongside DATABASE_URL_TEST.',
      );
    }
    testDbEnv = { prefix: '', url, appUserUrl, platformOpsUrl, partnerUserUrl };
  } else {
    const provisioned = await provisionEphemeralPostgres({
      database: 'fx_db_test',
      tmpPrefix: 'fx-db-pg-',
    });
    url = provisioned.url;
    cleanup = provisioned.cleanup;
    testDbEnv = {
      prefix: '',
      url: provisioned.url,
      appUserUrl: provisioned.appUserUrl,
      platformOpsUrl: provisioned.platformOpsUrl,
      partnerUserUrl: provisioned.partnerUserUrl,
    };
  }

  const pool = createPool(url);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }

  // D#2 H09c: a LOGIN that is a member of app_user AND agent_run_writer,
  // for the tests that call the agent_runs writer functions. Needs the
  // role 0642 creates, so it runs after runMigrations.
  await createRunWriterTestLogin(url);
  testDbEnv.runWriterUrl = process.env.DATABASE_URL_RUN_WRITER ?? runWriterUrlFrom(testDbEnv.appUserUrl);

  provide('testDbEnv', testDbEnv);

  return async () => {
    cleanup?.();
  };
}
