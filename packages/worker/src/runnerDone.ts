import type { Pool, PoolClient } from "pg";
import { ITEM_PR_BRANCH, MAX_ENVELOPE_INPUT_BYTES, redactText, NOT_RECORDED_MEASURE, RUNNER_LEASE_SECONDS, SESSION_ID_PATTERN, contextLedgerFromWire, redactDeep, type ContextLedgerBody, type ContextSection, type DoneCheck, type StopReason, checkNotRunReason, readCheckFailedFileHints, readCheckFailedFiles, CHECK_FAILED_FILE_HINTS_DROPPED, CHECK_FAILED_FILES_DROPPED } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RUNNER_RUN_BRANCH, insertRunEvent, noteRunnerActivityCap, readBoundItemBranch, recordContextFigure, recordContextLedger, writeRunStatusOn, type FailureReason } from "@fx/runner";
import { normaliseCheck } from "@fx/runner-cloud";
import { readPlanePush } from "@fx/core/src/repos/planePushRecord.js";
import { CLOUD_CLOSE_EVENT, SCOPE_REFUSAL_EVENT, cloudClosePayload, parseCloudClose, parseScopeRefusal, scopeRefusalPayload, type CloudClose, type ScopeRefusal } from "@fx/core/src/work-items/scopeRefusal.js";
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

/** What the cloud's scope refusal found out: the run's recorded refusal is in place, and the run's published public pull request when it has one the cloud may close. */
export type NoteScopeRefusalResult = { kind: "fenced"; reason: StopReason } | { kind: "noted"; publicPr: { codeRepo: string; number: number; branch: string } | null; publicSkipped?: "pairing_changed" };

export interface RunnerDoneFacade {
  /**
   * D#6 CHECKFIX-SUCCESS-AS-FAILED: BEFORE the cloud closes the private pull request of a run its scope check refused, records that refusal on the run (the fact the webhook and the
   * stale-pull-request sweep read to leave the item at In progress), under the lease fence. A repeat for the same pull request records nothing new. Also answers the run's public pull
   * request, when its item has one the platform opened and no person has taken the branch over, so the route can close it too. Nothing the runner sent is in either.
   */
  noteScopeRefusal(input: HeartbeatRunnerRunInput & { refusal: ScopeRefusal }): Promise<NoteScopeRefusalResult>;
  /**
   * D#6 SCOPE-REFUSAL-FOLLOWUPS: the same, for a close the cloud makes for another reason than the scope check (`done` closing a pull request whose files it could not read). Records
   * `run.cloud_pr_closed` and answers the public pull request exactly as `noteScopeRefusal` does; the webhook and the stale sweep hold both events alike.
   */
  noteCloudClose(input: HeartbeatRunnerRunInput & { close: CloudClose }): Promise<NoteScopeRefusalResult>;
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
  // D#600 CX-9b: how full the window was at the end (the latest turn's context and the window the job named). Its own savepoint, so a refused figure never costs the ledger or the verdict.
  const last = measure.last_context_tokens;
  if (last === undefined || last === null) return;
  await client.query("SAVEPOINT context_figure");
  try {
    await recordContextFigure(client, { accountId: input.accountId, runId: input.runId, lastContextTokens: last, windowTokens: measure.window_tokens });
    await client.query("RELEASE SAVEPOINT context_figure");
  } catch {
    // fx-swallow-ok: advisory like the ledger; the savepoint is rolled back and the same fixed line is the trace
    await client.query("ROLLBACK TO SAVEPOINT context_figure");
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
  // D#6 CHECK-FAILFILES-TO-CLOUD (hint lines): the repo's own fix hint `normaliseCheck` kept beside them, for the same fix round to read back.
  const hints = readCheckFailedFileHints(check.failed_file_hints, files.ok && files.value !== null ? files.value.files : null);
  await insertRunEvent(client, input.accountId, input.runId, CHECK_ENDED_EVENT, {
    exit_code: check.exit_code,
    timed_out: check.timed_out,
    duration_ms: check.duration_ms,
    ...(files.ok && files.value !== null ? { failed_files: files.value.files, ...(files.value.more === 0 ? {} : { failed_files_more: files.value.more }) } : {}),
    ...(hints.ok && hints.value !== null ? { failed_file_hints: hints.value } : {}),
  });
}

/** A stored closure record of either kind (`run.scope_refused`, `run.cloud_pr_closed`), read back; null when it is neither. */
const recordedClosure = (payload: unknown): { publicPr?: { codeRepo: string; number: number } } | null => parseScopeRefusal(payload) ?? parseCloudClose(payload);

const sameNamedPublicPr = (recorded: { publicPr?: { codeRepo: string; number: number } } | null, now: { codeRepo: string; number: number }): boolean =>
  recorded?.publicPr !== undefined && recorded.publicPr.number === now.number && recorded.publicPr.codeRepo.toLowerCase() === now.codeRepo.toLowerCase();

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createRunnerDoneFacade(runnerPool: Pool, deps: RunnerDoneDeps = {}): RunnerDoneFacade {
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? runnerLimits;

  /**
   * Records, under the lease fence and BEFORE the cloud closes the run's private pull request, the fact that the cloud is closing it (`kind`), and answers the run's public pull request when the
   * platform opened one and still holds it. The scope refusal and every other cloud close share this one path, so the hold they set and the public close they ask for cannot drift apart.
   */
  const noteClosure = (input: HeartbeatRunnerRunInput, kind: string, prNumber: number | null, build: (repo: string | null, publicPr: { codeRepo: string; number: number } | null) => Record<string, unknown>): Promise<NoteScopeRefusalResult> =>
    guarded(async () => {
      requireLease(input);
      if (prNumber === null) throw new RunActionInputError();
      const at = new Date(now());
      return withTenant(runnerPool, input.accountId, async (client): Promise<NoteScopeRefusalResult> => {
        const held = await leaseVerdict(client, input, at, 0, limits(input.accountId).maxRunWallClockMs);
        if (held !== "ok") return { kind: "fenced", reason: stopReasonFor(held) };
        // The repositories the event names are the cloud's own facts, read here from its rows: the run's dispatch repository (where the private pull request lives) and, on a paired
        // repository, the public copy the platform opened and still holds. Nothing in them comes from the request, so a runner cannot point the hold at another repository.
        const run = await client.query<{ work_item_id: string | null; dispatch_repo_id: string | null; repo: string | null }>(
          `SELECT r.work_item_id, r.dispatch_repo_id, CASE WHEN g.gh_owner IS NULL OR g.gh_name IS NULL THEN NULL ELSE g.gh_owner || '/' || g.gh_name END AS repo
             FROM agent_runs r LEFT JOIN repos g ON g.account_id = r.account_id AND g.id = r.dispatch_repo_id
            WHERE r.account_id = $1 AND r.id = $2`,
          [input.accountId, input.runId],
        );
        const facts = run.rows[0];
        const row = facts?.work_item_id && facts.dispatch_repo_id ? await readPlanePush(client, input.accountId, facts.work_item_id) : null;
        // Only the pull request the platform opened and still holds: a person who took the branch over keeps it, and a closed or merged one needs nothing.
        const open = row !== null && row.repoId === facts?.dispatch_repo_id && row.state === "pr_opened" && row.managedByPersonAt === null && row.prNumber !== null;
        // The public close also needs the repository's pairing to still name that public repository: a pairing removed or pointed elsewhere since the push means the record is no longer the platform's to act on.
        const paired = open && (await client.query("SELECT 1 FROM repo_pairing WHERE account_id = $1 AND repo_id = $2 AND lower(code_repo) = lower($3)", [input.accountId, row.repoId, row.codeRepo])).rows.length > 0;
        const publicPr = paired ? { codeRepo: row.codeRepo, number: row.prNumber!, branch: row.branch } : null;
        // Whatever repository fields the request carried are dropped: the event names only what the rows above say.
        const payload = build(facts?.repo ? facts.repo : null, publicPr === null ? null : { codeRepo: publicPr.codeRepo, number: publicPr.number });
        const known = await client.query<{ payload: unknown }>("SELECT payload FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 AND payload->>'prNumber' = $4::text LIMIT 1", [input.accountId, input.runId, kind, String(prNumber)]);
        if (known.rows.length === 0) await insertRunEvent(client, input.accountId, input.runId, kind, payload);
        // A repeat (the runner sent `done` again) closes only the public pull request the FIRST record named: a copy the record does not name would be closed with nothing holding its close.
        const named = known.rows.length === 0 ? publicPr : publicPr !== null && sameNamedPublicPr(recordedClosure(known.rows[0]!.payload), publicPr) ? publicPr : null;
        return { kind: "noted", publicPr: named, ...(open && !paired ? { publicSkipped: "pairing_changed" as const } : {}) };
      });
    });

  return {
    noteScopeRefusal: (input) => {
      // The payload is cleaned by the one function that writes it; a refusal that does not survive it is not recorded.
      const refusal = parseScopeRefusal(scopeRefusalPayload(input.refusal));
      return noteClosure(input, SCOPE_REFUSAL_EVENT, refusal === null ? null : refusal.prNumber, (repo, publicPr) =>
        scopeRefusalPayload({ reason: refusal!.reason, prNumber: refusal!.prNumber, total: refusal!.total, paths: refusal!.paths, ...(refusal!.detail === undefined ? {} : { detail: refusal!.detail }), ...(repo === null ? {} : { repo }), ...(publicPr === null ? {} : { publicPr }) }),
      );
    },

    noteCloudClose: (input) => {
      const close = parseCloudClose(cloudClosePayload(input.close));
      return noteClosure(input, CLOUD_CLOSE_EVENT, close === null ? null : close.prNumber, (repo, publicPr) =>
        cloudClosePayload({ cause: close!.cause, prNumber: close!.prNumber, ...(repo === null ? {} : { repo }), ...(publicPr === null ? {} : { publicPr }) }),
      );
    },

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
        if (norm?.failedFileHintsDropped === true) console.warn(JSON.stringify({ event: CHECK_FAILED_FILE_HINTS_DROPPED, run_id: input.runId }));
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
