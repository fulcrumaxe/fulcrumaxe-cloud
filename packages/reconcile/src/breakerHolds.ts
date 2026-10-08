import type { Pool } from 'pg';

/**
 * The recorded holds of the reconcilers' detach breaker (D#454 H2b2, migration 0748).
 *
 * A trip writes one OPEN hold per (job, kind) with the detaching installation ids; only the owner releases it. A release
 * counts for 48 hours and then lapses, unless a run consumed it first. Nothing here releases a hold on its own: the
 * failure the breaker exists for (a wrong or rotated App key) repeats on every run, so "release after N identical trips"
 * would release exactly that case.
 */
export const RELEASE_LAPSE_HOURS = 48;

/** A kind's run trips when its detaching changes exceed this: min(5, max(2, floor(0.1 x live))). */
export function breakerAllowance(live: number): number {
  return Math.min(5, Math.max(2, Math.floor(0.1 * live)));
}

export interface OpenHold {
  id: number;
  job: string;
  kind: string;
  ids: number[];
  tripCount: number;
  firstTrippedAt: Date;
  lastTrippedAt: Date;
  /** A release made within the last 48 hours and not yet consumed. */
  released: boolean;
  releasedAt: Date | null;
  releasedNote: string | null;
}

interface HoldRow {
  id: string;
  job: string;
  app_kind: string;
  ids: string[];
  trip_count: number;
  first_tripped_at: Date;
  last_tripped_at: Date;
  released: boolean;
  released_at: Date | null;
  released_note: string | null;
}

const SELECT_OPEN = `SELECT id::text AS id, job, app_kind, gh_installation_ids::text[] AS ids, trip_count, first_tripped_at, last_tripped_at,
       (released_at IS NOT NULL AND released_at > now() - make_interval(hours => ${RELEASE_LAPSE_HOURS})) AS released,
       released_at, released_note
  FROM reconcile_breaker_holds WHERE consumed_at IS NULL`;

const toHold = (r: HoldRow): OpenHold => ({
  id: Number(r.id),
  job: r.job,
  kind: r.app_kind,
  ids: r.ids.map(Number).sort((a, b) => a - b),
  tripCount: r.trip_count,
  firstTrippedAt: r.first_tripped_at,
  lastTrippedAt: r.last_tripped_at,
  released: r.released,
  releasedAt: r.released_at,
  releasedNote: r.released_note,
});

const sameSet = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export async function readOpenHold(pool: Pool, job: string, kind: string): Promise<OpenHold | null> {
  const { rows } = await pool.query<HoldRow>(`${SELECT_OPEN} AND job = $1 AND app_kind = $2`, [job, kind]);
  return rows[0] ? toHold(rows[0]) : null;
}

export async function listOpenHolds(pool: Pool): Promise<OpenHold[]> {
  const { rows } = await pool.query<HoldRow>(`${SELECT_OPEN} ORDER BY job, app_kind`);
  return rows.map(toHold);
}

/**
 * A trip: open the hold, or update it. The same id set only raises `trip_count` (no alert); a different set replaces the
 * hold in place, clears any release, and alerts again. Returns whether the caller should alert.
 */
export async function recordTrip(pool: Pool, job: string, kind: string, ids: readonly number[]): Promise<{ alert: boolean }> {
  const sorted = [...ids].sort((a, b) => a - b);
  const open = await readOpenHold(pool, job, kind);
  if (!open) {
    await pool.query(`INSERT INTO reconcile_breaker_holds (job, app_kind, gh_installation_ids) VALUES ($1, $2, $3::bigint[])`, [job, kind, sorted]);
    return { alert: true };
  }
  if (sameSet(open.ids, sorted)) {
    await pool.query(`UPDATE reconcile_breaker_holds SET trip_count = trip_count + 1, last_tripped_at = now() WHERE id = $1`, [open.id]);
    return { alert: false };
  }
  await pool.query(
    `UPDATE reconcile_breaker_holds
        SET gh_installation_ids = $2::bigint[], first_tripped_at = now(), last_tripped_at = now(), trip_count = 1,
            released_at = NULL, released_note = NULL
      WHERE id = $1`,
    [open.id, sorted],
  );
  return { alert: true };
}

/** A released hold whose release a run used up. Guarded, so a replay changes nothing. */
export async function consumeHold(pool: Pool, id: number): Promise<boolean> {
  const res = await pool.query(`UPDATE reconcile_breaker_holds SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`, [id]);
  return (res.rowCount ?? 0) > 0;
}

export type ReleaseResult =
  | { status: 'released'; hold: OpenHold }
  | { status: 'already_released' }
  | { status: 'no_such_hold' }
  /** The hold now covers a different set than the one the owner saw; nothing was released. */
  | { status: 'ids_changed'; hold: OpenHold };

/**
 * Owner release of exactly the hold the owner saw: by id AND by the id set, in ONE statement. The set is part of the UPDATE's
 * own WHERE, so a hold that was replaced by a different set between the owner's read and this write matches no row and is
 * never released (a separate check followed by an update by id alone could release the replacement). Only when no row comes
 * back is the hold read again, to say why. Releasing a hold that is already released (and not lapsed) changes nothing, so a
 * replayed request is harmless.
 */
export async function releaseHold(pool: Pool, input: { holdId: number; ids: readonly number[]; note: string }): Promise<ReleaseResult> {
  const ids = [...input.ids].sort((a, b) => a - b);
  const done = await pool.query<HoldRow>(
    `UPDATE reconcile_breaker_holds SET released_at = now(), released_note = $2
      WHERE id = $1 AND consumed_at IS NULL AND gh_installation_ids = $3::bigint[]
        AND (released_at IS NULL OR released_at <= now() - make_interval(hours => ${RELEASE_LAPSE_HOURS}))
      RETURNING id::text AS id, job, app_kind, gh_installation_ids::text[] AS ids, trip_count, first_tripped_at, last_tripped_at,
                true AS released, released_at, released_note`,
    [input.holdId, input.note.slice(0, 200), ids],
  );
  if (done.rows[0]) return { status: 'released', hold: toHold(done.rows[0]) };
  // Nothing was released. Say why; this read changes nothing.
  const { rows } = await pool.query<HoldRow>(`${SELECT_OPEN} AND id = $1`, [input.holdId]);
  if (!rows[0]) return { status: 'no_such_hold' };
  const hold = toHold(rows[0]);
  if (!sameSet(hold.ids, ids)) return { status: 'ids_changed', hold };
  // Same set and still not released means the hold changed between the two statements: report it as changed, release nothing.
  return hold.released ? { status: 'already_released' } : { status: 'ids_changed', hold };
}

/**
 * The launch check's "Reconcilers healthy" input: red while a hold exists that nobody has released (or whose release
 * lapsed) and no run has consumed. Green once a release is consumed, with no other change.
 */
export async function readBreakerHoldHealth(pool: Pool): Promise<{ healthy: boolean; red: { job: string; kind: string; tripCount: number }[] }> {
  const red = (await listOpenHolds(pool)).filter((h) => !h.released).map((h) => ({ job: h.job, kind: h.kind, tripCount: h.tripCount }));
  return { healthy: red.length === 0, red };
}
