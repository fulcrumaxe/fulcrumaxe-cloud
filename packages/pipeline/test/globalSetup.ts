import type { GlobalSetupContext } from "vitest/node";
import { createPool } from "@fx/db/src/pool.js";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type TestDbEnv } from "@fx/db/test/support/ephemeral-pg.js";
import { createRunWriterTestLogin, runWriterUrlFrom } from "@fx/db/test/support/run-writer-login.js";

/**
 * D#2 H14a's own throwaway-Postgres bootstrap for this package's [pg]
 * tests -- mirrors packages/runner/test/globalSetup.ts (including
 * @fx/db's runMigrations, which applies every migration through the
 * current 0627_webhooks.sql), except for the `PIPELINE_` prefix (D#56:
 * a new package gets its own namespace and throwaway cluster rather than
 * reusing another package's).
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  let url: string;
  let testDbEnv: TestDbEnv;
  let cleanup: (() => void) | undefined;

  if (process.env.PIPELINE_DATABASE_URL_TEST) {
    url = process.env.PIPELINE_DATABASE_URL_TEST;
    const appUserUrl = process.env.PIPELINE_DATABASE_URL_APP_USER;
    const platformOpsUrl = process.env.PIPELINE_DATABASE_URL_PLATFORM_OPS;
    if (!appUserUrl || !platformOpsUrl) {
      throw new Error(
        "PIPELINE_DATABASE_URL_APP_USER and PIPELINE_DATABASE_URL_PLATFORM_OPS must be set alongside PIPELINE_DATABASE_URL_TEST.",
      );
    }
    testDbEnv = { prefix: "PIPELINE_", url, appUserUrl, platformOpsUrl };
  } else {
    const provisioned = await provisionEphemeralPostgres({
      database: "fx_pipeline_test",
      tmpPrefix: "fx-pipeline-pg-",
    });
    url = provisioned.url;
    cleanup = provisioned.cleanup;
    testDbEnv = {
      prefix: "PIPELINE_",
      url: provisioned.url,
      appUserUrl: provisioned.appUserUrl,
      platformOpsUrl: provisioned.platformOpsUrl,
    };
  }

  const pool = createPool(url);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }

  // D#2 H09c: agent_runs is written only through agent_run_writer-only
  // SECURITY DEFINER functions (0642); the code under test gets a pool
  // that is a member of app_user AND agent_run_writer. Needs the role the
  // migration just created, so it runs after runMigrations.
  await createRunWriterTestLogin(url);
  testDbEnv.runWriterUrl = process.env.PIPELINE_DATABASE_URL_RUN_WRITER ?? runWriterUrlFrom(testDbEnv.appUserUrl);

  provide("testDbEnv", testDbEnv);

  return async () => {
    cleanup?.();
  };
}
