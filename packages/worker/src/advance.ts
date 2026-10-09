import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { advanceActionFor, type AdvanceAction } from "@fx/core/src/work-items/advance.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { IllegalStageTransitionError, WorkItemHaltedError as StageHaltedError } from "@fx/core/src/work-items/stages.js";
import { assertDriverEvent, recordDriverEvent, type DriverEventInput } from "@fx/core/src/work-items/driverEvents.js";
import { cancelRun, DuplicateExecutorRunError, IdempotencyKeyTakenError, SandboxReapingError, WorkItemHaltedError, failClosedOnQueued, PREVIEW_WORKDIR, readRecordedRunnerPullRequest, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import type { RunStarter } from "./preview.js";
import type { SeatRequest, SeatResult } from "./seat.js";
import { RunActionInputError, type PerformResult } from "./runActions.js";

/**
 * D#483 P1: the worker side of `advance_work_item`, the stage driver's run action.
 *
 * `performAdvanceWorkItem` turns a claimed action into ONE start of the durable advance workflow
 * (apps/web/workflows/workItemAdvance.ts), handed in as `startAdvance`. It starts nothing else and spends nothing.
 * The workflow's steps then call the other methods here: start one role run for the item, read how a run ended, and
 * run triage. Every one takes and returns plain data; the runner pool stays in this package.
 *
 * Why a kind of its own: `continue_work_item` is reserved for an executor picking up where a failed run stopped.
 *
 * Order in `performAdvanceWorkItem`, and why: (1) who it runs as, from the database, session principals only, and
 * still an owner or admin NOW (the request-time role check is not enough: a role can be lowered in between);
 * (2) the item, tenant-scoped; (3) every refusal that costs nothing; (4) the start. A replayed perform (a kick and a
 * sweep at once) finds the first one's run through the keys below, so it cannot start a second classify run.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refused = (errorCode: string): PerformResult => ({ result: "refused", errorCode });

// The stages the driver advances from, what advancing does at each, and what must be true first live in ONE table:
// @fx/core's work-items/advance.ts. The route, this file and the workflow all ask it; none keeps a list of its own.
export { ADVANCEABLE_STAGES, ADVANCE_NON_BUILDABLE_KINDS } from "@fx/core/src/work-items/advance.js";
/** Run statuses a run cannot leave; anything else is live. Mirrors @fx/runner's RUN_STATUS_TRANSITIONS (pinned by a test). */
export const ADVANCE_TERMINAL_STATUSES = ["succeeded", "failed", "timed_out", "killed_spend", "refused_spend", "cancelled"] as const;
const TERMINAL = new Set<string>(ADVANCE_TERMINAL_STATUSES);

/**
 * D#6 R2b-3 (C22 sections 5 and 7): the most runs `advanceRunOutcome` looks at when it follows a runner run to the run that
 * replaced it. The same bound as the database's follow-up chain walk (migration 0754).
 */
export const FOLLOW_UP_CHAIN_MAX_RUNS = 16;

/** The two reasons that make a failed runner run get a follow-up (a "follow-up hop", C22 section 5). */
const FOLLOW_UP_REASONS: ReadonlySet<string> = new Set(["runner_lost", "usage_limit"]);
/**
 * The first role each action starts: the seat the pre-flight in `performAdvanceWorkItem` resolves. `check_build` starts none
 * (a pull request is looked for first; with none open the item goes to Needs human and no model runs), so it has no seat to
 * require; if a pull request is found the review's own step refuses a missing reviewer seat with a recorded stop.
 */
const PREFLIGHT_ROLE: Readonly<Record<AdvanceAction, string | null>> = Object.freeze({ triage: "project-manager", light_spec: "project-manager", spec: "project-manager", build: "executor", rebuild: "executor", check_build: null, review: "code-reviewer" });

export interface AdvanceStartArgs {
  accountId: string;
  userId: string;
  workItemId: string;
  actionId: string;
  /**
   * The item's halt epoch when the approval was performed (after any halt it resumed from). Every step of the workflow
   * carries it; a step that finds a different epoch was started before a halt and is refused (`halted_since_approval`).
   * A workflow started before this field existed replays it as 0.
   */
  haltEpoch: number;
  /**
   * The newest published Spec's version when the approval was performed (null: none yet). The build and the review are
   * pinned to it: a newer version appearing after the person approved refuses them (`spec_changed`), so what is built and
   * reviewed is what was approved.
   */
  specVersion?: number | null;
}

/**
 * What an injected pipeline step may do with agent runs, bound to ONE account and work item by the worker: the request
 * cannot name another. Structurally the pipeline's `AdvanceRunPorts`.
 */
export interface AdvanceStepPorts {
  startRun(req: Omit<AdvanceRunRequest, "accountId" | "workItemId" | "haltEpoch">): Promise<AdvanceRunStart>;
  outcome(runId: string): Promise<AdvanceRunOutcome>;
  /** The existing cancel path, as the approver (so the cancel is audited as theirs and needs their membership to still be active). Safe on a finished run. */
  cancel(runId: string): Promise<void>;
}

/** What a pipeline step answers, as plain data: the pipeline's own status word and the ids a later step needs. */
export interface AdvanceStepResult {
  status: string;
  reason?: string;
  stage?: string | null;
  version?: number;
  runId?: string;
  branch?: string;
  complete?: boolean;
  missingRoles?: string[];
  round2Ran?: boolean;
  replayed?: boolean;
}

/** Who the steps run for: the workflow's own arguments. */
export interface AdvanceStepWho {
  accountId: string;
  userId: string;
  workItemId: string;
  /** The halt epoch the workflow was started under (AdvanceStartArgs.haltEpoch). */
  haltEpoch: number;
}

/** The triage step's input: everything it needs, as plain data. The classifier's category is a string the pipeline's own parser validates. */
export interface AdvanceTriageInput {
  /** The work item the webhook created for the issue. */
  workItemId: string;
  title: string;
  body: string;
  /** What the classify run answered. Not trusted: triage parses it again against the fixed set. */
  category: string;
  sourceEventId: string;
  repoId: string;
  /** The issue author's login. */
  login: string;
  /** The issue's number on GitHub. */
  number: number;
}

/** What triage answers, as plain data. `status` is the pipeline's own word ("triaged", "unclassified", "refused", ...). */
export type AdvanceTriageResult = { status: string; reason?: string; category?: string; stage?: string; workItemId?: string; discussionId?: string };

export interface AdvanceModuleDeps {
  starter: RunStarter | null;
  resolveRunSeat: (request: SeatRequest) => Promise<SeatResult>;
  /** apps/web starts the workflow here. Absent, `advance_work_item` is refused `advance_unavailable`. */
  startAdvance: ((args: AdvanceStartArgs) => Promise<void>) | null;
  /** Injected from apps/web (this package cannot import @fx/pipeline): runs triage on the runner pool, which never leaves the worker. */
  triage: ((pool: Pool, accountId: string, input: AdvanceTriageInput) => Promise<AdvanceTriageResult>) | null;
  /** D#483 P2, injected from apps/web the same way: the pipeline's panel, Spec and build, run with the runner pool and the run ports above. */
  panel?: ((pool: Pool, accountId: string, workItemId: string, ports: AdvanceStepPorts) => Promise<AdvanceStepResult>) | null;
  spec?: ((pool: Pool, accountId: string, workItemId: string, ports: AdvanceStepPorts, options: { attempt?: string }) => Promise<AdvanceStepResult>) | null;
  build?: ((pool: Pool, accountId: string, workItemId: string, approvalId: string, ports: AdvanceStepPorts, options: { expectedVersion?: number }) => Promise<AdvanceStepResult>) | null;
  /** D#483 P3, injected from apps/web: the pipeline's `publishLightSpec`: a small, bug or doc item's short Spec from the PM's result. */
  lightSpec?: ((pool: Pool, accountId: string, workItemId: string, output: unknown) => Promise<{ status: string; reason?: string; version?: number }>) | null;
  /** Records a build that ended without a pull request (in_progress -> needs_human). */
  buildFailed?: ((pool: Pool, accountId: string, workItemId: string, runId: string | null, code: string, attempt?: string) => Promise<AdvanceStepResult>) | null;
  /** The execution registry `cancelRun` dispatches through. Absent, a step's cancel is a no-op that the lost-run sweep backs up. */
  registry?: ExecutionTargetRegistry | null;
  /** D#483 P3, injected from apps/web the same way: the review stage's pipeline pieces. Absent, the review steps answer `review_unavailable`. */
  review?: AdvanceReviewDeps | null;
}

/** What the review stage needs from @fx/pipeline and the web app (this package can import neither). */
export interface AdvanceReviewDeps {
  /** The pipeline's `loadReviewContext`, flattened to plain data. The facade adds where the pull request comes from (`AdvancePrSource`). */
  load: (pool: Pool, accountId: string, workItemId: string) => Promise<{ ok: true; ctx: Omit<AdvanceReviewContext, keyof AdvancePrSource> } | { ok: false; reason: string }>;
  /** The pipeline's `recordRound`: every verdict of a head recorded (passes first), and the decision. */
  recordRound: (pool: Pool, registry: ExecutionTargetRegistry, input: AdvanceRoundInput) => Promise<AdvanceRoundResult>;
  /** The pipeline's `resumeAgentRun`: an executor fix round continues the PR's persistent sandbox and session. */
  resume: (pool: Pool, registry: ExecutionTargetRegistry, input: StartAgentRunInput) => Promise<{ id: string; status: string }>;
  /** The merge gate over the real GitHub port (a token of the `merge_gate` purpose). */
  mergeGate: (pool: Pool, input: { accountId: string; workItemId: string; prNumber: number }) => Promise<AdvanceMergeGateResult>;
}

/** The review context the workflow keeps: small facts only. The Spec's text is read inside the step that needs it. */
export interface AdvanceReviewContext extends AdvancePrSource {
  workItemId: string;
  stage: string;
  repoId: string;
  owner: string;
  name: string;
  issue: number;
  /** critical | feature | small | bug | doc */
  tier: string;
  specVersion: number;
  debaterEnabled: boolean;
}
export type AdvanceReviewLoad = { ok: true; ctx: AdvanceReviewContext } | { ok: false; reason: string };

export interface AdvanceVerdictInput {
  role: string;
  runId: string;
  verdict: string;
  /** The debater only. */
  debatedRole?: string;
}
export interface AdvanceRoundInput {
  accountId: string;
  workItemId: string;
  headSha: string;
  prNumber: number;
  /** Fix rounds already started. Omitted by the driver: it is read from the recorded driver events. */
  round?: number;
  requiredRoles: string[];
  verdicts: AdvanceVerdictInput[];
}
export interface AdvanceRoundResult {
  decision: string;
  /** Fix rounds already started when the decision was made. */
  round: number;
  recorded: Array<{ role: string; runId: string; verdict: string; outcome: string }>;
  nextRound?: number;
}
export interface AdvanceMergeGateResult {
  outcome: string;
  headSha?: string;
  reasons?: string[];
  status?: string;
  reason?: string;
}

/** What a fix round needs. The prompt is built by the caller (it holds the Spec text and the findings). */
export interface AdvanceFixRequest {
  /** The issue's number: it names the persistent sandbox, as the build used it. NEVER the pull request's number. */
  issue: number;
  /** The head the reviewers found fault with. */
  headSha: string;
  prompt: string;
  /** 1-based. */
  round: number;
  /** The approval that started the driver: names this fix attempt, so a replay finds its run and a fresh approval asks again. */
  actionId: string;
  /** Which review the card shows as asking for changes. */
  reviewer: "code" | "security" | "acceptance";
  /** A reviewer run whose verdict asked for the changes. */
  failingRunId: string;
}

export interface AdvanceRunRequest {
  accountId: string;
  workItemId: string;
  /** Names the step. The run's idempotency key is `advance:<workItemId>:<step>`, so a replayed step returns the same run. */
  step: string;
  role: string;
  prompt: string;
  /** Clone the item's repository (shallow, default branch) into the run's working directory before the agent starts. */
  clone?: boolean;
  /** Executor runs: the number that names the sandbox. The pull request does not exist yet, so the driver passes the issue's number. */
  pr?: number;
  /** Start only if no OTHER run of the item is live (a run already claimed under this step's key is always returned). The executor uses it so two approvals cannot build twice. */
  exclusive?: boolean;
  /** Reviewer runs: the pull request head the review is for. Stored on the run (`head_sha`), which is what the merge gate reads. */
  headSha?: string;
  /** The halt epoch the caller's workflow was started under. A start under an older epoch is refused (`halted_since_approval`). */
  haltEpoch: number;
}

export type AdvanceRunStart = { ok: true; runId: string } | { ok: false; reason: string };

export interface AdvanceRunOutcome {
  status: string;
  done: boolean;
  /** The run's parsed AGENT_OUTPUT envelope, or null (none was written, or the run is gone). Model text: never shown as markup. */
  envelope: Record<string, unknown> | null;
  /** Where the run executes (`local`, `production` or `runner`); only a `runner` run's `pending` time is credited (D#6 C12 A3). Absent when the run is gone. */
  runtime?: string;
  /**
   * D#6 R2b-3 (C22 section 7): the run this outcome is about, which is the end of the follow-up chain that starts at the run asked
   * about. A runner run that ended `runner_lost` or `usage_limit` has a follow-up run, and the status, envelope and runtime above are
   * the last of those runs'. It is the id the caller must cancel, and the one a failure is recorded against. Absent when the run is gone.
   */
  tailRunId?: string;
  /** The tail's failure reason when it is a failed runner run (`runner_lost`, `usage_limit` or another fixed word), else null. Absent when the run is gone. */
  failureReason?: string | null;
}

/**
 * Where the item's pull request comes from (D#6 C25 section 1.2): the repository's execution mode and, for a `runner_local` repository,
 * the pull request number and run branch its newest executor run recorded at `done` (null when none did). A sandbox repository has no record.
 */
export interface AdvancePrSource {
  executionMode: string;
  recordedPr: { number: number; branch: string } | null;
}

/** What the workflow reads about the item before it starts: plain data, or null when the item is gone. */
export interface AdvanceItem extends AdvancePrSource {
  stage: string;
  provenance: string;
  repoId: string | null;
  ghNumber: number | null;
  ghOwner: string | null;
  ghName: string | null;
  hasDiscussion: boolean;
  /** The discussion's kind, or null when the item has none. */
  kind: string | null;
  /** True when a published Spec (not erased) exists. */
  hasSpec: boolean;
  /** The newest published Spec's version, or null. The build and the review pin it when the person approves. */
  specVersion: number | null;
  /** The item's newest executor run (any status), or null. A build that ended with no pull request is recorded against it. */
  executorRunId: string | null;
}

interface PrincipalRow {
  allowed: boolean;
  account_id: string;
  kind: string;
  target_id: string;
  principal_kind: string;
  user_id: string | null;
}

export interface AdvanceFacade {
  /**
   * Performs a CLAIMED `advance_work_item` action. Takes the action id and nothing else. Outcome
   * `{ work_item_id, advance: "started" }`. Refusals: principal_not_authorised, kind_mismatch, advance_unavailable,
   * target_not_found, external_requires_human, no_repo, no_issue_link, not_advanceable (not at a stage the driver
   * can advance, or already triaged), already_running (a run of the item is live).
   */
  performAdvanceWorkItem(actionId: string): Promise<PerformResult>;
  advanceLoadItem(accountId: string, workItemId: string): Promise<AdvanceItem | null>;
  /** Starts one run of `req.role` for the item, keyed `advance:<item>:<step>`. Never throws for a refusal: it answers `{ ok: false, reason }`. */
  advanceStartRun(req: AdvanceRunRequest): Promise<AdvanceRunStart>;
  advanceRunOutcome(accountId: string, runId: string): Promise<AdvanceRunOutcome>;
  advanceTriage(accountId: string, input: AdvanceTriageInput): Promise<AdvanceTriageResult>;
  /** D#483 P2: the panel (round 1 and the one challenge round) for a discussed item. Never throws for a refusal. */
  advancePanel(who: AdvanceStepWho): Promise<AdvanceStepResult>;
  /**
   * D#483 P2: the pipeline's Spec step (re-enters the panel, runs the PM, publishes the Spec). `attempt` (the approval's id)
   * names this attempt's PM run, so an approval after a PM run that failed starts a fresh one (P3).
   */
  advanceSpec(who: AdvanceStepWho, attempt?: string): Promise<AdvanceStepResult>;
  /**
   * D#483 P2: starts the executor for an item at `spec_ready` and records `spec_ready -> in_progress`. `approvalId` names the
   * approval (the run action). P3: `expectedVersion` is the Spec version the person approved; a newer one refuses `spec_changed`.
   * A refused start is recorded as a `build_refused` driver event.
   */
  advanceBuild(who: AdvanceStepWho, approvalId: string, expectedVersion?: number): Promise<AdvanceStepResult>;
  /** D#483 P2: records a build that ended without a pull request as `in_progress -> needs_human`. `code` is a fixed word. */
  advanceBuildFailed(accountId: string, workItemId: string, runId: string | null, code: string, attempt?: string): Promise<AdvanceStepResult>;
  /**
   * "Check the build": the driver found the item's open pull request while the item still sits at `in_progress` (the
   * webhook that moves it never arrived). Records `in_progress -> pr_opened` so the review can record its verdicts. An item
   * at any other stage is left alone (`unchanged`).
   */
  advancePrFound(who: AdvanceStepWho, prNumber: number): Promise<AdvanceStepResult>;

  /**
   * D#483 P3: publishes the short Spec of a small, bug or doc item from the finished project-manager run `runId` (an
   * `advanceStartRun` of this item; the worker reads the run's result itself, so it never passes through the workflow).
   * `published` moves the item to spec_ready; `not_feasible` publishes nothing (the PM's reason stays in the run, as its
   * summary, for the card); `refused` carries a fixed code. A replay on an item that already has its Spec publishes nothing more.
   */
  advanceLightSpec(who: AdvanceStepWho, runId: string, actionId: string): Promise<{ status: string; reason: string | null; version: number | null }>;
  /** D#483 P3: the item's review context, or a fixed refusal. Plain data; the Spec text is not in it. */
  advanceLoadReview(who: AdvanceStepWho): Promise<AdvanceReviewLoad>;
  /** D#483 P3: the Spec's text for the version the person approved, or null (erased, or a newer version exists). Read inside the step that builds a prompt, never kept in the workflow. */
  advanceLoadSpecText(who: AdvanceStepWho, expectedVersion: number): Promise<{ version: number; body: string } | null>;
  /** D#483 P3: every verdict of one head recorded (passes first, non-passes last) and the decision that follows. */
  advanceRecordRound(who: AdvanceStepWho, input: Omit<AdvanceRoundInput, "accountId" | "workItemId">): Promise<AdvanceRoundResult | { decision: "refused"; reason: string }>;
  /**
   * D#483 P3: an executor fix round, continuing the build's persistent sandbox and session. Never a fresh start; refuses a
   * second concurrent resume (`already_running`); moves the card to Changes requested whatever an earlier record said;
   * records `fix_round_started` or `fix_round_refused`. A replay of the same approval and head returns the run it started.
   */
  advanceStartFix(who: AdvanceStepWho, req: AdvanceFixRequest): Promise<AdvanceRunStart>;
  /** D#483 P3: the merge gate on the pull request's current head. */
  advanceMergeGate(who: AdvanceStepWho, prNumber: number): Promise<AdvanceMergeGateResult>;
  /** D#483 P3: one recorded driver event (fixed vocabulary). A repeat of the same key writes nothing. */
  advanceRecordEvent(who: AdvanceStepWho, event: Omit<DriverEventInput, "workItemId">): Promise<{ recorded: boolean }>;
  /** D#483 P3: stops a live run of this item through the runner's own cancel, as the approver. */
  advanceCancel(who: AdvanceStepWho, runId: string): Promise<void>;
}

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createAdvanceModule(runnerPool: Pool, deps: AdvanceModuleDeps): AdvanceFacade {
  async function performAdvanceWorkItem(actionId: string): Promise<PerformResult> {
    if (typeof actionId !== "string" || !UUID_RE.test(actionId)) throw new RunActionInputError();
    const { rows } = await runnerPool.query<PrincipalRow>("SELECT * FROM run_action_perform_principal($1::uuid)", [actionId]);
    const who = rows[0];
    if (!who || !who.allowed || who.user_id === null || who.principal_kind !== "session") return refused("principal_not_authorised");
    if (who.kind !== "advance_work_item") return refused("kind_mismatch");
    if (!deps.startAdvance) return refused("advance_unavailable");
    const { account_id: accountId, user_id: userId, target_id: workItemId } = who;

    const read = await withTenant(runnerPool, accountId, userId, async (client) => {
      const role = await client.query<{ role: string }>("SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2", [accountId, userId]);
      const item = await client.query<{ stage: string; provenance: string; repo_id: string | null; gh_number: string | null; discussion_id: string | null; kind: string | null; has_spec: boolean; spec_version: number | null }>(
        `SELECT w.stage, w.provenance, w.repo_id, w.gh_number, w.discussion_id, d.kind,
                EXISTS (SELECT 1 FROM spec_versions s WHERE s.account_id = w.account_id AND s.work_item_id = w.id AND s.erased_at IS NULL) AS has_spec,
                (SELECT max(s.version) FROM spec_versions s WHERE s.account_id = w.account_id AND s.work_item_id = w.id AND s.erased_at IS NULL) AS spec_version
           FROM work_items w LEFT JOIN discussions d ON d.account_id = w.account_id AND d.id = w.discussion_id
          WHERE w.id = $1 AND w.account_id = $2`,
        [workItemId, accountId],
      );
      const live = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND NOT (status = ANY($3::text[]))",
        [accountId, workItemId, [...ADVANCE_TERMINAL_STATUSES]],
      );
      return { role: role.rows[0]?.role, item: item.rows[0], live: Number(live.rows[0]?.n ?? 0) };
    });
    if (read.role !== "owner" && read.role !== "admin") return refused("principal_not_authorised");
    const item = read.item;
    if (!item) return refused("target_not_found");
    // Fail closed, as the intake gate does: only the exact literal "internal" is internal.
    if (item.provenance !== "internal") return refused("external_requires_human");
    if (item.repo_id === null) return refused("no_repo");
    if (item.gh_number === null) return refused("no_issue_link");
    const verdict = advanceActionFor(item);
    if (!verdict.ok) return refused("not_advanceable");
    if (read.live > 0) return refused("already_running");

    // Every refusal that costs nothing is answered NOW, so the Approve sentence can say it: a role with no card, a model
    // with no key, an unset model budget, no usable GitHub installation. The seat resolver is read-only; it starts nothing.
    // The role asked is the first one the action starts. A refused build is also recorded as a fact of the item.
    const seatRole = PREFLIGHT_ROLE[verdict.action];
    const seat = seatRole === null ? null : await deps.resolveRunSeat({ accountId, role: seatRole, workItemId });
    if (seat !== null && !seat.ok) {
      if (verdict.action === "build" || verdict.action === "rebuild") {
        await withTenant(runnerPool, accountId, userId, (client) =>
          recordDriverEvent(client, accountId, { workItemId, kind: "build_refused", dedupeKey: `preflight:${actionId}`, code: seat.reason }),
        );
      }
      console.info(JSON.stringify({ event: "advance.preflight_refused", work_item_id: workItemId, action: verdict.action, reason: seat.reason }));
      return refused(seat.reason);
    }

    // The one place a halt is lifted: a person's approval that was requested AFTER the halt. An approval pressed before the
    // halt and performed after it is not a resume (the person's latest act was the halt), so the item stays halted.
    const lifted = await withTenant(runnerPool, accountId, userId, async (client) => {
      await client.query(
        `UPDATE work_items SET halted_at = NULL, halt_action_id = NULL
          WHERE id = $1 AND account_id = $2 AND halted_at IS NOT NULL
            AND halted_at < (SELECT q.created_at FROM run_action_requests q WHERE q.id = $3 AND q.account_id = $2)`,
        [workItemId, accountId, actionId],
      );
      const r = await client.query<{ halted: boolean; halt_epoch: number }>("SELECT halted_at IS NOT NULL AS halted, halt_epoch FROM work_items WHERE id = $1 AND account_id = $2", [workItemId, accountId]);
      return r.rows[0];
    });
    if (!lifted) return refused("target_not_found");
    if (lifted.halted) return refused("item_halted");

    await deps.startAdvance({ accountId, userId, workItemId, actionId, haltEpoch: lifted.halt_epoch, specVersion: item.spec_version === null ? null : Number(item.spec_version) });
    console.info(JSON.stringify({ event: "advance.started", work_item_id: workItemId, action_id: actionId }));
    return { result: "done", outcome: { work_item_id: workItemId, advance: "started" } };
  }

  /** The item's repository mode and, for a runner repository, the pull request its run recorded. Read in the item's tenant. */
  async function pullRequestSource(accountId: string, workItemId: string): Promise<AdvancePrSource> {
    return withTenant(runnerPool, accountId, async (client) => {
      const r = await client.query<{ execution_mode: string | null }>("SELECT r.execution_mode FROM work_items w JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id WHERE w.id = $1 AND w.account_id = $2", [workItemId, accountId]);
      const executionMode = r.rows[0]?.execution_mode ?? "sandbox";
      return { executionMode, recordedPr: executionMode === "runner_local" ? await readRecordedRunnerPullRequest(client, { accountId, workItemId }) : null };
    });
  }

  async function advanceLoadItem(accountId: string, workItemId: string): Promise<AdvanceItem | null> {
    if (!UUID_RE.test(accountId) || !UUID_RE.test(workItemId)) return null;
    const item = await loadItemRow(accountId, workItemId);
    return item === null ? null : { ...item, ...(await pullRequestSource(accountId, workItemId)) };
  }

  async function loadItemRow(accountId: string, workItemId: string): Promise<Omit<AdvanceItem, keyof AdvancePrSource> | null> {
    return withTenant(runnerPool, accountId, async (client) => {
      const r = await client.query<{ stage: string; provenance: string; repo_id: string | null; gh_number: string | null; discussion_id: string | null; gh_owner: string | null; gh_name: string | null; kind: string | null; has_spec: boolean; spec_version: number | null; executor_run_id: string | null }>(
        `SELECT w.stage, w.provenance, w.repo_id, w.gh_number, w.discussion_id, r.gh_owner, r.gh_name, d.kind,
                (SELECT ar.id FROM agent_runs ar WHERE ar.account_id = w.account_id AND ar.work_item_id = w.id AND ar.role = 'executor' ORDER BY ar.created_at DESC, ar.id DESC LIMIT 1) AS executor_run_id,
                EXISTS (SELECT 1 FROM spec_versions s WHERE s.account_id = w.account_id AND s.work_item_id = w.id AND s.erased_at IS NULL) AS has_spec,
                (SELECT max(s.version) FROM spec_versions s WHERE s.account_id = w.account_id AND s.work_item_id = w.id AND s.erased_at IS NULL) AS spec_version
           FROM work_items w
           LEFT JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
           LEFT JOIN discussions d ON d.account_id = w.account_id AND d.id = w.discussion_id
          WHERE w.id = $1 AND w.account_id = $2`,
        [workItemId, accountId],
      );
      const row = r.rows[0];
      return row
        ? {
            stage: row.stage,
            provenance: row.provenance,
            repoId: row.repo_id,
            ghNumber: row.gh_number === null ? null : Number(row.gh_number),
            ghOwner: row.gh_owner,
            ghName: row.gh_name,
            hasDiscussion: row.discussion_id !== null,
            kind: row.kind,
            hasSpec: row.has_spec,
            specVersion: row.spec_version === null ? null : Number(row.spec_version),
            executorRunId: row.executor_run_id,
          }
        : null;
    });
  }

  async function advanceStartRun(req: AdvanceRunRequest): Promise<AdvanceRunStart> {
    if (!UUID_RE.test(req.accountId) || !UUID_RE.test(req.workItemId) || !/^[a-z0-9:_.-]{1,128}$/i.test(req.step)) return { ok: false, reason: "invalid_input" };
    if (!deps.starter) return { ok: false, reason: "starter_unavailable" };
    if (req.pr !== undefined && !(Number.isSafeInteger(req.pr) && req.pr > 0)) return { ok: false, reason: "invalid_input" };
    const key = `advance:${req.workItemId}:${req.step}`;
    const found = await withTenant(runnerPool, req.accountId, async (client) => {
      const r = await client.query<{ repo_id: string | null; gh_owner: string | null; gh_name: string | null; halted: boolean; halt_epoch: number }>(
        "SELECT w.repo_id, w.halted_at IS NOT NULL AS halted, w.halt_epoch, r.gh_owner, r.gh_name FROM work_items w LEFT JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id WHERE w.id = $1 AND w.account_id = $2",
        [req.workItemId, req.accountId],
      );
      // `exclusive`: refuse when another run of the item is live and this step's own run is not already claimed. A
      // replay of the step finds its claim and goes on; a second approval does not start a second run.
      let busy = false;
      if (req.exclusive === true) {
        const claim = await client.query("SELECT 1 FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [req.accountId, key]);
        if (claim.rowCount === 0) {
          const live = await client.query<{ n: string }>("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND NOT (status = ANY($3::text[]))", [
            req.accountId,
            req.workItemId,
            [...ADVANCE_TERMINAL_STATUSES],
          ]);
          busy = Number(live.rows[0]?.n ?? 0) > 0;
        }
      }
      return { row: r.rows[0], busy };
    });
    const repo = found.row;
    // Advisory, and read before the seat and the environment so a halted item pays for neither: the authority is the
    // trigger on agent_runs (0750), which refuses the insert itself. The epoch fences a workflow started before a halt.
    if (repo?.halted) return { ok: false, reason: "item_halted" };
    if (repo && repo.halt_epoch !== req.haltEpoch) return { ok: false, reason: "halted_since_approval" };
    if (!repo?.repo_id) return { ok: false, reason: "no_repo" };
    if (found.busy) return { ok: false, reason: "already_running" };
    const seat = await deps.resolveRunSeat({ accountId: req.accountId, role: req.role, workItemId: req.workItemId });
    if (!seat.ok) return { ok: false, reason: seat.reason };
    const cloneFrom = req.clone === true ? (repo.gh_owner && repo.gh_name ? { owner: repo.gh_owner, name: repo.gh_name } : null) : undefined;
    if (cloneFrom === null) return { ok: false, reason: "no_repo" };
    const input: StartAgentRunInput = {
      ...seat.seat,
      accountId: req.accountId,
      repoId: repo.repo_id,
      workItemId: req.workItemId,
      role: req.role as StartAgentRunInput["role"],
      product: "team",
      prompt: req.prompt,
      ...(req.pr !== undefined ? { pr: req.pr } : {}),
      ...(req.headSha !== undefined ? { headSha: req.headSha } : {}),
      // The runner clones this repository (shallow, default branch) into the workdir before the agent starts.
      ...(cloneFrom ? { workdir: PREVIEW_WORKDIR, cloneRepo: cloneFrom } : {}),
      idempotency: { key, requestHash: createHash("sha256").update(`${key}:${req.role}`).digest("hex") },
    };
    let started: Awaited<ReturnType<RunStarter["start"]>>;
    try {
      started = await deps.starter.start(input);
    } catch (err) {
      // The database allows one live executor per pull request (the unique index). Two approvals racing to build, or a
      // build racing a fix round, lose here: the loser is told, and nothing is left behind. This is the lock.
      if (err instanceof DuplicateExecutorRunError) return { ok: false, reason: "already_running" };
      if (err instanceof WorkItemHaltedError) return { ok: false, reason: "item_halted" };
      // The executor's sandbox is inside a reaper claim (0761): nothing was written, and the step retries after a wait.
      if (err instanceof SandboxReapingError) return { ok: false, reason: "sandbox_reaping" };
      throw err;
    }
    console.info(JSON.stringify({ event: "advance.run_started", work_item_id: req.workItemId, step: req.step, role: req.role, run_id: started.runId, refused: started.refused ?? null }));
    if (started.refused) return { ok: false, reason: started.refused };
    return { ok: true, runId: started.runId };
  }

  /**
   * How a run stands, following the run that replaced it (C22 sections 5 and 7). A runner run that ended `failed` with
   * `runner_lost` or `usage_limit` and has a runner child (the follow-up) is not the end of the work: the outcome is that of the
   * child, and of ITS child in turn, for at most `FOLLOW_UP_CHAIN_MAX_RUNS` runs. Only a chain whose last run has no child is
   * final, so a pending child reads as not done and queued on a runner, and a childless failed run (a chain that ran out of
   * allowance, or whose child could not be made) reads as failed and done. Every other run is read as it stands.
   */
  async function advanceRunOutcome(accountId: string, runId: string): Promise<AdvanceRunOutcome> {
    if (!UUID_RE.test(accountId) || !UUID_RE.test(runId)) return { status: "missing", done: true, envelope: null };
    return withTenant(runnerPool, accountId, async (client) => {
      let currentId = runId;
      for (let seen = 1; ; seen++) {
        const r = await client.query<{ status: string; envelope: unknown; runtime: string }>("SELECT status, envelope, runtime FROM agent_runs WHERE id = $1 AND account_id = $2", [currentId, accountId]);
        const row = r.rows[0];
        if (!row) return { status: "missing", done: true, envelope: null };
        let reason: string | null = null;
        if (row.status === "failed" && row.runtime === "runner") {
          const e = await client.query<{ reason: string | null }>(
            "SELECT payload->>'failureReason' AS reason FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = 'run.status_changed' AND payload->>'to' = 'failed' ORDER BY seq DESC LIMIT 1",
            [accountId, currentId],
          );
          reason = e.rows[0]?.reason ?? null;
          if (reason !== null && FOLLOW_UP_REASONS.has(reason) && seen < FOLLOW_UP_CHAIN_MAX_RUNS) {
            const next = await client.query<{ id: string }>("SELECT id FROM agent_runs WHERE account_id = $1 AND parent_run_id = $2 AND runtime = 'runner' LIMIT 1", [accountId, currentId]);
            if (next.rows[0]) {
              currentId = next.rows[0].id;
              continue;
            }
          }
        }
        const envelope = row.envelope !== null && typeof row.envelope === "object" && !Array.isArray(row.envelope) ? (row.envelope as Record<string, unknown>) : null;
        return { status: row.status, done: TERMINAL.has(row.status), envelope, runtime: row.runtime, tailRunId: currentId, failureReason: reason };
      }
    });
  }

  async function supersededByTriage(accountId: string, workItemId: string): Promise<boolean> {
    return withTenant(runnerPool, accountId, async (client) => {
      const r = await client.query(
        "SELECT 1 FROM work_item_transitions WHERE account_id = $1 AND work_item_id = $2 AND to_stage = 'closed' AND source_ref LIKE 'superseded:%' LIMIT 1",
        [accountId, workItemId],
      );
      return r.rowCount === 1;
    });
  }

  async function advanceTriage(accountId: string, input: AdvanceTriageInput): Promise<AdvanceTriageResult> {
    if (!deps.triage) return { status: "refused", reason: "triage_unavailable" };
    if (!UUID_RE.test(accountId) || !UUID_RE.test(input.workItemId) || !UUID_RE.test(input.repoId)) return { status: "refused", reason: "invalid_input" };
    // The step re-asserts what perform checked: only an internal item that has no discussion yet is triaged here.
    const item = await advanceLoadItem(accountId, input.workItemId);
    if (!item) return { status: "refused", reason: "target_not_found" };
    if (item.provenance !== "internal") return { status: "refused", reason: "external_requires_human" };
    if (item.repoId !== input.repoId || item.ghNumber !== input.number) return { status: "refused", reason: "item_changed" };
    // A replay of a triage that already finished is allowed (the pipeline's triage is idempotent on the source event): the
    // item then sits at `closed`, retired by that very triage. Anything else not at `triaged` is not ours to advance.
    const replay = item.stage === "closed" && (await supersededByTriage(accountId, input.workItemId));
    const verdict = advanceActionFor({ stage: item.stage, discussion_id: item.hasDiscussion ? "d" : null, kind: item.kind, has_spec: item.hasSpec });
    if (!replay && !(verdict.ok && verdict.action === "triage")) return { status: "refused", reason: "not_advanceable" };
    const out = await deps.triage(runnerPool, accountId, input);
    console.info(JSON.stringify({ event: "advance.triaged", work_item_id: input.workItemId, status: out.status, category: out.category ?? null, stage: out.stage ?? null, reason: out.reason ?? null }));
    return out;
  }

  /** Stops a LIVE run of this item through the runner's own cancel (what the Cancel button runs), as the approver. A finished run, another item's run and an unknown run are left alone. */
  async function cancelItemRun(who: AdvanceStepWho, runId: string): Promise<void> {
    if (!deps.registry || !UUID_RE.test(runId)) return;
    const live = await withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1 AND account_id = $2 AND work_item_id = $3", [runId, who.accountId, who.workItemId]);
      return r.rows[0] !== undefined && !TERMINAL.has(r.rows[0].status);
    });
    if (!live) return;
    await cancelRun({ pool: runnerPool, principal: { accountId: who.accountId, userId: who.userId, kind: "session" } }, runId, deps.registry);
  }

  /** The ports one step gets: bound to one account and item, so the step cannot name another. */
  function portsFor(who: AdvanceStepWho): AdvanceStepPorts {
    return {
      startRun: (req) => advanceStartRun({ ...req, accountId: who.accountId, workItemId: who.workItemId, haltEpoch: who.haltEpoch }),
      outcome: (runId) => advanceRunOutcome(who.accountId, runId),
      cancel: (runId) => cancelItemRun(who, runId),
    };
  }

  /** What every pipeline step re-asserts before it spends: valid ids, the item exists, and it is internal. */
  async function guardStep(who: AdvanceStepWho): Promise<AdvanceStepResult | null> {
    if (!UUID_RE.test(who.accountId) || !UUID_RE.test(who.userId) || !UUID_RE.test(who.workItemId)) return { status: "refused", reason: "invalid_input" };
    const item = await advanceLoadItem(who.accountId, who.workItemId);
    if (!item) return { status: "refused", reason: "target_not_found" };
    // Fail closed, as the intake gate does: only the exact literal "internal" is internal.
    if (item.provenance !== "internal") return { status: "refused", reason: "external_requires_human" };
    // A halt is lifted only by a person's later approval, which starts a NEW workflow under the new epoch: this one, started
    // before the halt, stops here whether the halt still stands or has been resumed since.
    const halt = await withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ halted: boolean; halt_epoch: number }>("SELECT halted_at IS NOT NULL AS halted, halt_epoch FROM work_items WHERE id = $1 AND account_id = $2", [who.workItemId, who.accountId]);
      return r.rows[0];
    });
    if (halt?.halted) return { status: "refused", reason: "item_halted" };
    if (halt && halt.halt_epoch !== who.haltEpoch) return { status: "refused", reason: "halted_since_approval" };
    return null;
  }

  async function advancePanel(who: AdvanceStepWho): Promise<AdvanceStepResult> {
    if (!deps.panel) return { status: "refused", reason: "panel_unavailable" };
    const bad = await guardStep(who);
    if (bad) return bad;
    const out = await deps.panel(runnerPool, who.accountId, who.workItemId, portsFor(who));
    console.info(JSON.stringify({ event: "advance.panel", work_item_id: who.workItemId, status: out.status, reason: out.reason ?? null, complete: out.complete ?? null, missing: out.missingRoles?.length ?? null, round2: out.round2Ran ?? null }));
    return out;
  }

  async function advanceSpec(who: AdvanceStepWho, attempt?: string): Promise<AdvanceStepResult> {
    if (!deps.spec) return { status: "refused", reason: "spec_unavailable" };
    if (attempt !== undefined && !UUID_RE.test(attempt)) return { status: "refused", reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return bad;
    const out = await deps.spec(runnerPool, who.accountId, who.workItemId, portsFor(who), attempt !== undefined ? { attempt } : {});
    console.info(JSON.stringify({ event: "advance.spec", work_item_id: who.workItemId, status: out.status, reason: out.reason ?? null, stage: out.stage ?? null, version: out.version ?? null }));
    return out;
  }

  /** One driver event on a tenant-scoped client. Never throws for a bad value: the caller gets `recorded: false` (a bad event must not stop the pipeline). */
  async function writeEvent(who: AdvanceStepWho, event: Omit<DriverEventInput, "workItemId">): Promise<{ recorded: boolean }> {
    const full: DriverEventInput = { ...event, workItemId: who.workItemId };
    try {
      assertDriverEvent(full);
    } catch {
      // fx-swallow-ok: a value the store would refuse is dropped with a fixed log line; the pipeline goes on without the fact
      console.warn(JSON.stringify({ event: "advance.event_invalid", work_item_id: who.workItemId, kind: String(event.kind) }));
      return { recorded: false };
    }
    return withTenant(runnerPool, who.accountId, (client) => recordDriverEvent(client, who.accountId, full));
  }

  async function advanceBuild(who: AdvanceStepWho, approvalId: string, expectedVersion?: number): Promise<AdvanceStepResult> {
    if (!deps.build) return { status: "refused", reason: "build_unavailable" };
    if (!UUID_RE.test(approvalId) || (expectedVersion !== undefined && !(Number.isSafeInteger(expectedVersion) && expectedVersion > 0))) return { status: "refused", reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return bad;
    const out = await deps.build(runnerPool, who.accountId, who.workItemId, approvalId, portsFor(who), expectedVersion !== undefined ? { expectedVersion } : {});
    console.info(JSON.stringify({ event: "advance.build", work_item_id: who.workItemId, status: out.status, reason: out.reason ?? null, run_id: out.runId ?? null }));
    // A build that did not start is a fact of the item (its code is a fixed word the start named).
    // A start that met a reaper claim is not a refusal of the build: the workflow waits and starts again, so no fact is recorded.
    if (out.status === "refused" && out.reason !== "start_sandbox_reaping") {
      await writeEvent(who, { kind: "build_refused", dedupeKey: `build:${approvalId}`, code: /^[a-z][a-z0-9_]{0,63}$/.test(out.reason ?? "") ? out.reason : "refused" });
    }
    return out;
  }

  async function advanceBuildFailed(accountId: string, workItemId: string, runId: string | null, code: string, attempt?: string): Promise<AdvanceStepResult> {
    if (!deps.buildFailed) return { status: "refused", reason: "build_unavailable" };
    if (!UUID_RE.test(accountId) || !UUID_RE.test(workItemId) || (runId !== null && !UUID_RE.test(runId)) || (attempt !== undefined && !UUID_RE.test(attempt)) || !/^[a-z_]{1,40}$/.test(code)) return { status: "refused", reason: "invalid_input" };
    const out = await deps.buildFailed(runnerPool, accountId, workItemId, runId, code, ...(attempt === undefined ? [] : [attempt]));
    console.info(JSON.stringify({ event: "advance.build_failed", work_item_id: workItemId, run_id: runId, code, status: out.status, stage: out.stage ?? null }));
    return out;
  }

  async function advancePrFound(who: AdvanceStepWho, prNumber: number): Promise<AdvanceStepResult> {
    if (!UUID_RE.test(who.accountId) || !UUID_RE.test(who.workItemId) || !Number.isSafeInteger(prNumber) || prNumber <= 0) return { status: "refused", reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return bad;
    const out = await withTenant(runnerPool, who.accountId, async (client) => {
      // The stage is read under the row lock (recordStage takes the same lock), and the answer is read again after the
      // attempt, so it is the stage as it stands NOW and not the one seen before another writer (the webhook) got in.
      const stageNow = async () => (await client.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1 AND account_id = $2 FOR UPDATE", [who.workItemId, who.accountId])).rows[0]?.stage ?? null;
      const before = await stageNow();
      if (before !== "in_progress") return { status: "unchanged", stage: before };
      let recorded = false;
      try {
        recorded = (await recordStage(client, { workItemId: who.workItemId, toStage: "pr_opened", at: new Date(), source: "control_plane", sourceRef: `pr_found:${prNumber}` })).recorded;
      } catch (err) {
        if (err instanceof StageHaltedError) return { status: "unchanged", reason: "item_halted", stage: before };
        if (!(err instanceof IllegalStageTransitionError)) throw err;
      }
      return { status: recorded ? "recorded" : "unchanged", stage: await stageNow() };
    });
    console.info(JSON.stringify({ event: "advance.pr_found", work_item_id: who.workItemId, pr: prNumber, status: out.status, stage: out.stage }));
    return out;
  }

  // ---- D#483 P3: the review stage -------------------------------------------------------------------------------

  const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  const VERDICT_ROLES = ["code-reviewer", "acceptance-tester", "security-reviewer", "debater"];
  const VERDICT_WORDS = ["pass", "needs-fix", "fail"];
  const MAX_FIX_PROMPT_CHARS = 120_000;

  async function advanceLoadReview(who: AdvanceStepWho): Promise<AdvanceReviewLoad> {
    if (!deps.review) return { ok: false, reason: "review_unavailable" };
    const bad = await guardStep(who);
    if (bad) return { ok: false, reason: bad.reason ?? "refused" };
    const loaded = await deps.review.load(runnerPool, who.accountId, who.workItemId);
    if (!loaded.ok) return loaded;
    // Read here, not by the pipeline's loader: it is the worker that holds the run records this comes from.
    return { ok: true, ctx: { ...loaded.ctx, ...(await pullRequestSource(who.accountId, who.workItemId)) } };
  }

  async function advanceLoadSpecText(who: AdvanceStepWho, expectedVersion: number): Promise<{ version: number; body: string } | null> {
    if (!UUID_RE.test(who.accountId) || !UUID_RE.test(who.workItemId) || !Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) return null;
    return withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ version: number; body: string }>(
        "SELECT version, body FROM spec_versions WHERE account_id = $1 AND work_item_id = $2 AND erased_at IS NULL ORDER BY version DESC LIMIT 1",
        [who.accountId, who.workItemId],
      );
      const row = r.rows[0];
      // The Spec the person approved is the one used: a newer version appearing in between stops the driver.
      return row && Number(row.version) === expectedVersion ? { version: Number(row.version), body: row.body } : null;
    });
  }

  async function advanceRecordRound(who: AdvanceStepWho, input: Omit<AdvanceRoundInput, "accountId" | "workItemId">): Promise<AdvanceRoundResult | { decision: "refused"; reason: string }> {
    if (!deps.review || !deps.registry) return { decision: "refused", reason: "review_unavailable" };
    const sane =
      SHA_RE.test(input.headSha) &&
      Number.isSafeInteger(input.prNumber) && input.prNumber > 0 &&
      (input.round === undefined || (Number.isInteger(input.round) && input.round >= 0 && input.round <= 20)) &&
      input.requiredRoles.length > 0 && input.requiredRoles.length <= 4 && input.requiredRoles.every((r) => VERDICT_ROLES.includes(r)) &&
      input.verdicts.length <= 4 &&
      input.verdicts.every((v) => VERDICT_ROLES.includes(v.role) && UUID_RE.test(v.runId) && VERDICT_WORDS.includes(v.verdict) && (v.debatedRole === undefined || v.debatedRole === "code-reviewer" || v.debatedRole === "security-reviewer"));
    if (!sane) return { decision: "refused", reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return { decision: "refused", reason: bad.reason ?? "refused" };
    const out = await deps.review.recordRound(runnerPool, deps.registry, { ...input, accountId: who.accountId, workItemId: who.workItemId });
    console.info(JSON.stringify({ event: "advance.round", work_item_id: who.workItemId, round: input.round, decision: out.decision, verdicts: out.recorded.map((r) => `${r.role}:${r.verdict}:${r.outcome}`) }));
    return out;
  }

  /** The newest executor run of the item that holds a session (the build's, or the last fix's). */
  async function newestExecutorRun(who: AdvanceStepWho): Promise<string | null> {
    return withTenant(runnerPool, who.accountId, async (client) => {
      const r = await client.query<{ id: string }>(
        "SELECT id FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND role = 'executor' AND cc_session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        [who.accountId, who.workItemId],
      );
      return r.rows[0]?.id ?? null;
    });
  }

  async function advanceStartFix(who: AdvanceStepWho, req: AdvanceFixRequest): Promise<AdvanceRunStart> {
    const review = deps.review;
    if (!review || !deps.registry) return { ok: false, reason: "resume_unavailable" };
    const sane =
      UUID_RE.test(req.actionId) && UUID_RE.test(req.failingRunId) &&
      Number.isSafeInteger(req.issue) && req.issue > 0 &&
      SHA_RE.test(req.headSha) &&
      typeof req.prompt === "string" && req.prompt !== "" && req.prompt.length <= MAX_FIX_PROMPT_CHARS &&
      Number.isInteger(req.round) && req.round >= 1 && req.round <= 20 &&
      (req.reviewer === "code" || req.reviewer === "security" || req.reviewer === "acceptance");
    if (!sane) return { ok: false, reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return { ok: false, reason: bad.reason ?? "refused" };

    const refuse = async (reason: string): Promise<AdvanceRunStart> => {
      await writeEvent(who, { kind: "fix_round_refused", dedupeKey: `fix:${req.headSha}:${req.actionId}`, code: /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "refused", headSha: req.headSha, round: req.round });
      return { ok: false, reason };
    };

    // A replay of the same approval on the same head finds the run it started; it never starts a second one.
    const key = `advance:${who.workItemId}:fix:${req.headSha}:${req.actionId}`;
    const claimedRun = async (): Promise<string | null> =>
      withTenant(runnerPool, who.accountId, async (client) => {
        const r = await client.query<{ run_id: string }>("SELECT run_id FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [who.accountId, key]);
        return r.rows[0]?.run_id ?? null;
      });
    // The fact is written on every path that returns a started run (it is deduped): a step that died between the resume
    // and the event write would otherwise leave the run uncounted, and `fixRoundsStarted` would undercount.
    const started = async (runId: string): Promise<AdvanceRunStart> => {
      await writeEvent(who, { kind: "fix_round_started", dedupeKey: `fix:${req.headSha}:${req.actionId}`, headSha: req.headSha, round: req.round, runId });
      return { ok: true, runId };
    };
    const already = await claimedRun();
    if (already) return started(already);

    // One executor at a time: a second concurrent resume is refused (the database's one-live-executor-per-PR index is the backstop).
    const state = await withTenant(runnerPool, who.accountId, async (client) => {
      const live = await client.query("SELECT 1 FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND role = 'executor' AND status IN ('pending', 'running') LIMIT 1", [who.accountId, who.workItemId]);
      const item = await client.query<{ stage: string; repo_id: string | null }>("SELECT stage, repo_id FROM work_items WHERE id = $1 AND account_id = $2", [who.workItemId, who.accountId]);
      return { live: (live.rowCount ?? 0) > 0, stage: item.rows[0]?.stage ?? null, repoId: item.rows[0]?.repo_id ?? null };
    });
    if (state.live) return refuse("already_running");
    if (state.repoId === null) return refuse("no_repo");
    // Only a pull request that is still under review gets a fix round (not one that merged, closed or went to a person).
    if (state.stage !== "pr_opened" && state.stage !== "changes_requested" && state.stage !== "review_passed") return refuse(`stage_${state.stage ?? "gone"}`.replace(/[^a-z0-9_]/g, "_"));

    const parent = await newestExecutorRun(who);
    if (parent === null) return refuse("no_session");
    const seat = await deps.resolveRunSeat({ accountId: who.accountId, role: "executor", workItemId: who.workItemId });
    if (!seat.ok) return refuse(seat.reason);

    // The board says "Changes requested" the moment a fix round starts, whatever an earlier record said (a pass recorded
    // after a needs-fix used to leave the card at "ready to merge").
    if (state.stage !== "changes_requested") {
      try {
        await withTenant(runnerPool, who.accountId, (client) =>
          recordStage(client, { workItemId: who.workItemId, toStage: "changes_requested", reviewer: req.reviewer, at: new Date(), source: "control_plane", sourceRef: `fix-round:${req.failingRunId}` }),
        );
      } catch (err) {
        if (err instanceof StageHaltedError) return refuse("item_halted");
        if (!(err instanceof IllegalStageTransitionError)) throw err;
        return refuse("stage_changed");
      }
    }

    let out: { id: string; status: string };
    try {
      // The build ran in the sandbox this PR owns, in the checkout it made; a resume continues both: same sandbox, same
      // session, same working directory, no clone. `pr` is the ISSUE's number, as the build used it (it names the sandbox).
      // A fix round the target queued for a runner has no hook and may sit pending for days: it is cancelled and the
      // round is recorded as refused (resume_failed) below, never logged as resumed.
      out = await failClosedOnQueued(
        runnerPool,
        who.accountId,
        await review.resume(runnerPool, deps.registry, {
          ...seat.seat,
          accountId: who.accountId,
          repoId: state.repoId,
          workItemId: who.workItemId,
          role: "executor",
          product: "team",
          pr: req.issue,
          parentRunId: parent,
          prompt: req.prompt,
          workdir: PREVIEW_WORKDIR,
          idempotency: { key, requestHash: createHash("sha256").update(`${key}:executor`).digest("hex") },
        }),
      );
    } catch (err) {
      // fx-swallow-ok: the error's NAME is logged below and the refusal is recorded as a fact; its message can carry text from the sandbox or the platform
      const e = err as { name?: string };
      console.warn(JSON.stringify({ event: "advance.resume_failed", work_item_id: who.workItemId, name: typeof e?.name === "string" ? e.name.slice(0, 60) : null }));
      if (err instanceof IdempotencyKeyTakenError) {
        const won = await claimedRun();
        if (won) return started(won);
      }
      // A reaper claim on the sandbox is transient: the step throws and is retried (the run is keyed, so a replay is safe).
      if (err instanceof SandboxReapingError) throw err;
      if (err instanceof DuplicateExecutorRunError) return refuse("already_running");
      if (err instanceof WorkItemHaltedError) return refuse("item_halted");
      return refuse("resume_failed");
    }
    if (out.status === "refused_spend") return refuse("refused_spend");
    console.info(JSON.stringify({ event: "advance.resumed", work_item_id: who.workItemId, run_id: out.id, status: out.status, round: req.round }));
    return started(out.id);
  }

  async function advanceLightSpec(who: AdvanceStepWho, runId: string, actionId: string): Promise<{ status: string; reason: string | null; version: number | null }> {
    const refusedWith = (reason: string) => ({ status: "refused", reason, version: null });
    if (!deps.lightSpec) return refusedWith("light_spec_unavailable");
    if (!UUID_RE.test(runId) || !UUID_RE.test(actionId)) return refusedWith("invalid_input");
    const bad = await guardStep(who);
    if (bad) return refusedWith(bad.reason ?? "refused");
    const read = await withTenant(runnerPool, who.accountId, async (client) => {
      const run = await client.query<{ status: string; role: string; envelope: unknown }>("SELECT status, role, envelope FROM agent_runs WHERE id = $1 AND account_id = $2 AND work_item_id = $3", [runId, who.accountId, who.workItemId]);
      const item = await client.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1 AND account_id = $2", [who.workItemId, who.accountId]);
      const spec = await client.query<{ version: number }>("SELECT max(version) AS version FROM spec_versions WHERE account_id = $1 AND work_item_id = $2 AND erased_at IS NULL", [who.accountId, who.workItemId]);
      return { run: run.rows[0], stage: item.rows[0]?.stage ?? null, version: spec.rows[0]?.version ?? null };
    });
    if (!read.run || read.run.role !== "project-manager" || read.run.status !== "succeeded") return refusedWith("run_not_usable");
    // A replay after the Spec was published: nothing more is published (a second publish would add a version).
    if (read.stage === "spec_ready" && read.version !== null) return { status: "published", reason: null, version: Number(read.version) };
    if (read.stage !== "triaged") return refusedWith(`stage_${read.stage ?? "gone"}`.replace(/[^a-z0-9_]/g, "_"));
    const out = await deps.lightSpec(runnerPool, who.accountId, who.workItemId, read.run.envelope);
    const code = typeof out.reason === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(out.reason) ? out.reason : null;
    console.info(JSON.stringify({ event: "advance.light_spec", work_item_id: who.workItemId, status: out.status, reason: out.status === "refused" ? code : null, version: out.version ?? null }));
    if (out.status === "not_feasible" || out.status === "refused") {
      await writeEvent(who, { kind: "stopped", dedupeKey: `light:${actionId}`, code: out.status === "not_feasible" ? "not_feasible" : (code ?? "refused"), runId });
    }
    // The PM's own sentence for a not-feasible request is model text: it stays in the run (its summary), never returned.
    return { status: out.status, reason: out.status === "refused" ? code : null, version: typeof out.version === "number" ? out.version : null };
  }

  async function advanceMergeGate(who: AdvanceStepWho, prNumber: number): Promise<AdvanceMergeGateResult> {
    if (!deps.review) return { outcome: "refused", reason: "review_unavailable" };
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return { outcome: "refused", reason: "invalid_input" };
    const bad = await guardStep(who);
    if (bad) return { outcome: "refused", reason: bad.reason ?? "refused" };
    const out = await deps.review.mergeGate(runnerPool, { accountId: who.accountId, workItemId: who.workItemId, prNumber });
    console.info(JSON.stringify({ event: "advance.merge_gate", work_item_id: who.workItemId, pr: prNumber, outcome: out.outcome, reasons: out.reasons ?? null, status: out.status ?? null }));
    return out;
  }

  async function advanceRecordEvent(who: AdvanceStepWho, event: Omit<DriverEventInput, "workItemId">): Promise<{ recorded: boolean }> {
    if (!UUID_RE.test(who.accountId) || !UUID_RE.test(who.workItemId)) return { recorded: false };
    return writeEvent(who, event);
  }

  async function advanceCancel(who: AdvanceStepWho, runId: string): Promise<void> {
    await cancelItemRun(who, runId);
  }

  return {
    performAdvanceWorkItem,
    advanceLoadItem,
    advanceStartRun,
    advanceRunOutcome,
    advanceTriage,
    advancePanel,
    advanceSpec,
    advanceBuild,
    advanceBuildFailed,
    advancePrFound,
    advanceLightSpec,
    advanceLoadReview,
    advanceLoadSpecText,
    advanceRecordRound,
    advanceStartFix,
    advanceMergeGate,
    advanceRecordEvent,
    advanceCancel,
  };
}
