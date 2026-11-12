import type { Pool, PoolClient } from "pg";
import { TIP_PUBLISH_CAPABILITY, type StopReason } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RESTAMPABLE, pairingDigest, readPlanePush, recordUpdatedHead, recordVerifiedOutcome, UPDATED_AFTER_KEEP_EVENT, updatedAfterKeepPayload, type PlaneRefusalEntry, type PlanePushOutcomeState, type PlanePushRow } from "@fx/core/src/repos/planePushRecord.js";
import { RUNNER_REPLACE_ROUND_KIND, insertRunEvent, recordChildCodePullRequest } from "@fx/runner";
import { CHILD_BODY_CLOSING_CODE, buildPlanePushText, prFooterSkipReason } from "@fulcrumaxe/runner-protocol/planePushText";
import { safeChildTitle } from "@fx/core/src/work-items/childTitle.js";
import { resolveBuildIdentity } from "@fx/core/src/work-items/buildIdentity.js";
import { cleanWorkItemTitle } from "@fx/core/src/work-items/title.js";
import { REPUBLISH_BASE_MISSING, REPUBLISH_BRANCH_MOVED, REPUBLISH_FAILED, REPUBLISH_NO_CHANGE, REPUBLISH_PAIRING_OFF, REPLACE_ROUND_CODES, REPUBLISH_PR_CLOSED, REPUBLISH_PR_MERGED, REPUBLISH_TIP_MOVED } from "@fx/core/src/work-items/baseSync.js";
import { attemptWord, recordRepublishRefusal } from "./fixRoundBase.js";
import { raiseAfterLeaseFailure } from "./fixRoundHeads.js";
import { guarded } from "./runActions.js";
import { leaseVerdict, requireLease, stopReasonFor, type HeartbeatRunnerRunInput } from "./runnerClaims.js";
import { runnerLimits, type RunnerLimitsSource } from "./runnerLimits.js";

/**
 * D#598 P1f-2: the worker's half of `POST /api/runner/plane-push-token` and `POST /api/runner/plane-push-report`.
 *
 *   planePushGrant        the lease fence (WITHOUT extending the lease: asking for a token is not a sign of life), then the facts the route decides
 *                         on, all from our own rows, then ONE attempt row for this (run, lease generation). The unique index on that pair is what
 *                         makes the token use-once: a second request finds the row and mints nothing.
 *   planePushPairing      D#598 P1f-2b: the repository's pairing as it is NOW, only while its digest still equals the stamp. Read-only: no attempt row, no
 *                         grant, no GitHub. The hook calls it twice by design (load, then re-check after its scan), so it has no use-once rule.
 *   planePushSettleGrant  marks the attempt's token as issued (or, when the mint failed, finishes the attempt with the failure's code).
 *   planePushReportContext the same fence and facts for a report, plus the attempt (so the route knows whether a token was ever issued).
 *   planePushRecordReport  re-checks the fence, records the outcome the route has ALREADY verified against GitHub, and finishes the attempt.
 *
 * AUTHORITY WARNING, as for the other lease methods: `accountId` and `runnerId` MUST be the ones a verified runner request carries. Nothing a
 * runner sent decides the repo, the branch or the base: they are the `plane_pushes` row's. These methods decide nothing about statuses; the
 * route maps what they return.
 */

export type PlanePushLeaseInput = HeartbeatRunnerRunInput;

/** The `plane_pushes` facts the routes use. */
export interface PlanePushFacts {
  id: string;
  codeRepo: string;
  branch: string;
}

/** The `repo_pairing` row, as the pairing route hands it to the hook. */
export interface PlanePushPairing {
  codeRepo: string;
  overlayGlobs: string[];
  identifierRulesPath: string | null;
  planDataRulesPath: string | null;
  /** The digest STAMPED at build start, which the live row was just shown to equal. */
  pairingDigest: string;
}

export type PlanePushPairingResult =
  | { kind: "fenced"; reason: StopReason }
  /** The run is not an executor run on a runner, or its item has no `plane_pushes` record (so there is no stamp) for the run's own repository. */
  | { kind: "not_paired" }
  /** The pairing was removed, or its digest no longer equals the stamp. */
  | { kind: "pairing_changed" }
  | ({ kind: "pairing" } & PlanePushPairing);

export type PlanePushGrantResult =
  | { kind: "fenced"; reason: StopReason }
  /** The run is not an executor run on a runner, or its item has no `plane_pushes` row for the run's own repository. */
  | { kind: "not_paired" }
  /** The pairing was removed, or its digest no longer matches the one stamped at build start. */
  | { kind: "pairing_changed" }
  | { kind: "already_issued" }
  /** D#6 REPUBLISH-CLOSED-PR: an update's live pull request read failed or could not say (or the row moved under it). Nothing is recorded, spent or granted; the route answers 503 `public_unavailable`. */
  | { kind: "public_unavailable" }
  /**
   * FIXROUND-REPUBLISH (R2-c1): a fix round that must update the public pull request has no signed base to rebuild it from. Named; the hook reports it and the item goes to a person.
   * D#483 S5-b2c-4: also a planned PR child whose build identity the resolver refuses (its parent was deleted or closed, or re-specced and not approved again): the resolver's code.
   */
  | { kind: "refused"; code: string }
  /** The row already has the three push attempts the schema allows. */
  | { kind: "attempts_exhausted" }
  /** `itemTitle` is the work item's title as stored: untrusted text that only `buildPlanePushText` may turn into public text. */
  | ({ kind: "granted"; attemptId: string; itemTitle: string; /** The pairing's PR footer template and the item's issue number: inputs to the text builder only. */ prFooter: string | null; issueNumber: number | null; /** True for a planned PR child: `issueNumber` is then its parent's. */ child: boolean; /** The head the platform last pushed, for a fix round that updates the open public pull request; null for a first push. */ updateOf: string | null; /** The run is the merge-conflict round of its item (its `merge_conflict_rounds` row names it). */ conflictRound: boolean } & PlanePushFacts);

/**
 * D#6 PLANE-PUSH-REVERIFY-BOUND: what a refused report named, kept on its own attempt (migration 1012). Only the two checks a later read of GitHub can change are ever stored.
 * `check` is a closed name; the shas are the 40-hex head and tip that report carried.
 */
export const REVERIFY_CHECKS = ["head_unconfirmed", "pr_unconfirmed"] as const;
export interface RefusedReport {
  check: (typeof REVERIFY_CHECKS)[number];
  headSha: string;
  tipSha: string;
  /** The pull request number the refused report named; present exactly for `pr_unconfirmed`. */
  prNumber?: number;
}
/** The run event one re-check evaluation leaves (before GitHub is asked), so the count of them on a lease is the cap. */
export const REVERIFY_EVENT = "plane.reverify";
/**
 * The most re-check evaluations one attempt gets, and how long to wait before each: none for the first (the hook's own follow-up report, seconds after a refused one, is the first evaluation), then after the previous one. Each evaluation reads GitHub at most
 * twice (the branch, then the pull request), each read with a token minted and revoked, so an attempt costs at most 2 x this many reads however often the runner reports.
 */
export const REVERIFY_BACKOFF_MS: readonly number[] = Object.freeze([0, 30_000, 120_000]);
const SHA40 = /^[0-9a-f]{40}$/;

export type PlanePushReportContextResult =
  | { kind: "fenced"; reason: StopReason }
  | { kind: "not_paired" }
  | { kind: "context"; plane: PlanePushFacts & { state: string; /** The digest stamped at build start; a report's echo is compared with it. */ pairingDigest: string }; attempt: { id: string; tokenIssued: boolean; finished: boolean; outcome: string | null; /** Present only when this evaluation may re-check the attempt's refused report (see `claimReverify`); the evaluation is already counted. */ reverify?: RefusedReport } | null; /** Present for a merge-conflict round: the public main tip recorded at its grant, or null when none was. */ conflictRound?: { tip: string | null } };

export interface PlanePushRecordInput extends PlanePushLeaseInput {
  /** From `planePushReportContext`; the row is re-read and compared. */
  planePushId: string;
  /** Null records nothing on the item (a `building` report): the attempt is still updated. */
  outcome: {
    state: PlanePushOutcomeState | 'updated';
    code?: string;
    refusals?: readonly PlaneRefusalEntry[];
    headSha?: string;
    tipSha?: string;
    prNumber?: number;
    prUrl?: string;
  } | null;
  /** True for the phases that end the hook (a pull request opened, a refusal, a failed PR open, no change). */
  terminal: boolean;
  /** A fixed snake_case label for the attempt's `outcome` (a refusal code or a phase name). */
  label: string;
  tokenRevoked?: boolean;
  /** Stored on the attempt when this report ends it as `report_mismatch` (only for the two re-checkable checks). */
  refused?: RefusedReport;
  /** The outcome is a re-check of this attempt's own refused report: it is recorded only while the attempt, the row and the shas still match (see `recordVerifiedOutcome`). */
  reverify?: boolean;
}

export type PlanePushRecordResult = { kind: "fenced"; reason: StopReason } | { kind: "not_paired" } | { kind: "recorded"; recorded: boolean };

export interface RunnerPlanePushFacade {
  /** `atTip`: the runner asks to publish the branch tip because its fix round added no commit (D#598 P1g-3a-3). Only a round started by a confirmed Replace, on a runner that listed `tip_publish_v1`, is granted one; any other is `refused` with `NO_TIP_ROUND` and nothing is written. */
  planePushGrant(input: PlanePushLeaseInput & { atTip?: true }): Promise<PlanePushGrantResult>;
  planePushPairing(input: PlanePushLeaseInput): Promise<PlanePushPairingResult>;
  /** True when exactly one unsettled attempt row of this run and generation was updated; false when none matched (the caller must then not hand the token out). A refusal (an update whose branch a person took over, or whose lease changed, after the grant) finishes the attempt and carries its fixed code. */
  planePushSettleGrant(input: PlanePushLeaseInput & { attemptId: string; issued: true } | PlanePushLeaseInput & { attemptId: string; issued: false; code: string }): Promise<boolean | { kind: "refused"; code: string }>;
  planePushReportContext(input: PlanePushLeaseInput): Promise<PlanePushReportContextResult>;
  planePushRecordReport(input: PlanePushRecordInput): Promise<PlanePushRecordResult>;
}

export interface RunnerPlanePushDeps {
  /** The public repository's branch head (a token minted and revoked per read). Without it a conflict round's tip is not recorded and its end is judged against the tip read at the report. */
  publicHead?: (input: { accountId: string; codeRepo: string; branch: string }) => Promise<string | null>;
  /** D#6 REPUBLISH-CLOSED-PR: the public pull request's live state (a token minted and revoked per read), read before an update is granted a token. Absent: an update is answered `public_unavailable` (fail closed). */
  pullRequestState?: (input: { accountId: string; codeRepo: string; number: number }) => Promise<"open" | "closed" | "merged" | "unknown">;
  now?: () => number;
  limits?: RunnerLimitsSource;
}

const LABEL = /^[a-z][a-z0-9_]{0,63}$/;

interface RunFacts {
  row: PlanePushRow;
  /** The run continues a branch (a fix round), and the base the cloud signed for it, if any. */
  continues: boolean;
  baseSha: string | null;
}

/** The run's own facts and its item's `plane_pushes` row, or null when the run is not an executor run on a runner with a record for its own repository. */
async function runFacts(client: PoolClient, input: PlanePushLeaseInput): Promise<RunFacts | null> {
  const { rows } = await client.query<{ role: string; runtime: string; work_item_id: string | null; dispatch_repo_id: string | null; continues: boolean; base_sha: string | null }>(
    "SELECT role, runtime, work_item_id, dispatch_repo_id, (job_signed #> '{job,continues}') IS NOT NULL AND jsonb_typeof(job_signed #> '{job,continues}') = 'object' AS continues, job_signed #>> '{job,continues,base_sha}' AS base_sha FROM agent_runs WHERE account_id = $1 AND id = $2",
    [input.accountId, input.runId],
  );
  const run = rows[0];
  if (!run || run.role !== "executor" || run.runtime !== "runner" || !run.work_item_id || !run.dispatch_repo_id) return null;
  const row = await readPlanePush(client, input.accountId, run.work_item_id);
  if (!row || row.repoId !== run.dispatch_repo_id) return null;
  return { row, continues: run.continues === true, baseSha: run.base_sha };
}

interface PairingRow {
  code_repo: string;
  overlay_globs: string[];
  identifier_rules_path: string | null;
  plan_data_rules_path: string | null;
}

/** The repository's pairing as it is NOW, or null when there is none or its digest no longer equals the one stamped at build start. */
async function livePairing(client: PoolClient, accountId: string, row: PlanePushRow): Promise<PlanePushPairing | null> {
  const { rows } = await client.query<PairingRow>(
    "SELECT code_repo, overlay_globs, identifier_rules_path, plan_data_rules_path FROM repo_pairing WHERE repo_id = $1 AND account_id = $2",
    [row.repoId, accountId],
  );
  const pair = rows[0];
  if (!pair) return null;
  const digest = pairingDigest({ codeRepo: pair.code_repo, overlayGlobs: pair.overlay_globs, identifierRulesPath: pair.identifier_rules_path, planDataRulesPath: pair.plan_data_rules_path });
  if (digest !== row.pairingDigest) return null;
  return { codeRepo: pair.code_repo, overlayGlobs: pair.overlay_globs, identifierRulesPath: pair.identifier_rules_path, planDataRulesPath: pair.plan_data_rules_path, pairingDigest: row.pairingDigest };
}

/** The public pull request exists and no person has taken the branch over: a fix round updates it. */
const hasOpenPublicPr = (r: PlanePushRow): boolean => r.state === "pr_opened" && r.headSha !== null && r.managedByPersonAt === null;
/** Nothing was published yet (the row is in a state a new attempt may replace) and no person has the branch: a fix round publishes it for the first time. */
const mayFirstPublish = (r: PlanePushRow): boolean => r.managedByPersonAt === null && RESTAMPABLE.includes(r.state);

/** True when this run's token request was refused with one of the three stops, which `updateStop` recorded under the run's own attempt word. */
async function stoppedAtToken(client: PoolClient, accountId: string, workItemId: string, runId: string): Promise<boolean> {
  const word = attemptWord(runId);
  const { rows } = await client.query(
    "SELECT 1 FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'escalated' AND dedupe_key = ANY($3::text[]) LIMIT 1",
    [accountId, workItemId, [REPUBLISH_PR_CLOSED, REPUBLISH_PR_MERGED, REPUBLISH_PAIRING_OFF].map((c) => `${c}:${word}`)],
  );
  return rows.length > 0;
}

/** Why the open public pull request of `row` can no longer be updated: merged, closed unmerged, or the repository's pairing is gone (in that order); null when it can. */
async function updateStop(client: PoolClient, accountId: string, row: PlanePushRow): Promise<string | null> {
  const { rows } = await client.query<{ stage: string; paired: boolean }>(
    "SELECT w.stage, EXISTS (SELECT 1 FROM repo_pairing p WHERE p.repo_id = $3 AND p.account_id = $1) AS paired FROM work_items w WHERE w.id = $2 AND w.account_id = $1",
    [accountId, row.workItemId, row.repoId],
  );
  const item = rows[0];
  if (!item) return null;
  if (row.state === "pr_merged" || item.stage === "merged") return REPUBLISH_PR_MERGED;
  if (row.state === "pr_closed" || item.stage === "closed_unmerged") return REPUBLISH_PR_CLOSED;
  return item.paired ? null : REPUBLISH_PAIRING_OFF;
}

/** The run is the round of a merge conflict: a round row of its item names it. The marker is the platform's own row, never anything the run said. */
const isConflictRound = async (client: PoolClient, accountId: string, runId: string): Promise<boolean> =>
  (await client.query("SELECT 1 FROM merge_conflict_rounds WHERE account_id = $1 AND run_id = $2", [accountId, runId])).rows.length > 0;

/** The event a conflict round's grant leaves: the public main tip the cloud read before the runner pushed (the report is compared with it, never trusted). */
export const ROUND_TIP_EVENT = "plane.round_tip";
/** D#6 REPUBLISH-TRANSIENT-RETRY: one per token ask whose live pull request read failed even after its retries, on a lease. */
export const LIVE_READ_FAILED_EVENT = "plane.live_read_failed";
/** The asks on one lease that may read GitHub for the pull request's live state once earlier ones failed. */
export const MAX_FAILED_LIVE_READS_PER_LEASE = 3;
/** The head a fix round's token request was granted its lease on (the person's authorized head, or the stamp); the settle step checks the row still says the same. */
export const UPDATE_LEASE_EVENT = "plane.update_lease";
/** The fixed refusals of a token, and the labels the attempt ends with, when the row changed between the grant and the token. */
export const BRANCH_MANAGED_BY_PERSON = "branch_managed_by_person";
export const UPDATE_LEASE_CHANGED = "update_lease_changed";
/** The fixed refusal of an `at_tip` request for a run that is not the round of a confirmed Replace (or a runner that did not list `tip_publish_v1`): no attempt, no grant, no token. */
export const NO_TIP_ROUND = "no_changes";

/** True only for the fix round a person's confirmed Replace started (the marker event the round's create transaction wrote) on a runner whose latest hello listed `tip_publish_v1`. Never from anything a runner sent. */
const isTipRound = async (client: PoolClient, input: PlanePushLeaseInput, continues: boolean): Promise<boolean> =>
  continues &&
  (await client.query("SELECT 1 FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 LIMIT 1", [input.accountId, input.runId, RUNNER_REPLACE_ROUND_KIND])).rows.length > 0 &&
  (await client.query("SELECT 1 FROM runner_capabilities WHERE account_id = $1 AND runner_id = $2 AND $3::text = ANY(capabilities)", [input.accountId, input.runnerId, TIP_PUBLISH_CAPABILITY])).rows.length > 0;

const isPlannedChild = async (client: PoolClient, accountId: string, workItemId: string): Promise<boolean> =>
  (await client.query("SELECT 1 FROM work_items WHERE account_id = $1 AND id = $2 AND planned_pr_key IS NOT NULL", [accountId, workItemId])).rows.length > 0;

const facts = (row: PlanePushRow): PlanePushFacts => ({ id: row.id, codeRepo: row.codeRepo, branch: row.branch });

/**
 * D#6 PLANE-PUSH-REVERIFY-BOUND: decides whether this report evaluation may check an attempt's refused report against GitHub again, and counts it. Under the attempt's row lock: the attempt must be the
 * newest of its push row (no later attempt, so no other run's push is in play), its stored shas and check must be well formed, fewer than `REVERIFY_BACKOFF_MS.length` evaluations may have happened on its
 * lease, and the backoff since the attempt ended (or the previous evaluation) must have passed. The evaluation is written down BEFORE GitHub is asked, so a failing or slow read still counts. Returns the
 * stored report, or undefined.
 */
export async function claimReverify(client: PoolClient, input: { accountId: string; runId: string; leaseGeneration: number }, planePushId: string, a: { id: string; refused_check: string | null; refused_head_sha: string | null; refused_tip_sha: string | null; refused_pr_number: number | null }): Promise<RefusedReport | undefined> {
  const check = (REVERIFY_CHECKS as readonly string[]).includes(a.refused_check ?? "") ? (a.refused_check as RefusedReport["check"]) : null;
  if (check === null || !a.refused_head_sha || !SHA40.test(a.refused_head_sha) || !a.refused_tip_sha || !SHA40.test(a.refused_tip_sha)) return undefined;
  const { rows: locked } = await client.query<{ created_at: Date }>("SELECT created_at FROM plane_push_attempts WHERE id = $1 AND account_id = $2 AND run_id = $3 AND lease_generation = $4 AND runtime = 'runner' FOR UPDATE", [a.id, input.accountId, input.runId, input.leaseGeneration]);
  if (!locked[0]) return undefined;
  const later = await client.query("SELECT 1 FROM plane_push_attempts WHERE account_id = $1 AND plane_push_id = $2 AND id <> $3 AND created_at >= $4", [input.accountId, planePushId, a.id, locked[0].created_at]);
  if (later.rows.length > 0) return undefined;
  const { rows: seen } = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 AND payload->>'lease_generation' = $4", [input.accountId, input.runId, REVERIFY_EVENT, String(input.leaseGeneration)]);
  const n = Number(seen[0]?.n ?? 0);
  const wait = REVERIFY_BACKOFF_MS[n];
  if (wait === undefined) return undefined;
  const { rows: due } = await client.query<{ due: boolean }>(
    `SELECT now() >= GREATEST(
              (SELECT finished_at FROM plane_push_attempts WHERE id = $1 AND account_id = $2),
              COALESCE((SELECT max(created_at) FROM run_events WHERE account_id = $2 AND run_id = $3 AND kind = $4 AND payload->>'lease_generation' = $5), '-infinity')
            ) + ($6::int * interval '1 millisecond') AS due`,
    [a.id, input.accountId, input.runId, REVERIFY_EVENT, String(input.leaseGeneration), wait],
  );
  if (due[0]?.due !== true) return undefined;
  await insertRunEvent(client, input.accountId, input.runId, REVERIFY_EVENT, { lease_generation: input.leaseGeneration, check });
  return { check, headSha: a.refused_head_sha, tipSha: a.refused_tip_sha, ...(check === "pr_unconfirmed" && a.refused_pr_number !== null ? { prNumber: a.refused_pr_number } : {}) };
}

/**
 * D#6 PLANE-PUSH-REVERIFY-BOUND: records a re-checked push (GitHub confirmed the STORED head, tip and, for a pull request, number) on the refused record. The one writer for both callers (the report
 * route, with a live lease, and the merge gate, with none). Everything it writes is bound by `recordVerifiedOutcome`'s `reverify` condition to the named run's own attempt; the attempt is then relabelled
 * under the same equality. Returns whether the record moved.
 */
export async function recordReverified(
  client: PoolClient,
  input: { accountId: string; runId: string; leaseGeneration: number; row: PlanePushRow; outcome: { state: PlanePushOutcomeState; headSha: string; tipSha: string; prNumber?: number; prUrl?: string }; label: string },
): Promise<boolean> {
  const o = input.outcome;
  if (!["pushed", "pr_opened", "pushed_pr_not_opened"].includes(o.state)) return false;
  const row = await recordVerifiedOutcome(client, {
    accountId: input.accountId,
    id: input.row.id,
    outcome: { state: o.state, headSha: o.headSha, tipSha: o.tipSha, ...(o.prNumber !== undefined ? { prNumber: o.prNumber } : {}), ...(o.prUrl !== undefined ? { prUrl: o.prUrl } : {}) },
    reverify: { runId: input.runId, leaseGeneration: input.leaseGeneration },
  });
  if (row === null) return false;
  if (o.state === "pr_opened" && o.prNumber !== undefined && (await isPlannedChild(client, input.accountId, input.row.workItemId))) {
    await recordChildCodePullRequest(client, input.accountId, input.runId, { branch: input.row.branch, prNumber: o.prNumber, codeRepo: input.row.codeRepo });
  }
  await client.query(
    `UPDATE plane_push_attempts SET outcome = $4
      WHERE account_id = $1 AND run_id = $2 AND lease_generation = $3 AND runtime = 'runner' AND outcome = 'report_mismatch' AND refused_head_sha = $5 AND refused_tip_sha = $6`,
    [input.accountId, input.runId, input.leaseGeneration, input.label, o.headSha, o.tipSha],
  );
  return true;
}

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createRunnerPlanePushFacade(runnerPool: Pool, deps: RunnerPlanePushDeps = {}): RunnerPlanePushFacade {
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? runnerLimits;
  const fence = async (client: PoolClient, input: PlanePushLeaseInput) => leaseVerdict(client, input, new Date(now()), 0, limits(input.accountId).maxRunWallClockMs);

  /** A conflict round's grant records the public main tip it saw. A read that fails records nothing, which only makes the end stricter (the tip is then read again at the report). */
  const recordRoundTip = async (input: PlanePushLeaseInput, codeRepo: string): Promise<void> => {
    if (!deps.publicHead) return;
    let tip: string | null = null;
    try {
      tip = await deps.publicHead({ accountId: input.accountId, codeRepo, branch: "main" });
    } catch {
      // fx-swallow-ok: GitHub could not be asked; no tip is recorded and the report is judged against the tip read then
      return;
    }
    if (tip === null || !/^[0-9a-f]{40}$/.test(tip)) return;
    await withTenant(runnerPool, input.accountId, (client) => insertRunEvent(client, input.accountId, input.runId, ROUND_TIP_EVENT, { tip }));
  };

  /**
   * D#6 REPUBLISH-TRANSIENT-RETRY: the live state for this ask. The read itself is retried inside the hosted port (one token, at most three reads). A read that THREW is counted on the lease: after
   * `MAX_FAILED_LIVE_READS_PER_LEASE` such asks the lease is answered `unknown` (so `public_unavailable`, the same answer) with no token minted and nothing read. A cap by count, not by time: the runner
   * stops after one refusal, so asks on one lease are few, and a count needs no clock and bounds a lease's cost whatever its length: at most 3 asks x (1 token + 3 reads + 1 revoke).
   */
  const liveState = async (input: PlanePushLeaseInput, peek: { number: number; codeRepo: string; failedReads: number }): Promise<"open" | "closed" | "merged" | "unknown"> => {
    if (!deps.pullRequestState || peek.failedReads >= MAX_FAILED_LIVE_READS_PER_LEASE) return "unknown";
    try {
      return await deps.pullRequestState({ accountId: input.accountId, codeRepo: peek.codeRepo, number: peek.number });
    } catch {
      // fx-swallow-ok: GitHub could not be asked; the failure is counted on the lease and the grant answers public_unavailable
      await withTenant(runnerPool, input.accountId, (client) => insertRunEvent(client, input.accountId, input.runId, LIVE_READ_FAILED_EVENT, { lease_generation: input.leaseGeneration })).catch(() => undefined);
      return "unknown";
    }
  };

  const grant = (input: PlanePushLeaseInput & { atTip?: true }): Promise<PlanePushGrantResult> =>
      guarded(async () => {
        requireLease(input);
        // D#6 REPUBLISH-CLOSED-PR: the network read happens before the grant transaction, so no pool connection or lock is held across it. A short read-only look comes first and makes NO read when the lease is
        // fenced or finished, when this lease already has its attempt (a re-ask answers `already_issued`), or when the round is not an update of an open pull request: the fence, then the read.
        const peek = await withTenant(runnerPool, input.accountId, async (c) => {
          if ((await fence(c, input)) !== "ok") return null;
          const f = await runFacts(c, input);
          if (f === null || !f.continues || !hasOpenPublicPr(f.row) || f.row.prNumber === null) return null;
          const { rows } = await c.query("SELECT 1 FROM plane_push_attempts WHERE run_id = $1 AND lease_generation = $2 AND runtime = 'runner' AND account_id = $3", [input.runId, input.leaseGeneration, input.accountId]);
          if (rows.length > 0) return null;
          const failed = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 AND payload->>'lease_generation' = $4", [input.accountId, input.runId, LIVE_READ_FAILED_EVENT, String(input.leaseGeneration)]);
          return { number: f.row.prNumber, codeRepo: f.row.codeRepo, failedReads: Number(failed.rows[0]?.n ?? 0) };
        });
        const live = peek === null ? null : { number: peek.number, codeRepo: peek.codeRepo, state: await liveState(input, peek) };
        return withTenant(runnerPool, input.accountId, async (client): Promise<PlanePushGrantResult> => {
          const held = await fence(client, input);
          if (held !== "ok") return { kind: "fenced", reason: stopReasonFor(held) };
          const found = await runFacts(client, input);
          if (!found) return { kind: "not_paired" };
          // D#598 P1g-3a-3: before anything else is read or written, so an ordinary round that asked for the tip leaves no trace.
          if (input.atTip === true && !(await isTipRound(client, input, found.continues))) return { kind: "refused", code: NO_TIP_ROUND };
          const { row } = found;
          // D#598 P1g-1: a pull request closed or merged on GitHub (the item records it), or a pairing that is gone, is said in words and pauses the item; nothing is pushed.
          if (found.continues && row.managedByPersonAt === null && row.headSha !== null && ["pr_opened", "pr_closed", "pr_merged"].includes(row.state)) {
            const stop = await updateStop(client, input.accountId, row);
            if (stop !== null) {
              await recordRepublishRefusal(client, { accountId: input.accountId, workItemId: row.workItemId }, { code: stop, prNumber: null, moveToNeedsPerson: true, attempt: input.runId });
              return { kind: "refused", code: stop };
            }
          }
          // FIXROUND-REPUBLISH (R2-c1): a fix round (a continuation) updates the open public pull request or publishes nothing. No open one, or one a person took over: nothing to do. Open, and the round was
          // not signed with a base (the round start refuses that, this asks again): named, and no token.
          // A fix round of an item whose first round never published (its check failed) has no public pull request to update: it publishes one, like a first round (RESTAMPABLE states, no person on the branch).
          const update = found.continues && hasOpenPublicPr(row);
          if (found.continues && !update && !mayFirstPublish(row)) return { kind: "not_paired" };
          if (update && found.baseSha === null) return { kind: "refused", code: REPUBLISH_BASE_MISSING };
          // D#6 REPUBLISH-CLOSED-PR: the record can say open while GitHub shows the pull request closed or merged. The live state was read for this grant before this transaction (stamped nowhere). Closed and merged
          // are recorded like the stored-state stops. A read that failed, named nothing, or was for another number is `public_unavailable` (503): nothing is recorded, spent or refused, so a Replace
          // round's answer stays and the runner's own report of the refusal puts the question again. A rate limit or 5xx is never "closed".
          if (update && live !== null) {
            // The repository cannot differ (a push row's code_repo is fixed by a trigger); the number can move, so it is compared.
            const same = live.number === row.prNumber;
            const stop = !same ? null : live.state === "closed" ? REPUBLISH_PR_CLOSED : live.state === "merged" ? REPUBLISH_PR_MERGED : null;
            if (stop !== null) {
              await recordRepublishRefusal(client, { accountId: input.accountId, workItemId: row.workItemId }, { code: stop, prNumber: null, moveToNeedsPerson: true, attempt: input.runId });
              return { kind: "refused", code: stop };
            }
            if (!same || live.state !== "open") return { kind: "public_unavailable" };
          }

          // The pairing as it is NOW, against the digest stamped at build start. A pairing that was removed or edited is `pairing_changed`.
          if (!(await livePairing(client, input.accountId, row))) return { kind: "pairing_changed" };

          // D#483 S5-b2c-4 (R9): the issue number the text names comes from the build identity (a planned PR child's is its parent's), never from `gh_number`. A fix round reads what already happened
          // (`observe`); a first push starts the publish (`start`). A top-level item with no number keeps its old outcome (a grant whose text has no footer that needs one); a child the resolver refuses gets no grant.
          const identity = await resolveBuildIdentity(client, input.accountId, row.workItemId, found.continues ? "observe" : "start");
          if (!identity.ok && identity.isChild) return { kind: "refused", code: identity.reason };
          const build = identity.ok ? { issueNumber: identity.identity.issueNumber as number | null, child: identity.identity.isChild } : { issueNumber: null, child: false };

          // Final guard, before an attempt row exists: a child's finished body that would still close an issue gets no grant.
          if (build.child) {
            const meta = (await client.query<{ title: string | null; pr_footer: string | null }>("SELECT w.title, (SELECT rp.pr_footer FROM repo_pairing rp WHERE rp.repo_id = $3 AND rp.account_id = $2) AS pr_footer FROM work_items w WHERE w.id = $1 AND w.account_id = $2", [row.workItemId, input.accountId, row.repoId])).rows[0];
            try {
              buildPlanePushText({ itemTitle: safeChildTitle(cleanWorkItemTitle(meta?.title ?? "")), runId: input.runId, prFooter: meta?.pr_footer ?? null, issueNumber: build.issueNumber, child: true });
            } catch (err) {
              if (err instanceof Error && err.message === CHILD_BODY_CLOSING_CODE) return { kind: "refused", code: CHILD_BODY_CLOSING_CODE };
              throw err;
            }
          }

          // Serialise the attempts of one record, then look for this lease's grant before making one.
          await client.query("SELECT 1 FROM plane_pushes WHERE id = $1 AND account_id = $2 FOR UPDATE", [row.id, input.accountId]);
          // The row as it is under the lock: a person may have taken the branch over, or the state moved, since the read above.
          const locked = await readPlanePush(client, input.accountId, row.workItemId);
          if (found.continues && (locked === null || locked.id !== row.id || (update ? !hasOpenPublicPr(locked) : !mayFirstPublish(locked)))) return { kind: "not_paired" };
          const { rows: existing } = await client.query("SELECT 1 FROM plane_push_attempts WHERE run_id = $1 AND lease_generation = $2 AND runtime = 'runner' AND account_id = $3", [input.runId, input.leaseGeneration, input.accountId]);
          if (existing.length > 0) return { kind: "already_issued" };
          // No read was made for an update (the row became an open pull request between the look and here): nothing is granted on a state nobody asked GitHub about. Only a real interleaving reaches this.
          if (update && live === null) return { kind: "public_unavailable" };
          // An update is its own kind of attempt, numbered on its own and not held to the three pushes of a first publish (each fix round has one).
          const kind = update ? "fix_round" : "push";
          const { rows: next } = await client.query<{ n: number }>("SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM plane_push_attempts WHERE plane_push_id = $1 AND account_id = $2 AND kind = $3", [row.id, input.accountId, kind]);
          const attemptNo = Number(next[0]!.n);
          if (!update && attemptNo > 3) return { kind: "attempts_exhausted" };
          const { rows: made } = await client.query<{ id: string }>(
            `INSERT INTO plane_push_attempts (account_id, plane_push_id, run_id, lease_generation, runtime, kind, attempt_no)
             VALUES ($1, $2, $3, $4, 'runner', $6, $5) RETURNING id`,
            [input.accountId, row.id, input.runId, input.leaseGeneration, attemptNo, kind],
          );
          // The item's title for the public pull request text. A missing row cannot happen under the run's own foreign key; it reads as an empty
          // title, which the text builder turns into its fixed run-id title.
          const { rows: titles } = await client.query<{ title: string | null }>("SELECT title FROM work_items WHERE id = $1 AND account_id = $2", [row.workItemId, input.accountId]);
          const { rows: footers } = await client.query<{ pr_footer: string | null }>("SELECT pr_footer FROM repo_pairing WHERE repo_id = $1 AND account_id = $2", [row.repoId, input.accountId]);
          const prFooter = footers[0]?.pr_footer ?? null;
          // A footer that needs an issue number this item lacks, or that would close a planned PR child's parent, is left off the body; the run says why.
          const skipped = prFooterSkipReason(prFooter, build.issueNumber, { child: build.child });
          if (skipped !== null) await insertRunEvent(client, input.accountId, input.runId, "plane.pr_footer_skipped", { reason: skipped });
          const leaseOf = update ? (locked!.replaceAuthorizedHead ?? locked!.headSha) : null;
          if (leaseOf !== null) await insertRunEvent(client, input.accountId, input.runId, UPDATE_LEASE_EVENT, { head: leaseOf });
          const stored = titles[0]?.title ?? "";
          return { kind: "granted", attemptId: made[0]!.id, itemTitle: build.child ? safeChildTitle(cleanWorkItemTitle(stored)) : stored, prFooter, issueNumber: build.issueNumber, child: build.child, updateOf: leaseOf, conflictRound: update && (await isConflictRound(client, input.accountId, input.runId)), ...facts(row) };
        });
      });

  return {
    planePushGrant: async (input) => {
      const granted = await grant(input);
      if (granted.kind === "granted" && granted.conflictRound) await recordRoundTip(input, granted.codeRepo);
      return granted;
    },

    planePushPairing: (input) =>
      guarded(async () => {
        requireLease(input);
        return withTenant(runnerPool, input.accountId, async (client): Promise<PlanePushPairingResult> => {
          const held = await fence(client, input);
          if (held !== "ok") return { kind: "fenced", reason: stopReasonFor(held) };
          const found = await runFacts(client, input);
          if (!found) return { kind: "not_paired" };
          const pairing = await livePairing(client, input.accountId, found.row);
          return pairing ? { kind: "pairing", ...pairing } : { kind: "pairing_changed" };
        });
      }),

    planePushSettleGrant: (input) =>
      guarded(async () => {
        requireLease(input);
        return withTenant(runnerPool, input.accountId, async (client) => {
          // Tied to this run, this generation and this account, and only while still unsettled.
          if (input.issued) {
            // An update's token is the last moment the cloud can still stop the push: under the push row's lock, the row must still be unmanaged and still hold the lease the grant named. A person's Keep
            // (or a spent authorization) between the grant and here refuses the token with a fixed code and finishes the attempt, so nothing is pushed. After the token the cloud cannot stop the push.
            const { rows: held } = await client.query<{ kind: string; managed: boolean; lease: string | null }>(
              `SELECT a.kind, p.managed_by_person_at IS NOT NULL AS managed, COALESCE(p.replace_authorized_head, p.head_sha) AS lease
                 FROM plane_push_attempts a JOIN plane_pushes p ON p.id = a.plane_push_id AND p.account_id = a.account_id
                WHERE a.id = $1 AND a.account_id = $2 AND a.run_id = $3 AND a.lease_generation = $4 AND a.runtime = 'runner' AND a.token_issued_at IS NULL AND a.finished_at IS NULL
                  FOR UPDATE OF p`,
              [input.attemptId, input.accountId, input.runId, input.leaseGeneration],
            );
            const now = held[0];
            if (now?.kind === "fix_round") {
              const granted = (await client.query<{ head: string | null }>("SELECT payload->>'head' AS head FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 ORDER BY seq DESC LIMIT 1", [input.accountId, input.runId, UPDATE_LEASE_EVENT])).rows[0]?.head ?? null;
              const refusal = now.managed ? { code: BRANCH_MANAGED_BY_PERSON, label: "managed_after_grant" } : granted !== null && granted !== now.lease ? { code: UPDATE_LEASE_CHANGED, label: "lease_changed_after_grant" } : null;
              if (refusal !== null) {
                await client.query(
                  `UPDATE plane_push_attempts SET finished_at = now(), outcome = $5
                    WHERE id = $1 AND account_id = $2 AND run_id = $3 AND lease_generation = $4 AND runtime = 'runner' AND token_issued_at IS NULL AND finished_at IS NULL`,
                  [input.attemptId, input.accountId, input.runId, input.leaseGeneration, refusal.label],
                );
                return { kind: "refused" as const, code: refusal.code };
              }
            }
            const done = await client.query(
              `UPDATE plane_push_attempts SET token_issued_at = now()
                WHERE id = $1 AND account_id = $2 AND run_id = $3 AND lease_generation = $4 AND runtime = 'runner' AND token_issued_at IS NULL AND finished_at IS NULL`,
              [input.attemptId, input.accountId, input.runId, input.leaseGeneration],
            );
            return done.rowCount === 1;
          } else {
            if (!LABEL.test(input.code)) throw new Error("planePushSettleGrant: bad code");
            const done = await client.query(
              `UPDATE plane_push_attempts SET finished_at = now(), outcome = $5
                WHERE id = $1 AND account_id = $2 AND run_id = $3 AND lease_generation = $4 AND runtime = 'runner' AND token_issued_at IS NULL AND finished_at IS NULL`,
              [input.attemptId, input.accountId, input.runId, input.leaseGeneration, input.code],
            );
            return done.rowCount === 1;
          }
        });
      }),

    planePushReportContext: (input) =>
      guarded(async () => {
        requireLease(input);
        return withTenant(runnerPool, input.accountId, async (client): Promise<PlanePushReportContextResult> => {
          const held = await fence(client, input);
          if (held !== "ok") return { kind: "fenced", reason: stopReasonFor(held) };
          const found = await runFacts(client, input);
          if (!found) return { kind: "not_paired" };
          const { rows } = await client.query<{ id: string; token_issued_at: Date | null; finished_at: Date | null; outcome: string | null; refused_check: string | null; refused_head_sha: string | null; refused_tip_sha: string | null; refused_pr_number: number | null }>(
            "SELECT id, token_issued_at, finished_at, outcome, refused_check, refused_head_sha, refused_tip_sha, refused_pr_number FROM plane_push_attempts WHERE account_id = $1 AND run_id = $2 AND lease_generation = $3 AND runtime = 'runner'",
            [input.accountId, input.runId, input.leaseGeneration],
          );
          const row0 = rows[0];
          // A re-check is for the first publish of a run only (a fix round's refusal leaves the pull request open and is never re-read), of an attempt that ended as `report_mismatch` with a stored check,
          // while the item's row still holds that refusal and the attempt is its newest.
          const reverify =
            row0 && row0.finished_at !== null && row0.outcome === "report_mismatch" && row0.refused_check !== null && !found.continues && found.row.state === "refused" && found.row.code === "report_mismatch"
              ? await claimReverify(client, input, found.row.id, row0)
              : undefined;
          const attempt = row0 ? { id: row0.id, tokenIssued: row0.token_issued_at !== null, finished: row0.finished_at !== null, outcome: row0.outcome, ...(reverify ? { reverify } : {}) } : null;
          // A conflict round's end is judged against the tip recorded at its grant (the newest one; none when the grant could not read it).
          const round = found.continues && (await isConflictRound(client, input.accountId, input.runId));
          const tip = !round ? null : ((await client.query<{ tip: string | null }>("SELECT payload->>'tip' AS tip FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 ORDER BY seq DESC LIMIT 1", [input.accountId, input.runId, ROUND_TIP_EVENT])).rows[0]?.tip ?? null);
          return { kind: "context", plane: { ...facts(found.row), state: found.row.state, pairingDigest: found.row.pairingDigest }, attempt, ...(round ? { conflictRound: { tip } } : {}) };
        });
      }),

    planePushRecordReport: (input) =>
      guarded(async () => {
        requireLease(input);
        if (!LABEL.test(input.label)) throw new Error("planePushRecordReport: bad label");
        if (input.refused !== undefined && (!(REVERIFY_CHECKS as readonly string[]).includes(input.refused.check) || !SHA40.test(input.refused.headSha) || !SHA40.test(input.refused.tipSha) || (input.refused.check === "pr_unconfirmed") !== (input.refused.prNumber !== undefined))) throw new Error("planePushRecordReport: bad refused report");
        // D#598 P1g-2: set when the round's update failed its lease; the branch is read and the request raised once the report is recorded (no GitHub read inside the transaction).
        let leaseFailedFor: string | null = null;
        const result = await withTenant(runnerPool, input.accountId, async (client): Promise<PlanePushRecordResult> => {
          const held = await fence(client, input);
          if (held !== "ok") return { kind: "fenced", reason: stopReasonFor(held) };
          const found = await runFacts(client, input);
          if (!found || found.row.id !== input.planePushId) return { kind: "not_paired" };
          let recorded = false;
          // D#6 PLANE-PUSH-REVERIFY-BOUND: a re-checked report of a refused first publish. Everything it may write is bound to the attempt's own stored report: the recording below only matches while the row
          // is still that refusal, this run's attempt is its newest and the shas equal the ones it stored; the attempt is then relabelled under the same equality. A round that continues a branch never takes this path.
          if (input.reverify === true) {
            const o = input.outcome;
            if (found.continues || !o || o.headSha === undefined || o.tipSha === undefined) return { kind: "recorded", recorded: false };
            const moved = await recordReverified(client, { accountId: input.accountId, runId: input.runId, leaseGeneration: input.leaseGeneration, row: found.row, outcome: { ...o, state: o.state as PlanePushOutcomeState, headSha: o.headSha, tipSha: o.tipSha }, label: input.label });
            return { kind: "recorded", recorded: moved };
          }
          // D#598 P1g-1: a round the token request already stopped (closed, merged, pairing off) keeps that stop. A runner's follow-up report (an old runner says `public_unavailable`, a new one the stop's own code) is not
          // recorded over it: the item would read "Press Build again" instead of what happened.
          if (found.continues && input.outcome !== undefined && (await stoppedAtToken(client, input.accountId, found.row.workItemId, input.runId))) return { kind: "recorded", recorded: false };
          // Only the run that was granted an update (a continuation, with an attempt of kind fix_round) may move the stamp.
          const granted = found.continues && (await client.query("SELECT 1 FROM plane_push_attempts WHERE account_id = $1 AND run_id = $2 AND lease_generation = $3 AND runtime = 'runner' AND kind = 'fix_round'", [input.accountId, input.runId, input.leaseGeneration])).rows.length > 0;
          if (input.outcome?.state === "updated") {
            // Verified against GitHub by the route. The stamp moves; an update the row no longer accepts (a person took the branch over meanwhile) records nothing.
            const row = !granted ? null : await recordUpdatedHead(client, { accountId: input.accountId, id: found.row.id, headSha: input.outcome.headSha ?? "", tipSha: input.outcome.tipSha ?? "", sourceHead: null });
            recorded = row !== null;
            // The Keep lost to this update: a fixed-code event on the run says so (the push row holds the new head and the commit it replaced).
            if (row?.keptReplacedAt) await insertRunEvent(client, input.accountId, input.runId, UPDATED_AFTER_KEEP_EVENT, updatedAfterKeepPayload(row));
          } else if ((input.outcome?.state === "refused" || input.outcome?.state === "no_public_change") && found.continues && found.row.state === "pr_opened") {
            // The update of the open public pull request was refused: the round's change is on the private branch only. A person decides (nothing is shown as published that is not).
            const code = input.outcome.state === "no_public_change" ? REPUBLISH_NO_CHANGE : input.outcome.code === "public_branch_moved" ? REPUBLISH_BRANCH_MOVED : input.outcome.code === "public_tip_moved" ? REPUBLISH_TIP_MOVED : input.outcome.code === REPUBLISH_BASE_MISSING ? REPUBLISH_BASE_MISSING : REPUBLISH_FAILED;
            // D#598 P1g-3a-3: the round a person's Replace started is recorded under the Replace form of the code (the cloud's marker on the run decides), which spends the answer.
            const wrote = await recordRepublishRefusal(client, { accountId: input.accountId, workItemId: found.row.workItemId }, { code, prNumber: null, moveToNeedsPerson: true, attempt: input.runId });
            recorded = true;
            // The question again: a lease that failed at the push, and a Replace round that ended without a landed update (nothing else would put the person back at it).
            if (wrote === REPUBLISH_BRANCH_MOVED || REPLACE_ROUND_CODES.includes(wrote)) leaseFailedFor = found.row.workItemId;
          } else if (input.outcome) {
            const o = input.outcome;
            const row = await recordVerifiedOutcome(client, {
              accountId: input.accountId,
              id: found.row.id,
              outcome: {
                state: o.state as PlanePushOutcomeState,
                ...(o.code !== undefined ? { code: o.code } : {}),
                ...(o.refusals ? { refusals: o.refusals } : {}),
                ...(o.headSha !== undefined ? { headSha: o.headSha } : {}),
                ...(o.tipSha !== undefined ? { tipSha: o.tipSha } : {}),
                ...(o.prNumber !== undefined ? { prNumber: o.prNumber } : {}),
                ...(o.prUrl !== undefined ? { prUrl: o.prUrl } : {}),
              },
            });
            recorded = row !== null;
            // R9: a planned PR child's code-plane pull request is bound to its run once the hosted side verified it (the route did, before this call), in the same transaction as the push row's outcome. Set once.
            if (row !== null && o.state === "pr_opened" && o.prNumber !== undefined && (await isPlannedChild(client, input.accountId, found.row.workItemId))) {
              await recordChildCodePullRequest(client, input.accountId, input.runId, { branch: found.row.branch, prNumber: o.prNumber, codeRepo: found.row.codeRepo });
            }
          }
          // The attempt for this lease, if there is one: whether its token was revoked (a terminal report that does not say, did not confirm it) and how it ended.
          await client.query(
            `UPDATE plane_push_attempts
                SET token_revoked = CASE WHEN token_issued_at IS NOT NULL AND ($5::boolean IS NOT NULL OR $4::boolean) THEN COALESCE($5::boolean, false) ELSE token_revoked END,
                    finished_at = CASE WHEN $4::boolean THEN COALESCE(finished_at, now()) ELSE finished_at END,
                    outcome = CASE WHEN $4::boolean OR $6 = 'pushed' THEN $6 ELSE outcome END,
                    refused_check = CASE WHEN $4::boolean AND finished_at IS NULL AND refused_check IS NULL AND $6 = 'report_mismatch' THEN $7::text ELSE refused_check END,
                    refused_head_sha = CASE WHEN $4::boolean AND finished_at IS NULL AND refused_check IS NULL AND $6 = 'report_mismatch' THEN $8::text ELSE refused_head_sha END,
                    refused_tip_sha = CASE WHEN $4::boolean AND finished_at IS NULL AND refused_check IS NULL AND $6 = 'report_mismatch' THEN $9::text ELSE refused_tip_sha END,
                    refused_pr_number = CASE WHEN $4::boolean AND finished_at IS NULL AND refused_check IS NULL AND $6 = 'report_mismatch' THEN $10::integer ELSE refused_pr_number END
              WHERE account_id = $1 AND run_id = $2 AND lease_generation = $3 AND runtime = 'runner'`,
            [input.accountId, input.runId, input.leaseGeneration, input.terminal, input.tokenRevoked ?? null, input.label, input.refused?.check ?? null, input.refused?.headSha ?? null, input.refused?.tipSha ?? null, input.refused?.prNumber ?? null],
          );
          return { kind: "recorded", recorded };
        });
        if (leaseFailedFor !== null) await raiseAfterLeaseFailure(runnerPool, deps.publicHead, { accountId: input.accountId, workItemId: leaseFailedFor });
        return result;
      }),
  };
}
