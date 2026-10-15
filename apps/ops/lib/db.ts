import type { Pool } from "pg";
import { createPool } from "@fx/db/src/pool.js";

/** The console's only database login is the ops_console role, from this one setting. */
export class OpsNotConfiguredError extends Error {
  static readonly fixedMessage = "the ops console database login is not configured";
  constructor() {
    super(OpsNotConfiguredError.fixedMessage);
  }
}

let pool: Pool | undefined;
let poolUrl: string | undefined;

/** One small pool per process, opened on first use (a build, or a health check with the setting missing, never connects). */
export function opsPool(env: Readonly<Record<string, string | undefined>> = process.env): Pool {
  const url = env.DATABASE_URL_OPS_CONSOLE;
  if (!url) throw new OpsNotConfiguredError();
  if (pool && poolUrl === url) return pool;
  void pool?.end();
  pool = createPool(url, { max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 });
  pool.on("error", () => {
    // fx-swallow-ok: a dropped idle connection is replaced by the next request
  });
  poolUrl = url;
  return pool;
}
