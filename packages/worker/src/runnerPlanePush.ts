import type { Pool, PoolClient } from "pg";
import type { StopReason } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { pairingDigest, readPlanePush, recordVerifiedOutcome, type PlaneRefusalEntry, type PlanePushOutcomeState, type PlanePushRow } from "@fx/core/src/repos/planePushRecord.js";
import { insertRunEvent } from "@fx/runner";
import { prFooterSkipReason } from "@fulcrumaxe/runner-protocol/planePushText";
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
  /** The row already has the three push attempts the schema allows. */
  | { kind: "attempts_exhausted" }
  /** `itemTitle` is the work item's title as stored: untrusted text that only `buildPlanePushText` may turn into public text. */
  | ({ kind: "granted"; attemptId: string; itemTitle: string; /** The pairing's PR footer template and the item's issue number: inputs to the text builder only. */ prFooter: string | null; issueNumber: number | null } & PlanePushFacts);

export type PlanePushReportContextResult =
  | { kind: "fenced"; reason: StopReason }
  | { kind: "not_paired" }
  | { kind: "context"; plane: PlanePushFacts & { state: string; /** The digest stamped at build start; a report's echo is compared with it. */ pairingDigest: string }; attempt: { id: string; tokenIssued: boolean; finished: boolean; outcome: string | null } | null };

export interface PlanePushRecordInput extends PlanePushLeaseInput {
  /** From `planePushReportContext`; the row is re-read and compared. */
  planePushId: string;
  /** Null records nothing on the item (a `building` report): the attempt is still updated. */
  outcome: {
    state: PlanePushOutcomeState;
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
}

/** The run's own facts and its item's `plane_pushes` row, or null when the run is not an executor run on a runner with a record for its own repository. */
async function runFacts(client: PoolClient, input: PlanePushLeaseInput): Promise<RunFacts | null> {
  const { rows } = await client.query<{ role: string; runtime: string; work_item_id: string | null; dispatch_repo_id: string | null }>("SELECT role, runtime, work_item_id, dispatch_repo_id FROM agent_runs WHERE account_id = $1 AND id = $2", [input.accountId, input.runId]);
  const run = rows[0];
  if (!run || run.role !== "executor" || run.runtime !== "runner" || !run.work_item_id || !run.dispatch_repo_id) return null;
  const row = await readPlanePush(client, input.accountId, run.work_item_id);
  if (!row || row.repoId !== run.dispatch_repo_id) return null;
  return { row };
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

          // The pairing as it is NOW, against the digest stamped at build start. A pairing that was removed or edited is `pairing_changed`.
          if (!(await livePairing(client, input.accountId, row))) return { kind: "pairing_changed" };

          // Serialise the attempts of one record, then look for this lease's grant before making one.
          await client.query("SELECT 1 FROM plane_pushes WHERE id = $1 AND account_id = $2 FOR UPDATE", [row.id, input.accountId]);
          const { rows: existing } = await client.query("SELECT 1 FROM plane_push_attempts WHERE run_id = $1 AND lease_generation = $2 AND runtime = 'runner' AND account_id = $3", [input.runId, input.leaseGeneration, input.accountId]);
          if (existing.length > 0) return { kind: "already_issued" };
          const { rows: next } = await client.query<{ n: number }>("SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM plane_push_attempts WHERE plane_push_id = $1 AND account_id = $2 AND kind = 'push'", [row.id, input.accountId]);
          const attemptNo = Number(next[0]!.n);
          if (attemptNo > 3) return { kind: "attempts_exhausted" };
          const { rows: made } = await client.query<{ id: string }>(
            `INSERT INTO plane_push_attempts (account_id, plane_push_id, run_id, lease_generation, runtime, kind, attempt_no)
             VALUES ($1, $2, $3, $4, 'runner', 'push', $5) RETURNING id`,
            [input.accountId, row.id, input.runId, input.leaseGeneration, attemptNo],
          );
          // The item's title for the public pull request text. A missing row cannot happen under the run's own foreign key; it reads as an empty
          // title, which the text builder turns into its fixed run-id title.
          const { rows: titles } = await client.query<{ title: string | null; gh_number: string | null }>("SELECT title, gh_number::text AS gh_number FROM work_items WHERE id = $1 AND account_id = $2", [row.workItemId, input.accountId]);
          const { rows: footers } = await client.query<{ pr_footer: string | null }>("SELECT pr_footer FROM repo_pairing WHERE repo_id = $1 AND account_id = $2", [row.repoId, input.accountId]);
          const prFooter = footers[0]?.pr_footer ?? null;
          const issueNumber = titles[0]?.gh_number == null ? null : Number(titles[0].gh_number);
          // A footer that needs an issue number this item lacks is left off the body; the run says so.
          if (prFooterSkipReason(prFooter, issueNumber) !== null) await insertRunEvent(client, input.accountId, input.runId, "plane.pr_footer_skipped", { reason: "no_issue_number" });
          return { kind: "granted", attemptId: made[0]!.id, itemTitle: titles[0]?.title ?? "", prFooter, issueNumber, ...facts(row) };
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
          if (input.outcome) {
            const o = input.outcome;
            const row = await recordVerifiedOutcome(client, {
              accountId: input.accountId,
              id: found.row.id,
              outcome: {
                state: o.state,
                ...(o.code !== undefined ? { code: o.code } : {}),
                ...(o.refusals ? { refusals: o.refusals } : {}),
                ...(o.headSha !== undefined ? { headSha: o.headSha } : {}),
                ...(o.tipSha !== undefined ? { tipSha: o.tipSha } : {}),
                ...(o.prNumber !== undefined ? { prNumber: o.prNumber } : {}),
                ...(o.prUrl !== undefined ? { prUrl: o.prUrl } : {}),
              },
            });
            recorded = row !== null;
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
