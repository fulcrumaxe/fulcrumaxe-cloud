import type { Pool, PoolClient } from 'pg';

/**
 * D#845 ON-27d4a: the TypeScript side of the twin sweep's database calls (migration 1116). The sweep itself, its two-installation parity check and the handler wiring are ON-27d4b's; these are the calls it makes, each one a
 * definer, so the rules (who may call, which account, which state, the lease, the anchor) live in SQL and are tested there.
 *
 *   listTwinParityDue / listTwinWork   the cross-tenant lists, run-writer pool, no tenant. They name the twin and what to do, and nothing else.
 *   claimTwinWork                      the lease, under the twin's own tenant: five minutes for a seed, a publish, a sync or a parity check.
 *   recordTwinParity                   one parity result with the anchor the claim returned; a result whose anchor has moved is dropped and logged.
 */
export type TwinWorkKind = 'seed' | 'publish' | 'sync';
export type TwinClaimKind = TwinWorkKind | 'parity';

export interface DueTwinParity {
  accountId: string;
  twinId: string;
  dueAtMs: number;
  dueNow: boolean;
}
export interface TwinWorkItem {
  accountId: string;
  twinId: string;
  kind: TwinWorkKind;
}

/** Every twin with a parity due time, earliest first (`twin_parity_list_due`). */
export async function listTwinParityDue(pool: Pick<Pool, 'query'>, limit = 50): Promise<DueTwinParity[]> {
  const { rows } = await pool.query<{ account_id: string; twin_id: string; due_ms: string; due_now: boolean }>(
    'SELECT account_id, twin_id, (extract(epoch FROM due_at) * 1000)::bigint AS due_ms, due_now FROM twin_parity_list_due($1::integer)',
    [limit],
  );
  return rows.map((r) => ({ accountId: r.account_id, twinId: r.twin_id, dueAtMs: Number(r.due_ms), dueNow: r.due_now }));
}

/** Every twin whose next step is a job, not under a lease (`twin_work_list`). */
export async function listTwinWork(pool: Pick<Pool, 'query'>, limit = 50): Promise<TwinWorkItem[]> {
  const { rows } = await pool.query<{ account_id: string; twin_id: string; o_kind: TwinWorkKind }>('SELECT account_id, twin_id, o_kind FROM twin_work_list($1::integer)', [limit]);
  return rows.map((r) => ({ accountId: r.account_id, twinId: r.twin_id, kind: r.o_kind }));
}

export type TwinClaim =
  | { result: 'ok'; markSeq: number; anchor: string | null }
  | { result: 'not_found' | 'bad_state' | 'not_due' | 'leased' };

/** Takes the twin's work for this tick. `client` must be under the twin's tenant (no person, or an owner or admin). */
export async function claimTwinWork(client: PoolClient, twinId: string, kind: TwinClaimKind): Promise<TwinClaim> {
  const { rows } = await client.query<{ o_result: string; o_mark_seq: string | null; o_anchor: string | null }>('SELECT o_result, o_mark_seq, o_anchor FROM twin_work_claim($1::uuid, $2)', [twinId, kind]);
  const r = rows[0];
  if (!r) return { result: 'not_found' };
  if (r.o_result === 'ok') return { result: 'ok', markSeq: Number(r.o_mark_seq), anchor: r.o_anchor };
  return { result: r.o_result as 'not_found' | 'bad_state' | 'not_due' | 'leased' };
}

/** What the check found, in the pipeline's `TwinParityOutcome` shape for the four results a twin stores. */
export interface TwinParityRecord {
  result: 'in_parity' | 'publish_pending' | 'sync_pending' | 'conflict';
  privateSha: string | null;
  publicSha: string | null;
  paths: readonly string[];
  pathCount: number;
  publishCount: number;
  syncCount: number;
  conflictCount: number;
  advanceSyncedTo: string | null;
}
export type TwinParityRecorded = 'ok' | 'not_found' | 'bad_state' | 'stale';

/**
 * Stores one result. `claim` is what `claimTwinWork` returned for the check: `markSeq` keeps a push that arrived meanwhile due, and `anchor` is the synced tip the result was computed from (FU-312). A result whose anchor is no longer the
 * stored one is dropped by the definer (nothing written, the twin due again at once) and logged here by twin id and a fixed code.
 */
export async function recordTwinParity(client: PoolClient, twinId: string, claim: { markSeq: number; anchor: string }, o: TwinParityRecord): Promise<TwinParityRecorded> {
  const { rows } = await client.query<{ o_result: TwinParityRecorded }>('SELECT o_result FROM twin_parity_record($1::uuid, $2::bigint, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11, $12)', [
    twinId, claim.markSeq, claim.anchor, o.result, o.privateSha, o.publicSha, [...o.paths], o.pathCount, o.publishCount, o.syncCount, o.conflictCount, o.advanceSyncedTo,
  ]);
  const result = rows[0]?.o_result ?? 'not_found';
  if (result === 'stale') console.warn(JSON.stringify({ event: 'twin.parity_result_dropped', code: 'anchor_moved', twin_id: twinId }));
  return result;
}
