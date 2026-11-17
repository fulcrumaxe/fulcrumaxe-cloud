import type { PoolClient } from 'pg';

/**
 * The SQL the engine command channel (migration 1029) shares between the person's routes (issue, cancel, list) and the runner's pull. Every function runs on a
 * tenant transaction (a person's `withTenant`, or the runner's own session for the halt read) and relies on RLS for the account; none takes a table name from outside.
 */

/** The commands a halted repo refuses. Migration 1031's trigger holds the same four names; the pull route also withholds them from a halted repo. */
export const START_LIKE_KINDS = ['start_day', 'resume_loop', 'request_spawn', 'set_dial'] as const;

/** A command a runner still has not acked this long past its `expires_at` reads as `not_confirmed`: the runner's own inbox gives up 10 minutes after expiry. */
export const NOT_CONFIRMED_AFTER_S = 15 * 60;

/** At most this many commands for one runner and repo may wait at once (pending and still alive). */
export const MAX_PENDING_PER_TARGET = 20;

/** How recently a session must have been heard from to count as connected, in seconds (the app shows "stale" past the same figure). */
export const SESSION_LIVE_WITHIN_S = 180;

export interface HaltState {
  halt_epoch: number;
  halted: boolean;
}

/**
 * The halt of each repo named. A repo with no marker has never been halted: epoch 0, not halted. The marker table arrives with migration 1031, which merges after
 * this one, so until it exists nothing can be halted and its absence answers "not halted" (checked on every call, never cached).
 */
export async function readHaltStates(client: Pick<PoolClient, 'query'>, repoIds: readonly string[]): Promise<Map<string, HaltState>> {
  const out = new Map<string, HaltState>();
  for (const id of repoIds) out.set(id, { halt_epoch: 0, halted: false });
  if (repoIds.length === 0) return out;
  const present = await client.query<{ present: boolean }>("SELECT to_regclass('engine_repo_controls') IS NOT NULL AS present");
  if (present.rows[0]?.present !== true) return out;
  const { rows } = await client.query<{ repo_id: string; halt_epoch: number; halted: boolean }>(
    'SELECT repo_id, halt_epoch, halted_at IS NOT NULL AS halted FROM engine_repo_controls WHERE repo_id = ANY($1::uuid[])',
    [repoIds],
  );
  for (const r of rows) out.set(r.repo_id, { halt_epoch: r.halt_epoch, halted: r.halted });
  return out;
}

export type EngineTarget =
  | { status: 'ok'; runnerId: string; repoGhId: number }
  | { status: 'no_repo' }
  | { status: 'operate_off' }
  | { status: 'not_connected' };

/**
 * Where a command for this repo goes: the runner of the repo's live engine session, never anything a request names. In order: the repo is the account's
 * (else `no_repo`), watch and operate are both on (else `operate_off`), and some session of the repo was heard from within {@link SESSION_LIVE_WITHIN_S} on a
 * runner that is not revoked, is paired with the repo and runs it locally (else `not_connected`). The most recently heard session wins.
 */
export async function findEngineTarget(client: Pick<PoolClient, 'query'>, accountId: string, repoId: string): Promise<EngineTarget> {
  const repo = await client.query<{ gh_repo_id: string }>('SELECT gh_repo_id FROM repos WHERE id = $1 AND account_id = $2', [repoId, accountId]);
  if (repo.rows[0] === undefined) return { status: 'no_repo' };
  const settings = await client.query<{ on: boolean }>('SELECT (watch_enabled AND operate_enabled) AS on FROM engine_bridge_settings WHERE account_id = $1', [accountId]);
  if (settings.rows[0]?.on !== true) return { status: 'operate_off' };
  const live = await client.query<{ runner_id: string }>(
    `SELECT s.runner_id
       FROM engine_sessions s
       JOIN runners rn ON rn.id = s.runner_id AND rn.account_id = s.account_id AND rn.revoked_at IS NULL AND $2::uuid = ANY (rn.allowed_repo_ids)
       JOIN repos r ON r.id = s.repo_id AND r.account_id = s.account_id AND r.execution_mode = 'runner_local'
      WHERE s.account_id = $1 AND s.repo_id = $2
        AND GREATEST(s.last_event_at, s.last_heartbeat_at) > now() - make_interval(secs => $3)
      ORDER BY GREATEST(s.last_event_at, s.last_heartbeat_at) DESC
      LIMIT 1`,
    [accountId, repoId, SESSION_LIVE_WITHIN_S],
  );
  const runnerId = live.rows[0]?.runner_id;
  return runnerId === undefined ? { status: 'not_connected' } : { status: 'ok', runnerId, repoGhId: Number(repo.rows[0].gh_repo_id) };
}

export interface IssuedEngineCommand {
  id: string;
  expires_at: Date;
  command_seq: number;
}

/** Thrown when {@link MAX_PENDING_PER_TARGET} commands already wait for the runner and repo. The route answers 409 `too_many_pending`. */
export class EngineCommandsBacklog extends Error {
  constructor() {
    super('engineCommands: too many commands are waiting');
    this.name = 'EngineCommandsBacklog';
  }
}

/**
 * Inserts one pending command for the runner and repo on the person's tenant transaction. The sequence number is the runner and repo's next one: a lock keyed
 * on the pair is held until the transaction ends, so numbers are handed out in commit order and a runner that pulls by sequence never skips a lower one that
 * commits later. The row's RLS check names the issuer (`app.user_id`, an owner or admin) and the unique key is the backstop. A halted repo is refused by
 * migration 1031's trigger (SQLSTATE HX409), which the caller maps. `issued_at` and `expires_at` come from one `now()`, so the life is exactly 600 s.
 */
export async function insertEngineCommand(
  client: Pick<PoolClient, 'query'>,
  input: { accountId: string; runnerId: string; repoId: string; kind: string; args: Record<string, unknown>; issuedBy: string; haltEpoch: number },
): Promise<IssuedEngineCommand> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('engine_commands:' || $1::text || ':' || $2::text, 0))`, [input.runnerId, input.repoId]);
  const waiting = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM engine_commands WHERE runner_id = $1 AND repo_id = $2 AND state = 'pending' AND expires_at > now()`,
    [input.runnerId, input.repoId],
  );
  if (Number(waiting.rows[0]!.n) >= MAX_PENDING_PER_TARGET) throw new EngineCommandsBacklog();
  const { rows } = await client.query<{ id: string; expires_at: Date; command_seq: string }>(
    `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at, halt_epoch_at_issue)
     SELECT $1, $2, $3, COALESCE(max(command_seq), 0) + 1, $4, $5::jsonb, $6, now(), now() + interval '600 seconds', $7
       FROM engine_commands WHERE runner_id = $2 AND repo_id = $3
     RETURNING id, expires_at, command_seq`,
    [input.accountId, input.runnerId, input.repoId, input.kind, JSON.stringify(input.args), input.issuedBy, input.haltEpoch],
  );
  const row = rows[0]!;
  return { id: row.id, expires_at: row.expires_at, command_seq: Number(row.command_seq) };
}

/** True for the error migration 1031's trigger raises on a start-like command to a halted repo (SQLSTATE HX409). The code alone decides: nothing else raises it. */
export function isHaltedRefusal(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'HX409';
}
