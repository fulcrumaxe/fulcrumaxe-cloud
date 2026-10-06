import type { GlobalSetupContext } from "vitest/node";
import { createPool } from "@fx/db/src/pool.js";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type TestDbEnv } from "@fx/db/test/support/ephemeral-pg.js";

/**
 * D#71 DS-2's own throwaway-Postgres bootstrap for this package's [pg]
 * tests -- mirrors packages/pipeline/test/globalSetup.ts (including
 * @fx/db's runMigrations, which applies every migration through the
 * current head, including migrations/0618_discussions.sql), except for
 * the `DISCUSSIONS_` prefix (D#56: a new package gets its own namespace
 * and throwaway cluster rather than reusing another package's).
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  let url: string;
  let testDbEnv: TestDbEnv;
  let cleanup: (() => void) | undefined;

  if (process.env.DISCUSSIONS_DATABASE_URL_TEST) {
    url = process.env.DISCUSSIONS_DATABASE_URL_TEST;
    const appUserUrl = process.env.DISCUSSIONS_DATABASE_URL_APP_USER;
    const platformOpsUrl = process.env.DISCUSSIONS_DATABASE_URL_PLATFORM_OPS;
    if (!appUserUrl || !platformOpsUrl) {
      throw new Error(
        "DISCUSSIONS_DATABASE_URL_APP_USER and DISCUSSIONS_DATABASE_URL_PLATFORM_OPS must be set alongside DISCUSSIONS_DATABASE_URL_TEST.",
      );
    }
    testDbEnv = { prefix: "DISCUSSIONS_", url, appUserUrl, platformOpsUrl };
  } else {
    const provisioned = await provisionEphemeralPostgres({
      database: "fx_discussions_test",
      tmpPrefix: "fx-discussions-pg-",
    });
    url = provisioned.url;
    cleanup = provisioned.cleanup;
    testDbEnv = {
      prefix: "DISCUSSIONS_",
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
