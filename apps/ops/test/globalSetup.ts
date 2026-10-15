import type { GlobalSetupContext } from "vitest/node";
import { createPool } from "@fx/db/src/pool.js";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres } from "@fx/db/test/support/ephemeral-pg.js";

declare module "vitest" {
  interface ProvidedContext {
    opsDbEnv: { migrationUrl: string; opsConsoleUrl: string };
  }
}

/** One throwaway, fully migrated Postgres for this project; the tests log in to it as the migration owner and as ops_console. */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const pg = await provisionEphemeralPostgres({ database: "fx_ops_test", tmpPrefix: "fx-ops-pg-" });
  const pool = createPool(pg.url);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
  provide("opsDbEnv", { migrationUrl: pg.url, opsConsoleUrl: `postgres://ops_console@127.0.0.1:${pg.port}/${pg.database}` });
  return async () => {
    pg.cleanup();
  };
}
