import type { AdvanceFacade, AdvanceRunOutcome, AdvanceRunStart, AdvanceTriageResult } from "@fx/worker";
import type { IssueReader } from "@fx/github";
import { advanceActionFor } from "@fx/core/src/work-items/advance.js";
import { buildClassifyRunPrompt, decideFromLabels } from "@fx/pipeline";

/**
 * D#483 P1: the bodies of the stage driver's durable steps (apps/web/workflows/workItemAdvance.ts holds the
 * directives and calls these). Plain async functions over injected ports, so they run in a test without the Workflow
 * service. All the I/O of the driver is here: a workflow body imports no Node module, so prompts are built here too.
 *
 * Every refusal is DATA with a fixed reason code, never a throw: a step that throws is retried by the Workflow
 * service, and none of these refusals gets better by retrying. Only a failure with no definite answer (the issue read
 * on a GitHub outage) throws inside the reader; `loadBody` catches it and reports `fetch_failed`, so the workflow ends
 * with a fixed code and the person can approve again.
 */
export type AdvanceWorker = Pick<AdvanceFacade, "advanceLoadItem" | "advanceStartRun" | "advanceRunOutcome" | "advanceTriage" | "advancePanel" | "advanceSpec" | "advanceBuild" | "advanceBuildFailed">;

export type LoadFailure =
  | "worker_unavailable"
  | "not_found"
  | "external_requires_human"
  | "no_issue_link"
  | "not_advanceable"
  | "reader_unavailable"
  | "issue_missing"
  | "issue_closed"
  | "fetch_failed";

export type LoadedAdvance =
  /** An item at `spec_ready` with a published Spec: the build follows. No issue read (the Spec is in the database). `specVersion` is the Spec the person approved: the build is pinned to it. */
  | { ok: true; mode: "build"; number: number; specVersion: number | null }
  /** An item at `needs_human` that still has its Spec ("Build again"): a fresh build, after a look for a pull request that is still open for the issue's branch (the repository facts are for that lookup). */
  | { ok: true; mode: "rebuild"; number: number; specVersion: number | null; repoId: string; owner: string; name: string }
  /** A small, bug or doc item the pipeline triaged (no panel) that has no Spec yet: the project manager's short Spec, from the issue as it reads NOW (an edited issue is what a re-approval wants). */
  | { ok: true; mode: "light"; category: string; title: string; body: string }
  /** An item discussed by the pipeline that has no Spec yet (a panel or Spec step that failed): the panel and the Spec run again. */
  | { ok: true; mode: "spec" }
  /** An item at `in_progress` with no run live: its build ended and nobody recorded what came of it. Look for the pull request (found: the review; none: Needs human, against `executorRunId`). */
  | { ok: true; mode: "check_build"; specVersion: number | null; executorRunId: string | null }
  /** An item whose pull request is open (pr_opened, changes_requested, review_passed): reviews, fix rounds and the merge gate. Pinned to the approved Spec version. */
  | { ok: true; mode: "review"; number: number; specVersion: number | null }
  | {
      ok: true;
      mode: "triage";
      repoId: string;
      owner: string;
      name: string;
      number: number;
      login: string;
      title: string;
      body: string;
      /** Set when a trusted, unambiguous label decided the category: the classify run is skipped. */
      decided: string | null;
      /** The label that decided it, as written on the issue. */
      because: string | null;
      /** Trusted labels the classifier should weigh. */
      hints: string[];
    }
  | { ok: false; reason: LoadFailure };

/** The load of an item that is going to be triaged (the issue was read). */
export type TriageLoaded = Extract<LoadedAdvance, { ok: true; mode: "triage" }>;
/** The load of an item at spec_ready that is going to be built. */
export type BuildLoaded = Extract<LoadedAdvance, { ok: true; mode: "build" }>;

/** Reads the item and its issue and applies the label rule. The issue's title, body and labels are third-party text: they go only into the prompt (sanitized there) and the discussion body. */
export async function loadBody(worker: AdvanceWorker | null, reader: IssueReader | null, accountId: string, workItemId: string): Promise<LoadedAdvance> {
  if (!worker) return { ok: false, reason: "worker_unavailable" };
  const item = await worker.advanceLoadItem(accountId, workItemId);
  if (!item) return { ok: false, reason: "not_found" };
  if (item.provenance !== "internal") return { ok: false, reason: "external_requires_human" };
  if (!item.repoId || !item.ghOwner || !item.ghName || item.ghNumber === null) return { ok: false, reason: "no_issue_link" };
  // The one table (@fx/core work-items/advance.ts), the same one the route and the worker's perform ask, says whether this
  // stage and state can be advanced and by what. A later stage adds a mode here and a branch in the workflow.
  const verdict = advanceActionFor({ stage: item.stage, discussion_id: item.hasDiscussion ? "d" : null, kind: item.kind, has_spec: item.hasSpec });
  if (!verdict.ok) return { ok: false, reason: "not_advanceable" };
  // The build: the Spec is in the database, so no issue is read.
  if (verdict.action === "build") return { ok: true, mode: "build", number: item.ghNumber, specVersion: item.specVersion };
  if (verdict.action === "rebuild") return { ok: true, mode: "rebuild", number: item.ghNumber, specVersion: item.specVersion, repoId: item.repoId, owner: item.ghOwner, name: item.ghName };
  // The panel and the Spec again, for the pipeline's own root item: no issue read either.
  if (verdict.action === "spec") return { ok: true, mode: "spec" };
  if (verdict.action === "check_build") return { ok: true, mode: "check_build", specVersion: item.specVersion, executorRunId: item.executorRunId };
  if (verdict.action === "review") return { ok: true, mode: "review", number: item.ghNumber, specVersion: item.specVersion };
  if (!reader) return { ok: false, reason: "reader_unavailable" };
  const light = verdict.action === "light_spec";
  let issue;
  try {
    issue = await reader({ repoId: item.repoId, owner: item.ghOwner, name: item.ghName, number: item.ghNumber });
  } catch {
    // fx-swallow-ok: fixed code only is logged and returned; the reader's message can carry a repository name, and a login must never reach a log
    console.warn(JSON.stringify({ event: "advance.issue_read_failed", work_item_id: workItemId }));
    return { ok: false, reason: "fetch_failed" };
  }
  if (issue.status === "missing") return { ok: false, reason: "issue_missing" };
  if (issue.state !== "open") return { ok: false, reason: "issue_closed" };
  if (light) return { ok: true, mode: "light", category: item.kind ?? "", title: issue.title, body: issue.body };
  // The item is internal, so the intake already trusted the issue's author: that author's own labels count.
  const label = decideFromLabels(issue.labels, issue.login, true);
  return {
    ok: true,
    mode: "triage",
    repoId: item.repoId,
    owner: item.ghOwner,
    name: item.ghName,
    number: item.ghNumber,
    login: issue.login,
    title: issue.title,
    body: issue.body,
    decided: label.decided,
    because: label.because,
    hints: label.hints,
  };
}

/** The classify run on the PM card. The key names the approval (the action), so a replayed step finds its run and a fresh approval after a failure starts a new one. */
export async function startClassifyBody(worker: AdvanceWorker | null, accountId: string, workItemId: string, haltEpoch: number, actionId: string, loaded: TriageLoaded): Promise<AdvanceRunStart> {
  if (!worker) return { ok: false, reason: "worker_unavailable" };
  return worker.advanceStartRun({
    accountId,
    workItemId,
    haltEpoch,
    step: `classify:${actionId}`,
    role: "project-manager",
    prompt: buildClassifyRunPrompt({ owner: loaded.owner, name: loaded.name, number: loaded.number, title: loaded.title, body: loaded.body, labels: loaded.hints }),
  });
}

/**
 * D#6 C12 A3: only a run that is `pending` AND executes on a runner is waiting for a person's machine. A `pending` sandbox or
 * production run is the platform's own delay (or a crash between the insert and the dispatch) and counts against the normal
 * wait budget, so a wait on it still ends.
 */
export function isQueuedOnRunner(out: Pick<AdvanceRunOutcome, "status" | "runtime">): boolean {
  return out.status === "pending" && out.runtime === "runner";
}

/**
 * How the classify run stands. The workflow gets the category word and not the run's envelope: the envelope is model
 * output, and nothing in it but this one short string has any business in the workflow's event history. (It also keeps
 * every value import out of the workflow body, which the Workflow builder requires.)
 */
export interface ClassifyOutcome {
  status: string;
  done: boolean;
  category: string | null;
  /** The run is `pending` on a runner (a queued runner run): the workflow credits that wait to the pending ceiling, not to the work budget. */
  queuedOnRunner: boolean;
}

export async function runOutcomeBody(worker: AdvanceWorker | null, accountId: string, runId: string): Promise<ClassifyOutcome> {
  if (!worker) return { status: "missing", done: true, category: null, queuedOnRunner: false };
  const out: AdvanceRunOutcome = await worker.advanceRunOutcome(accountId, runId);
  return { status: out.status, done: out.done, category: categoryOf(out.envelope), queuedOnRunner: isQueuedOnRunner(out) };
}

export interface TriageStepInput {
  workItemId: string;
  loaded: TriageLoaded;
  /** A category word, from a label or from the classify run's envelope. Parsed again by triage's own parser. */
  category: string;
}

export async function triageBody(worker: AdvanceWorker | null, accountId: string, input: TriageStepInput): Promise<AdvanceTriageResult> {
  if (!worker) return { status: "refused", reason: "worker_unavailable" };
  const { loaded } = input;
  return worker.advanceTriage(accountId, {
    workItemId: input.workItemId,
    title: loaded.title,
    body: loaded.body,
    category: input.category,
    sourceEventId: `gh-issue:${loaded.repoId}:${loaded.number}`,
    repoId: loaded.repoId,
    login: loaded.login,
    number: loaded.number,
  });
}

/** The category word in a classify run's envelope, or null. Not validated here: triage's own parser does that. */
export function categoryOf(envelope: Record<string, unknown> | null): string | null {
  const c = envelope?.category;
  return typeof c === "string" && c.length > 0 && c.length <= 200 ? c : null;
}
