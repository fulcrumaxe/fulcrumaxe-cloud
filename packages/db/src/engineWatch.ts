import type { PoolClient } from 'pg';
import { EngineCommandsBacklog, insertWatchCommand, readHaltStates } from './engineCommands.js';
import { writeEngineAudit } from './engineAudit.js';

/**
 * D#845 ON-24b: the watch leases of migration 1049. Every function runs on the caller's tenant transaction (`withTenant` with the person's user id) and names the account on every
 * statement, on top of row security. Time is the database's own `now()`, never a value a caller passes, so a lease ends when the server says it does.
 */

/** A lease lives this long after its last renewal: the fallback for a killed tab (a closed stream removes its lease at once). */
export const WATCH_LEASE_TTL_S = 90;
/** At most one `watch` command per repo in this many seconds, whoever asks. */
export const WATCH_COMMAND_MIN_GAP_S = 30;
/** A watch command with less than this left is replaced by a new one, so a person who keeps watching never has a gap. */
export const WATCH_COMMAND_REFRESH_S = 120;

export interface WatchLeaseLimits {
  perRepo: number;
  perAccount: number;
  maxSessionMinutes: number;
  idleMinutes: number;
}

/** The new expiry of a lease that is still live, never past the hard maximum or the idle limit. `$ACTIVE` is replaced by the SQL for the last-input time. */
const EXPIRY = (lastInput: string): string =>
  `LEAST(now() + make_interval(secs => ${WATCH_LEASE_TTL_S}), hard_expires_at, ${lastInput} + make_interval(secs => idle_limit_s))`;

/**
 * The SET and the guard of a renewal that is not a person's input (the event stream's re-check): the lease moves only while it is live and only for its own user. Shared with the
 * stream's statement so the two cannot disagree about what a renewal may do.
 */
export const WATCH_RENEW_SET = EXPIRY('last_input_at');
export const WATCH_RENEW_LIVE = 'expires_at > now()';

export type WatchLeaseResult =
  | { status: 'ok'; leaseId: string; created: boolean; expiresAt: Date; sessionEndsAt: Date }
  | { status: 'limit'; cap: 'repo' | 'account'; limit: number; inUse: number }
  | { status: 'ended' };

/**
 * Takes a lease for (account, repo, user, browser), or renews the one the key already holds. A lease that is still live is renewed in place (its session maximum is fixed when it started,
 * and a renewal never moves it); `active` says the person did something, which restarts the idle clock. A new key counts against the plan's caps. Everything runs under one advisory lock
 * per account, so two requests cannot both find room for one more watcher, and expired rows of the account are swept first. An expired key starts a new session: a view ended by its
 * maximum or its idle limit comes back only when the person asks for it again: a call with no input (`active` false) never starts one and answers `ended`.
 */
export async function takeWatchLease(
  client: Pick<PoolClient, 'query'>,
  input: { accountId: string; repoId: string; userId: string; browserId: string; limits: WatchLeaseLimits; active: boolean },
): Promise<WatchLeaseResult> {
  const { accountId, repoId, userId, browserId, limits } = input;
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('engine_watch:' || $1::text, 0))`, [accountId]);
  await client.query('DELETE FROM engine_watch_leases WHERE account_id = $1 AND expires_at <= now()', [accountId]);
  const renewed = await client.query<{ id: string; expires_at: Date; hard_expires_at: Date }>(
    `UPDATE engine_watch_leases
        SET last_input_at = CASE WHEN $5::boolean THEN now() ELSE last_input_at END,
            expires_at = ${EXPIRY('CASE WHEN $5::boolean THEN now() ELSE last_input_at END')}
      WHERE account_id = $1 AND repo_id = $2 AND user_id = $3 AND browser_id = $4 AND expires_at > now()
      RETURNING id, expires_at, hard_expires_at`,
    [accountId, repoId, userId, browserId, input.active],
  );
  if (renewed.rows[0] !== undefined) {
    const r = renewed.rows[0];
    return { status: 'ok', leaseId: r.id, created: false, expiresAt: r.expires_at, sessionEndsAt: r.hard_expires_at };
  }
  // A refresh (no input) never starts a view: one that ended at its maximum or its idle limit stays ended until the person asks again, so a page that refreshes on a timer cannot hold a watch forever.
  if (!input.active) return { status: 'ended' };
  const counts = await client.query<{ repo: number; account: number }>(
    `SELECT count(*) FILTER (WHERE repo_id = $2)::int AS repo, count(*)::int AS account FROM engine_watch_leases WHERE account_id = $1 AND expires_at > now()`,
    [accountId, repoId],
  );
  const { repo, account } = counts.rows[0]!;
  if (repo >= limits.perRepo) return { status: 'limit', cap: 'repo', limit: limits.perRepo, inUse: repo };
  if (account >= limits.perAccount) return { status: 'limit', cap: 'account', limit: limits.perAccount, inUse: account };
  const idleS = limits.idleMinutes * 60;
  const inserted = await client.query<{ id: string; expires_at: Date; hard_expires_at: Date }>(
    `INSERT INTO engine_watch_leases (account_id, repo_id, user_id, browser_id, started_at, hard_expires_at, last_input_at, idle_limit_s, expires_at)
     SELECT $1, $2, $3, $4, now(), now() + make_interval(mins => $5::int), now(), $6::int,
            LEAST(now() + make_interval(secs => ${WATCH_LEASE_TTL_S}), now() + make_interval(mins => $5::int), now() + $6::int * interval '1 second')
     RETURNING id, expires_at, hard_expires_at`,
    [accountId, repoId, userId, browserId, limits.maxSessionMinutes, idleS],
  );
  const row = inserted.rows[0]!;
  return { status: 'ok', leaseId: row.id, created: true, expiresAt: row.expires_at, sessionEndsAt: row.hard_expires_at };
}

/**
 * Removes the caller's own lease for a repo and browser. Returns whether one was removed. The account and the user are in the predicate, so a lease of another user or another
 * account cannot be named by guessing its key.
 */
export async function releaseWatchLease(client: Pick<PoolClient, 'query'>, input: { accountId: string; repoId: string; userId: string; browserId: string }): Promise<boolean> {
  const { rowCount } = await client.query('DELETE FROM engine_watch_leases WHERE account_id = $1 AND repo_id = $2 AND user_id = $3 AND browser_id = $4', [input.accountId, input.repoId, input.userId, input.browserId]);
  return (rowCount ?? 0) > 0;
}

/** The event stream closing: removes the caller's lease by id (the stream knows only the id the route handed out). Scoped to the account and the user like the rest. */
export async function releaseWatchLeaseById(client: Pick<PoolClient, 'query'>, input: { accountId: string; userId: string; leaseId: string }): Promise<void> {
  await client.query('DELETE FROM engine_watch_leases WHERE id = $1 AND account_id = $2 AND user_id = $3', [input.leaseId, input.accountId, input.userId]);
}

/** Renews a live lease by id when a stream opens (the periodic renewal rides on the stream's re-check statement). Returns whether it was live and the caller's. */
export async function renewWatchLeaseById(client: Pick<PoolClient, 'query'>, input: { accountId: string; userId: string; leaseId: string }): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE engine_watch_leases SET expires_at = ${WATCH_RENEW_SET} WHERE id = $1 AND account_id = $2 AND user_id = $3 AND ${WATCH_RENEW_LIVE}`,
    [input.leaseId, input.accountId, input.userId],
  );
  return (rowCount ?? 0) > 0;
}

export type WatchCommandOutcome = 'issued' | 'held' | 'throttled' | 'runner_too_old' | 'before_ahead';

/**
 * Issues a `watch` command for the repo's runner when one is due, in the caller's name. Idempotent while a watch is held: a command alive with at least
 * {@link WATCH_COMMAND_REFRESH_S} left covers the request (`held`), and at most one command is issued per repo in {@link WATCH_COMMAND_MIN_GAP_S} seconds (`throttled`), so ten starts in
 * half a minute make one command. A "load older" request (`before`) is a new command whenever the gap allows it. The caller holds the account's watch lock (`takeWatchLease`), so the
 * read and the insert are one step per account. A full queue reads as `throttled`.
 */
export async function ensureWatchCommand(
  client: Pick<PoolClient, 'query'>,
  input: { accountId: string; repoId: string; runnerId: string; userId: string; before?: number },
): Promise<WatchCommandOutcome> {
  const state = await client.query<{ recent: boolean; covered: boolean }>(
    `SELECT COALESCE(bool_or(issued_at > now() - make_interval(secs => $3)), false) AS recent,
            COALESCE(bool_or(state IN ('pending', 'delivered', 'applied') AND expires_at > now() + make_interval(secs => $4)), false) AS covered
       FROM engine_commands WHERE account_id = $1 AND repo_id = $2 AND kind = 'watch'`,
    [input.accountId, input.repoId, WATCH_COMMAND_MIN_GAP_S, WATCH_COMMAND_REFRESH_S],
  );
  const { recent, covered } = state.rows[0]!;
  if (recent) return input.before === undefined && covered ? 'held' : 'throttled';
  if (covered && input.before === undefined) return 'held';
  const halt = (await readHaltStates(client, [input.repoId])).get(input.repoId)!;
  try {
    const issued = await insertWatchCommand(client, {
      accountId: input.accountId, runnerId: input.runnerId, repoId: input.repoId, issuedBy: input.userId, haltEpoch: halt.halt_epoch, untilSeconds: 600,
      ...(input.before === undefined ? {} : { before: input.before }),
    });
    if (issued.status !== 'ok') return issued.status;
    await writeEngineAudit(client, 'engine_command.issued', { repo_id: input.repoId, command_id: issued.command.id, kind: 'watch' });
    return 'issued';
  } catch (error) {
    if (error instanceof EngineCommandsBacklog) return 'throttled';
    throw error;
  }
}
