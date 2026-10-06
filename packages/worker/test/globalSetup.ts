import type { GlobalSetupContext } from "vitest/node";
import { createPool } from "@fx/db/src/pool.js";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type TestDbEnv } from "@fx/db/test/support/ephemeral-pg.js";
import { createRunWriterTestLogin, runWriterUrlFrom } from "@fx/db/test/support/run-writer-login.js";

/**
 * The throwaway Postgres for this package's [pg] tests (the run-action facade
 * against the real 0658 definers). Same shape as packages/runner's setup, with
 * a `WORKER_` prefix so it gets its own namespace and cluster (D#56).
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  let url: string;
  let testDbEnv: TestDbEnv;
  let cleanup: (() => void) | undefined;

  if (process.env.WORKER_DATABASE_URL_TEST) {
    url = process.env.WORKER_DATABASE_URL_TEST;
    // These tests write to the database they are given; never a remote one.
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new Error("WORKER_DATABASE_URL_TEST is not a valid URL.");
    }
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
      throw new Error("WORKER_DATABASE_URL_TEST must point at a loopback host (localhost, 127.0.0.1 or ::1).");
    }
    const appUserUrl = process.env.WORKER_DATABASE_URL_APP_USER;
    const platformOpsUrl = process.env.WORKER_DATABASE_URL_PLATFORM_OPS;
    if (!appUserUrl || !platformOpsUrl) {
      throw new Error("WORKER_DATABASE_URL_APP_USER and WORKER_DATABASE_URL_PLATFORM_OPS must be set alongside WORKER_DATABASE_URL_TEST.");
    }
    testDbEnv = { prefix: "WORKER_", url, appUserUrl, platformOpsUrl };
  } else {
    const provisioned = await provisionEphemeralPostgres({ database: "fx_worker_test", tmpPrefix: "fx-worker-pg-" });
    url = provisioned.url;
    cleanup = provisioned.cleanup;
    testDbEnv = { prefix: "WORKER_", url, appUserUrl: provisioned.appUserUrl, platformOpsUrl: provisioned.platformOpsUrl };
  }

  const pool = createPool(url);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }

  await createRunWriterTestLogin(url);
  testDbEnv.runWriterUrl = process.env.WORKER_DATABASE_URL_RUN_WRITER ?? runWriterUrlFrom(testDbEnv.appUserUrl);

  provide("testDbEnv", testDbEnv);

  return async () => {
    cleanup?.();
  };
}
