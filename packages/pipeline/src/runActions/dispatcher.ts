import { performCancelRun, performCancelWorkItem } from "./cancelPerformers.js";

/**
 * D#2 H14c-3b: what the run-action workflow needs from the worker, and which
 * performer handles which kind.
 *
 * `RunActionsWorker` is a STRUCTURAL port: this package does not depend on
 * `@fx/worker` (the only package that may reach the runner login). apps/web
 * hands the real `Worker` in and type-checks it against this shape
 * (apps/web/lib/worker.ts). Every method takes and returns plain data.
 */

export type RunActionSettleState = "accepted" | "done" | "refused" | "failed";

/** What a perform returns. `refused` is a policy refusal (settled without a retry); `errorCode` is a fixed enum. */
export type PerformResult = { result: "done"; outcome: Record<string, unknown> } | { result: "refused"; errorCode: string };

/** A claimed request, as data (the parts the workflow reads). */
export interface ClaimedAction {
  id: string;
  kind: string;
  attempts: number;
}

export interface SettleInput {
  state: RunActionSettleState;
  outcome?: Record<string, unknown> | null;
  errorCode?: string | null;
  retryAfterSeconds?: number;
  /** A page of a paged cancel made progress: re-queue without spending an attempt (only with state "accepted"). */
  progress?: true;
}

export interface RunActionsWorker {
  claimRunAction(actionId: string, leaseSeconds: number): Promise<ClaimedAction | null>;
  settleRunAction(actionId: string, input: SettleInput): Promise<void>;
  /** Lists due ids and changes nothing: the workflow's own claim takes the lease. */
  listDueRunActions(minAgeSeconds: number, limit: number): Promise<string[]>;
  purgeRunActions(olderThanSeconds: number, limit: number): Promise<number>;
  performCancelRun(actionId: string): Promise<PerformResult>;
  performCancelWorkItem(actionId: string): Promise<PerformResult>;
  /** Optional so a worker built before H17c still satisfies the port; the real `Worker` always has it. */
  performStartPreview?(actionId: string): Promise<PerformResult>;
  /** Optional the same way: a worker without it refuses `retry_unavailable`. */
  performRetryRun?(actionId: string): Promise<PerformResult>;
  /** Optional the same way: a worker without it refuses `advance_unavailable`. Starts the stage driver for an approved work item. */
  performAdvanceWorkItem?(actionId: string): Promise<PerformResult>;
  /** Optional the same way: a worker without it refuses `respec_unavailable`. Starts the stage driver in Re-spec mode (D#6 R4d-5b). */
  performRespecWorkItem?(actionId: string): Promise<PerformResult>;
  /** Optional the same way: a worker without it refuses `amend_unavailable`. Publishes the next Spec version for accepted Spec amendments (D#597 CC-2b). */
  performAmendSpec?(actionId: string): Promise<PerformResult>;
}

/** A performer is handed the action id and nothing else: the facade derives who it runs as from the database. */
export type Performer = (worker: RunActionsWorker, actionId: string) => Promise<PerformResult>;

/** Kind -> performer. API-6b, API-6c and H17c add their kinds here. */
const PERFORMERS: Readonly<Record<string, Performer>> = Object.freeze({
  cancel_run: performCancelRun,
  cancel_work_item: performCancelWorkItem,
  start_preview: async (worker, actionId) => (await worker.performStartPreview?.(actionId)) ?? { result: "refused", errorCode: "preview_unavailable" },
  retry_run: async (worker, actionId) => (await worker.performRetryRun?.(actionId)) ?? { result: "refused", errorCode: "retry_unavailable" },
  advance_work_item: async (worker, actionId) => (await worker.performAdvanceWorkItem?.(actionId)) ?? { result: "refused", errorCode: "advance_unavailable" },
  respec_work_item: async (worker, actionId) => (await worker.performRespecWorkItem?.(actionId)) ?? { result: "refused", errorCode: "respec_unavailable" },
  amend_spec_work_item: async (worker, actionId) => (await worker.performAmendSpec?.(actionId)) ?? { result: "refused", errorCode: "amend_unavailable" },
});

/** The performer for a kind, or undefined (a kind nobody performs is settled refused, never retried). */
export function performerFor(kind: string): Performer | undefined {
  return Object.hasOwn(PERFORMERS, kind) ? PERFORMERS[kind] : undefined;
}
