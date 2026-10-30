import type { GlobalSetupContext } from "vitest/node";
import { createPool } from "@fx/db/src/pool.js";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type TestDbEnv } from "@fx/db/test/support/ephemeral-pg.js";

/**
 * The throwaway Postgres for this package's [pg] tests (the live price and build-state reads against the real schema). Same shape as
 * packages/worker's setup, with a `RECEIPTS_` prefix so it gets its own namespace and cluster (D#56).
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  let url: string;
  let testDbEnv: TestDbEnv;
  let cleanup: (() => void) | undefined;

  if (process.env.RECEIPTS_DATABASE_URL_TEST) {
    url = process.env.RECEIPTS_DATABASE_URL_TEST;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new Error("RECEIPTS_DATABASE_URL_TEST is not a valid URL.");
    }
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
      throw new Error("RECEIPTS_DATABASE_URL_TEST must point at a loopback host (localhost, 127.0.0.1 or ::1).");
    }
    const appUserUrl = process.env.RECEIPTS_DATABASE_URL_APP_USER;
    const platformOpsUrl = process.env.RECEIPTS_DATABASE_URL_PLATFORM_OPS;
    if (!appUserUrl || !platformOpsUrl) {
      throw new Error("RECEIPTS_DATABASE_URL_APP_USER and RECEIPTS_DATABASE_URL_PLATFORM_OPS must be set alongside RECEIPTS_DATABASE_URL_TEST.");
    }
    testDbEnv = { prefix: "RECEIPTS_", url, appUserUrl, platformOpsUrl };
  } else {
    const provisioned = await provisionEphemeralPostgres({ database: "fx_receipts_test", tmpPrefix: "fx-receipts-pg-" });
    url = provisioned.url;
    cleanup = provisioned.cleanup;
    testDbEnv = { prefix: "RECEIPTS_", url, appUserUrl: provisioned.appUserUrl, platformOpsUrl: provisioned.platformOpsUrl };
  }

  const pool = createPool(url);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }

  provide("testDbEnv", testDbEnv);

  return async () => {
    cleanup?.();
  };
}
