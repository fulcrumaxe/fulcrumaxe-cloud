import type { GlobalSetupContext } from 'vitest/node';
import { createPool } from '@fx/db/src/pool.js';
import { runMigrations } from '@fx/db/src/migrate.js';
import { provisionEphemeralPostgres, type TestDbEnv } from '@fx/db/test/support/ephemeral-pg.js';

/**
 * Runs once for the whole vitest process, before any test file (test/unit/**
 * doesn't touch the database at all, but shares this config/process with
 * test/pg/**, which does).
 *
 * D#56: mirrors packages/db/test/globalSetup.ts's fix -- provisioning now
 * goes through the shared ephemeral-pg.ts helper (same pattern as this
 * file already used for `@fx/db/src/pool.js` and `@fx/db/src/migrate.js`),
 * and the result is handed to THIS project only via `provide()` rather than
 * written to the shared `process.env`. See that file's header for why: two
 * projects' globalSetups writing the same bare `DATABASE_URL*` name in the
 * one orchestrator process `vitest.workspace.ts` runs them all in was
 * exactly the D#56 flake. bind-test-env.ts (a setupFiles entry) puts the
 * value back into `process.env` inside this project's own worker fork.
 *
 * If `DATABASE_URL_TEST` is set, that database is used as-is (a
 * developer's own Postgres, or CI-provided) -- `DATABASE_URL_APP_USER` and
 * `DATABASE_URL_PLATFORM_OPS` must also be set in that case, same
 * host/port/db, connecting as role app_user / platform_ops respectively.
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
    if (!appUserUrl || !platformOpsUrl) {
      throw new Error(
        'DATABASE_URL_APP_USER and DATABASE_URL_PLATFORM_OPS must be set alongside DATABASE_URL_TEST.',
      );
    }
    testDbEnv = { prefix: '', url, appUserUrl, platformOpsUrl };
  } else {
    const provisioned = await provisionEphemeralPostgres({
      database: 'fx_core_test',
      tmpPrefix: 'fx-core-pg-',
    });
    url = provisioned.url;
    cleanup = provisioned.cleanup;
    testDbEnv = {
      prefix: '',
      url: provisioned.url,
      appUserUrl: provisioned.appUserUrl,
      platformOpsUrl: provisioned.platformOpsUrl,
    };
  }

  provide('testDbEnv', testDbEnv);

  const pool = createPool(url);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }

  return async () => {
    cleanup?.();
  };
}
