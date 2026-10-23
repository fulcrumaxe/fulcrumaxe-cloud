import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DiscoverySettings } from '@fx/plan-data';

/**
 * D#483 S4-b2b: the claim verifier's two daily limits, in one place for the sweep that refuses by them and the read that reports them.
 *
 *  - `discovery.externalVerifiesPerRepoPerDay`: how many verifier runs for outsiders' proposals one repository may start in a UTC day.
 *    `overExternalDailyLimit` is the one predicate: the sweep starts nothing for a proposal it holds, and the detail route's `verify_wait`
 *    reads `daily_limit` from the same call, so the two cannot disagree (no second count).
 *  - `discovery.perRepoDailyUsd`: what one repository's verifier runs may spend in a UTC day. `overRepoDailyUsd` is checked by the sweep
 *    before anything is reserved.
 *
 * `verifyHold` is the one function that decides which of the two (if either) holds a proposal. The sweep refuses by it and the detail
 * route's `verify_wait` reads it, so the two cannot drift.
 *
 * Both are counted from the run keys (`proposalVerifyKey`), so they need no stamp of their own. All reads run inside the caller's tenant
 * transaction, under the tables' own RLS.
 */

export const PROPOSAL_VERIFY_KEY_PREFIX = 'proposal-verify:';
export const VERIFY_WAITS = ['queued', 'daily_limit', 'daily_spend'] as const;
export type VerifyWait = (typeof VERIFY_WAITS)[number];

/** What a run key is made of: the proposal's id, the text the run is asked about, and the attempt. */
export interface VerifyKeyInput {
  id: string;
  title: string;
  summary: string | null;
  gh_number: number | null;
  discussion_number: number | null;
  verify_attempts: number;
}
type Query = Pick<PoolClient, 'query'>;

/** The proposal's source refs as the verifier is given them (`#<n>`). */
export const verifySourceRefs = (p: Pick<VerifyKeyInput, 'gh_number' | 'discussion_number'>): string[] =>
  [p.gh_number, p.discussion_number].filter((n): n is number => n !== null).map((n) => `#${n}`);

/** The first 8 hex of a hash of the proposal text a run is asked about (title, summary, source refs). */
const textHash8 = (p: VerifyKeyInput): string =>
  createHash('sha256').update(JSON.stringify([p.title, p.summary, verifySourceRefs(p)])).digest('hex').slice(0, 8);

/**
 * The current attempt's run key, `proposal-verify:<id>:<text_hash_8>:<attempts>`. The text is part of the key, so an edited proposal sent
 * back to `pending` starts a fresh key space. The id stays the second `:` field: the counters below read it there.
 */
export const proposalVerifyKey = (p: VerifyKeyInput): string => `${PROPOSAL_VERIFY_KEY_PREFIX}${p.id}:${textHash8(p)}:${p.verify_attempts}`;

/** Verifier runs keyed for one repository's proposals and started this UTC day. `$1` account, `$2` repo, `$3` the key prefix pattern. */
const runsToday = (externalOnly: boolean): string => `SELECT k.run_id FROM agent_run_idempotency_keys k
       JOIN proposals p ON p.account_id = k.account_id AND p.id::text = split_part(k.idempotency_key, ':', 2)
      WHERE k.account_id = $1 AND k.idempotency_key LIKE $3 AND k.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND p.repo_id = $2${externalOnly ? " AND p.provenance = 'external'" : ''}`;

/**
 * External proposals of one repository whose verifier run was started this UTC day. It counts run STARTS: every attempt's key is a row,
 * so a retry of the same proposal takes another place in the day. That is intended: each attempt spends.
 */
export async function externalVerifiesToday(client: Query, accountId: string, repoId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (${runsToday(true)}) x`,
    [accountId, repoId, `${PROPOSAL_VERIFY_KEY_PREFIX}%`],
  );
  return rows[0]?.n ?? 0;
}

/**
 * True when the daily external limit holds this proposal back: it is an outsider's, its current attempt has not started (a run that
 * already started is not held back, it is answered), and the repository has used its day.
 */
export async function overExternalDailyLimit(
  client: Query,
  accountId: string,
  p: VerifyKeyInput & { repo_id: string; provenance: string },
  limit: number,
): Promise<boolean> {
  if (p.provenance !== 'external') return false;
  const started = await client.query('SELECT 1 FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2', [accountId, proposalVerifyKey(p)]);
  if (started.rows.length > 0) return false;
  return (await externalVerifiesToday(client, accountId, p.repo_id)) >= limit;
}

/** What holds a pending proposal back today: the external-author limit or the repository's USD cap. */
export type VerifyHold = 'daily_limit' | 'daily_spend';

/** The figures `verifyHold` needs: the same three the sweep reads from plan data. */
export interface VerifyHoldLimits {
  externalVerifiesPerRepoPerDay: number;
  verifyPerProposalUsd: number;
  perRepoDailyUsd: number;
}

/**
 * The one decision both the sweep and the read use. Null when the proposal's current attempt already has a run (it is answered, not
 * held). Otherwise `daily_limit` when `overExternalDailyLimit` holds it, else `daily_spend` when `overRepoDailyUsd` holds it (one more
 * reservation of `verifyPerProposalUsd` against `perRepoDailyUsd`), else null. When both hold, `daily_limit` wins. The sweep refuses by
 * this before it resolves a seat or reserves anything.
 */
export async function verifyHold(
  client: Query,
  accountId: string,
  p: VerifyKeyInput & { repo_id: string; provenance: string },
  limits: VerifyHoldLimits,
): Promise<VerifyHold | null> {
  const started = await client.query('SELECT 1 FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2', [accountId, proposalVerifyKey(p)]);
  if (started.rows.length > 0) return null;
  if (await overExternalDailyLimit(client, accountId, p, limits.externalVerifiesPerRepoPerDay)) return 'daily_limit';
  if (await overRepoDailyUsd(client, accountId, p.repo_id, limits.verifyPerProposalUsd, limits.perRepoDailyUsd)) return 'daily_spend';
  return null;
}

/**
 * The detail route's `verify_wait`: null unless the proposal is `pending`; then what `verifyHold` says (`daily_limit` or `daily_spend`),
 * else `queued`. With verification off (`discovery_unconfigured`) nothing is held by a limit, so a pending proposal reads `queued`.
 */
export async function verifyWait(
  client: Query,
  accountId: string,
  p: VerifyKeyInput & { repo_id: string; provenance: string; verification: string },
  settings: DiscoverySettings,
): Promise<VerifyWait | null> {
  if (p.verification !== 'pending') return null;
  if (!settings.on) return 'queued';
  return (await verifyHold(client, accountId, p, settings)) ?? 'queued';
}

/**
 * True when starting one more verifier run that reserves `nextUsd` would take the repository past `capUsd` today: the ledger rows (model
 * and compute) of the repository's verifier runs started this UTC day, plus their open reservations, plus `nextUsd`. Settled reservations
 * are not counted (their spend is in the ledger), so nothing is counted twice. Compared in `numeric`, never in binary fractions.
 */
export async function overRepoDailyUsd(client: Query, accountId: string, repoId: string, nextUsd: number, capUsd: number): Promise<boolean> {
  const { rows } = await client.query<{ over: boolean }>(
    `WITH runs AS (${runsToday(false)})
     SELECT (COALESCE((SELECT sum(l.usd) FROM ledger l WHERE l.account_id = $1 AND l.run_id IN (SELECT run_id FROM runs)), 0)
           + COALESCE((SELECT sum(s.usd_reserved) FROM spend_reservations s WHERE s.account_id = $1 AND s.state = 'open' AND s.run_id IN (SELECT run_id FROM runs)), 0)
           + $4::numeric) > $5::numeric AS over`,
    [accountId, repoId, `${PROPOSAL_VERIFY_KEY_PREFIX}%`, String(nextUsd), String(capUsd)],
  );
  // No answer is no room: fail closed.
  return rows[0]?.over !== false;
}
