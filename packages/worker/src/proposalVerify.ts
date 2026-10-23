import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { MAX_VERIFY_ATTEMPTS } from "@fx/core/src/plan/proposalVerification.js";
import { proposalVerifyKey, verifyHold, verifySourceRefs } from "@fx/core/src/plan/proposalVerifyLimits.js";
import { reportError } from "@fx/telemetry";
import { PROPOSAL_VERIFIER_ROLE, VERIFIER_WORKDIR, readExecutionMode, type RepoVisibility, type RepoVisibilityPort, type StartAgentRunInput } from "@fx/runner";
import type { RunStarter } from "./preview.js";
import type { SeatRequest, SeatResult } from "./seat.js";

/**
 * D#483 S4-b2a: the claim verifier's sweep, the cron's body. One pass, under one advisory lock (a second sweep that finds it held does nothing):
 *
 *  1. The cross-account list (migration 0889) names proposals waiting to be checked: `pending`, or `check_failed` with attempts left.
 *  2. For each, under its own tenant, the run for its current attempt is looked up by its idempotency key,
 *     `proposal-verify:<id>:<text_hash_8>:<attempts>` (`verifyKey`): the text is part of the key, so an edited proposal sent back to `pending`
 *     (attempts at 0 again) starts a fresh key space instead of meeting a run made for its old text.
 *     - No run yet: an external proposal over its repository's daily limit waits ("daily limit") with nothing reserved, and so does any
 *       proposal whose run would take its repository's verifier spend today past `perRepoDailyUsd` ("daily cap"). Both limits are
 *       @fx/core's proposalVerifyLimits.ts, the same functions the detail route's `verify_wait` reads (S4-b2b). Otherwise the
 *       default branch's head is read through the read-only plan client and pinned, the seat is resolved (purpose "verify": the per-proposal
 *       figure is both the run's cap and its reservation) and the run starts: role proposal-verifier, the pinned commit itself fetched and
 *       checked out read-only (the launch fails if it cannot be, which records `check_failed`), the pinned sha on the run row (`head_sha`), and
 *       its Read, Glob and Grep confined to the checkout (agentConfig.ts). The agent reads exactly the tree every cite is re-read at.
 *     - A run still going: wait for the next pass.
 *     - A run that ended: its envelope goes through S4-b1's `recordFromOutput` (the system re-reads every cite at the pinned sha) and the
 *       result is written by `proposal_record_verification`, the only writer. A run refused at admit, failed, timed out, killed at its cap or
 *       cancelled records `check_failed`, never a verdict; the definer counts the attempt, so the next attempt has a new key and the third
 *       failure is the last (MAX_VERIFY_ATTEMPTS).
 *
 * D#483 S4-b2c: where the run goes is the repository's effective mode, read when the run is started:
 *  - `sandbox`: our sandbox, as above, through the sandbox-only starter.
 *  - `runner_verified` (Cloud-verified): a light job on the person's runner, through the starter that leaves a queued runner run pending
 *    (this sweep's wait is its next pass, which reads the run's status, so queued time is credited). The repository must read as private
 *    from GitHub now (`visibility`); anything else (public, unknown, a failed read) starts nothing and uses no attempt. The job carries the
 *    pinned commit (the runner checks it out, detached), and its result is recorded exactly as a sandbox run's: our cloud re-reads every cite
 *    at the pinned sha, as it already reads such a repository for its reviews.
 *  - `runner_local` (Local-only), or anything else: nothing. Our cloud never reads a Local-only repository's files, so its proposals wait for a
 *    runner-side check (a later row). The lister (0889/0893) leaves them out; this is the second lock.
 * The pipeline decides everything here; the model's output is only parsed (R-597-1). Nothing here changes a proposal's state, approval or
 * work item (the definer refuses it).
 *
 * The verifier's pieces from @fx/pipeline (prompt, parser, the `discovery.*` reader) are injected: this package does not import it.
 */

export const VERIFY_LIST_LIMIT = 50;
/** A pass stops starting proposals after this long, leaving the rest to the next tick. */
export const VERIFY_PASS_BUDGET_MS = 40_000;
const SWEEP_LOCK = "fx:proposal_verify_sweep";
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
export type VerifySettings = { on: false; code: string } | { on: true; perRepoDailyUsd: number; verifyPerProposalUsd: number; externalVerifiesPerRepoPerDay: number };

export interface ProposalVerifyDeps {
  /** The runner login's pool (it holds EXECUTE on the list). */
  pool: Pool;
  resolveSeat: (request: SeatRequest) => Promise<SeatResult>;
  /** The production run starter, idempotent on the key; sandbox-only (`queued: "refuse"`). */
  starter: RunStarter;
  /** S4-b2c: the starter for a `runner_verified` repository's run (`queued: "accept"`). Absent: such a proposal starts nothing. */
  runnerStarter?: RunStarter;
  /** S4-b2c: the repository visibility port (GitHub metadata). Absent, or anything but `private`: a runner run is not started. */
  visibility?: RepoVisibilityPort;
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
  /** Held by `perRepoDailyUsd`: the repository's verifier spend today leaves no room for one more reservation. */
  daily_cap: number;
  skipped: number;
  failed: number;
}
type Outcome = "started" | "waiting" | "recorded" | "daily_limit" | "daily_cap" | "skipped";

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

/** The daily external counter, defined once in @fx/core (the read side's `verify_wait` derives from it too). */
export { externalVerifiesToday } from "@fx/core/src/plan/proposalVerifyLimits.js";

const eligible = (p: { verification: string; verify_attempts: number }): boolean =>
  p.verification === "pending" || (p.verification === "check_failed" && p.verify_attempts < MAX_VERIFY_ATTEMPTS);
const sourceRefs = verifySourceRefs;
/** The current attempt's run key (@fx/core's `proposalVerifyKey`, which the limits count by). */
const verifyKey = proposalVerifyKey;
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

  /** S4-b2c: the starter and mode a new run of this repository uses, or null when none may start (see the header). */
  async function placementFor(accountId: string, repoId: string): Promise<{ mode: "sandbox" | "runner_verified"; starter: RunStarter } | null> {
    const mode = await readExecutionMode(deps.pool, accountId, repoId);
    if (mode === "sandbox") return { mode, starter: deps.starter };
    if (mode !== "runner_verified" || deps.runnerStarter === undefined || deps.visibility === undefined) return null;
    const seen: RepoVisibility = await deps.visibility.visibility({ accountId, repoId }).catch((): RepoVisibility => "unknown");
    return seen === "private" ? { mode, starter: deps.runnerStarter } : null;
  }

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
      // Both daily limits are read before anything is reserved: a proposal held by either starts nothing and stays as it is.
      // `verifyHold` is the same function the detail route's `verify_wait` reads, so the two cannot disagree.
      const hold = run === undefined ? await verifyHold(client, accountId, p, settings) : null;
      return { p, key, run, hold };
    });
    if (found === null) return "skipped";
    const { p, key, run, hold } = found;
    if (run !== undefined) return settle(accountId, p, run);
    if (hold === "daily_limit") return "daily_limit";
    if (hold === "daily_spend") return "daily_cap";
    if (!p.gh_owner || !p.gh_name) return "skipped";

    const placement = await placementFor(accountId, p.repo_id);
    if (placement === null) return "skipped";

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
      // The mode read above: a repository that moved since starts nothing (`ExecutionModeChangedError`), and the run is tried again next pass.
      expectedExecutionMode: placement.mode,
      prompt: deps.prompt({ owner: p.gh_owner, name: p.gh_name, sha, title: p.title, summary: p.summary, sourceRefs: sourceRefs(p) }),
      workdir: VERIFIER_WORKDIR,
      // The pinned commit, not the default branch: the agent reads the tree its cites are re-read at, or the launch fails.
      cloneRepo: { owner: p.gh_owner, name: p.gh_name, sha },
      headSha: sha,
      idempotency: { key, requestHash: requestHash(p) },
    };
    await placement.starter.start(input);
    // A run refused at admit has already ended: record it now rather than on the next pass.
    const after = await withTenant(deps.pool, accountId, (client) => readRun(client, accountId, key));
    return after !== undefined && ENDED.has(after.status) ? settle(accountId, p, after) : "started";
  }

  return async function sweepProposalVerification(): Promise<ProposalVerifyCounts> {
    const counts: ProposalVerifyCounts = { listed: 0, started: 0, waiting: 0, recorded: 0, daily_limit: 0, daily_cap: 0, skipped: 0, failed: 0 };
    let settings: VerifySettings;
    try {
      settings = deps.settings();
    } catch (err) {
      // Fail closed: settings that cannot be read verify nothing. The pass ends idle with a code; the next tick asks again.
      reportError(err, { stage: "proposal_verify.settings" });
      return { ...counts, idle: "discovery_settings_failed" };
    }
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
