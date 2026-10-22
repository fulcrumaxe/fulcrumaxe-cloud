import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { MAX_VERIFY_ATTEMPTS } from "@fx/core/src/plan/proposalVerification.js";
import { reportError } from "@fx/telemetry";
import { PROPOSAL_VERIFIER_ROLE, VERIFIER_WORKDIR, type StartAgentRunInput } from "@fx/runner";
import type { RunStarter } from "./preview.js";
import type { SeatRequest, SeatResult } from "./seat.js";

/**
 * D#483 S4-b2a: the claim verifier's sweep, the cron's body. One pass, under one advisory lock (a second sweep that finds it held does nothing):
 *
 *  1. The cross-account list (migration 0889) names proposals waiting to be checked: `pending`, or `check_failed` with attempts left.
 *  2. For each, under its own tenant, the run for its current attempt is looked up by its idempotency key,
 *     `proposal-verify:<id>:<text_hash_8>:<attempts>` (`verifyKey`): the text is part of the key, so an edited proposal sent back to `pending`
 *     (attempts at 0 again) starts a fresh key space instead of meeting a run made for its old text.
 *     - No run yet: an external proposal over its repository's daily limit waits ("daily limit") with nothing reserved. Otherwise the
 *       default branch's head is read through the read-only plan client and pinned, the seat is resolved (purpose "verify": the per-proposal
 *       figure is both the run's cap and its reservation) and the run starts: role proposal-verifier, the pinned commit itself fetched and
 *       checked out read-only (the launch fails if it cannot be, which records `check_failed`), the pinned sha on the run row (`head_sha`), and
 *       its Read, Glob and Grep confined to the checkout (agentConfig.ts). The agent reads exactly the tree every cite is re-read at.
 *     - A run still going: wait for the next pass.
 *     - A run that ended: its envelope goes through S4-b1's `recordFromOutput` (the system re-reads every cite at the pinned sha) and the
 *       result is written by `proposal_record_verification`, the only writer. A run refused at admit, failed, timed out, killed at its cap or
 *       cancelled records `check_failed`, never a verdict; the definer counts the attempt, so the next attempt has a new key and the third
 *       failure is the last (MAX_VERIFY_ATTEMPTS).
 * The pipeline decides everything here; the model's output is only parsed (R-597-1). Nothing here changes a proposal's state, approval or
 * work item (the definer refuses it).
 *
 * The verifier's pieces from @fx/pipeline (prompt, parser, the `discovery.*` reader) are injected: this package does not import it.
 */

export const VERIFY_LIST_LIMIT = 50;
/** A pass stops starting proposals after this long, leaving the rest to the next tick. */
export const VERIFY_PASS_BUDGET_MS = 40_000;
const SWEEP_LOCK = "fx:proposal_verify_sweep";
const KEY_PREFIX = "proposal-verify:";
const ENDED = new Set(["succeeded", "refused_spend", "failed", "timed_out", "killed_spend", "cancelled"]);
const SHA_RE = /^[0-9a-f]{40}$/;

export type VerifyVerdict = "verified" | "partly_verified" | "refuted" | "not_checked" | "check_failed";
/** What S4-b1's `recordFromOutput` returns, in the definer's argument shape. */
export interface VerifyRecord {
  verification: VerifyVerdict;
  verified_sha: string | null;
  claims: ReadonlyArray<{ text: string; verdict: string; refute_code?: string }>;
  evidence: ReadonlyArray<{ kind: string; ref: string; excerpt: string; commit_sha: string }>;
}
/** One repository through the read-only plan client: its default branch's head, and a file at a commit (null when absent). */
export interface VerifyRepoReader {
  headSha(): Promise<string>;
  readFile(path: string, sha: string): Promise<string | null>;
}
export type VerifySettings = { on: false; code: string } | { on: true; verifyPerProposalUsd: number; externalVerifiesPerRepoPerDay: number };

export interface ProposalVerifyDeps {
  /** The runner login's pool (it holds EXECUTE on the list). */
  pool: Pool;
  resolveSeat: (request: SeatRequest) => Promise<SeatResult>;
  /** The production run starter, idempotent on the key; sandbox-only (`queued: "refuse"`). */
  starter: RunStarter;
  github: (target: { repoId: string; owner: string; name: string }) => VerifyRepoReader;
  /** plan-data's `discoverySettings` (fail closed). */
  settings: () => VerifySettings;
  /** pipeline's `buildVerifierPrompt`. */
  prompt: (input: { owner: string; name: string; sha: string; title: string; summary: string | null; sourceRefs: string[] }) => string;
  /** pipeline's `recordFromOutput`. */
  record: (input: { envelope: unknown; sha: string; reader: VerifyRepoReader }) => Promise<VerifyRecord>;
  now?: () => number;
}

export interface ProposalVerifyCounts {
  /** Why the pass did nothing: verification is off (`discovery_unconfigured`) or another pass holds the lock (`busy`). */
  idle?: string;
  listed: number;
  started: number;
  waiting: number;
  recorded: number;
  daily_limit: number;
  skipped: number;
  failed: number;
}
type Outcome = "started" | "waiting" | "recorded" | "daily_limit" | "skipped";

interface ProposalRow {
  id: string;
  repo_id: string;
  title: string;
  summary: string | null;
  provenance: string;
  gh_number: number | null;
  discussion_number: number | null;
  verification: string;
  verify_attempts: number;
  gh_owner: string | null;
  gh_name: string | null;
}
interface RunRow {
  id: string;
  status: string;
  head_sha: string | null;
  envelope: unknown;
  request_hash: string;
}

const FAILED: VerifyRecord = { verification: "check_failed", verified_sha: null, claims: [], evidence: [] };

/**
 * External proposals of one repository whose verifier run was started this UTC day: the one counter the daily limit refuses by (and
 * the read side's `verify_wait` will derive from). Counted from the run claims, so it needs no stamp of its own. It counts run STARTS:
 * every attempt's key is a row, so a retry of the same proposal takes another place in the day. That is intended: each attempt spends.
 * The proposal id is read as the second `:` field of the key (`verifyKey`), which the text hash after it does not move.
 */
export async function externalVerifiesToday(client: Pick<PoolClient, "query">, accountId: string, repoId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_run_idempotency_keys k
       JOIN proposals p ON p.account_id = k.account_id AND p.id::text = split_part(k.idempotency_key, ':', 2)
      WHERE k.account_id = $1 AND k.idempotency_key LIKE $3 AND k.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND p.repo_id = $2 AND p.provenance = 'external'`,
    [accountId, repoId, `${KEY_PREFIX}%`],
  );
  return rows[0]?.n ?? 0;
}

const eligible = (p: { verification: string; verify_attempts: number }): boolean =>
  p.verification === "pending" || (p.verification === "check_failed" && p.verify_attempts < MAX_VERIFY_ATTEMPTS);
const sourceRefs = (p: ProposalRow): string[] => [p.gh_number, p.discussion_number].filter((n): n is number => n !== null).map((n) => `#${n}`);
/** The first 8 hex of a hash of the proposal text the request hash covers (title, summary, source refs). */
const textHash8 = (p: ProposalRow): string => createHash("sha256").update(JSON.stringify([p.title, p.summary, sourceRefs(p)])).digest("hex").slice(0, 8);
/** The current attempt's run key. The id stays the second `:` field (externalVerifiesToday reads it there). */
const verifyKey = (p: ProposalRow): string => `${KEY_PREFIX}${p.id}:${textHash8(p)}:${p.verify_attempts}`;
/** What the run was started for: a run made for other text (an edited proposal sent back to `pending`) is not its answer. */
const requestHash = (p: ProposalRow): string =>
  createHash("sha256").update(JSON.stringify(["proposal-verify", p.id, p.verify_attempts, p.title, p.summary, sourceRefs(p)])).digest("hex");

async function readProposal(client: PoolClient, accountId: string, proposalId: string): Promise<ProposalRow | undefined> {
  const { rows } = await client.query<ProposalRow>(
    `SELECT p.id, p.repo_id, p.title, p.summary, p.provenance, p.gh_number, p.discussion_number, p.verification, p.verify_attempts, r.gh_owner, r.gh_name
       FROM proposals p JOIN repos r ON r.account_id = p.account_id AND r.id = p.repo_id
      WHERE p.account_id = $1 AND p.id = $2 AND p.state = 'new' AND p.owner_process = 'product'`,
    [accountId, proposalId],
  );
  return rows[0];
}

async function readRun(client: PoolClient, accountId: string, key: string): Promise<RunRow | undefined> {
  const { rows } = await client.query<RunRow>(
    `SELECT r.id, r.status, r.head_sha, r.envelope, k.request_hash FROM agent_run_idempotency_keys k
       JOIN agent_runs r ON r.account_id = k.account_id AND r.id = k.run_id
      WHERE k.account_id = $1 AND k.idempotency_key = $2`,
    [accountId, key],
  );
  return rows[0];
}

export function createProposalVerifySweep(deps: ProposalVerifyDeps): () => Promise<ProposalVerifyCounts> {
  const now = deps.now ?? Date.now;

  /** Records the outcome of an ended run, if the proposal is still waiting on exactly that run. */
  async function settle(accountId: string, p: ProposalRow, run: RunRow): Promise<Outcome> {
    if (!ENDED.has(run.status)) return "waiting";
    const repo = { repoId: p.repo_id, owner: p.gh_owner ?? "", name: p.gh_name ?? "" };
    let rec: VerifyRecord = FAILED;
    // Only a run that finished, for this text, at a pinned sha, has an answer to read. Anything else is a failed check.
    if (run.status === "succeeded" && run.request_hash === requestHash(p) && run.head_sha !== null && SHA_RE.test(run.head_sha)) {
      rec = await deps.record({ envelope: run.envelope, sha: run.head_sha, reader: deps.github(repo) });
    }
    return withTenant(deps.pool, accountId, async (client): Promise<Outcome> => {
      // Read again in the writing transaction: a proposal that moved on (decided, edited, recorded by another pass) is left alone.
      const fresh = await readProposal(client, accountId, p.id);
      if (!fresh || !eligible(fresh) || fresh.verify_attempts !== p.verify_attempts || requestHash(fresh) !== requestHash(p)) return "skipped";
      const named = rec.verification === "verified" || rec.verification === "partly_verified";
      await client.query("SELECT * FROM proposal_record_verification($1::uuid, $2::text, $3::text, $4::uuid, $5::jsonb, $6::jsonb)", [
        p.id,
        rec.verification,
        rec.verification === "check_failed" || rec.verification === "not_checked" ? null : rec.verified_sha,
        named ? run.id : null,
        JSON.stringify(rec.claims),
        JSON.stringify(rec.evidence),
      ]);
      return "recorded";
    });
  }

  async function verifyOne(settings: Extract<VerifySettings, { on: true }>, accountId: string, proposalId: string): Promise<Outcome> {
    const found = await withTenant(deps.pool, accountId, async (client) => {
      const p = await readProposal(client, accountId, proposalId);
      if (!p || !eligible(p)) return null;
      const key = verifyKey(p);
      const run = await readRun(client, accountId, key);
      // The daily limit is read before anything is reserved: a proposal over it starts nothing and stays `pending`.
      const over = run === undefined && p.provenance === "external" && (await externalVerifiesToday(client, accountId, p.repo_id)) >= settings.externalVerifiesPerRepoPerDay;
      return { p, key, run, over };
    });
    if (found === null) return "skipped";
    const { p, key, run, over } = found;
    if (run !== undefined) return settle(accountId, p, run);
    if (over) return "daily_limit";
    if (!p.gh_owner || !p.gh_name) return "skipped";

    const repo = { repoId: p.repo_id, owner: p.gh_owner, name: p.gh_name };
    let sha: string;
    try {
      sha = await deps.github(repo).headSha();
    } catch (err) {
      // GitHub could not be asked: nothing was spent and no attempt is used; the next pass asks again.
      reportError(err, { stage: "proposal_verify.head" });
      return "skipped";
    }
    if (!SHA_RE.test(sha)) return "skipped";
    const seat = await deps.resolveSeat({ accountId, role: PROPOSAL_VERIFIER_ROLE, repoId: p.repo_id, purpose: "verify", capUsd: settings.verifyPerProposalUsd });
    if (!seat.ok) return "skipped";
    const cap = settings.verifyPerProposalUsd;
    if (seat.seat.capUsd !== cap || seat.seat.spend.estimateModelUsd !== cap || seat.seat.spend.perSpawnCapUsd !== cap) return "skipped";

    const input: StartAgentRunInput = {
      ...seat.seat,
      accountId,
      repoId: p.repo_id,
      role: PROPOSAL_VERIFIER_ROLE,
      product: "team",
      expectedExecutionMode: "sandbox",
      prompt: deps.prompt({ owner: p.gh_owner, name: p.gh_name, sha, title: p.title, summary: p.summary, sourceRefs: sourceRefs(p) }),
      workdir: VERIFIER_WORKDIR,
      // The pinned commit, not the default branch: the agent reads the tree its cites are re-read at, or the launch fails.
      cloneRepo: { owner: p.gh_owner, name: p.gh_name, sha },
      headSha: sha,
      idempotency: { key, requestHash: requestHash(p) },
    };
    await deps.starter.start(input);
    // A run refused at admit has already ended: record it now rather than on the next pass.
    const after = await withTenant(deps.pool, accountId, (client) => readRun(client, accountId, key));
    return after !== undefined && ENDED.has(after.status) ? settle(accountId, p, after) : "started";
  }

  return async function sweepProposalVerification(): Promise<ProposalVerifyCounts> {
    const counts: ProposalVerifyCounts = { listed: 0, started: 0, waiting: 0, recorded: 0, daily_limit: 0, skipped: 0, failed: 0 };
    const settings = deps.settings();
    if (!settings.on) return { ...counts, idle: settings.code };
    // One pass at a time: a transaction-scoped try-lock on its own connection, held for the whole pass and ended with it. That connection
    // stays checked out for the whole pass (up to VERIFY_PASS_BUDGET_MS plus one run), so the pool needs at least one more free connection
    // for the per-proposal `withTenant` work and the run starter.
    const lock = await deps.pool.connect();
    try {
      await lock.query("BEGIN");
      const got = await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [SWEEP_LOCK]);
      if (got.rows[0]?.ok !== true) return { ...counts, idle: "busy" };
      const { rows } = await deps.pool.query<{ account_id: string; proposal_id: string }>("SELECT account_id, proposal_id FROM proposal_verify_list_due($1::integer)", [VERIFY_LIST_LIMIT]);
      counts.listed = rows.length;
      const startedAt = now();
      for (const r of rows) {
        if (now() - startedAt > VERIFY_PASS_BUDGET_MS) break;
        try {
          counts[await verifyOne(settings, r.account_id, r.proposal_id)] += 1;
        } catch (err) {
          // One proposal that cannot be checked never holds up the rest; it is listed again next pass.
          reportError(err, { stage: "proposal_verify.item" });
          counts.failed += 1;
        }
      }
      return counts;
    } finally {
      await lock.query("COMMIT").catch((err: unknown) => reportError(err, { stage: "proposal_verify.unlock" }));
      lock.release();
    }
  };
}
