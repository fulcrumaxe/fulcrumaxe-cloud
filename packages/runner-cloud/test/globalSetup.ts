import type { GlobalSetupContext } from "vitest/node";
import { createPool } from "@fx/db/src/pool.js";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type TestDbEnv } from "@fx/db/test/support/ephemeral-pg.js";

/** This package's throwaway Postgres, in its own `RUNNER_CLOUD_` namespace and cluster (D#56). */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const provisioned = await provisionEphemeralPostgres({ database: "fx_runner_cloud_test", tmpPrefix: "fx-rc-pg-" });
  const testDbEnv: TestDbEnv = { prefix: "RUNNER_CLOUD_", url: provisioned.url, appUserUrl: provisioned.appUserUrl, platformOpsUrl: provisioned.platformOpsUrl };
  provide("testDbEnv", testDbEnv);
  const pool = createPool(provisioned.url);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
  return async () => {
    provisioned.cleanup();
  };
}
