import type { GlobalSetupContext } from 'vitest/node';
import { createPool } from '@fx/db/src/pool.js';
import { runMigrations } from '@fx/db/src/migrate.js';
import { provisionEphemeralPostgres, type TestDbEnv } from '@fx/db/test/support/ephemeral-pg.js';

/**
 * Mirrors packages/model-connection/test/globalSetup.ts exactly (see D#56,
 * that file's own header). This package's [pg] tests (route.live.pg.test.ts,
 * proposal's promotion-guard test) need the real routing_tables/routing_rows
 * schema and grants from migrations/0010_model_routing.sql -- a mocked pg
 * client would not prove the live-version read or the promotion write.
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
      database: 'fx_model_router_test',
      tmpPrefix: 'fx-model-router-pg-',
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
