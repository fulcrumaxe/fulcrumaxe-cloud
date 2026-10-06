import type { Pool } from "pg";
import { createPool } from "@fx/db/src/pool.js";

/**
 * The two pools every `/api/v1` route file uses (the catch-all
 * `apps/web/app/api/v1/[...path]/route.ts` imports them from here too, so
 * one function instance holds one set of connections), built lazily from:
 * `DATABASE_URL_APP_USER` for every tenant-scoped read and
 * `DATABASE_URL_PLATFORM_OPS` for the session epoch check and the
 * watermark call. Cached per process, so the streams on one instance
 * share connections (and share one poller).
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

let appUser: Pool | undefined;
let platformOps: Pool | undefined;

export function appUserPool(): Pool {
  appUser ??= createPool(requireEnv("DATABASE_URL_APP_USER"));
  return appUser;
}

export function platformOpsPool(): Pool {
  platformOps ??= createPool(requireEnv("DATABASE_URL_PLATFORM_OPS"));
  return platformOps;
}
