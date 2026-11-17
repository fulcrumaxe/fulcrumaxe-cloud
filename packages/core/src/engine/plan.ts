import type { Pool, PoolClient } from 'pg';
import { readEngineRepoFreshness, type EngineRepoFreshness } from '@fx/db/src/engineBridge.js';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * Engine bridge EB-7: the plan and roadmap a person's engine last reported for one repo (migration 1032). The engine sends a snapshot in chunks; the database
 * keeps one only when every chunk has arrived, so what is read here is always a snapshot that was whole, and a newer one that is still arriving never hides it
 * (it is reported beside it as `newer_partial`). Every field is an id, an enum, a count, a date or a row key; nothing is computed here but the snapshot's age.
 */
export interface EnginePlanItem {
  discussion: number;
  ordinal: number;
  state: 'planned' | 'in_progress' | 'pr_open' | 'merged' | 'blocked' | 'dropped';
}

export interface EngineRoadmapRow {
  row_key: string;
  /** Null when the row has no Discussion. */
  discussion: number | null;
  status: 'not_started' | 'in_progress' | 'done' | 'blocked' | 'deferred' | 'split' | 'removed' | 'superseded';
  /** Null when the engine did not declare one (a declared fact, not a count of merges). */
  planned_prs: number | null;
}

export interface EnginePlanView {
  /** The plan file's own date, `YYYY-MM-DD`. */
  plan_date: string;
  /** When the engine made the snapshot (its own clock on the last chunk, never later than the cloud's receipt). */
  snapshot_at: string;
  /** When the cloud had the whole snapshot. The newest by this wins. */
  received_at: string;
  /** Seconds since `snapshot_at`, derived on this read and never stored. */
  age_s: number;
  items: EnginePlanItem[];
  roadmap: EngineRoadmapRow[];
  /** A snapshot that is still arriving and is newer than the one shown: how many of its chunks are here. Null when nothing newer is pending. */
  newer_partial: { chunks_received: number; chunk_count: number; last_chunk_at: string } | null;
  /** The repo's data age and completeness (as of, heard age, per-source ages, gaps), the same as every other per-repo read. Null when the repo has no session. */
  freshness: EngineRepoFreshness | null;
}

const iso = (v: Date | string): string => new Date(v).toISOString();

/**
 * The repo's newest complete plan snapshot, or null when it has none. Throws `NotFoundError` for a repo that is not the account's or is not ticked for the
 * bridge (the same answer for both, so a caller cannot tell whether another account's repo exists). Runs on the caller's tenant client.
 */
export async function readEnginePlan(client: Pick<PoolClient, 'query'>, repoId: string): Promise<EnginePlanView | null> {
  const ticked = await client.query(`SELECT 1 FROM engine_bridge_repos WHERE repo_id = $1`, [repoId]);
  if (ticked.rows.length === 0) throw new NotFoundError(`repos ${repoId} not found`);

  const { rows } = await client.query(
    `SELECT session_id, to_char(plan_date, 'YYYY-MM-DD') AS plan_date, snapshot_at, received_at, GREATEST(0, EXTRACT(EPOCH FROM (now() - snapshot_at)))::float8 AS age, items, roadmap
       FROM engine_plan_snapshots WHERE repo_id = $1 ORDER BY received_at DESC, completed_seq DESC LIMIT 1`,
    [repoId],
  );
  const row = rows[0];
  if (!row) return null;

  // The newer-than comparison stays in SQL: a timestamptz read into a JS Date keeps milliseconds only, and a chunk that arrived in the same millisecond as the
  // snapshot but earlier in microseconds would then count as newer. The snapshot row is addressed by its key, so no timestamp makes the round trip.
  const partial = await client.query(
    `SELECT c.chunk_count, count(*)::int AS received, max(c.received_at) AS last_at
       FROM engine_plan_chunks c JOIN engine_sessions s ON s.id = c.session_id
      WHERE s.repo_id = $1
      GROUP BY c.session_id, c.snapshot_id, c.chunk_count
     HAVING max(c.received_at) > (SELECT p.received_at FROM engine_plan_snapshots p WHERE p.session_id = $2 AND p.plan_date = $3::date)
      ORDER BY max(c.received_at) DESC LIMIT 1`,
    [repoId, row.session_id, row.plan_date],
  );
  const p = partial.rows[0];

  return {
    plan_date: row.plan_date,
    snapshot_at: iso(row.snapshot_at),
    received_at: iso(row.received_at),
    age_s: Math.round(row.age),
    items: (row.items as Array<Record<string, unknown>>).map((i) => ({ discussion: Number(i.discussion), ordinal: Number(i.ordinal), state: i.state as EnginePlanItem['state'] })),
    roadmap: (row.roadmap as Array<Record<string, unknown>>).map((r) => ({
      row_key: String(r.row_key),
      discussion: r.discussion === undefined ? null : Number(r.discussion),
      status: r.status as EngineRoadmapRow['status'],
      planned_prs: r.planned_prs === undefined ? null : Number(r.planned_prs),
    })),
    newer_partial: p ? { chunks_received: Number(p.received), chunk_count: Number(p.chunk_count), last_chunk_at: iso(p.last_at) } : null,
    freshness: await readEngineRepoFreshness(client, repoId),
  };
}

/** The same read for a caller: opens the tenant transaction (row security confines it to the account) and reads. */
export async function getEnginePlan(ctx: { pool: Pool; principal: { accountId: string; userId: string } }, repoId: string): Promise<EnginePlanView | null> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, (client) => readEnginePlan(client, repoId));
}
