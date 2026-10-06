import type { GlobalSetupContext } from 'vitest/node';
import { createPool } from '@fx/db/src/pool.js';
import { runMigrations } from '@fx/db/src/migrate.js';
import { provisionEphemeralPostgres, type TestDbEnv } from '@fx/db/test/support/ephemeral-pg.js';

/**
 * H13a's own throwaway-Postgres bootstrap, parallel to
 * packages/core/test/globalSetup.ts and packages/billing/test/globalSetup.ts
 * (each DB-backed package keeps its own -- @fx/db publishes no main/
 * exports). Applies the full packages/db/migrations/*.sql chain, giving
 * this project the real work_items/work_item_transitions/installations/
 * repos schema H13a needs. `GITHUB_`-prefixed env var names (D#56): each
 * project uses a distinct prefix so worker forks never collide, per
 * packages/db/test/support/bind-test-env.ts.
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  let url: string;
  let testDbEnv: TestDbEnv;
  let cleanup: (() => void) | undefined;

  if (process.env.GITHUB_DATABASE_URL_TEST) {
    url = process.env.GITHUB_DATABASE_URL_TEST;
    const appUserUrl = process.env.GITHUB_DATABASE_URL_APP_USER;
    const platformOpsUrl = process.env.GITHUB_DATABASE_URL_PLATFORM_OPS;
    if (!appUserUrl || !platformOpsUrl) {
      throw new Error(
        'GITHUB_DATABASE_URL_APP_USER and GITHUB_DATABASE_URL_PLATFORM_OPS must both be set alongside GITHUB_DATABASE_URL_TEST.',
      );
    }
    testDbEnv = { prefix: 'GITHUB_', url, appUserUrl, platformOpsUrl };
  } else {
    const provisioned = await provisionEphemeralPostgres({
      database: 'fx_github_test',
      tmpPrefix: 'fx-github-pg-',
    });
    url = provisioned.url;
    cleanup = provisioned.cleanup;
    testDbEnv = {
      prefix: 'GITHUB_',
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
