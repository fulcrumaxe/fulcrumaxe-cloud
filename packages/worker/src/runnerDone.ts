import type { Pool, PoolClient } from "pg";
import { ITEM_PR_BRANCH, MAX_ENVELOPE_INPUT_BYTES, redactText, NOT_RECORDED_MEASURE, RUNNER_LEASE_SECONDS, SESSION_ID_PATTERN, contextLedgerFromWire, redactDeep, type ContextLedgerBody, type ContextSection, type DoneCheck, type StopReason, checkNotRunReason, readCheckFailedFiles, CHECK_FAILED_FILES_DROPPED } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RUNNER_RUN_BRANCH, insertRunEvent, noteRunnerActivityCap, readBoundItemBranch, recordContextLedger, writeRunStatusOn, type FailureReason } from "@fx/runner";
import { normaliseCheck } from "@fx/runner-cloud";
import { guarded, RunActionInputError } from "./runActions.js";
import { leaseVerdict, requireLease, stopReasonFor, type HeartbeatRunnerRunInput } from "./runnerClaims.js";
import { runnerLimits, type RunnerLimitsSource } from "./runnerLimits.js";

/**
 * D#6 R2b-3f (C21 section 5, C12 section 5, C14 section 4): the `done` half of the runner lease facade on the `Worker`.
 *
 * `done` has to ask GitHub (is there a commit, are its paths in the Spec's scope, open the pull request), and a network call must
 * not sit inside the transaction that holds the run row's lock. So the facade is two writes around the route's GitHub work:
 *
 *   beginRunnerDone   the fence, once, with the lease extended by the lease length (the GitHub work may take a while, and the run must
 *                     still be the runner's when it ends). The answers are `proceed`, `fenced` (the stop reply) or `replay` (the run is
 *                     already finished by THIS runner's `done` at THIS generation, so the stored verdict is answered again).
 *   finishRunnerDone  the fence again, inside the write transaction, then the verdict: the status move through the one compare-and-set
 *                     writer, the session id in `cc_session_id` and the runner's `agentOutput`, redacted and byte-capped, in `envelope`.
 *                     All of it commits with the fence or not at all. If another `done` finished first, the answer is that one's
 *                     verdict (`replay`), so two concurrent attempts record once.
 *
 * Where the verdict lives: on the `run.status_changed` event the move writes (`viaRunnerDone`, `prNumber`, `branch`, `prHttpStatus`, and the
 * failure reason it already carries). The `branch` is the run branch the verdict was judged on, recorded next to `prNumber` (C25 section 1.2):
 * the job issuer reads it back as the branch a fix round continues, so the pull request is updated and never replaced. It is written in the same transaction as the move, so a stored verdict exists exactly when the
 * run is finished by `done`; a run finished any other way (the sweeper's `runner_lost`, a usage limit, a cancel) has none, and a `done`
 * for it is a stop. No column, so no migration.
 *
 * AUTHORITY WARNING, as for the other lease methods: `accountId` and `runnerId` MUST be the ones a verified runner request carries.
 * `verdict` is the cloud's own decision, made from GitHub and from our rows; nothing the runner sent decides it.
 */

/** The reasons a `done` can end a run `failed` with. All are `FailureReason`s (checked at compile time). */
export const DONE_FAILURE_REASONS = ["no_commit", "scope_unknown", "scope_violation", "pr_rejected", "internal_error", "taken_over", "check_failed"] as const satisfies readonly FailureReason[];
export type DoneFailureReason = (typeof DONE_FAILURE_REASONS)[number];

/** What the cloud decided about a run that sent `done`. */
export interface RunnerDoneVerdict {
  outcome: "succeeded" | "failed";
  /** Null exactly when `outcome` is `succeeded`. */
  failureReason: DoneFailureReason | null;
  /** The pull request the verdict is about; null when none exists. */
  prNumber: number | null;
  /** The run branch the verdict was judged on, recorded next to `prNumber` (C25 section 1.2): `fx/<run>-g<generation>` for a fresh run, a continuation's own branch otherwise. Set exactly when `prNumber` is. */
  branch?: string;
  /** The HTTP status GitHub refused the pull request with (`pr_rejected`); a number only. */
  /** D#598 P1f-5c: the run branch's head as the cloud read it from GitHub when it judged the run (never from the runner). Set with `prNumber`; the branch cleanup deletes the branch only while its head is still this commit. */
  headOid?: string;
  prHttpStatus?: number;
  /** Why a `scope_unknown` ended the run, where that matters to the words shown: a renamed file, or a change type GitHub reported that the port does not know. */
  detail?: "renamed" | "unknown_change_type" | "no_file_list";
}

export interface FinishRunnerDoneInput extends HeartbeatRunnerRunInput {
  verdict: RunnerDoneVerdict;
  /** The runner's context ledger (D#600 CX-1b), already schema-checked by the route. Absent from an older runner: the run's row is then `partial`. */
  contextLedger?: ContextLedgerBody;
  /** D#6 R-CHK-3: the check result (already schema-checked, and only for a run whose signed job carried a check). Recorded in `run_checks` in the transaction that ends the run. */
  check?: DoneCheck;
  /** The Claude Code session the run ended in (already shape-checked by the protocol); stored in `cc_session_id`. */
  sessionId?: string;
  /** The runner's own output envelope: advisory, stored after redaction and capped in bytes. */
  agentOutput?: Record<string, unknown>;
}

export type BeginRunnerDoneResult = { kind: "proceed" } | { kind: "fenced"; reason: StopReason } | { kind: "replay"; verdict: RunnerDoneVerdict };
export type FinishRunnerDoneResult = { kind: "recorded"; verdict: RunnerDoneVerdict } | { kind: "fenced"; reason: StopReason } | { kind: "replay"; verdict: RunnerDoneVerdict };

export interface RunnerDoneFacade {
  /** Fences a runner's `done`, extends its lease, and says whether to go on, stop, or answer the stored verdict again. */
  beginRunnerDone(input: HeartbeatRunnerRunInput): Promise<BeginRunnerDoneResult>;
  /** Records the cloud's verdict for the run under the fence, in one transaction. */
  finishRunnerDone(input: FinishRunnerDoneInput): Promise<FinishRunnerDoneResult>;
}

export interface RunnerDoneDeps {
  /** Tests inject a fixed clock (milliseconds since the epoch). */
  now?: () => number;
  /** The wall-clock figure per account. Defaults to `runnerLimits`. */
  limits?: RunnerLimitsSource;
}

/** What is stored in place of an `agentOutput` that is over the byte cap once redacted. */
export const DROPPED_AGENT_OUTPUT = Object.freeze({ dropped: "too_large" });

const REASONS: ReadonlySet<string> = new Set(DONE_FAILURE_REASONS);

function requireVerdict(verdict: RunnerDoneVerdict): void {
  if (typeof verdict !== "object" || verdict === null) throw new RunActionInputError();
  const okReason = verdict.outcome === "succeeded" ? verdict.failureReason === null : verdict.outcome === "failed" && typeof verdict.failureReason === "string" && REASONS.has(verdict.failureReason);
  if (!okReason) throw new RunActionInputError();
  if (verdict.prNumber !== null && !(Number.isSafeInteger(verdict.prNumber) && verdict.prNumber >= 1)) throw new RunActionInputError();
  // A run branch, or (D#599 PL-2b) the item's pull request branch; the latter is checked against the run's bound event in `requireBoundBranch`, in the writing transaction.
  if (verdict.branch !== undefined && !((verdict.prNumber !== null || (verdict.failureReason === "check_failed" && RUNNER_RUN_BRANCH.test(verdict.branch))) && typeof verdict.branch === "string" && (RUNNER_RUN_BRANCH.test(verdict.branch) || ITEM_PR_BRANCH.test(verdict.branch)))) throw new RunActionInputError();
  if (verdict.headOid !== undefined && !(verdict.prNumber !== null && typeof verdict.headOid === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(verdict.headOid))) throw new RunActionInputError();
  if (verdict.prHttpStatus !== undefined && !(Number.isInteger(verdict.prHttpStatus) && verdict.prHttpStatus >= 100 && verdict.prHttpStatus <= 599)) throw new RunActionInputError();
  if (verdict.detail !== undefined && !((verdict.detail === "renamed" || verdict.detail === "unknown_change_type" || verdict.detail === "no_file_list") && verdict.failureReason === "scope_unknown")) throw new RunActionInputError();
}

/**
 * D#599 PL-2b security model 3: a verdict naming an item pull request branch is recorded only when it is the branch this run is bound to (the
 * `runner.continues_bound` event, the signed job's `continues.branch` and `fx/issue-<item issue>` all agree) and the pull request number is the bound one.
 * Anything else is a refusal, never a fallback. A run branch needs no binding. `client` is the writing transaction.
 */
async function requireBoundBranch(client: PoolClient, i: { accountId: string; runId: string }, verdict: RunnerDoneVerdict): Promise<void> {
  if (verdict.branch === undefined || !ITEM_PR_BRANCH.test(verdict.branch)) return;
  const bound = await readBoundItemBranch(client, i);
  if (bound === null || bound.branch !== verdict.branch || bound.prNumber !== verdict.prNumber) throw new RunActionInputError();
}

/** The stored output: redacted (G2) first, then dropped whole if it is still over the cap in UTF-8 bytes. */
export function storedAgentOutput(agentOutput: Record<string, unknown>): Record<string, unknown> {
  const clean = redactDeep(agentOutput, []);
  return Buffer.byteLength(JSON.stringify(clean), "utf8") > MAX_ENVELOPE_INPUT_BYTES ? { ...DROPPED_AGENT_OUTPUT } : clean;
}

interface StoredRow {
  to: string;
  failureReason: string | null;
  prNumber: number | null;
  branch: string | null;
  prHttpStatus: number | null;
  headOid: string | null;
  detail: string | null;
}

/** The verdict a finished-by-`done` run stored, for this runner and generation; null when the run was finished some other way. */
async function storedVerdict(client: PoolClient, i: HeartbeatRunnerRunInput): Promise<RunnerDoneVerdict | null> {
  const { rows } = await client.query<{ payload: Record<string, unknown> }>(
    `SELECT e.payload
       FROM run_events e
       JOIN agent_runs a ON a.account_id = e.account_id AND a.id = e.run_id
      WHERE e.account_id = $1 AND e.run_id = $2 AND e.kind = 'run.status_changed' AND e.payload->>'viaRunnerDone' = 'true'
        AND a.runner_id = $3 AND a.lease_generation = $4 AND a.status IN ('succeeded', 'failed')
      ORDER BY e.seq DESC LIMIT 1`,
    [i.accountId, i.runId, i.runnerId, i.leaseGeneration],
  );
  const p = rows[0]?.payload as Partial<Record<keyof StoredRow, unknown>> | undefined;
  if (!p || (p.to !== "succeeded" && p.to !== "failed")) return null;
  const failureReason = typeof p.failureReason === "string" && REASONS.has(p.failureReason) ? (p.failureReason as DoneFailureReason) : null;
  if ((p.to === "succeeded") !== (failureReason === null)) return null;
  const prNumber = typeof p.prNumber === "number" && Number.isSafeInteger(p.prNumber) && p.prNumber >= 1 ? p.prNumber : null;
  // An item pull request branch in a stored verdict is replayed only while the run's binding still agrees (the same rule that let it be written).
  const bound = typeof p.branch === "string" && ITEM_PR_BRANCH.test(p.branch) ? await readBoundItemBranch(client, { accountId: i.accountId, runId: i.runId }) : null;
  return {
    outcome: p.to,
    failureReason,
    prNumber,
    ...((prNumber !== null || failureReason === "check_failed") && typeof p.branch === "string" && (RUNNER_RUN_BRANCH.test(p.branch) || (ITEM_PR_BRANCH.test(p.branch) && bound?.branch === p.branch && bound.prNumber === prNumber)) ? { branch: p.branch } : {}),
    ...(prNumber !== null && typeof p.headOid === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(p.headOid) ? { headOid: p.headOid } : {}),
    ...(typeof p.prHttpStatus === "number" ? { prHttpStatus: p.prHttpStatus } : {}),
    ...(p.detail === "renamed" || p.detail === "unknown_change_type" || p.detail === "no_file_list" ? { detail: p.detail } : {}),
  };
}

/** The log line a refused or failed ledger write leaves: a fixed word, never a value from the runner. */
export const LEDGER_WRITE_FAILED = "runner.done.context_ledger_not_recorded";

/**
 * D#600 CX-1b: the run's context ledger, written in the `done` transaction on the run-writer login (the login `run_context_ledger_record`
 * grants EXECUTE to; migration 0792). A runner that sent none, and a taken-over run (whose runner output counts for nothing), get a
 * `partial` row with nothing measured. The write sits inside a savepoint: the ledger is advisory, so a refusal (the definer re-checks every
 * value) or a database error rolls back to the savepoint, leaves the fixed log line, and the verdict still commits.
 */
async function recordRunnerLedger(client: PoolClient, input: FinishRunnerDoneInput): Promise<void> {
  const sent = input.verdict.failureReason === "taken_over" ? undefined : input.contextLedger;
  const { measure, sections, memoryTokens } = sent === undefined ? { measure: NOT_RECORDED_MEASURE, sections: [] as ContextSection[] } : contextLedgerFromWire(sent);
  await client.query("SAVEPOINT context_ledger");
  try {
    await recordContextLedger(client, { accountId: input.accountId, runId: input.runId, sections, measure, ...(memoryTokens === undefined ? {} : { memoryTokens }) });
    await client.query("RELEASE SAVEPOINT context_ledger");
  } catch {
    // fx-swallow-ok: the ledger is advisory; the savepoint is rolled back and a fixed line is the trace
    await client.query("ROLLBACK TO SAVEPOINT context_ledger");
    console.warn(JSON.stringify({ event: LEDGER_WRITE_FAILED, run_id: input.runId }));
  }
}

/** The `run_events` kind the check's end is logged under (D#6 R-CHK-3): numbers and a flag only, so the activity log can show the duration without the output. */
export const CHECK_ENDED_EVENT = "run.check_ended";

/**
 * D#6 R-CHK-3: the check's row, beside the status move. The summary is redacted again here (the runner already did) and cut at the column's cap; the row and the log
 * line commit with the verdict or not at all. A taken-over run records none (nothing the runner reported counts after the owner took over).
 */
async function recordRunnerCheck(client: PoolClient, input: FinishRunnerDoneInput): Promise<void> {
  const check = input.check;
  if (check === undefined || input.verdict.failureReason === "taken_over") return;
  const summary = redactText(check.summary, []).slice(0, 4096);
  await client.query(
    `INSERT INTO run_checks (account_id, run_id, exit_code, duration_ms, timed_out, skipped_tests, summary, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.accountId, input.runId, check.exit_code, check.duration_ms, check.timed_out, check.skipped_tests, summary, check.reason === undefined ? null : checkNotRunReason(check.reason)],
  );
  // D#6 CHECK-FAILFILES-TO-CLOUD: the failing test files `normaliseCheck` kept (names only, bounded), for the card and the fix round to read back.
  const files = readCheckFailedFiles(check.failed_files, check.failed_files_more);
  await insertRunEvent(client, input.accountId, input.runId, CHECK_ENDED_EVENT, {
    exit_code: check.exit_code,
    timed_out: check.timed_out,
    duration_ms: check.duration_ms,
    ...(files.ok && files.value !== null ? { failed_files: files.value.files, ...(files.value.more === 0 ? {} : { failed_files_more: files.value.more }) } : {}),
  });
}

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createRunnerDoneFacade(runnerPool: Pool, deps: RunnerDoneDeps = {}): RunnerDoneFacade {
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? runnerLimits;

  return {
    beginRunnerDone: (input) =>
      guarded(async () => {
        requireLease(input);
        const at = new Date(now());
        return withTenant(runnerPool, input.accountId, async (client): Promise<BeginRunnerDoneResult> => {
          const held = await leaseVerdict(client, input, at, RUNNER_LEASE_SECONDS, limits(input.accountId).maxRunWallClockMs);
          if (held === "ok") return { kind: "proceed" };
          if (held === "not_running") {
            const stored = await storedVerdict(client, input);
            if (stored) return { kind: "replay", verdict: stored };
          }
          return { kind: "fenced", reason: stopReasonFor(held) };
        });
      }),

    finishRunnerDone: (input) =>
      guarded(async () => {
        requireLease(input);
        requireVerdict(input.verdict);
        // D#6 R-CHK-3: a check result that cannot be stored is stored in its nearest storable form and fails the check, whatever verdict came with it; it never aborts the finish below.
        const norm = input.check === undefined ? null : normaliseCheck(input.check);
        if (norm?.failedFilesDropped === true) console.warn(JSON.stringify({ event: CHECK_FAILED_FILES_DROPPED, run_id: input.runId }));
        const forced = norm !== null && norm.outOfContract !== null && input.verdict.failureReason !== "taken_over" && input.verdict.failureReason !== "check_failed";
        const rec: FinishRunnerDoneInput = {
          ...input,
          ...(norm === null ? {} : { check: norm.check }),
          ...(forced ? { verdict: { outcome: "failed", failureReason: "check_failed", prNumber: null, ...(input.verdict.branch !== undefined && RUNNER_RUN_BRANCH.test(input.verdict.branch) ? { branch: input.verdict.branch } : {}) } } : {}),
        };
        if (input.sessionId !== undefined && (typeof input.sessionId !== "string" || !SESSION_ID_PATTERN.test(input.sessionId))) throw new RunActionInputError();
        // A taken-over run stores no envelope (D#6 R4a-7): nothing the agent said before the owner stopped it can count as a result.
        const envelope = input.agentOutput === undefined || rec.verdict.failureReason === "taken_over" ? undefined : storedAgentOutput(input.agentOutput);
        const at = new Date(now());
        return withTenant(runnerPool, input.accountId, async (client): Promise<FinishRunnerDoneResult> => {
          // Fenced again, in the transaction that writes: the lease may have ended while GitHub was being asked. The fence takes the run
          // row's lock, so a second `done` waits here and then finds the run finished.
          const held = await leaseVerdict(client, input, at, 0, limits(input.accountId).maxRunWallClockMs);
          if (held === "not_running") {
            const stored = await storedVerdict(client, input);
            return stored ? { kind: "replay", verdict: stored } : { kind: "fenced", reason: stopReasonFor(held) };
          }
          if (held !== "ok") return { kind: "fenced", reason: stopReasonFor(held) };
          const { verdict } = rec;
          await requireBoundBranch(client, input, verdict);
          const moved = await writeRunStatusOn(client, {
            accountId: input.accountId,
            runId: input.runId,
            from: "running",
            to: verdict.outcome,
            ...(verdict.failureReason === null ? {} : { failureReason: verdict.failureReason }),
            runnerDone: { prNumber: verdict.prNumber, ...(verdict.branch === undefined ? {} : { branch: verdict.branch }), ...(verdict.headOid === undefined ? {} : { headOid: verdict.headOid }), ...(verdict.prHttpStatus === undefined ? {} : { prHttpStatus: verdict.prHttpStatus }), ...(verdict.detail === undefined ? {} : { detail: verdict.detail }) },
            result: { ...(envelope === undefined ? {} : { envelope }), ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }) },
          });
          // Held under the row lock, so this is a defence: the run was running a statement ago.
          if (!moved.updated) return { kind: "fenced", reason: "run_terminal" };
          await noteRunnerActivityCap(client, { accountId: input.accountId, runId: input.runId });
          await recordRunnerLedger(client, rec);
          await recordRunnerCheck(client, rec);
          return { kind: "recorded", verdict };
        });
      }),
  };
}
