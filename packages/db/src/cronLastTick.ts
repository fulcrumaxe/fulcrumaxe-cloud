import type { Pool } from "pg";

/**
 * CRON-OBS-1: the `cron_last_tick` table (migration 0926). One row per cron sweep, written by a tick that connected anyway and read by the
 * operator view of /api/health. platform_ops only.
 */

type Queryable = Pick<Pool, "query">;

export interface CronLastTick {
  sweep: string;
  lastTickAt: number;
  lastConnectedAt: number;
}

/**
 * Upserts the sweep's row to `atMs` (epoch ms). Never moves a time backwards: two instances whose clocks differ by a little must not make
 * the row older than the newest tick either of them saw.
 */
export async function recordCronConnected(pool: Queryable, sweep: string, atMs: number): Promise<void> {
  await pool.query(
    `INSERT INTO cron_last_tick (sweep, last_tick_at, last_connected_at)
     VALUES ($1, to_timestamp($2::float8 / 1000.0), to_timestamp($2::float8 / 1000.0))
     ON CONFLICT (sweep) DO UPDATE
       SET last_tick_at = GREATEST(cron_last_tick.last_tick_at, EXCLUDED.last_tick_at),
           last_connected_at = GREATEST(cron_last_tick.last_connected_at, EXCLUDED.last_connected_at)`,
    [sweep, atMs],
  );
}

/** Every recorded row, keyed by sweep. */
export async function readCronLastTicks(pool: Queryable): Promise<Map<string, CronLastTick>> {
  const { rows } = await pool.query<{ sweep: string; tick: number; connected: number }>(
    `SELECT sweep, (EXTRACT(EPOCH FROM last_tick_at) * 1000)::float8 AS tick, (EXTRACT(EPOCH FROM last_connected_at) * 1000)::float8 AS connected FROM cron_last_tick`,
  );
  return new Map(rows.map((r) => [r.sweep, { sweep: r.sweep, lastTickAt: Number(r.tick), lastConnectedAt: Number(r.connected) }]));
}
