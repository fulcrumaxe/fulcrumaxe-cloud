import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { performerFor, type ClaimedAction, type PerformResult, type RunActionsWorker, type SettleInput } from "./dispatcher.js";

/**
 * D#2 H14c-3b: the plain step bodies of the run-action workflow. NO directives
 * live here: the Workflow builder only compiles `"use step"` / `"use workflow"`
 * in the app's own source, so the thin wrapper is apps/web/workflows/runAction.ts.
 * It calls these with the worker; nothing here runs SQL, holds a pool or charges
 * anything (money moves only inside the facade's cancel, through the runner).
 *
 * Every argument and result below is plain JSON (the worker itself is never an
 * argument: a step reaches it through apps/web's memoised getWorker()).
 */

/** Seconds a claim holds the lease: longer than one perform (a preview perform waits for the agent to start, up to the runner's 3-minute start window, after the sandbox is created; worker/test/claimLease.test.ts pins the margin), short enough that a crashed worker is re-run by the next sweep. */
export const CLAIM_LEASE_SECONDS = 300;
/** The retry delay is 2^attempts x 5 s, never more than this (the definer's own limit is 86400). */
const MAX_RETRY_SECONDS = 3600;

/** A worker that disappears after a claim fails the step: the lease runs out and the next sweep starts the action again. */
const NOT_CONFIGURED = "run actions: worker not configured";

/** A claimed request as a step passes it on. */
export type ClaimStepResult = ClaimedAction;

/** What the perform step returns: a facade result, or `error` when the performer threw. */
export type PerformStepResult = PerformResult | { result: "error"; errorCode: string };

/** What the settle step returns. */
export interface SettleStepResult {
  id: string;
  state: SettleInput["state"];
  /** Present (true) only when the settle was a page of progress: the workflow claims again at once. */
  progress?: true;
}

/** Claim. Null ends the workflow: a duplicate kick, an action that is not claimable, or no worker configured. */
export async function claimBody(worker: RunActionsWorker | null, actionId: string): Promise<ClaimStepResult | null> {
  if (!worker) return null;
  const claimed = await worker.claimRunAction(actionId, CLAIM_LEASE_SECONDS);
  // D#454 H3c: a worker that dies holding the lease leaves the action to the sweep, at the moment the lease runs out.
  if (claimed) void markWorkPending("run-action-sweep", { since: Date.now() + (CLAIM_LEASE_SECONDS + 5) * 1000 });
  return claimed ? { id: claimed.id, kind: claimed.kind, attempts: claimed.attempts } : null;
}

/** A fixed, lower-case code for a thrown error. Never the error's message (it may carry driver text). */
function errorCodeFor(err: unknown): string {
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === "RunActionUnavailableError") return "worker_unavailable";
  if (name === "RunActionRefusedError") return "database_refused";
  if (name === "RunActionInputError") return "invalid_input";
  if (name === "AuthorCheckUnavailableError") return "author_check_unavailable";
  return "perform_failed";
}

/**
 * Perform. A kind with no performer is refused without calling the facade. A policy
 * refusal comes back as a result; a thrown error becomes `error` so settle can retry it.
 */
export async function performBody(worker: RunActionsWorker | null, claimed: ClaimStepResult): Promise<PerformStepResult> {
  const performer = performerFor(claimed.kind);
  if (!performer) return { result: "refused", errorCode: "kind_not_supported" };
  if (!worker) throw new Error(NOT_CONFIGURED);
  try {
    return await performer(worker, claimed.id);
  } catch (err) {
    // fx-swallow-ok: the failure goes back as an "error" outcome with its code, and the settle call records it
    return { result: "error", errorCode: errorCodeFor(err) };
  }
}

/** The settle call for a perform outcome. Exported so the branches can be asserted one by one. */
export function settleInputFor(claimed: ClaimStepResult, outcome: PerformStepResult): SettleInput {
  if (outcome.result === "done") {
    // A work item with more live runs than one call cancels: a page of progress, back to accepted at once without spending an attempt.
    if (claimed.kind === "cancel_work_item" && outcome.outcome.remaining === true) return { state: "accepted", progress: true };
    return { state: "done", outcome: outcome.outcome };
  }
  if (outcome.result === "refused") return { state: "refused", errorCode: outcome.errorCode, outcome: { reason: outcome.errorCode } };
  // A thrown error retries with backoff; from the 5th attempt the settle definer writes `failed` with this code instead.
  return {
    state: "accepted",
    errorCode: outcome.errorCode,
    retryAfterSeconds: Math.min(MAX_RETRY_SECONDS, 2 ** claimed.attempts * 5),
  };
}

/** Settle. The settle definer writes run_action.settled (and run_action.failed) in its own transaction. */
export async function settleBody(worker: RunActionsWorker | null, claimed: ClaimStepResult, outcome: PerformStepResult): Promise<SettleStepResult> {
  if (!worker) throw new Error(NOT_CONFIGURED);
  const input = settleInputFor(claimed, outcome);
  await worker.settleRunAction(claimed.id, input);
  // D#454 H3c: a retry (or a further page) is back in the queue; mark when it becomes due so the sweep does not skip it.
  if (input.state === "accepted") void markWorkPending("run-action-sweep", { since: Date.now() + (input.retryAfterSeconds ?? 0) * 1000 });
  return input.progress ? { id: claimed.id, state: input.state, progress: true } : { id: claimed.id, state: input.state };
}

/**
 * The same three steps in a row, without the directives. The workflow wrapper composes
 * the same bodies as separate durable steps; this is for callers that have a worker in
 * hand and no workflow runtime (tests).
 */
export async function runActionSteps(worker: RunActionsWorker | null, actionId: string): Promise<SettleStepResult | null> {
  const claimed = await claimBody(worker, actionId);
  if (!claimed) return null;
  return settleBody(worker, claimed, await performBody(worker, claimed));
}
