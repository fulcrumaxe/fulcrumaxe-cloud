import { CHECK_FAILED_FILES_DROPPED, DONE_RETRY_AFTER_SECONDS, DoneMessage, DoneReply, DoneRetryReply, SignedJobSchema, privateOnlyEditsNotAllowed, readDerivedFresh, pathsOutsideScopeFresh, type DoneCheck, type Job, type StopReason } from "@fulcrumaxe/runner-protocol";
import type { CloudClose, ScopeRefusal } from "@fx/core/src/work-items/scopeRefusal.js";
import { DERIVED_FILE_RULES } from "@fx/core/src/specs/derivedFileRules.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RUNNER_REPLACE_ROUND_KIND, RUNNER_RUN_BRANCH, isRunnerMode } from "@fx/runner";
import { RUNNER_PUSHING_ROLES } from "@fx/gh-policy";
import {
  RunnerHttpError,
  MAX_BODY_BYTES,
  asRunner,
  parseJsonBody,
  parseMessage,
  requireLeases,
  type RunnerCloudDeps,
  type RunnerDoneStored,
  type RunnerHttpRequest,
  type RunnerHttpResponse,
} from "./http.js";
import { stopReply } from "./heartbeat.js";
import { loadAcceptanceScope, loadPrivateOnlyRule, type AcceptanceScope, type PrivateOnlyRule, type TenantQueryable } from "./acceptanceScope.js";
import { RunPullRequestError, loadRunPullRequestText, type PullRequestRef, type PullRequestRepo, type RunPullRequestPort, type RunPullRequestText } from "./runPullRequest.js";
import { normaliseCheck } from "./checkResult.js";
import { checkConflictAttestation, storeConflictAttestation } from "./conflictAttest.js";
import { verifyRunnerRequest } from "./verifyRunnerRequest.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const donePath = (runId: string): string => `/api/runner/runs/${runId}/done`;

/** The `run_events` kind a continuation's dispatch records its branch head under (packages/runner `RUNNER_DISPATCH_BASE_KIND`; a test pins that the two match). */
export const DISPATCH_BASE_KIND = "runner.dispatch_base";

/**
 * POST /api/runner/runs/:id/done (D#6 R2b-3f; body R2b.8 as amended by C12 section 5, C14 section 4, C21 sections 1 and 5, C23 and
 * C24 section 2). `done` is a HINT: the runner says it is finished, and the cloud decides what that means from GitHub and from its
 * own rows. In order:
 *  1. the request is verified; the body must name the path's run. `begin` fences it (generation, runner, lease end, wall clock), extends the
 *     lease while GitHub is asked, and answers the STORED verdict again when this runner's earlier `done` already finished the run at
 *     this generation. Any other finished or fenced run is 409 `{continue:false, reason}`.
 *  1a. a run with a live handoff (D#599 HO-2b) is not judged: the handoff ends it and makes the next run (`completeHandoffOnDone`); the reply says `succeeded` with no pull request, which the runner reads only as "stop".
 *  1b. a run whose runner sent `taken_over` ends `failed taken_over` at once, with no envelope and no pull request (D#6 R4a-7).
 *  2. a reviewer (or any role that is neither the executor nor the docs-writer) makes no commit: its run ends `succeeded`.
 *  3. an executor or a docs-writer is judged, in this order (C21 section 5.4, C25 section 3.1): a continuation with no recorded dispatch head
 *     -> `failed internal_error` (the cloud cannot judge it, C25 section 4); no commit on its branch (or `aheadBy` null, or a continuation whose
 *     head did not move; except an executor's `fix` round whose passing check came in this same `done`, which is judged on its unchanged head like a build that committed)
 *     -> `failed no_commit` for the executor, `succeeded` with no pull request for the docs-writer (finding nothing to update
 *     is a valid outcome for it); a scope that cannot be read -> `failed scope_unknown`, no pull request; then
 *     the pull request is opened as a DRAFT (or reused, if our App opened it), its changed paths are read (paths and change types only),
 *     and: an incomplete listing -> close it, `failed scope_violation`; any rename or unknown change type -> close it, `failed
 *     scope_unknown` (C23 section 3); any path outside the scope -> close it, `failed scope_violation`; otherwise mark it ready (skipped
 *     for a pull request that is already ready, such as a ready-PR fallback) and the run is `succeeded` with the pull request number.
 *     The branch is always kept. GitHub refusing to open the pull request for good is `failed pr_rejected` (C23 section 4); GitHub refusing for good
 *     while its files are read closes it, draft or ready, and ends `failed internal_error` (C25 section 4). GitHub refusing for good to mark it
 *     ready (the runner's pull request token cannot make that call) comes AFTER the scope check passed, so the pull request is left open as a
 *     draft, the run is `succeeded` with its number, and the failure is only logged (C37). Someone with write access marks it ready.
 *     A verdict that names a pull request also records the branch the run was judged on (C25 section 1.2), so a later fix round finds it.
 *  3a. D#6 SCOPE-IN-JOB: a `done` whose check result says `out_of_scope` (the runner skipped the check on its own test of the job's `scope`) skips the early `check_failed` return and goes through step 3 up to
 *     and including the scope-list test (`no_commit`, `scope_unknown` stand). It then ends `failed check_failed` WITHOUT opening a pull request (the check never ran), the stored check naming `out_of_scope`.
 *  4. GitHub unreachable (transport, 5xx, 429, rate limit, timeout) is 503 `{retry_after}` and NOTHING is written; the runner keeps
 *     heartbeating and sends `done` again.
 *  5. `finish` records the verdict under the fence in one transaction. The reply is 200 `{continue:false, outcome, failure_reason, pr_number}`.
 *
 * Every local-only decision is taken from the RUN'S OWN `agent_runs.execution_mode` (C24 section 2), never from the repository's
 * current mode: a run claimed as `runner_local` keeps the local-only rules through `done` even if the repository was switched since.
 * The branch, the repository's owner and name, the scope and the pull request text are all read from our own rows (the run's signed
 * job, `repos`, `spec_versions`, `work_items`); nothing the runner sent in the body names any of them.
 */
export async function doneRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, runId: string): Promise<RunnerHttpResponse> {
  // The edge caps the body in bytes already; the schema's own cap counts UTF-16 units, so the byte cap is held here too (comment 27 item 6).
  if (req.body.byteLength > MAX_BODY_BYTES) throw new RunnerHttpError(413, "body_too_large", "the request body is too large");
  const runner = await verifyRunnerRequest(deps, donePath(runId), req, { replay: "once" });
  // After the signature, not before: an unsigned caller must not learn from a 404 which ids are well formed.
  if (!UUID.test(runId)) throw new RunnerHttpError(404, "not_found", "no such run");
  const message = parseMessage(DoneMessage, parseJsonBody(req));
  if (message.run_id.toLowerCase() !== runId.toLowerCase()) throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  const leases = requireLeases(deps);
  const lease = { accountId: runner.accountId, runnerId: runner.runnerId, runId: message.run_id, leaseGeneration: message.lease_generation };

  // D#519 MQ4-e2-c1: a conflict attestation is judged from the cloud's own rows before anything else is touched; a refusal is a 400 and writes nothing.
  const attestation = message.conflict_attest === undefined ? undefined : { value: message.conflict_attest, ...(await asRunner(() => checkConflictAttestation(deps, { accountId: runner.accountId, runnerId: runner.runnerId, runId: message.run_id, leaseGeneration: message.lease_generation }, message.conflict_attest!))) };

  const begun = await asRunner(() => leases.beginRunnerDone(lease));
  if (begun.kind === "fenced") return stopReply(begun.reason);
  if (begun.kind === "replay") return doneReply(begun.verdict);

  // D#599 HO-2b: a run that is being moved to the other side is not judged. Its work is on the branch; the handoff ends the run and makes the next one.
  if (leases.completeHandoffOnDone) {
    const handed = await asRunner(() => leases.completeHandoffOnDone!(lease));
    if (handed.kind === "fenced") return stopReply(handed.reason);
    if (handed.kind === "retry") return retryReply();
    if (handed.kind === "completed") return doneReply({ outcome: "succeeded", failureReason: null, prNumber: null });
  }

  // Stored once the lease has held (not fenced, not a replay), before the verdict, so a retried `done` finds it; the same value again is a no-op.
  if (attestation?.store) await asRunner(() => storeConflictAttestation(deps, { accountId: runner.accountId, runId: message.run_id }, attestation.value));

  const decided = await decide(deps, lease, message.check);
  if (decided.kind === "retry") return retryReply();
  if (decided.kind === "stop") return stopReply(decided.reason);

  const finished = await asRunner(() =>
    leases.finishRunnerDone({
      ...lease,
      verdict: decided.verdict,
      ...(message.session_id === undefined ? {} : { sessionId: message.session_id }),
      ...(message.agentOutput === undefined ? {} : { agentOutput: message.agentOutput }),
      // D#600 CX-1b: checked by the strict schema above; absent from an older runner, which the store records as `partial`.
      ...(message.context_ledger === undefined ? {} : { contextLedger: message.context_ledger }),
      // D#6 R-CHK-3: recorded only when `decide` accepted it, that is when the run's own signed job carried a check.
      ...(decided.check === undefined ? {} : { check: decided.check }),
    }),
  );
  if (finished.kind === "fenced") return stopReply(finished.reason);
  return doneReply(finished.verdict);
}

const doneReply = (v: RunnerDoneStored): RunnerHttpResponse => ({
  status: 200,
  body: DoneReply.parse({ continue: false, outcome: v.outcome, failure_reason: v.failureReason, pr_number: v.prNumber }),
});

const retryReply = (): RunnerHttpResponse => ({
  status: 503,
  body: DoneRetryReply.parse({ retry_after: DONE_RETRY_AFTER_SECONDS }),
  headers: { "retry-after": String(DONE_RETRY_AFTER_SECONDS) },
});

type Decision = { kind: "verdict"; verdict: RunnerDoneStored; check?: DoneCheck } | { kind: "retry" } | { kind: "stop"; reason: StopReason };
const verdictOf = (verdict: RunnerDoneStored): Decision => ({ kind: "verdict", verdict });
const failed = (failureReason: NonNullable<RunnerDoneStored["failureReason"]>, extra: Partial<RunnerDoneStored> = {}): Decision =>
  verdictOf({ outcome: "failed", failureReason, prNumber: null, ...extra });

/** What the verdict needs from our own rows, read once under the run's tenant. */
interface DoneContext {
  role: string;
  runtime: string;
  /** The RUN's own mode (`agent_runs.execution_mode`), never the repository's current one. */
  executionMode: string;
  repo: PullRequestRepo | null;
  /** The signed job we issued for the run, or null if the stored value does not parse. */
  job: Job | null;
  /** The branch head recorded at this run's dispatch, if a continuation recorded one. `oid` is null when the branch did not exist then. */
  dispatchBase: { oid: string | null } | null;
  scope: AcceptanceScope;
  /** A paired repository's private-only list and the Spec's `private_files`; null when the repository is not paired. */
  privateOnly: PrivateOnlyRule | null;
  text: RunPullRequestText | null;
  /** The runner sent a `taken_over` event for this run: its owner stopped the agent and took over by hand (D#6 R4a-7). */
  takenOver: boolean;
  /** D#598 P1g-3a-3: the cloud's own marker, written in the create transaction of the fix round a person's confirmed Replace started. Nothing in a runner's message can set it. */
  replaceRound: boolean;
  /** D#598 P1g-3a-3: a finished attempt of this run ended `updated`: the runner's report that the public branch was moved to the round's head, verified by the route before it was recorded. */
  updateLanded: boolean;
}

async function loadContext(client: TenantQueryable, i: { accountId: string; runId: string }): Promise<DoneContext | null> {
  const { rows } = await client.query<{ role: string; runtime: string; execution_mode: string; job_signed: unknown; repo_id: string | null; gh_owner: string | null; gh_name: string | null }>(
    `SELECT ar.role, ar.runtime, ar.execution_mode, ar.job_signed, r.id AS repo_id, r.gh_owner, r.gh_name
       FROM agent_runs ar
       LEFT JOIN repos r ON r.account_id = ar.account_id AND r.id = ar.dispatch_repo_id
      WHERE ar.account_id = $1 AND ar.id = $2`,
    [i.accountId, i.runId],
  );
  const row = rows[0];
  if (!row) return null;
  const parsed = SignedJobSchema.safeParse(row.job_signed);
  const base = await client.query<{ head_oid: string | null }>(
    `SELECT payload->>'head_oid' AS head_oid FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 ORDER BY seq DESC LIMIT 1`,
    [i.accountId, i.runId, DISPATCH_BASE_KIND],
  );
  const taken = await client.query(`SELECT 1 FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = 'runner.event' AND payload->>'type' = 'taken_over' LIMIT 1`, [i.accountId, i.runId]);
  const replace = await client.query("SELECT 1 FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 LIMIT 1", [i.accountId, i.runId, RUNNER_REPLACE_ROUND_KIND]);
  const landed = await client.query("SELECT 1 FROM plane_push_attempts WHERE account_id = $1 AND run_id = $2 AND runtime = 'runner' AND kind = 'fix_round' AND finished_at IS NOT NULL AND outcome = 'updated' LIMIT 1", [i.accountId, i.runId]);
  return {
    takenOver: taken.rows.length > 0,
    replaceRound: replace.rows.length > 0,
    updateLanded: landed.rows.length > 0,
    role: row.role,
    runtime: row.runtime,
    executionMode: row.execution_mode,
    repo: row.repo_id && row.gh_owner && row.gh_name ? { id: row.repo_id, owner: row.gh_owner, name: row.gh_name } : null,
    job: parsed.success ? parsed.data.job : null,
    dispatchBase: base.rows.length === 1 ? { oid: base.rows[0]!.head_oid } : null,
    scope: await loadAcceptanceScope(client, i),
    privateOnly: await loadPrivateOnlyRule(client, i),
    text: await loadRunPullRequestText(client, i),
  };
}

/** The change types that pass when the path is in scope (C23 section 3). A copy deletes nothing and a deletion reports its own path. */
const PASSING_CHANGE_TYPES: ReadonlySet<string> = new Set(["ADDED", "MODIFIED", "CHANGED", "DELETED", "COPIED"]);

/** D#6 R-CHK-3: a check passes only on exit 0 inside its cap. No exit status (never started) and a kill at the cap both fail, and so does a result the runner gave a reason for (R-CHK-3d: it was not run safely). */
export const checkPassed = (check: DoneCheck): boolean => check.exit_code === 0 && !check.timed_out && check.reason === undefined;

async function decide(deps: RunnerCloudDeps, i: { accountId: string; runnerId: string; runId: string; leaseGeneration: number }, runnerReported: DoneCheck | undefined): Promise<Decision> {
  const ctx = await withTenant(deps.appUserPool, i.accountId, (client) => loadContext(client, { accountId: i.accountId, runId: i.runId }));
  // A run that passed the fence has a row; if it vanished since, nothing here can be trusted.
  if (!ctx) return failed("internal_error");
  // A run its owner took over ends here, for every role, before any commit or pull request is looked at: no result is judged, nothing is opened,
  // and a reviewer's run can never count toward a merge gate (D#6 R4a-7). The envelope the facade stores for it is none.
  if (ctx.takenOver) return failed("taken_over");
  // Only the executor and the docs-writer push (C25 section 3.2). Every other role (the reviewers, the panel seats, the advisory roles) ends
  // `succeeded` on its done; its envelope is stored after redaction (C21 section 5.2).
  if (!RUNNER_PUSHING_ROLES.has(ctx.role)) return verdictOf({ outcome: "succeeded", failureReason: null, prNumber: null });

  // The local-only rules are keyed on the run's own mode. A run that is not a runner run (either runner mode) has no business here.
  if (ctx.runtime !== "runner" || !isRunnerMode(ctx.executionMode) || !ctx.repo || !ctx.job) return failed("internal_error");
  const port = deps.pullRequests;
  if (!port) throw new RunnerHttpError(503, "not_configured", "the runner API has no GitHub access configured");
  // D#6 R-CHK-3 (C47): the check is judged first, from the run's own signed job and the runner's report, never from `agentOutput`. A job that carried a check and a `done` with no
  // result cannot be told from a check nobody ran, so it is not judged either way (`internal_error`: no fix round is spent on a runner that skipped the step). A result for a job that
  // carried no check is not the cloud's to record. A failed check ends the run `check_failed` BEFORE GitHub is asked anything: no commit test, no scope test, no pull request.
  let reported = runnerReported;
  let scopeHint = false;
  if (ctx.job.check !== undefined) {
    if (reported === undefined) return failed("internal_error");
    // What is stored is the normalised result; a field outside the contract fails the check whatever the exit status said (it is never a pass).
    const norm = normaliseCheck(reported);
    // D#6 CHECK-FAILFILES-TO-CLOUD: a malformed list of failing test files is dropped here and the check goes on without it; the fixed code is the only trace.
    if (norm.failedFilesDropped) (deps.log ?? ((line) => console.warn(line)))(JSON.stringify({ event: CHECK_FAILED_FILES_DROPPED, run_id: i.runId }));
    // D#6 SCOPE-IN-JOB: a result the runner gave the reason `out_of_scope` (and nothing else: no exit status, no cap kill) says it did not run the check because it found changed files outside the list in
    // its job. It does not end the run here: the commit and scope-list tests below run first, from our own rows, exactly as for a run whose check passed, and then the run ends `check_failed`
    // without a pull request (see `judgeCommit`). A hint on a result with any other field out of contract is not read as one.
    scopeHint = norm.outOfContract === null && norm.check.reason === "out_of_scope" && norm.check.exit_code === null && !norm.check.timed_out;
    if (norm.outOfContract !== null || (!checkPassed(norm.check) && !scopeHint)) {
      // The runner pushed the work to the run branch before reporting; recording it (with no pull request) is what lets the fix round continue from its tip.
      const branch = branchOf(ctx.job, i);
      return { ...(failed("check_failed", RUNNER_RUN_BRANCH.test(branch) ? { branch } : {}) as Extract<Decision, { kind: "verdict" }>), check: norm.check };
    }
    reported = norm.check;
  }
  // FIXROUND-NOCOMMIT-CHECK-PASSED: reaching this line with a check in the job means the check passed (a failing or out-of-contract result returned above), so `reported` is a
  // passing result the cloud stores in this same `done` (run_checks and run.check_ended) and the job it signed asked for.
  // A check the runner did not run on a scope hint did not pass on the head, so it never lends the fix round its no-commit exception either.
  const checkPassedOnHead = ctx.job.check !== undefined && reported !== undefined && !scopeHint;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const judged = await judgeRun(port, ctx, ctx.repo, ctx.job, i, log, checkPassedOnHead, (refusal) => refuseScope(deps, i, refusal, log), (close) => holdCloudClose(deps, i, close, log), scopeHint, checkPassedOnHead && reported !== undefined ? readDerivedFresh(DERIVED_FILE_RULES, reported.derived_fresh) : []);
  // A check that passed (or that the runner reported it did not run on its scope hint) is recorded beside whatever the commit and scope tests decided.
  return judged.kind === "verdict" && ctx.job.check !== undefined && reported !== undefined ? { ...judged, check: reported } : judged;
}

/** D#6 SCOPE-IN-JOB: the one log line (stdout, one JSON object, the run id only) left when a run ends `check_failed` on a runner's `out_of_scope` hint. */
export const SCOPE_HINT_EVENT = "runner.done.scope_hint";

/** The plain comment left on a public pull request the cloud closed after its scope check refused the run. Fixed words: no path, no count, nothing from the Spec. */
export const SCOPE_REFUSAL_PUBLIC_COMMENT = "This pull request was closed because the run that produced it was refused by the scope check: it changed files outside the list it was allowed to change. The branch is kept.";

type RefuseScope = (refusal: ScopeRefusal) => Promise<{ kind: "go" } | { kind: "retry" } | { kind: "stop"; reason: StopReason }>;

/**
 * Before the private pull request of a refused run is closed: (1) the refusal is recorded on the run, under the lease fence (the webhook reads it and leaves the item at In progress);
 * (2) the run's public pull request, when the platform opened one and no person took the branch over, is closed with one plain comment. A GitHub blip on (2) asks the runner to
 * send `done` again (nothing is lost: both steps repeat safely); any other failure there is one log line and the verdict is recorded all the same. The branch is never touched.
 */
async function refuseScope(deps: RunnerCloudDeps, i: { accountId: string; runnerId: string; runId: string; leaseGeneration: number }, refusal: ScopeRefusal, write: (line: string) => void): Promise<{ kind: "go" } | { kind: "retry" } | { kind: "stop"; reason: StopReason }> {
  const leases = requireLeases(deps);
  if (!leases.noteScopeRefusal) return { kind: "go" };
  const noted = await asRunner(() => leases.noteScopeRefusal!({ ...i, refusal }));
  if (noted.kind === "fenced") return { kind: "stop", reason: noted.reason };
  return closePublicCopy(deps, i, noted, SCOPE_REFUSAL_PUBLIC_COMMENT, write);
}

/** The plain comment left on a public pull request the cloud closed because it could not read the private pull request's files. Fixed words: nothing from the Spec, no error text. */
export const CLOUD_CLOSE_PUBLIC_COMMENT = "This pull request was closed because the platform could not finish checking the run that produced it. The branch is kept.";

type HoldCloudClose = (close: CloudClose) => Promise<{ kind: "go" } | { kind: "retry" } | { kind: "stop"; reason: StopReason }>;

/**
 * D#6 SCOPE-REFUSAL-FOLLOWUPS: the same two steps as `refuseScope`, for a private pull request the cloud closes for another cause (today: it could not read the files of the pull request it
 * opened, so it closes it unjudged). (1) The close is recorded on the run under the fence BEFORE the close, so the webhook and the stale sweep hold it and the item is not moved to
 * `closed_unmerged` as if a person had closed it; (2) the run's public copy, when the platform opened one, is closed with one plain comment. An older worker without the record: the close goes ahead
 * as it always did.
 */
async function holdCloudClose(deps: RunnerCloudDeps, i: { accountId: string; runnerId: string; runId: string; leaseGeneration: number }, close: CloudClose, write: (line: string) => void): Promise<{ kind: "go" } | { kind: "retry" } | { kind: "stop"; reason: StopReason }> {
  const leases = requireLeases(deps);
  if (!leases.noteCloudClose) return { kind: "go" };
  const noted = await asRunner(() => leases.noteCloudClose!({ ...i, close }));
  if (noted.kind === "fenced") return { kind: "stop", reason: noted.reason };
  return closePublicCopy(deps, i, noted, CLOUD_CLOSE_PUBLIC_COMMENT, write);
}

/** Step (2) of both: closes the public copy the record named (head-ref and pairing checks are the port's and the record's). */
async function closePublicCopy(
  deps: RunnerCloudDeps,
  i: { accountId: string; runnerId: string; runId: string; leaseGeneration: number },
  noted: { publicPr: { codeRepo: string; number: number; branch: string } | null; publicSkipped?: "pairing_changed" },
  comment: string,
  write: (line: string) => void,
): Promise<{ kind: "go" } | { kind: "retry" } | { kind: "stop"; reason: StopReason }> {
  const close = deps.planePush?.closeRefusedPullRequest;
  if (noted.publicPr === null && noted.publicSkipped !== undefined) write(JSON.stringify({ event: "runner.done.public_pr_close_skipped", run_id: UUID.test(i.runId) ? i.runId.toLowerCase() : null, code: noted.publicSkipped }));
  if (noted.publicPr === null || !close) return { kind: "go" };
  try {
    const closed = await close.call(deps.planePush, { accountId: i.accountId, codeRepo: noted.publicPr.codeRepo, number: noted.publicPr.number, branch: noted.publicPr.branch, comment });
    write(JSON.stringify({ event: "runner.done.public_pr_closed", run_id: UUID.test(i.runId) ? i.runId.toLowerCase() : null, result: closed.result, commented: closed.result === "closed" ? closed.commented : null }));
  } catch (error) {
    if ((error as { transient?: unknown } | null)?.transient === true) return { kind: "retry" };
    // fx-swallow-ok: the public close is best effort beside the verdict; the fixed code is the trace, never the error text
    write(JSON.stringify({ event: "runner.done.public_pr_close_failed", run_id: UUID.test(i.runId) ? i.runId.toLowerCase() : null, code: typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "unknown" }));
  }
  return { kind: "go" };
}

/** The `fx/<run>-g<generation>` branch a fresh run pushes, or a continuation's own branch (C25 section 1.2). */
export const branchOf = (job: Job, i: { runId: string; leaseGeneration: number }): string => (job.continues ? job.continues.branch : `${job.branch_prefix}${i.runId}-g${i.leaseGeneration}`);

/** The head the cloud read for the branch (a full sha), for the verdict; nothing when it is not one. */
const headOf = (s: { headOid: string | null } | null): { headOid?: string } => (s !== null && s.headOid !== null && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s.headOid) ? { headOid: s.headOid } : {});

/** Records the judged branch next to the pull request number, and only there: a verdict with no pull request names no branch. */
async function judgeRun(port: RunPullRequestPort, ctx: DoneContext, repo: PullRequestRepo, job: Job, i: { runId: string; leaseGeneration: number }, write: (line: string) => void, checkPassedOnHead: boolean, refuse: RefuseScope, holdClose: HoldCloudClose, scopeHint = false, derivedFresh: readonly string[] = []): Promise<Decision> {
  const decision = await judgeCommit(port, ctx, repo, job, i, write, checkPassedOnHead, refuse, holdClose, scopeHint, derivedFresh);
  if (decision.kind !== "verdict" || decision.verdict.prNumber === null) return decision;
  return verdictOf({ ...decision.verdict, branch: branchOf(job, i) });
}

/** The one line a permanent pull request failure leaves in the logs (stdout, one JSON object). */
export const PR_FAILURE_EVENT = "runner.done.pr_failure";
const LOG_LABEL = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * Says WHY `done` ended a run `internal_error` or `pr_rejected` because of GitHub: the run, the stage, the call, the HTTP status and the
 * GraphQL error type codes. Nothing GitHub wrote is in it (no message, no body, no path), and no token or name: the run id comes from our
 * own row and every other value is a number or a label we chose, or an error type code held to `^[A-Z][A-Z_]{0,39}$`.
 */
export function logPullRequestFailure(write: (line: string) => void, input: { runId: string; stage: string; error: RunPullRequestError }): void {
  try {
    const { error } = input;
    const op = error.op !== undefined && LOG_LABEL.test(error.op) ? error.op : "unknown";
    write(
      JSON.stringify({
        event: PR_FAILURE_EVENT,
        run_id: UUID.test(input.runId) ? input.runId.toLowerCase() : null,
        stage: input.stage,
        op,
        reason: error.reason,
        status: typeof error.status === "number" ? error.status : null,
        graphql_types: error.graphqlTypes,
      }),
    );
  } catch {
    // fx-swallow-ok: diagnostics never change the verdict
  }
}

async function judgeCommit(
  port: RunPullRequestPort,
  ctx: DoneContext,
  repo: PullRequestRepo,
  job: Job,
  i: { runId: string; leaseGeneration: number },
  write: (line: string) => void,
  checkPassedOnHead: boolean,
  refuse: RefuseScope,
  holdClose: HoldCloudClose,
  scopeHint: boolean,
  derivedFresh: readonly string[] = [],
): Promise<Decision> {
  // A fresh run's branch is `<prefix><run>-g<generation>`: a stale generation's branch is never looked at. A continuation works on exactly
  // the branch our issuer put in its signed job (the one recorded for the pull request it fixes).
  const continuation = job.continues !== null;
  const branch = branchOf(job, i);
  // A continuation whose dispatch recorded no branch head cannot show a new commit, and the cloud cannot tell "no change" from "unknown": the
  // user is never told the agent made no change when the cloud simply cannot judge (C25 section 4 a). Checked before GitHub is asked anything.
  if (continuation && ctx.dispatchBase === null) return failed("internal_error");

  let stage: "read" | "create" | "files" | "ready" = "read";
  let branchHead: { headOid: string | null } | null = null;
  let pr: PullRequestRef | null = null;
  /** Closes the pull request (A5). Unreachable GitHub means retry; a permanent refusal does not change the verdict, which is already failed. */
  const close = async (): Promise<"closed" | "retry"> => {
    try {
      await port.close({ repo, number: pr!.number });
      return "closed";
    } catch (error) {
      if (error instanceof RunPullRequestError) return error.retryable ? "retry" : "closed";
      throw error;
    }
  };
  // D#6 CHECKFIX-SUCCESS-AS-FAILED: the refusal is recorded (and the public copy closed) BEFORE the private pull request is closed, so the close the webhook reports is known to be the cloud's own.
  const closeAnd = async (failureReason: "scope_violation" | "scope_unknown", found: { total: number | null; paths: string[] }, extra: Partial<RunnerDoneStored> = {}): Promise<Decision> => {
    const noted = await refuse({ reason: failureReason, prNumber: pr!.number, total: found.total, paths: found.paths, ...(extra.detail === "renamed" || extra.detail === "unknown_change_type" ? { detail: extra.detail } : {}) });
    if (noted.kind !== "go") return noted;
    return (await close()) === "retry" ? { kind: "retry" } : failed(failureReason, { prNumber: pr!.number, ...extra });
  };

  try {
    const base = await port.defaultBranch(repo);
    const state = await port.branchState({ repo, branch, base });
    branchHead = state;
    // The first test: no commit. A missing ref, no comparison (`aheadBy` null: the port never turns it into a number), zero commits ahead, or a
    // continuation whose head is the one recorded at its dispatch. It comes BEFORE the scope test, so a run with no commit never reports a scope
    // problem. A docs-writer that made no commit succeeded with nothing to show: no pull request, no branch (C25 section 3.1).
    // FIXROUND-NOCOMMIT-CHECK-PASSED: the one exception to "a continuation must move the head" is an executor's check-fix round (task kind `fix`) whose repository check
    // passed on the branch head: the earlier commit was right and the failure was unrelated, so the round correctly added nothing. The branch must still exist and be ahead of the
    // base; the pull request is opened (or reused) and the scope test runs on its files exactly as for a build that committed.
    const headUnmoved = continuation && state.headOid === ctx.dispatchBase?.oid;
    const unchangedButChecked = headUnmoved && checkPassedOnHead && ctx.role === "executor" && job.task.kind === "fix";
    // D#598 P1g-3a-3: the other exception. The one round a person's confirmed Replace started (the cloud's own marker) normally adds nothing: the refused round's change is already on the branch and this round
    // publishes it. The branch must still exist and be ahead of the base; every later test runs as for a build that committed.
    // Success needs the update to have landed: a finished attempt of this run that ended `updated` (the runner's report comes before `done`, in sequence). Without it the round stays `no_commit`, as before.
    const unchangedReplace = headUnmoved && ctx.replaceRound && ctx.updateLanded && ctx.role === "executor" && job.task.kind === "fix";
    const noCommit = !state.exists || state.aheadBy === null || state.aheadBy === 0 || (headUnmoved && !unchangedButChecked && !unchangedReplace);
    if (noCommit) {
      if (ctx.role !== "docs-writer") return failed("no_commit");
      // A docs-writer that cannot be shown to have made no commit (the comparison could not be read) is not told it succeeded.
      return state.exists && state.aheadBy === null ? failed("internal_error") : verdictOf({ outcome: "succeeded", failureReason: null, prNumber: null });
    }

    // C34 section 2.2: a Spec with no list (absent or empty) says so; an unreadable one keeps today's detail-less answer.
    if (ctx.scope.kind === "unknown") return failed("scope_unknown", ctx.scope.reason === "absent" ? { detail: "no_file_list" } : {});
    // D#6 SCOPE-IN-JOB: the runner skipped the check because it thought changed files were outside the job's list. The check never ran, so the run cannot succeed, and the cloud opens NO pull request for it:
    // opening one only to read its files (and closing it again) would reach the webhook as a pull request that opened and then closed, and move the item. It ends `check_failed` with no pull request, the
    // stored check naming `out_of_scope`, the branch recorded for the fix round. The tests above this line (no commit, scope unreadable) are judged first and stand; a file really outside the list is
    // therefore met by the check-fix round, not by a refusal record. The hint can never produce a pass.
    if (scopeHint) {
      write(JSON.stringify({ event: SCOPE_HINT_EVENT, run_id: UUID.test(i.runId) ? i.runId.toLowerCase() : null }));
      return failed("check_failed", RUNNER_RUN_BRANCH.test(branch) ? { branch } : {});
    }
    // The pull request's text is made from the run's work item. A run with none cannot be given a pull request at all.
    if (ctx.text === null) return failed("internal_error");

    stage = "create";
    pr = await port.openDraft({ repo, branch, base, run: ctx.text });
    stage = "files";
    const changed = await port.changedFiles({ repo, number: pr.number });
    // Order (C23 section 3): the count, then renames and unknown types, then the paths.
    if (!changed.complete) return closeAnd("scope_violation", { total: null, paths: [] });
    const odd = changed.files.find((f) => !PASSING_CHANGE_TYPES.has(f.changeType));
    if (odd) return closeAnd("scope_unknown", { total: 1, paths: [odd.path] }, { detail: odd.changeType === "RENAMED" ? "renamed" : "unknown_change_type" });
    // A paired repository's private-only paths never reach the public repository, so a change that edits one cannot be published. It is out of scope here, whatever the file list says,
    // unless the Spec lists the path in `private_files`. Caught now, with the paths named, instead of after the review at the public push.
    // #751: a generated file (the OpenAPI document and client beside a route) is in scope when its rule's input is and the runner, whose check passed on this head, vouched that it equals a fresh
    // generator run (`derivedFresh`; empty for every run whose runner did not). Everything else is held to the list as before.
    const notInScope = new Set(pathsOutsideScopeFresh(DERIVED_FILE_RULES, ctx.scope, changed.files.map((f) => f.path), derivedFresh));
    const outside = changed.files
      .filter((f) => notInScope.has(f.path) || (ctx.privateOnly !== null && privateOnlyEditsNotAllowed(ctx.privateOnly.overlayGlobs, ctx.privateOnly.privateFiles, [f.path]).length > 0))
      .map((f) => f.path);
    if (outside.length > 0) return closeAnd("scope_violation", { total: outside.length, paths: outside });

    // After a ready-PR fallback (or a pull request someone marked ready) there is nothing to mark.
    if (pr.draft) {
      stage = "ready";
      await port.markReady({ repo, pullRequest: pr });
    }
    return verdictOf({ outcome: "succeeded", failureReason: null, prNumber: pr.number, ...headOf(state) });
  } catch (error) {
    if (!(error instanceof RunPullRequestError)) throw error;
    if (error.retryable) return { kind: "retry" };
    logPullRequestFailure(write, { runId: i.runId, stage, error });
    // GitHub refused to open the pull request for good (or our App did not open the one on the branch): `pr_rejected`. A permanent failure at
    // any other step has no reason of its own in the Spec, so it is `internal_error`. If the pull request exists by then because its files could
    // not be read, its paths were never checked, so it is closed, a draft or a ready fallback alike (C25 section 4 b).
    if (stage === "create") return failed("pr_rejected", error.status === undefined ? {} : { prHttpStatus: error.status });
    // C37: a permanent refusal to mark ready happens after the scope check passed, so the pull request is already known to be in scope. The
    // runner's token may not make that mutation, and closing a checked pull request for it would throw away good work. It stays open as a
    // draft (nothing is closed), the run succeeded, and the log line above is the only trace.
    if (stage === "ready" && pr) return verdictOf({ outcome: "succeeded", failureReason: null, prNumber: pr.number, ...headOf(branchHead) });
    // SCOPE-REFUSAL-FOLLOWUPS: this close is the cloud's own. It is recorded (and the public copy closed) BEFORE the private pull request is closed, so the close the webhook reports is not read as a person's.
    if (pr) {
      const held = await holdClose({ cause: "internal_error", prNumber: pr.number });
      if (held.kind !== "go") return held;
      if ((await close()) === "retry") return { kind: "retry" };
    }
    return failed("internal_error", { prNumber: pr?.number ?? null });
  }
}
