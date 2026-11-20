import type { PoolClient } from 'pg';
import { BRIDGE_ENABLE_MIN_PROTOCOL } from '@fulcrumaxe/runner-protocol';

/**
 * The SQL behind one-click Connect and Disconnect (D#845 ON-BR-2, migration 1042). Every function runs on a tenant transaction (a person's `withTenant`) and
 * names the account in every predicate beside RLS. A bridge command goes to a RUNNER the account owns that is paired with the repo, never to a repo's engine session.
 */

/** The kinds that go to a runner and not to an engine session. */
export const BRIDGE_KINDS = ['bridge_enable', 'bridge_disable'] as const;
/** The most bridge commands an account may issue in {@link BRIDGE_RATE_WINDOW_S} seconds. */
export const BRIDGE_RATE_MAX = 5;
export const BRIDGE_RATE_WINDOW_S = 600;
/** How long the folders a runner offered stay pickable, in seconds. */
export const BRIDGE_OFFER_WINDOW_S = 600;
/** A reported checkout, and with it "connected", is read as gone this long after the runner last reported it (24 h). */
export const BRIDGE_REPORT_FRESH_S = 24 * 3600;
/** A runner is online when heard from within this many seconds, or within {@link RUNNER_WAKE_LIVE_S} when it holds a wake grant (the fleet's own rule, `runnerLiveSql`). */
const RUNNER_ONLINE_S = 120;
const RUNNER_WAKE_LIVE_S = 35 * 60;

export interface BridgeRunner {
  id: string;
  name: string;
  /** False when `name` is the placeholder, so a screen can say the runner has no name yet. */
  has_name: boolean;
  last_seen_at: Date | null;
  online: boolean;
  /** At the protocol that takes `bridge_enable` (`BRIDGE_ENABLE_MIN_PROTOCOL`). */
  protocol_ok: boolean;
}

/**
 * The account's runners that are paired with the repo and not revoked, oldest first. The repo must be the account's and run on a runner (else `null`: the caller answers 404).
 * `online` follows the fleet's own test: 120 s, or 35 min for a runner that holds a wake grant.
 */
export async function listBridgeRunners(client: Pick<PoolClient, 'query'>, accountId: string, repoId: string): Promise<BridgeRunner[] | null> {
  const repo = await client.query<{ ok: boolean }>("SELECT execution_mode = 'runner_local' AS ok FROM repos WHERE id = $1 AND account_id = $2", [repoId, accountId]);
  if (repo.rows[0] === undefined) return null;
  if (repo.rows[0].ok !== true) return [];
  const { rows } = await client.query<{ id: string; set_name: string | null; registrant: string; last_seen_at: Date | null; protocol_version: number | null; online: boolean }>(
    `SELECT rn.id, st.name AS set_name, COALESCE(NULLIF(u.name, ''), NULLIF(u.github_login, ''), 'unknown') AS registrant, rn.last_seen_at, rn.protocol_version,
            COALESCE(rn.last_seen_at >= now() - make_interval(secs => $3)
                     OR (rn.last_seen_at >= now() - make_interval(secs => $4) AND 'wake_v1' = ANY (rc.capabilities)), false) AS online
       FROM runners rn
       LEFT JOIN users u ON u.id = rn.registered_by
       LEFT JOIN runner_settings st ON st.runner_id = rn.id AND st.account_id = rn.account_id
       LEFT JOIN runner_capabilities rc ON rc.runner_id = rn.id AND rc.account_id = rn.account_id
      WHERE rn.account_id = $1 AND rn.revoked_at IS NULL AND $2::uuid = ANY (rn.allowed_repo_ids)
      ORDER BY rn.created_at, rn.id`,
    [accountId, repoId, RUNNER_ONLINE_S, RUNNER_WAKE_LIVE_S],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.set_name ?? `Unnamed runner (${r.registrant})`,
    has_name: r.set_name !== null,
    last_seen_at: r.last_seen_at,
    online: r.online,
    protocol_ok: r.protocol_version !== null && r.protocol_version >= BRIDGE_ENABLE_MIN_PROTOCOL,
  }));
}

/**
 * Takes the account's bridge lock for the rest of the transaction, so the rate count and the pending check below, and the insert after them, are one step: two clicks at once see each other.
 */
export async function lockBridgeIssue(client: Pick<PoolClient, 'query'>, accountId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('engine_bridge_issue:' || $1::text, 0))`, [accountId]);
}

/** How many bridge commands the account issued in the last {@link BRIDGE_RATE_WINDOW_S} seconds, whatever became of them. */
export async function countRecentBridgeCommands(client: Pick<PoolClient, 'query'>, accountId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM engine_commands WHERE account_id = $1 AND kind = ANY ($2::text[]) AND issued_at > now() - make_interval(secs => $3)`,
    [accountId, [...BRIDGE_KINDS], BRIDGE_RATE_WINDOW_S],
  );
  return Number(rows[0]!.n);
}

/** True while a bridge command for the repo is still undelivered (pending and inside its life). */
export async function hasPendingBridgeCommand(client: Pick<PoolClient, 'query'>, accountId: string, repoId: string): Promise<boolean> {
  const { rows } = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM engine_commands WHERE account_id = $1 AND repo_id = $2 AND kind = ANY ($3::text[]) AND state = 'pending' AND expires_at > now() LIMIT 1`,
    [accountId, repoId, [...BRIDGE_KINDS]],
  );
  return rows.length > 0;
}

/**
 * True when `root` is one of the folders `runnerId` offered for this repo in an answer within the last {@link BRIDGE_OFFER_WINDOW_S} seconds. A person may carry only a folder the runner
 * itself put on the table: an arbitrary typed path is never accepted.
 */
export async function rootWasOffered(client: Pick<PoolClient, 'query'>, accountId: string, repoId: string, runnerId: string, root: string): Promise<boolean> {
  const { rows } = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM engine_commands
      WHERE account_id = $1 AND repo_id = $2 AND runner_id = $3 AND kind = 'bridge_enable' AND state = 'refused'
        AND acked_at > now() - make_interval(secs => $4)
        AND ack_result -> 'candidates' @> to_jsonb($5::text)
      LIMIT 1`,
    [accountId, repoId, runnerId, BRIDGE_OFFER_WINDOW_S, root],
  );
  return rows.length > 0;
}

export interface BridgeCommandView {
  id: string;
  kind: 'bridge_enable' | 'bridge_disable';
  runner_id: string;
  state: 'pending' | 'delivered' | 'applied' | 'refused' | 'expired' | 'cancelled' | 'not_confirmed';
  refusal: string | null;
  result: string | null;
  root_tail: string | null;
  /** The folders the runner offered, whole paths: show only to an owner or admin. */
  candidates: string[];
  /** Copies the runner skipped as unsafe: information only, never offered for a pick. */
  skipped: string[];
  /** True when a `not_found` answer came from a search that hit its time or entry cap, so a copy may exist past it (ON-BR-4). False for every other answer, and for an answer from a runner that never says. */
  incomplete: boolean;
  issued_at: Date;
  expires_at: Date;
  delivered_at: Date | null;
  acked_at: Date | null;
}

/** The newest bridge command for the repo with its state as the routes read time (a pending one past its life is `expired`, a delivered one 15 minutes past its life `not_confirmed`). */
export async function latestBridgeCommand(client: Pick<PoolClient, 'query'>, accountId: string, repoId: string, notConfirmedAfterS: number): Promise<BridgeCommandView | null> {
  const { rows } = await client.query<{
    id: string; kind: BridgeCommandView['kind']; runner_id: string; state: BridgeCommandView['state']; refusal: string | null; ack_result: { result?: string; root_tail?: string; candidates?: string[]; skipped?: string[]; incomplete?: boolean } | null;
    issued_at: Date; expires_at: Date; delivered_at: Date | null; acked_at: Date | null;
  }>(
    `SELECT id, kind, runner_id,
            CASE WHEN state = 'pending' AND expires_at <= now() THEN 'expired'
                 WHEN state = 'delivered' AND expires_at + make_interval(secs => $4) <= now() THEN 'not_confirmed'
                 ELSE state END AS state,
            refusal, ack_result, issued_at, expires_at, delivered_at, acked_at
       FROM engine_commands
      WHERE account_id = $1 AND repo_id = $2 AND kind = ANY ($3::text[])
      ORDER BY issued_at DESC, command_seq DESC LIMIT 1`,
    [accountId, repoId, [...BRIDGE_KINDS], notConfirmedAfterS],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: r.id,
    kind: r.kind,
    runner_id: r.runner_id,
    state: r.state,
    refusal: r.refusal,
    result: r.ack_result?.result ?? null,
    root_tail: r.ack_result?.root_tail ?? null,
    candidates: r.ack_result?.candidates ?? [],
    skipped: r.ack_result?.skipped ?? [],
    incomplete: r.ack_result?.result === 'not_found' && r.ack_result.incomplete === true,
    issued_at: r.issued_at,
    expires_at: r.expires_at,
    delivered_at: r.delivered_at,
    acked_at: r.acked_at,
  };
}

export interface ReportedBridge {
  runner_id: string;
  root: string | null;
  reported_at: Date;
}

/** The runners that reported bridging the repo within {@link BRIDGE_REPORT_FRESH_S} (and are not revoked). This is what "connected" is derived from. */
export async function reportedBridges(client: Pick<PoolClient, 'query'>, accountId: string, repoId: string): Promise<ReportedBridge[]> {
  const { rows } = await client.query<ReportedBridge>(
    `SELECT b.runner_id, b.root, b.reported_at
       FROM engine_runner_bridges b JOIN runners rn ON rn.id = b.runner_id AND rn.account_id = b.account_id AND rn.revoked_at IS NULL
      WHERE b.account_id = $1 AND b.repo_id = $2 AND b.reported_at > now() - make_interval(secs => $3)
      ORDER BY b.reported_at DESC`,
    [accountId, repoId, BRIDGE_REPORT_FRESH_S],
  );
  return rows;
}

/** Seconds until the account may issue another bridge command: when the fifth newest one inside the window leaves it (at least 1). */
export async function recentBridgeRetryAfterS(client: Pick<PoolClient, 'query'>, accountId: string): Promise<number> {
  const { rows } = await client.query<{ wait: string }>(
    `SELECT GREATEST(1, ceil(extract(epoch FROM (issued_at + make_interval(secs => $3) - now()))))::text AS wait
       FROM engine_commands WHERE account_id = $1 AND kind = ANY ($2::text[]) AND issued_at > now() - make_interval(secs => $3)
      ORDER BY issued_at DESC OFFSET $4 - 1 LIMIT 1`,
    [accountId, [...BRIDGE_KINDS], BRIDGE_RATE_WINDOW_S, BRIDGE_RATE_MAX],
  );
  return Number(rows[0]?.wait ?? 1);
}

export const BRIDGE_PHASES = ['connecting', 'connected', 'disconnecting', 'not_found', 'ambiguous', 'incomplete', 'refused', 'not_confirmed', 'expired', 'disconnect_failed', 'disconnect_refused', 'idle'] as const;
export const BRIDGE_PLANS = ['send', 'choose', 'no_runner', 'offline', 'old'] as const;

/** What a Connect press would do, from the runners that are paired with the repo. */
export function bridgePlan(runners: readonly BridgeRunner[]): (typeof BRIDGE_PLANS)[number] {
  if (runners.length === 0) return 'no_runner';
  const ready = runners.filter((r) => r.online && r.protocol_ok);
  if (ready.length === 1) return 'send';
  if (ready.length > 1) return 'choose';
  return runners.some((r) => r.online) ? 'old' : 'offline';
}

const OFFER_WINDOW_MS = 600_000;
/** The phase the repo is in, derived from the runners' reports and the newest command; never a stored word. */
export function bridgePhase(input: { connected: boolean; command: BridgeCommandView | null; now: Date }): (typeof BRIDGE_PHASES)[number] {
  const { command: c } = input;
  // A disconnect that ran out of its 600 s unanswered did not happen: the repo is not shown as connected as if nothing was asked, and not as disconnecting either. It says the disconnect did not reach the runner,
  // until a newer command is answered or the runners' reports no longer list the repo (ruling 8).
  const lapsed = c !== null && c.kind === 'bridge_disable' && (c.state === 'expired' || c.state === 'not_confirmed' || (c.state === 'delivered' && c.expires_at.getTime() <= input.now.getTime()));
  if (lapsed && input.connected) return 'disconnect_failed';
  // A disconnect the runner refused did not happen either: it says so (with the reason, from the command) instead of silently showing connected.
  if (input.connected && c !== null && c.kind === 'bridge_disable' && c.state === 'refused') return 'disconnect_refused';
  const alive = c !== null && (c.state === 'pending' || c.state === 'delivered') && !lapsed;
  if (alive && c.kind === 'bridge_disable') return 'disconnecting';
  if (alive && c.kind === 'bridge_enable') return 'connecting';
  if (input.connected) return 'connected';
  if (c === null || c.kind !== 'bridge_enable') return 'idle';
  // An answer is shown for as long as its offered folders can still be picked, then the screen goes back to idle.
  const fresh = c.acked_at !== null && input.now.getTime() - c.acked_at.getTime() <= OFFER_WINDOW_MS;
  if (c.state === 'not_confirmed' || c.state === 'expired') return c.state;
  if (!fresh) return 'idle';
  if (c.result === 'ambiguous') return 'ambiguous';
  if (c.result === 'not_found') return 'not_found';
  if (c.refusal === 'checkout_incomplete') return 'incomplete';
  if (c.state === 'refused') return 'refused';
  return 'idle';
}

