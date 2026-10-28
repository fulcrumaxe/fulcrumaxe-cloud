import type { Pool } from "pg";
import { createPool } from "@fx/db/src/pool";
import { readCronLastTicks, recordCronConnected } from "@fx/db/src/cronLastTick";
import { CONNECTS_WHILE_PAUSED, effectiveBackstopMs, isStagingPaused, readCronCache, SWEEP_NAMES, SWEEP_SCHEDULE_MS, type SweepName } from "@fx/core/src/pendingWork";

/**
 * CRON-OBS-1: cron liveness, in two places that fail differently.
 *  - Runtime Cache (`tick:<sweep>`): written on EVERY cron call, skipped or not, with no database. Regional and ephemeral, so a miss is
 *    ambiguous (a cold or other region, an eviction, or a cron that stopped).
 *  - `cron_last_tick`: upserted only by a tick that connected anyway. Durable, but it can only show when the sweep last CONNECTED, which on
 *    an idle deployment is the backstop, not the schedule.
 * The staging check calls a sweep dead only when both agree (the staging liveness check).
 */

let cachedPool: Pool | undefined;

/** The platform_ops pool, built on the first connecting tick (never on a skipped one). Null while the login is not configured. */
function platformOpsPool(): Pool | null {
  if (cachedPool) return cachedPool;
  const url = process.env.DATABASE_URL_PLATFORM_OPS;
  if (!url) return null;
  cachedPool = createPool(url);
  return cachedPool;
}

/**
 * The hook a connecting tick calls once its work is done (installed by installPendingWork). It uses its own platform_ops pool, opened on first use:
 * one extra connection per instance, only ever on a tick that connected anyway.
 */
export async function recordConnectedTick(name: SweepName, at: number): Promise<void> {
  const pool = platformOpsPool();
  if (pool) await recordCronConnected(pool, name, at);
}

export interface CronSweepLiveness {
  schedule_ms: number;
  /** Effective backstop in force for this sweep right now (30 or 60 minutes, times 4 for the reconciler; 12 hours while paused). */
  backstop_ms: number;
  /** False for a sweep that ends before the gate while staging is paused, so it never refreshes its row then; the check judges it by the cache alone while paused. */
  connects_while_paused: boolean;
  /** Milliseconds since the Runtime Cache tick, or null on a miss. */
  tick_age_ms: number | null;
  /** Milliseconds since the sweep last connected (database), or null when it has no row. */
  connected_age_ms: number | null;
}

export interface CronLiveness {
  paused: boolean;
  idle: boolean;
  /** False when this instance has no Runtime Cache at all (every tick age is then null). */
  cache: boolean;
  /** VERCEL_ENV of this deployment (Vercel starts crons on a project's "production" deployment only), or null when unset. The deploy check reads it. */
  vercel_env: string | null;
  sweeps: Record<string, CronSweepLiveness>;
}

/**
 * The operator view for /api/health. Reads the cache, then the table through `pool` (the operator asked, so this one read may open a
 * connection; no cron path calls it). A table that cannot be read leaves every connected age null rather than failing the health answer.
 */
export async function readCronLiveness(now: number = Date.now(), pool?: Pick<Pool, "query"> | null, paused: boolean = isStagingPaused(), env: Record<string, string | undefined> = process.env): Promise<CronLiveness> {
  const cache = await readCronCache(now);
  let rows = new Map<string, { lastConnectedAt: number }>();
  try {
    // The default pool is resolved here, inside the try: a malformed URL then gives null ages instead of failing the health answer.
    const p = pool === undefined ? platformOpsPool() : pool;
    if (p) rows = await readCronLastTicks(p);
  } catch {
    // fx-swallow-ok: an unreadable table reads as "no connected time" (null ages); the check then judges on what it has and the health answer stays up
  }
  const sweeps: Record<string, CronSweepLiveness> = {};
  for (const name of SWEEP_NAMES) {
    const tick = cache.ticks[name];
    const row = rows.get(name);
    sweeps[name] = {
      schedule_ms: SWEEP_SCHEDULE_MS[name],
      connects_while_paused: CONNECTS_WHILE_PAUSED[name],
      backstop_ms: effectiveBackstopMs(name, { paused, idle: cache.idle }),
      tick_age_ms: tick === null ? null : Math.max(0, now - tick),
      connected_age_ms: row ? Math.max(0, now - row.lastConnectedAt) : null,
    };
  }
  return { paused, idle: cache.idle, cache: cache.store, vercel_env: env.VERCEL_ENV ? env.VERCEL_ENV : null, sweeps };
}
