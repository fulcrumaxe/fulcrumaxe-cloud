import type { GlobalSetupContext } from 'vitest/node';
import { createPool } from '@fx/db/src/pool.js';
import { runMigrations } from '@fx/db/src/migrate.js';
import { provisionEphemeralPostgres, type TestDbEnv } from '@fx/db/test/support/ephemeral-pg.js';

/**
 * Runs once per vitest process, before any test file -- mirrors
 * packages/webhooks/test/globalSetup.ts (see its header
 * for the D#56 shared-orchestrator-process rationale). If
 * `DATABASE_URL_TEST` is set, that database is used as-is (with
 * `DATABASE_URL_APP_USER`/`DATABASE_URL_PLATFORM_OPS` set alongside it);
 * otherwise an ephemeral cluster is provisioned and torn down afterward.
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
      database: 'fx_reconcile_test',
      tmpPrefix: 'fx-reconcile-pg-',
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
