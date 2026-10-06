import type { GlobalSetupContext } from "vitest/node";
import { createPool } from "@fx/db/src/pool.js";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type TestDbEnv } from "@fx/db/test/support/ephemeral-pg.js";

/**
 * `@fx/api`'s own throwaway-Postgres bootstrap, deliberately parallel to
 * `packages/core/test/globalSetup.ts` -- same shared `ephemeral-pg.ts`
 * provisioner, same `@fx/db` migration runner (this package's tests need
 * the real schema, including `packages/db/migrations/0600_api_core.sql`'s
 * `idempotency_keys`, not a hand-rolled subset).
 *
 * `API_`-prefixed env names, hands the result to THIS project only via
 * `provide()` -- never a bare `process.env` write here. See
 * `packages/db/test/support/ephemeral-pg.ts`'s header for why (D#56):
 * `vitest.workspace.ts` runs every project's globalSetup in one shared
 * orchestrator process, so writing `process.env` directly here could be
 * raced by another project's globalSetup before this project's own test
 * workers fork and read it back.
 * `packages/db/test/support/bind-test-env.ts` (wired as a `setupFiles`
 * entry in `vitest.config.ts`) puts the value into `process.env` inside
 * this project's own worker fork.
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  let url: string;
  let testDbEnv: TestDbEnv;
  let cleanup: (() => void) | undefined;

  if (process.env.API_DATABASE_URL_TEST) {
    url = process.env.API_DATABASE_URL_TEST;
    const appUserUrl = process.env.API_DATABASE_URL_APP_USER;
    const platformOpsUrl = process.env.API_DATABASE_URL_PLATFORM_OPS;
    if (!appUserUrl || !platformOpsUrl) {
      throw new Error(
        'API_DATABASE_URL_APP_USER and API_DATABASE_URL_PLATFORM_OPS must be set alongside API_DATABASE_URL_TEST.',
      );
    }
    testDbEnv = { prefix: "API_", url, appUserUrl, platformOpsUrl };
  } else {
    const provisioned = await provisionEphemeralPostgres({
      database: "fx_api_test",
      tmpPrefix: "fx-api-pg-",
    });
    url = provisioned.url;
    cleanup = provisioned.cleanup;
    testDbEnv = {
      prefix: "API_",
      url: provisioned.url,
      appUserUrl: provisioned.appUserUrl,
      platformOpsUrl: provisioned.platformOpsUrl,
    };
  }

  provide("testDbEnv", testDbEnv);

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
