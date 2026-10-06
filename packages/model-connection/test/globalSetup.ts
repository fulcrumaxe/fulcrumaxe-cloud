import type { GlobalSetupContext } from 'vitest/node';
import { createPool } from '@fx/db/src/pool.js';
import { runMigrations } from '@fx/db/src/migrate.js';
import { provisionEphemeralPostgres, type TestDbEnv } from '@fx/db/test/support/ephemeral-pg.js';

/**
 * Runs once for the whole vitest process, before any test file. Test files
 * assume migrations are already applied and just open their own pools.
 *
 * D#56 (fix round 3, Part 2): mirrors packages/core/test/globalSetup.ts
 * exactly -- this used to be a third near-identical copy of the throwaway-
 * Postgres bootstrap (initdb/pg_ctl on a pseudo-randomly offset port) that
 * wrote to the shared environment directly. With `vitest.workspace.ts`
 * running every project's globalSetup in ONE shared orchestrator process,
 * that shared environment object is a single object across every project
 * -- two projects' globalSetups writing the same bare name (or a
 * collision between two pseudo-randomly picked ports) is D#56's root
 * cause. Provisioning now goes through the shared ephemeral-pg.ts helper
 * (OS-assigned free ports, not a pseudo-random guess), and the result is
 * handed to THIS project only via `provide()` -- bind-test-env.ts (a
 * setupFiles entry, see vitest.config.ts) puts it back into the process
 * environment inside this project's own worker fork, where nothing else
 * can overwrite it. Existing test files keep reading
 * `process.env.DATABASE_URL*` completely unchanged.
 * scripts/check-globalsetup-env.sh (D#56's guard) enforces that this file
 * never regresses back to writing that environment directly or picking a
 * port pseudo-randomly.
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
      database: 'fx_model_connection_test',
      tmpPrefix: 'fx-model-connection-pg-',
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
