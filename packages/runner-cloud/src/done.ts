import { DONE_RETRY_AFTER_SECONDS, DoneMessage, DoneReply, DoneRetryReply, SignedJobSchema, type Job } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
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
import { loadAcceptanceScope, pathInScope, type AcceptanceScope, type TenantQueryable } from "./acceptanceScope.js";
import { RunPullRequestError, loadRunPullRequestText, type PullRequestRef, type PullRequestRepo, type RunPullRequestPort, type RunPullRequestText } from "./runPullRequest.js";
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
 *  1b. a run whose runner sent `taken_over` ends `failed taken_over` at once, with no envelope and no pull request (D#6 R4a-7).
 *  2. a reviewer (or any role that is neither the executor nor the docs-writer) makes no commit: its run ends `succeeded`.
 *  3. an executor or a docs-writer is judged, in this order (C21 section 5.4, C25 section 3.1): a continuation with no recorded dispatch head
 *     -> `failed internal_error` (the cloud cannot judge it, C25 section 4); no commit on its branch (or `aheadBy` null, or a continuation whose
 *     head did not move) -> `failed no_commit` for the executor, `succeeded` with no pull request for the docs-writer (finding nothing to update
 *     is a valid outcome for it); a scope that cannot be read -> `failed scope_unknown`, no pull request; then
 *     the pull request is opened as a DRAFT (or reused, if our App opened it), its changed paths are read (paths and change types only),
 *     and: an incomplete listing -> close it, `failed scope_violation`; any rename or unknown change type -> close it, `failed
 *     scope_unknown` (C23 section 3); any path outside the scope -> close it, `failed scope_violation`; otherwise mark it ready (skipped
 *     for a pull request that is already ready, such as a ready-PR fallback) and the run is `succeeded` with the pull request number.
 *     The branch is always kept. GitHub refusing to open the pull request for good is `failed pr_rejected` (C23 section 4); GitHub refusing for good
 *     after the pull request exists (reading its files, or marking it ready) closes it, draft or ready, and ends `failed internal_error` (C25 section 4).
 *     A verdict that names a pull request also records the branch the run was judged on (C25 section 1.2), so a later fix round finds it.
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
  if (!UUID.test(runId)) throw new RunnerHttpError(404, "not_found", "no such run");
  // The edge caps the body in bytes already; the schema's own cap counts UTF-16 units, so the byte cap is held here too (comment 27 item 6).
  if (req.body.byteLength > MAX_BODY_BYTES) throw new RunnerHttpError(413, "body_too_large", "the request body is too large");
  const runner = await verifyRunnerRequest(deps, donePath(runId), req, { replay: "once" });
  const message = parseMessage(DoneMessage, parseJsonBody(req));
  if (message.run_id.toLowerCase() !== runId.toLowerCase()) throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  const leases = requireLeases(deps);
  const lease = { accountId: runner.accountId, runnerId: runner.runnerId, runId: message.run_id, leaseGeneration: message.lease_generation };

  const begun = await asRunner(() => leases.beginRunnerDone(lease));
  if (begun.kind === "fenced") return stopReply(begun.reason);
  if (begun.kind === "replay") return doneReply(begun.verdict);

  const decided = await decide(deps, lease);
  if (decided.kind === "retry") return retryReply();

  const finished = await asRunner(() =>
    leases.finishRunnerDone({
      ...lease,
      verdict: decided.verdict,
      ...(message.session_id === undefined ? {} : { sessionId: message.session_id }),
      ...(message.agentOutput === undefined ? {} : { agentOutput: message.agentOutput }),
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

type Decision = { kind: "verdict"; verdict: RunnerDoneStored } | { kind: "retry" };
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
  text: RunPullRequestText | null;
  /** The runner sent a `taken_over` event for this run: its owner stopped the agent and took over by hand (D#6 R4a-7). */
  takenOver: boolean;
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
  return {
    takenOver: taken.rows.length > 0,
    role: row.role,
    runtime: row.runtime,
    executionMode: row.execution_mode,
    repo: row.repo_id && row.gh_owner && row.gh_name ? { id: row.repo_id, owner: row.gh_owner, name: row.gh_name } : null,
    job: parsed.success ? parsed.data.job : null,
    dispatchBase: base.rows.length === 1 ? { oid: base.rows[0]!.head_oid } : null,
    scope: await loadAcceptanceScope(client, i),
    text: await loadRunPullRequestText(client, i),
  };
}

/** The change types that pass when the path is in scope (C23 section 3). A copy deletes nothing and a deletion reports its own path. */
const PASSING_CHANGE_TYPES: ReadonlySet<string> = new Set(["ADDED", "MODIFIED", "CHANGED", "DELETED", "COPIED"]);

async function decide(deps: RunnerCloudDeps, i: { accountId: string; runId: string; leaseGeneration: number }): Promise<Decision> {
  const ctx = await withTenant(deps.appUserPool, i.accountId, (client) => loadContext(client, { accountId: i.accountId, runId: i.runId }));
  // A run that passed the fence has a row; if it vanished since, nothing here can be trusted.
  if (!ctx) return failed("internal_error");
  // A run its owner took over ends here, for every role, before any commit or pull request is looked at: no result is judged, nothing is opened,
  // and a reviewer's run can never count toward a merge gate (D#6 R4a-7). The envelope the facade stores for it is none.
  if (ctx.takenOver) return failed("taken_over");
  // Only the executor and the docs-writer push (C25 section 3.2). Every other role (the reviewers, the panel seats, the advisory roles) ends
  // `succeeded` on its done; its envelope is stored after redaction (C21 section 5.2).
  if (ctx.role !== "executor" && ctx.role !== "docs-writer") return verdictOf({ outcome: "succeeded", failureReason: null, prNumber: null });

  // The local-only rules are keyed on the run's own mode. A run that is not a `runner_local` runner run has no business here.
  if (ctx.runtime !== "runner" || ctx.executionMode !== "runner_local" || !ctx.repo || !ctx.job) return failed("internal_error");
  const port = deps.pullRequests;
  if (!port) throw new RunnerHttpError(503, "not_configured", "the runner API has no GitHub access configured");
  return judgeRun(port, ctx, ctx.repo, ctx.job, i);
}

/** The `fx/<run>-g<generation>` branch a fresh run pushes, or a continuation's own branch (C25 section 1.2). */
export const branchOf = (job: Job, i: { runId: string; leaseGeneration: number }): string => (job.continues ? job.continues.branch : `${job.branch_prefix}${i.runId}-g${i.leaseGeneration}`);

/** Records the judged branch next to the pull request number, and only there: a verdict with no pull request names no branch. */
async function judgeRun(port: RunPullRequestPort, ctx: DoneContext, repo: PullRequestRepo, job: Job, i: { runId: string; leaseGeneration: number }): Promise<Decision> {
  const decision = await judgeCommit(port, ctx, repo, job, i);
  if (decision.kind !== "verdict" || decision.verdict.prNumber === null) return decision;
  return verdictOf({ ...decision.verdict, branch: branchOf(job, i) });
}

async function judgeCommit(
  port: RunPullRequestPort,
  ctx: DoneContext,
  repo: PullRequestRepo,
  job: Job,
  i: { runId: string; leaseGeneration: number },
): Promise<Decision> {
  // A fresh run's branch is `<prefix><run>-g<generation>`: a stale generation's branch is never looked at. A continuation works on exactly
  // the branch our issuer put in its signed job (the one recorded for the pull request it fixes).
  const continuation = job.continues !== null;
  const branch = branchOf(job, i);
  // A continuation whose dispatch recorded no branch head cannot show a new commit, and the cloud cannot tell "no change" from "unknown": the
  // user is never told the agent made no change when the cloud simply cannot judge (C25 section 4 a). Checked before GitHub is asked anything.
  if (continuation && ctx.dispatchBase === null) return failed("internal_error");

  let stage: "read" | "create" | "files" | "ready" = "read";
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
  const closeAnd = async (failureReason: "scope_violation" | "scope_unknown", extra: Partial<RunnerDoneStored> = {}): Promise<Decision> =>
    (await close()) === "retry" ? { kind: "retry" } : failed(failureReason, { prNumber: pr!.number, ...extra });

  try {
    const base = await port.defaultBranch(repo);
    const state = await port.branchState({ repo, branch, base });
    // The first test: no commit. A missing ref, no comparison (`aheadBy` null: the port never turns it into a number), zero commits ahead, or a
    // continuation whose head is the one recorded at its dispatch. It comes BEFORE the scope test, so a run with no commit never reports a scope
    // problem. A docs-writer that made no commit succeeded with nothing to show: no pull request, no branch (C25 section 3.1).
    const noCommit = !state.exists || state.aheadBy === null || state.aheadBy === 0 || (continuation && state.headOid === ctx.dispatchBase?.oid);
    if (noCommit) {
      if (ctx.role !== "docs-writer") return failed("no_commit");
      // A docs-writer that cannot be shown to have made no commit (the comparison could not be read) is not told it succeeded.
      return state.exists && state.aheadBy === null ? failed("internal_error") : verdictOf({ outcome: "succeeded", failureReason: null, prNumber: null });
    }

    // C34 section 2.2: a Spec with no list (absent or empty) says so; an unreadable one keeps today's detail-less answer.
    if (ctx.scope.kind === "unknown") return failed("scope_unknown", ctx.scope.reason === "absent" ? { detail: "no_file_list" } : {});
    // The pull request's text is made from the run's work item. A run with none cannot be given a pull request at all.
    if (ctx.text === null) return failed("internal_error");

    stage = "create";
    pr = await port.openDraft({ repo, branch, base, run: ctx.text });
    stage = "files";
    const changed = await port.changedFiles({ repo, number: pr.number });
    // Order (C23 section 3): the count, then renames and unknown types, then the paths.
    if (!changed.complete) return closeAnd("scope_violation");
    const odd = changed.files.find((f) => !PASSING_CHANGE_TYPES.has(f.changeType));
    if (odd) return closeAnd("scope_unknown", { detail: odd.changeType === "RENAMED" ? "renamed" : "unknown_change_type" });
    if (changed.files.some((f) => !pathInScope(ctx.scope, f.path))) return closeAnd("scope_violation");

    // After a ready-PR fallback (or a pull request someone marked ready) there is nothing to mark.
    if (pr.draft) {
      stage = "ready";
      await port.markReady({ repo, pullRequest: pr });
    }
    return verdictOf({ outcome: "succeeded", failureReason: null, prNumber: pr.number });
  } catch (error) {
    if (!(error instanceof RunPullRequestError)) throw error;
    if (error.retryable) return { kind: "retry" };
    // GitHub refused to open the pull request for good (or our App did not open the one on the branch): `pr_rejected`. A permanent failure at
    // any other step has no reason of its own in the Spec, so it is `internal_error`. If the pull request exists by then (its files could not be
    // read, or it could not be marked ready) its paths were never checked, so it is closed, a draft or a ready fallback alike (C25 section 4 b).
    if (stage === "create") return failed("pr_rejected", error.status === undefined ? {} : { prHttpStatus: error.status });
    if (pr && (await close()) === "retry") return { kind: "retry" };
    return failed("internal_error", { prNumber: pr?.number ?? null });
  }
}
