import type { Pool, PoolClient } from "pg";
import type { StopReason } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RESTAMPABLE, pairingDigest, readPlanePush, recordUpdatedHead, recordVerifiedOutcome, type PlaneRefusalEntry, type PlanePushOutcomeState, type PlanePushRow } from "@fx/core/src/repos/planePushRecord.js";
import { insertRunEvent, recordChildCodePullRequest } from "@fx/runner";
import { CHILD_BODY_CLOSING_CODE, buildPlanePushText, prFooterSkipReason } from "@fulcrumaxe/runner-protocol/planePushText";
import { safeChildTitle } from "@fx/core/src/work-items/childTitle.js";
import { resolveBuildIdentity } from "@fx/core/src/work-items/buildIdentity.js";
import { cleanWorkItemTitle } from "@fx/core/src/work-items/title.js";
import { REPUBLISH_BASE_MISSING, REPUBLISH_BRANCH_MOVED, REPUBLISH_FAILED, REPUBLISH_NO_CHANGE } from "@fx/core/src/work-items/baseSync.js";
import { recordRepublishRefusal } from "./fixRoundBase.js";
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
  /**
   * FIXROUND-REPUBLISH (R2-c1): a fix round that must update the public pull request has no signed base to rebuild it from. Named; the hook reports it and the item goes to a person.
   * D#483 S5-b2c-4: also a planned PR child whose build identity the resolver refuses (its parent was deleted or closed, or re-specced and not approved again): the resolver's code.
   */
  | { kind: "refused"; code: string }
  /** The row already has the three push attempts the schema allows. */
  | { kind: "attempts_exhausted" }
  /** `itemTitle` is the work item's title as stored: untrusted text that only `buildPlanePushText` may turn into public text. */
  | ({ kind: "granted"; attemptId: string; itemTitle: string; /** The pairing's PR footer template and the item's issue number: inputs to the text builder only. */ prFooter: string | null; issueNumber: number | null; /** True for a planned PR child: `issueNumber` is then its parent's. */ child: boolean; /** The head the platform last pushed, for a fix round that updates the open public pull request; null for a first push. */ updateOf: string | null } & PlanePushFacts);

export type PlanePushReportContextResult =
  | { kind: "fenced"; reason: StopReason }
  | { kind: "not_paired" }
  | { kind: "context"; plane: PlanePushFacts & { state: string; /** The digest stamped at build start; a report's echo is compared with it. */ pairingDigest: string }; attempt: { id: string; tokenIssued: boolean; finished: boolean; outcome: string | null } | null };

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
}

export type PlanePushRecordResult = { kind: "fenced"; reason: StopReason } | { kind: "not_paired" } | { kind: "recorded"; recorded: boolean };

export interface RunnerPlanePushFacade {
  planePushGrant(input: PlanePushLeaseInput): Promise<PlanePushGrantResult>;
  planePushPairing(input: PlanePushLeaseInput): Promise<PlanePushPairingResult>;
  /** True when exactly one unsettled attempt row of this run and generation was updated; false when none matched (the caller must then not hand the token out). */
  planePushSettleGrant(input: PlanePushLeaseInput & { attemptId: string; issued: true } | PlanePushLeaseInput & { attemptId: string; issued: false; code: string }): Promise<boolean>;
  planePushReportContext(input: PlanePushLeaseInput): Promise<PlanePushReportContextResult>;
  planePushRecordReport(input: PlanePushRecordInput): Promise<PlanePushRecordResult>;
}

export interface RunnerPlanePushDeps {
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

const isPlannedChild = async (client: PoolClient, accountId: string, workItemId: string): Promise<boolean> =>
  (await client.query("SELECT 1 FROM work_items WHERE account_id = $1 AND id = $2 AND planned_pr_key IS NOT NULL", [accountId, workItemId])).rows.length > 0;

const facts = (row: PlanePushRow): PlanePushFacts => ({ id: row.id, codeRepo: row.codeRepo, branch: row.branch });

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createRunnerPlanePushFacade(runnerPool: Pool, deps: RunnerPlanePushDeps = {}): RunnerPlanePushFacade {
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? runnerLimits;
  const fence = async (client: PoolClient, input: PlanePushLeaseInput) => leaseVerdict(client, input, new Date(now()), 0, limits(input.accountId).maxRunWallClockMs);

  return {
    planePushGrant: (input) =>
      guarded(async () => {
        requireLease(input);
        return withTenant(runnerPool, input.accountId, async (client): Promise<PlanePushGrantResult> => {
          const held = await fence(client, input);
          if (held !== "ok") return { kind: "fenced", reason: stopReasonFor(held) };
          const found = await runFacts(client, input);
          if (!found) return { kind: "not_paired" };
          const { row } = found;
          // FIXROUND-REPUBLISH (R2-c1): a fix round (a continuation) updates the open public pull request or publishes nothing. No open one, or one a person took over: nothing to do. Open, and the round was
          // not signed with a base (the round start refuses that, this asks again): named, and no token.
          // A fix round of an item whose first round never published (its check failed) has no public pull request to update: it publishes one, like a first round (RESTAMPABLE states, no person on the branch).
          const update = found.continues && hasOpenPublicPr(row);
          if (found.continues && !update && !mayFirstPublish(row)) return { kind: "not_paired" };
          if (update && found.baseSha === null) return { kind: "refused", code: REPUBLISH_BASE_MISSING };

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
          const stored = titles[0]?.title ?? "";
          return { kind: "granted", attemptId: made[0]!.id, itemTitle: build.child ? safeChildTitle(cleanWorkItemTitle(stored)) : stored, prFooter, issueNumber: build.issueNumber, child: build.child, updateOf: update ? locked!.headSha : null, ...facts(row) };
        });
      }),

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
          const { rows } = await client.query<{ id: string; token_issued_at: Date | null; finished_at: Date | null; outcome: string | null }>(
            "SELECT id, token_issued_at, finished_at, outcome FROM plane_push_attempts WHERE account_id = $1 AND run_id = $2 AND lease_generation = $3 AND runtime = 'runner'",
            [input.accountId, input.runId, input.leaseGeneration],
          );
          const attempt = rows[0] ? { id: rows[0].id, tokenIssued: rows[0].token_issued_at !== null, finished: rows[0].finished_at !== null, outcome: rows[0].outcome } : null;
          return { kind: "context", plane: { ...facts(found.row), state: found.row.state, pairingDigest: found.row.pairingDigest }, attempt };
        });
      }),

    planePushRecordReport: (input) =>
      guarded(async () => {
        requireLease(input);
        if (!LABEL.test(input.label)) throw new Error("planePushRecordReport: bad label");
        return withTenant(runnerPool, input.accountId, async (client): Promise<PlanePushRecordResult> => {
          const held = await fence(client, input);
          if (held !== "ok") return { kind: "fenced", reason: stopReasonFor(held) };
          const found = await runFacts(client, input);
          if (!found || found.row.id !== input.planePushId) return { kind: "not_paired" };
          let recorded = false;
          // Only the run that was granted an update (a continuation, with an attempt of kind fix_round) may move the stamp.
          const granted = found.continues && (await client.query("SELECT 1 FROM plane_push_attempts WHERE account_id = $1 AND run_id = $2 AND lease_generation = $3 AND runtime = 'runner' AND kind = 'fix_round'", [input.accountId, input.runId, input.leaseGeneration])).rows.length > 0;
          if (input.outcome?.state === "updated") {
            // Verified against GitHub by the route. The stamp moves; an update the row no longer accepts (a person took the branch over meanwhile) records nothing.
            const row = !granted ? null : await recordUpdatedHead(client, { accountId: input.accountId, id: found.row.id, headSha: input.outcome.headSha ?? "", tipSha: input.outcome.tipSha ?? "", sourceHead: null });
            recorded = row !== null;
          } else if ((input.outcome?.state === "refused" || input.outcome?.state === "no_public_change") && found.continues && found.row.state === "pr_opened") {
            // The update of the open public pull request was refused: the round's change is on the private branch only. A person decides (nothing is shown as published that is not).
            const code = input.outcome.state === "no_public_change" ? REPUBLISH_NO_CHANGE : input.outcome.code === "public_branch_moved" ? REPUBLISH_BRANCH_MOVED : input.outcome.code === REPUBLISH_BASE_MISSING ? REPUBLISH_BASE_MISSING : REPUBLISH_FAILED;
            await recordRepublishRefusal(client, { accountId: input.accountId, workItemId: found.row.workItemId }, { code, prNumber: null, moveToNeedsPerson: true, attempt: input.runId });
            recorded = true;
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
                    outcome = CASE WHEN $4::boolean OR $6 = 'pushed' THEN $6 ELSE outcome END
              WHERE account_id = $1 AND run_id = $2 AND lease_generation = $3 AND runtime = 'runner'`,
            [input.accountId, input.runId, input.leaseGeneration, input.terminal, input.tokenRevoked ?? null, input.label],
          );
          return { kind: "recorded", recorded };
        });
      }),
  };
}
