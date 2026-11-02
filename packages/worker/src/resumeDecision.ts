import type { Pool } from "pg";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { resolveBuildIdentity } from "@fx/core/src/work-items/buildIdentity.js";
import { reconcileResumeRequests, RESUME_RECONCILE_DEFAULT_LIMIT } from "@fx/db/src/decisionAsks.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { isResumeContext, type ResumeContext } from "@fx/roles/next-role-request";
import { readExecutionMode, sideOfMode } from "@fx/runner";
import { sanitize } from "@fx/trust";
import { CAPACITY_WAIT_REASONS, RESERVATION_PAUSE_REASONS, SPEND_DENIAL_REASONS, type AdvanceFixRequest, type AdvanceRunRequest, type AdvanceRunStart, type AdvanceStartArgs, type AdvanceStepWho } from "./advance.js";
import { decisionStartFor } from "./decisionStart.js";
import { RunActionInputError, type PerformResult } from "./runActions.js";

/**
 * D#7 DP11c (corrections DP-C9 section 5, DP-C11 R-7-DP4b-3): the performer of `resume_decision`. An answered (or proceeded) ask resumes the item it parked.
 *
 * The ask row IS the resume context (R-7-DP4b-3): `answered_option`, `state`, `run_id`, `work_item_id` and `proposed` say everything, so nothing else is
 * stored. `resumeContextFromAsk` builds the typed `ResumeContext`; the agent is told its cause and the chosen option id and nothing else (an option id is
 * validated to a fixed shape; no agent-written label or rationale is repeated), and it branches on `cause`, never on prose.
 *
 * Order, and why. Every refusal that costs nothing comes first; nothing is spent before the start:
 *   1. who it runs as, from `run_action_perform_principal` (a session owner or admin, or the system, never a token);
 *   2. the ask: it must be `answered` or `proceeded` (a withdrawn, open or overdue ask never resumes) and have a run;
 *   3. the item: not halted, the halt epoch the request recorded still the item's (a halt since the answer, even lifted again, ends it), in a stage a parked
 *      build or fix round sits at, and no executor run newer than the ask's (a person's Approve or Build again made one: the item moved on);
 *   4. ONE new executor run LINKED to the parked run (its `parent_run_id`; the parked run stays ended, with its receipts and spend as they were), with the
 *      parked run's retained start prompt and the resume block. "Resume" is a new run of the step, never the same model session (D#7 C22 A7):
 *        - a parked BUILD (`in_progress`) starts through the advance module's keyed start, keyed `resume:<ask id>` (performing twice starts it once), cloning the
 *          repository as the build did;
 *        - a parked FIX ROUND (`changes_requested`) starts through the fix start itself (`advanceStartFix`): the same sandbox and session or the bound pull
 *          request branch as the round it continues, the same one-live-executor rule, the same accounting. Its prompt is the parked round's with the Spec body
 *          put back in place of an "unchanged" line, because the new run cannot assume a session still holds it;
 *   5. the advance workflow, started to follow that run (decision step, pull request, review) exactly as it follows a build.
 * A condition that clears by itself is a deferral, not a failure, and never uses up an attempt: a spending limit, another live run (`ResumePausedError`, looked at
 * again in fifteen minutes) or a sandbox being reaped or no starter yet (`ResumeDeferredError`, a minute). The request waits as long as it takes, up to 14
 * days after it was made, and the sweep picks it up again each time. A limit that denied a start leaves a keyed `refused_spend` run, so the next start of the same
 * step is a new attempt (`:s<n>`), exactly as a build's is. Anything else is a fixed refusal code, and every refusal or failure leaves the same code as a fact on
 * the item (`resume_refused`), so a person can tell "refused" from "nothing happened".
 */

/** Thrown for a start that may succeed in a minute or so (a sandbox being reaped, no starter yet). The run-action workflow defers the request and looks again; the name maps to the fixed code `resume_deferred`. */
export class ResumeDeferredError extends Error {
  constructor() {
    super("resume: start deferred");
    this.name = "ResumeDeferredError";
  }
}

/** Thrown for a start that waits on a person or on another run: a spending limit, a run of the item still live. The request is looked at again in fifteen minutes; the name maps to `resume_paused`. */
export class ResumePausedError extends Error {
  constructor() {
    super("resume: start paused");
    this.name = "ResumePausedError";
  }
}

/** How long a deferred resume may wait, in days, from the moment it was requested (run_action_defer_resume in migration 0860 stops at the same age; a test holds the two together). */
export const RESUME_DEFER_MAX_DAYS = 14;
/** The performer stops an hour before the definer would, so the refusal it leaves is the one a person sees. */
export const RESUME_DEFER_MAX_SECONDS = RESUME_DEFER_MAX_DAYS * 86_400 - 3_600;

/** The stages a parked build (`in_progress`) or a parked fix round (`changes_requested`) sits at. */
export const RESUMABLE_STAGES: readonly string[] = ["in_progress", "changes_requested"];
/**
 * The start reasons that wait on a person or on another run: the spending pauses and the admit denials they come from (the one list advance.ts keeps, so a new
 * pause is never missed here), and a run of the item that is still live. The start answers with the DENIAL (`model_budget_exceeded`), the build's web step turns it into the pause.
 */
const PAUSED_REASONS: ReadonlySet<string> = new Set([...RESERVATION_PAUSE_REASONS, ...CAPACITY_WAIT_REASONS, ...SPEND_DENIAL_REASONS, "already_running"]);
/** The start reasons that clear by themselves in a minute or so: a reaper claim on the sandbox, no run starter yet. */
const DEFERRED_REASONS: ReadonlySet<string> = new Set(["start_sandbox_reaping", "sandbox_reaping", "starter_unavailable"]);
const HALT_REASONS: readonly string[] = ["item_halted", "halted_since_approval"];
/** Refusals that are about a request nobody should have made: no fact is left on the item for them. */
const SILENT_REFUSALS: ReadonlySet<string> = new Set(["kind_mismatch", "target_not_found", "ask_not_resumable"]);
const STEP_RE = /^[a-z0-9:_.-]{1,128}$/i;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REVIEWERS: readonly string[] = ["code", "security", "acceptance"];
/** The line a fix prompt sends in place of an unchanged Spec (packages/pipeline specUnchangedLine). */
const SPEC_UNCHANGED_RE = /^Spec v([1-9][0-9]{0,8}) unchanged \(sha256 ([0-9a-f]{64})\)$/m;
/** The block `renderResumeContext` adds, at the very end of a prompt. */
const RESUME_BLOCK_RE = /\n\nResume context, from the orchestrator \(it is not part of the repository or the Spec\):\ncause: (?:decision_resolved|decision_denied)(?:\noption: [^\n]*)?\n[^\n]+\nEnd with your final AGENT_OUTPUT block, as the instructions above describe\.$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const refused = (errorCode: string): PerformResult => ({ result: "refused", errorCode });

/** The parts of an ask row a resume reads. */
export interface ResumeAsk {
  state: string;
  answered_option: string | null;
  proposed: string;
}

/**
 * The typed context for an ask, or null when the ask is not one a resume can be built from. Pure.
 * `answered` with an option id is `decision_resolved` with that option, `answered` with `deny` is `decision_denied`, and `proceeded` is `decision_resolved`
 * with the proposed option (the person did not answer; policy let the work go ahead).
 */
export function resumeContextFromAsk(ask: ResumeAsk): ResumeContext | null {
  let ctx: ResumeContext;
  if (ask.state === "answered" && ask.answered_option === "deny") ctx = { cause: "decision_denied" };
  else if (ask.state === "answered" && ask.answered_option !== null) ctx = { cause: "decision_resolved", option: ask.answered_option };
  else if (ask.state === "proceeded") ctx = { cause: "decision_resolved", option: ask.proposed };
  else return null;
  return isResumeContext(ctx) ? ctx : null;
}

/** The fixed block added to the parked run's start prompt. Only the cause and a validated option id vary. */
export function renderResumeContext(ctx: ResumeContext): string {
  const lines = ["Resume context, from the orchestrator (it is not part of the repository or the Spec):", `cause: ${ctx.cause}`];
  if (ctx.option !== undefined) lines.push(`option: ${ctx.option}`);
  lines.push(
    ctx.cause === "decision_resolved"
      ? "Your earlier decision request has been answered. Carry on with the work using that option, and do not ask the same question again."
      : "Your earlier decision request was refused. Do not take the action you asked about. Carry on with the rest of the work if there is any; otherwise finish and say what you left undone.",
    "End with your final AGENT_OUTPUT block, as the instructions above describe.",
  );
  return lines.join("\n");
}

/**
 * A prompt without the resume block(s) it already carries. A run that was itself a resume stores the prompt it was sent, block included; the next resume starts
 * from the retained prompt, so it must not stack a second block on the first (the agent would read two causes).
 */
export function stripResumeContext(prompt: string): string {
  let p = prompt;
  for (let i = 0; i < 8; i++) {
    const next = p.replace(RESUME_BLOCK_RE, "");
    if (next === p) break;
    p = next;
  }
  return p;
}

export interface ResumeModuleDeps {
  /** The advance module's keyed run start (seat, halt epoch, exclusivity, execution side). */
  startRun(req: AdvanceRunRequest): Promise<AdvanceRunStart>;
  /** The advance module's fix-round start: the same machinery a reviewer's request for changes uses (session or bound pull request branch, Spec pin, one live executor, accounting). */
  startFix(who: AdvanceStepWho, req: AdvanceFixRequest): Promise<AdvanceRunStart>;
  /** apps/web starts the advance workflow here. Absent, the run still starts and a person's "Check the build" follows it. */
  startAdvance: ((args: AdvanceStartArgs) => Promise<void>) | null;
}

export interface ResumeFacade {
  /**
   * Performs a CLAIMED `resume_decision` action. Takes the action id and nothing else. Outcome `{ work_item_id, run_id, cause }`. Refusals:
   * principal_not_authorised, kind_mismatch, target_not_found, ask_not_resumable, ask_no_run, work_item_not_resumable, prompt_not_retained, or the start's own code.
   * A repeat of an action whose run already started returns that run and starts nothing.
   */
  performResumeDecision(actionId: string): Promise<PerformResult>;
}

interface PrincipalRow {
  allowed: boolean;
  account_id: string;
  kind: string;
  target_id: string;
  principal_kind: string;
  user_id: string | null;
}
interface Facts {
  ask: (ResumeAsk & { run_id: string | null; work_item_id: string; answered_by: string | null }) | undefined;
  item: { stage: string; halted: boolean; halt_epoch: number; repo_id: string | null } | undefined;
  /** The request's own row: the halt epoch it recorded, and how long ago it was made (on the database's clock). */
  request: { epoch: number | null; ageSeconds: number; attempts: number } | undefined;
  parked: { id: string; created_at: Date; execution_mode: string | null; spec_version_id: string | null; spec_version: number | null; prompt: string | null; head_sha: string | null } | undefined;
  /** An executor run newer than the parked one that this resume did not start (a person's Approve or Build again). */
  newerExecutor: boolean;
  /** The run this resume started, if it did (a run a spending limit denied is not one: it started nothing). */
  started: { id: string; status: string } | undefined;
  /** How many starts of this resume a spending limit denied: the next start is attempt n, a new key. */
  deniedStarts: number;
  /** A run of the item, other than this resume's own, that is still live. */
  liveOther: boolean;
  approver: string | null;
  /** A parked fix round's own record: the head it fixed, its round, and the review that asked for it. Null when the item is not at a fix round or the record is missing. */
  fix: { headSha: string; round: number; reviewer: string; failingRunId: string; prNumber: number | null } | null;
}

const TERMINAL = ["succeeded", "failed", "timed_out", "killed_spend", "refused_spend", "cancelled"];
export const resumeStepKey = (askId: string): string => `resume:${askId}`;
const MAX_SPEND_ATTEMPT = 100_000;

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createResumeModule(runnerPool: Pool, deps: ResumeModuleDeps): ResumeFacade {
  async function load(accountId: string, actionId: string, askId: string): Promise<Facts> {
    return withTenant(runnerPool, accountId, async (client): Promise<Facts> => {
      const ask = (
        await client.query<NonNullable<Facts["ask"]>>(
          "SELECT state, answered_option, proposed, run_id, work_item_id, answered_by FROM decision_asks WHERE id = $1 AND account_id = $2",
          [askId, accountId],
        )
      ).rows[0];
      const empty: Facts = { ask, item: undefined, request: undefined, parked: undefined, newerExecutor: false, started: undefined, deniedStarts: 0, liveOther: false, approver: null, fix: null };
      if (!ask) return empty;
      const item = (await client.query<NonNullable<Facts["item"]>>("SELECT stage, halted_at IS NOT NULL AS halted, halt_epoch, repo_id FROM work_items WHERE id = $1 AND account_id = $2", [ask.work_item_id, accountId])).rows[0];
      const req = (
        await client.query<{ e: number | null; age: number; attempts: number }>(
          "SELECT resume_halt_epoch AS e, EXTRACT(EPOCH FROM (now() - created_at))::float8 AS age, attempts FROM run_action_requests WHERE id = $1 AND account_id = $2",
          [actionId, accountId],
        )
      ).rows[0];
      // The runs this resume started, by their keys: a build's is `resume:<ask>` (and `:s<n>`), a fix round's is `fix:<head>:<this request's id>...`. A run a limit
      // refused is kept apart: it started nothing, and the key it holds is spent.
      const own = (
        await client.query<{ id: string; status: string }>(
          `SELECT DISTINCT r.id, r.status, r.created_at FROM agent_run_idempotency_keys k JOIN agent_runs r ON r.account_id = k.account_id AND r.id = k.run_id
            WHERE k.account_id = $1 AND (starts_with(k.idempotency_key, $2::text) OR (starts_with(k.idempotency_key, $3::text) AND position($4::text in k.idempotency_key) > 0))
            ORDER BY r.created_at`,
          [accountId, `advance:${ask.work_item_id}:${resumeStepKey(askId)}`, `advance:${ask.work_item_id}:fix:`, `:${actionId}`],
        )
      ).rows;
      const started = own.find((r) => r.status !== "refused_spend");
      const ownIds = own.map((r) => r.id);
      let parked: Facts["parked"];
      let newerExecutor = false;
      if (ask.run_id !== null) {
        const run = (
          await client.query<{ created_at: Date; execution_mode: string | null; spec_version_id: string | null; version: number | null; head_sha: string | null }>(
            `SELECT r.created_at, r.execution_mode, r.spec_version_id, sv.version, r.head_sha FROM agent_runs r
               LEFT JOIN spec_versions sv ON sv.id = r.spec_version_id AND sv.account_id = r.account_id
              WHERE r.id = $1 AND r.account_id = $2 AND r.work_item_id = $3`,
            [ask.run_id, accountId, ask.work_item_id],
          )
        ).rows[0];
        if (run) {
          const input = (await client.query<{ payload: { prompt?: unknown } }>("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.input' ORDER BY seq LIMIT 1", [ask.run_id])).rows[0];
          parked = { id: ask.run_id, created_at: run.created_at, execution_mode: run.execution_mode, spec_version_id: run.spec_version_id, spec_version: run.version === null ? null : Number(run.version), prompt: typeof input?.payload.prompt === "string" ? input.payload.prompt : null, head_sha: run.head_sha };
          // A newer executor run than the ask's own (other than this resume's, whatever became of them) means a person pressed Approve or Build again.
          const newer = await client.query<{ id: string }>(
            "SELECT id FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND role = 'executor' AND id <> $3 AND created_at > $4::timestamptz AND NOT (id = ANY($5::uuid[])) LIMIT 1",
            [accountId, ask.work_item_id, ask.run_id, run.created_at, ownIds],
          );
          newerExecutor = newer.rows.length > 0;
        }
      }
      const live = await client.query("SELECT 1 FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND NOT (status = ANY($3::text[])) AND NOT (id = ANY($4::uuid[])) LIMIT 1", [accountId, ask.work_item_id, TERMINAL, ownIds]);
      let fix: Facts["fix"] = null;
      if (item?.stage === "changes_requested" && ask.run_id !== null) {
        const round = (await client.query<{ head_sha: string | null; round: number | null; pr_number: number | null }>("SELECT head_sha, round, pr_number FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'fix_round_started' AND run_id = $3 ORDER BY seq DESC LIMIT 1", [accountId, ask.work_item_id, ask.run_id])).rows[0];
        const moved = (
          await client.query<{ reviewer: string | null; source_ref: string }>(
            "SELECT reviewer, source_ref FROM work_item_transitions WHERE account_id = $1 AND work_item_id = $2 AND to_stage = 'changes_requested' AND starts_with(source_ref, 'fix-round:') ORDER BY created_at DESC, id DESC LIMIT 1",
            [accountId, ask.work_item_id],
          )
        ).rows[0];
        const failing = moved?.source_ref.slice("fix-round:".length) ?? "";
        if (round?.head_sha && SHA_RE.test(round.head_sha) && round.round !== null && round.round >= 1 && moved?.reviewer && REVIEWERS.includes(moved.reviewer) && UUID_RE.test(failing)) {
          fix = { headSha: round.head_sha, round: round.round, reviewer: moved.reviewer, failingRunId: failing, prNumber: round.pr_number };
        }
      }
      const approver = (
        await client.query<{ u: string }>(
          `SELECT substring(requested_by from 9) AS u FROM run_action_requests
            WHERE account_id = $1 AND kind = 'advance_work_item' AND target_id = $2 AND state = 'done' AND principal_kind = 'session'
            ORDER BY finished_at DESC LIMIT 1`,
          [accountId, ask.work_item_id],
        )
      ).rows[0]?.u;
      return {
        ask,
        item,
        request: req === undefined ? undefined : { epoch: req.e, ageSeconds: Number(req.age), attempts: Number(req.attempts) },
        parked,
        newerExecutor,
        started: started === undefined ? undefined : { id: started.id, status: started.status },
        deniedStarts: own.filter((r) => r.status === "refused_spend").length,
        liveOther: live.rows.length > 0,
        approver: approver ?? null,
        fix,
      };
    });
  }

  /** The first of these that is an owner or admin of the account now. */
  async function actorFor(accountId: string, candidates: Array<string | null>): Promise<string | null> {
    const ids = candidates.filter((c): c is string => c !== null && UUID_RE.test(c));
    for (const id of ids) {
      const role = await withTenant(runnerPool, accountId, async (client) => (await client.query<{ role: string }>("SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2", [accountId, id])).rows[0]?.role);
      if (role === "owner" || role === "admin") return id;
    }
    return null;
  }

  /**
   * Leaves the fixed code on the item (the activity read shows the newest one) and answers with it. A failure to write it is logged as a fixed line and never
   * changes the answer: the request's own settle still carries the code. One fact per ask (the request settles once).
   */
  async function refuse(accountId: string, askId: string, workItemId: string | null, code: string, runId: string | null = null): Promise<PerformResult> {
    if (workItemId !== null && !SILENT_REFUSALS.has(code) && CODE_RE.test(code)) {
      try {
        await withTenant(runnerPool, accountId, (client) => recordDriverEvent(client, accountId, { workItemId, kind: "resume_refused", code, dedupeKey: `ask:${askId}`, ...(runId !== null && UUID_RE.test(runId) ? { runId } : {}) }));
      } catch {
        // fx-swallow-ok: logged as a fixed line (never the error's text, which can carry a host or a user); the settled request still carries the code
        console.warn(JSON.stringify({ event: "decision.resume_refusal_unrecorded", ask_id: askId, code }));
      }
    }
    return refused(code);
  }

  async function perform(actionId: string): Promise<PerformResult> {
    if (typeof actionId !== "string" || !UUID_RE.test(actionId)) throw new RunActionInputError();
    const who = (await runnerPool.query<PrincipalRow>("SELECT * FROM run_action_perform_principal($1::uuid)", [actionId])).rows[0];
    if (!who) return refused("principal_not_authorised");
    const { account_id: accountId, target_id: askId } = who;
    const f = who.kind === "resume_decision" ? await load(accountId, actionId, askId) : undefined;
    const itemId = f?.ask?.work_item_id ?? null;
    // A token never resumes. A session principal must still be an owner or admin NOW; the system principal is the reconcile's.
    if (!who.allowed || (who.principal_kind !== "session" && who.principal_kind !== "system")) return refuse(accountId, askId, itemId, "principal_not_authorised", f?.ask?.run_id ?? null);
    if (who.kind !== "resume_decision" || f === undefined) return refused("kind_mismatch");
    const attemptNo = f.request?.attempts ?? 1;
    try {
      return await resume(who, f, accountId, askId, actionId);
    } catch (err) {
      // The last attempt a failure gets (the settle definer writes `failed` from the fifth): leave the code on the item first. A deferral never reaches here
      // spent, because it gives its attempt back.
      if (!(err instanceof ResumeDeferredError) && !(err instanceof ResumePausedError) && !(err instanceof RunActionInputError) && attemptNo >= 5) {
        await refuse(accountId, askId, itemId, "resume_failed", f.ask?.run_id ?? null);
      }
      throw err;
    }
  }

  async function resume(who: PrincipalRow, f: Facts, accountId: string, askId: string, actionId: string): Promise<PerformResult> {
    const note = (code: string): Promise<PerformResult> => refuse(accountId, askId, f.ask?.work_item_id ?? null, code, f.ask?.run_id ?? null);
    if (!f.ask || !f.item) return refused("target_not_found");
    const ctx = resumeContextFromAsk(f.ask);
    if (ctx === null) return refused("ask_not_resumable");
    if (f.ask.run_id === null || f.parked === undefined) return note("ask_no_run");
    const workItemId = f.ask.work_item_id;

    // A replay: the first perform started the run. Answer from it, and follow it again while it is still going, or while the item still sits where the park
    // left it (a run that ended in the crash window between its start and the workflow's has an outcome nobody has read yet; every workflow step is keyed).
    if (f.started) {
      if (!TERMINAL.includes(f.started.status) || RESUMABLE_STAGES.includes(f.item.stage)) await follow(accountId, f, who.user_id, workItemId, actionId, f.started.id);
      return { result: "done", outcome: { work_item_id: workItemId, run_id: f.started.id, cause: ctx.cause } };
    }

    if (f.item.halted || f.request?.epoch === null || f.request === undefined || f.item.halt_epoch !== f.request.epoch) return note("work_item_not_resumable");
    if (!RESUMABLE_STAGES.includes(f.item.stage) || f.newerExecutor) return note("work_item_not_resumable");
    // D#483 S5-b2c-3 (R7): the issue number and the branch are the build identity's. A planned PR child's launch checks run again now; a refusal is named by the identity's own code
    // (`child_orphaned`, `parent_closed`, `respec_needs_approval`, `key_not_in_approved_spec`), so the card says what is wrong and not a bare "not resumable".
    const begin = await withTenant(runnerPool, accountId, (client) => resolveBuildIdentity(client, accountId, f.ask!.work_item_id, "start"));
    if (!begin.ok) return note(begin.reason === "no_issue_link" || begin.reason === "not_found" ? "work_item_not_resumable" : begin.reason);
    const identity = begin.identity;
    if (f.parked.prompt === null) return note("prompt_not_retained");
    const actor = await actorFor(accountId, [who.user_id, f.ask.answered_by, f.approver]);
    if (actor === null || (who.principal_kind === "session" && who.user_id !== actor)) return note("principal_not_authorised");

    // From here the start may have to wait. A wait is a deferral up to the age limit, then a refusal a person can read.
    const wait = (err: ResumeDeferredError | ResumePausedError): Promise<PerformResult> => {
      if (f.request!.ageSeconds > RESUME_DEFER_MAX_SECONDS) return note("resume_pause_expired");
      throw err;
    };
    const kindOf = (reason: string): "paused" | "deferred" | "halt" | "other" => (PAUSED_REASONS.has(reason) ? "paused" : DEFERRED_REASONS.has(reason) ? "deferred" : HALT_REASONS.includes(reason) ? "halt" : "other");
    const outcome = (runId: string): PerformResult => {
      console.info(JSON.stringify({ event: "decision.resume_started", work_item_id: workItemId, ask_id: askId, run_id: runId, cause: ctx.cause }));
      return { result: "done", outcome: { work_item_id: workItemId, run_id: runId, cause: ctx.cause } };
    };
    const refusal = async (reason: string): Promise<PerformResult> => {
      const kind = kindOf(reason);
      if (kind === "paused") return wait(new ResumePausedError());
      if (kind === "deferred") return wait(new ResumeDeferredError());
      if (kind === "halt") return note("work_item_not_resumable");
      return note(CODE_RE.test(reason) ? reason : "start_refused");
    };
    const spendAttempt = Math.min(f.deniedStarts, MAX_SPEND_ATTEMPT);

    if (f.item.stage === "changes_requested") {
      // A parked fix round. It goes through the fix start, which continues the pull request's own sandbox and session (or binds the run to its branch) and
      // refuses a second live executor. Anything it needs from the parked round that is not on record is a visible refusal, never a guess.
      if (f.fix === null) return note("fix_round_context_missing");
      if (f.item.repo_id === null) return note("no_repo");
      if (f.liveOther) return refusal("already_running");
      const effective = await readExecutionMode(runnerPool, accountId, f.item.repo_id, workItemId);
      if (f.parked.execution_mode !== null && sideOfMode(f.parked.execution_mode) !== sideOfMode(effective)) return note("execution_mode_changed");
      const prompt = await fixPromptFor(accountId, f.parked, ctx);
      if (prompt === null) return note("spec_unavailable");
      const started = await deps.startFix(
        { accountId, userId: actor, workItemId, haltEpoch: f.item.halt_epoch },
        {
          issue: identity.issueNumber,
          headSha: f.fix.headSha,
          prompt,
          round: f.fix.round,
          actionId,
          ...(spendAttempt > 0 ? { spendAttempt } : {}),
          reviewer: f.fix.reviewer as AdvanceFixRequest["reviewer"],
          failingRunId: f.fix.failingRunId,
          // The pull request the round was first started with (the sandbox review step found it on GitHub), so a sandbox round that resumes is synced as it was.
          ...(f.fix.prNumber !== null ? { pr: { number: f.fix.prNumber, branch: identity.branch } } : {}),
          ...(f.parked.execution_mode !== null && /^[a-z][a-z_]{0,31}$/.test(f.parked.execution_mode) ? { expectedExecutionMode: f.parked.execution_mode } : {}),
        },
      );
      if (!started.ok) return refusal(started.reason);
      await follow(accountId, f, actor, workItemId, actionId, started.runId, actor);
      return outcome(started.runId);
    }

    // D#7 DP4b-3b: the resumed run is offered what the dials and the catalogue say NOW, not what the parked run was told. Its prompt's block is replaced to match, and the
    // snapshot below is written with the run. The answer reaches the run through the resume block, as before.
    const dec = await decisionStartFor(runnerPool, accountId, workItemId);
    const prompt = `${dec.prompt(stripResumeContext(f.parked.prompt))}\n\n${renderResumeContext(ctx)}`;
    const step = spendAttempt > 0 ? `${resumeStepKey(askId)}:s${spendAttempt}` : resumeStepKey(askId);
    if (!STEP_RE.test(step)) return note("start_refused");
    const started = await deps.startRun({
      accountId,
      workItemId,
      step,
      role: "executor",
      prompt,
      clone: true,
      pr: identity.issueNumber,
      exclusive: true,
      haltEpoch: f.item.halt_epoch,
      parentRunId: f.parked.id,
      // D#519 MQ4-b0: the resumed build starts from the parked run's start commit (a stacked or paired base), so its first push is bounded by it.
      ...(f.parked.head_sha !== null && SHA_RE.test(f.parked.head_sha) ? { headSha: f.parked.head_sha } : {}),
      decisionSnapshot: dec.offer.snapshot,
      ...(f.parked.execution_mode !== null && /^[a-z][a-z_]{0,31}$/.test(f.parked.execution_mode) ? { expectedExecutionMode: f.parked.execution_mode } : {}),
      ...(f.parked.spec_version_id === null ? {} : { specVersionId: f.parked.spec_version_id }),
    });
    if (!started.ok) return refusal(started.reason);
    await follow(accountId, f, actor, workItemId, actionId, started.runId, actor);
    return outcome(started.runId);
  }

  /**
   * The prompt a resumed fix round is sent: the parked round's own prompt, with the Spec body where it said the Spec was unchanged (the new run cannot assume a
   * session still holds it), and the resume block once. Null when the Spec it names cannot be read back as the same text (erased, or another version).
   */
  async function fixPromptFor(accountId: string, parked: NonNullable<Facts["parked"]>, ctx: ResumeContext): Promise<string | null> {
    let base = stripResumeContext(parked.prompt ?? "");
    const held = SPEC_UNCHANGED_RE.exec(base);
    if (held) {
      if (parked.spec_version_id === null) return null;
      const spec = await withTenant(runnerPool, accountId, async (client) =>
        (await client.query<{ version: number; body: string; body_sha256: string }>("SELECT version, body, body_sha256 FROM spec_versions WHERE id = $1 AND account_id = $2 AND erased_at IS NULL", [parked.spec_version_id, accountId])).rows[0],
      );
      if (!spec || String(spec.version) !== held[1] || spec.body_sha256 !== held[2]) return null;
      // The same text `specText` builds for a prompt that carries the body.
      base = base.replace(SPEC_UNCHANGED_RE, () => `SPEC (version ${spec.version}):\n${sanitize(spec.body)}`);
    }
    if (!/^SPEC \(version [1-9][0-9]{0,8}\):$/m.test(base)) return null;
    return `${base}\n\n${renderResumeContext(ctx)}`;
  }

  /** Starts the advance workflow that follows the resumed run to its end (decision step, pull request, review). */
  async function follow(accountId: string, f: Facts, principalUser: string | null, workItemId: string, actionId: string, runId: string, known?: string): Promise<void> {
    if (!deps.startAdvance || !f.item) return;
    const actor = known ?? (await actorFor(accountId, [principalUser, f.ask?.answered_by ?? null, f.approver]));
    if (actor === null) return;
    await deps.startAdvance({
      accountId,
      userId: actor,
      workItemId,
      actionId,
      haltEpoch: f.item.halt_epoch,
      specVersion: f.parked?.spec_version ?? null,
      resumeRunId: runId,
    });
  }

  return { performResumeDecision: perform };
}

/** The most batches one tick runs, so a large backlog cannot hold the tick: the rest goes next time. */
export const RESUME_RECONCILE_MAX_BATCHES = 5;

export interface ResumeReconcileDeps {
  /** The RECEIPT pool: the only login that can call the definer. */
  pool: Pick<Pool, "query">;
  warn: (line: string) => void;
  limit?: number;
  maxBatches?: number;
}

/**
 * D#7 DP11c (DP-C9 section 5, criterion 7): the tick's reconcile. Every answered or proceeded ask with no `resume_decision` request, of any state, gets one
 * (asks answered before this shipped, and DP12a-2's proceed-recommended timeouts). It never throws: a failed batch is logged as a fixed line and the next
 * tick looks again. Returns how many requests it made.
 */
export async function reconcileResumes(deps: ResumeReconcileDeps): Promise<number> {
  const limit = deps.limit ?? RESUME_RECONCILE_DEFAULT_LIMIT;
  let made = 0;
  for (let batch = 0; batch < (deps.maxBatches ?? RESUME_RECONCILE_MAX_BATCHES); batch++) {
    let enqueued;
    try {
      enqueued = await reconcileResumeRequests(deps.pool, limit);
    } catch {
      // fx-swallow-ok: logged as a fixed line (never the error's text, which can carry a host or a user); the next tick looks again
      deps.warn(JSON.stringify({ event: "decision.resume_reconcile_failed" }));
      break;
    }
    made += enqueued.length;
    if (enqueued.length < limit) break;
  }
  // The new requests wait for the run-action sweep (nothing kicks them), so tell it there is work.
  if (made > 0) {
    void markWorkPending("run-action-sweep");
    deps.warn(JSON.stringify({ event: "decision.resume_requested", total: made }));
  }
  return made;
}
