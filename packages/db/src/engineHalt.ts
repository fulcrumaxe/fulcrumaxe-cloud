import type { PoolClient } from 'pg';

/**
 * The engine halt (migration 1031): a per-repo marker that only a person can set or clear, and that every engine decide and every
 * start-like command is refused under. This file is the one place TypeScript touches it. The writes are two SECURITY DEFINER
 * functions that check, inside the database, that the session is a verified owner or admin of an active account; nothing here
 * (and no token, runner or engine path) can write the marker any other way.
 */

/** What a repo's halt looks like to anyone who reads it. `halt_epoch` is +1 per halt and never changes on a clear. */
export interface EngineHaltState {
  halt_epoch: number;
  halted: boolean;
}

export interface EngineHaltSetResult {
  halt_epoch: number;
  /** False when the repo was already halted: nothing changed and no audit row belongs to this call. */
  newly_halted: boolean;
}

export interface EngineHaltClearResult {
  halt_epoch: number;
  /** False when the repo was not halted: nothing changed and no audit row belongs to this call. */
  newly_cleared: boolean;
}

/** The repo is not one of the session account's. The route answers 404. */
export class EngineHaltRepoNotFound extends Error {
  constructor() {
    super('engineHalt: no such repo');
    this.name = 'EngineHaltRepoNotFound';
  }
}

/** The session is not an owner or admin of an active account (42501 from the definer). The route answers 403. */
export class EngineHaltForbidden extends Error {
  constructor() {
    super('engineHalt: only an owner or admin can change the halt');
    this.name = 'EngineHaltForbidden';
  }
}

function mapError(error: unknown): unknown {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'P0002') return new EngineHaltRepoNotFound(); // no_data_found
  if (code === '42501') return new EngineHaltForbidden();
  return error;
}

/**
 * Halts the repo's engine, on the caller's tenant transaction (`withTenant`, a session). The definer takes the marker's row under FOR UPDATE, so a decide
 * or command insert in flight commits first and one that follows is refused. The caller writes `engine_halt.set` in the same transaction when `newly_halted`.
 */
export async function setEngineHalt(client: Pick<PoolClient, 'query'>, repoId: string): Promise<EngineHaltSetResult> {
  try {
    const { rows } = await client.query<EngineHaltSetResult>('SELECT halt_epoch, newly_halted FROM engine_halt_set($1::uuid)', [repoId]);
    return rows[0]!;
  } catch (error) {
    throw mapError(error);
  }
}

/** Clears the repo's halt. The epoch does not change. The caller writes `engine_halt.cleared` in the same transaction when `newly_cleared`. */
export async function clearEngineHalt(client: Pick<PoolClient, 'query'>, repoId: string): Promise<EngineHaltClearResult> {
  try {
    const { rows } = await client.query<EngineHaltClearResult>('SELECT halt_epoch, newly_cleared FROM engine_halt_clear($1::uuid)', [repoId]);
    return rows[0]!;
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * The halt of each repo named, for the account on the tenant transaction. A repo with no marker row has never been halted: epoch 0, not halted.
 * Pull replies and the dial snapshot (EB-8a, EB-9b) carry these two fields.
 */
export async function readEngineHalts(client: Pick<PoolClient, 'query'>, repoIds: readonly string[]): Promise<Map<string, EngineHaltState>> {
  const out = new Map<string, EngineHaltState>();
  for (const id of repoIds) out.set(id, { halt_epoch: 0, halted: false });
  if (repoIds.length === 0) return out;
  const { rows } = await client.query<{ repo_id: string; halt_epoch: number; halted: boolean }>(
    'SELECT repo_id, halt_epoch, halted_at IS NOT NULL AS halted FROM engine_repo_controls WHERE repo_id = ANY($1::uuid[])',
    [repoIds],
  );
  for (const r of rows) out.set(r.repo_id, { halt_epoch: r.halt_epoch, halted: r.halted });
  return out;
}

/**
 * Whether the repo's engine is halted, read THROUGH the halt's lock (`engine_halt_lock`, which takes the marker row FOR SHARE) for the session's
 * own account, so the answer holds until the caller's transaction ends: a halt that follows waits for it. A decide path MUST read the halt this way,
 * in the same transaction as its replay or insert. A plain SELECT of the marker is not enough: a replayed `act` receipt, or an ask a person approved,
 * is answered with no insert, so the BEFORE INSERT trigger never fires and a halt that commits after the plain read would be overtaken.
 * Runs on a tenant transaction (`withTenant`, or a runner session); the repo must be one of the session's account (the marker's foreign key refuses
 * anything else with 23503).
 */
export async function lockEngineHaltForSession(client: Pick<PoolClient, 'query'>, repoId: string): Promise<boolean> {
  const { rows } = await client.query<{ halted: boolean }>(
    `SELECT engine_halt_lock(NULLIF(current_setting('app.account_id', true), '')::uuid, $1::uuid) AS halted`,
    [repoId],
  );
  return rows[0]?.halted === true;
}

/** True for the error the halt triggers raise (SQLSTATE HX409, message `engine_halted`). A decide path answers `halted`; a command path refuses `halted`. */
export function isEngineHalted(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === 'HX409' && e.message === 'engine_halted';
}

/**
 * Whether the runner still has to apply a halt. True while the repo is halted and no `halt_applied` event with an epoch at or above the current one has
 * arrived. `appliedEpoch` is the highest `halt_epoch` over the session's `halt_applied` events (null when there is none); the read API derives it from the
 * session's events on each read, so it is never stored as a flag. A repo that is not halted is never pending.
 */
export function haltPending(state: EngineHaltState, appliedEpoch: number | null): boolean {
  if (!state.halted) return false;
  return appliedEpoch === null || appliedEpoch < state.halt_epoch;
}
