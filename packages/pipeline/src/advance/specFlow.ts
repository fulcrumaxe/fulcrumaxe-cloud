import type { Pool } from "pg";
import { runPanel } from "../plan/panel.js";
import { runSpecStep } from "../plan/spec.js";
import { createFollowedRunner, type FollowedRunnerOptions } from "./followedRunner.js";
import type { AdvanceRunPorts } from "./runPorts.js";

/**
 * D#483 P2: the panel and the Spec for one discussed work item, over real agent runs.
 *
 * Two entry points, because one workflow step has a time limit and a panel round plus the PM does not fit inside it:
 *
 *  - `runPanelForItem` is the panel alone: round 1 and, if a seat asked for it or dissented, the one challenge round.
 *    Worst case: two round deadlines.
 *  - `runSpecForItem` is the pipeline's own `runSpecStep`. It re-enters the panel first, which costs nothing: every
 *    seat is a keyed run, a finished one is followed to its result at once, and the store keeps one signed comment per
 *    (discussion, run). Then it runs the PM and publishes the Spec. Worst case: the re-entry bound plus one PM deadline.
 *
 * The workflow calls them as two steps, so each step stays well under the platform's function time limit
 * (STEP_LIMIT_MS below pins the arithmetic in a test). If the platform cuts a step short and replays it, the keys make
 * the replay follow the runs already started; nothing is started or paid for twice.
 *
 * Every outcome is the pipeline's own: a seat that was refused, failed or timed out is a "DID NOT POST (<code>)" line in
 * the Spec, not an error; a PM that failed or timed out, an unusable Spec, an oversize Spec and an external item are
 * the outcomes `runSpecStep` already names. Nothing here swallows one.
 *
 * Known: a seat cut off at the round deadline had its run cancelled. When the Spec step re-enters the panel it sees a
 * cancelled keyed run and records the seat as `runner_failed`, not `timed_out`. Both are "DID NOT POST"; only the code
 * differs.
 */

/** How long one panel round waits for its seats. */
export const SEAT_ROUND_TIMEOUT_MS = 6 * 60_000;
/** How long the PM run may take. */
export const PM_TIMEOUT_MS = 10 * 60_000;
/**
 * How long the Spec step lets its re-entry of the panel wait. Every seat is already finished (the panel step ran
 * first), so this is only a bound on a seat somehow still live, not a budget.
 */
export const REPLAY_PANEL_TIMEOUT_MS = 90_000;
/** The function time limit a workflow step runs under (the 800 s the long-running routes use). */
export const STEP_LIMIT_MS = 800_000;

export type PanelForItemResult =
  | { status: "completed"; complete: boolean; missingRoles: string[]; round2Ran: boolean }
  | { status: "refused"; reason: string };

export interface SpecFlowOptions extends FollowedRunnerOptions {
  /** Panel step: the wait per round. Spec step: the wait for the panel re-entry. */
  roundTimeoutMs?: number;
  pmTimeoutMs?: number;
  /** The approval's id: names this attempt's PM run (see `SpecStepDeps.pmAttempt`). */
  attempt?: string;
}

export async function runPanelForItem(pool: Pool, accountId: string, workItemId: string, ports: AdvanceRunPorts, options: SpecFlowOptions = {}): Promise<PanelForItemResult> {
  const { panel } = createFollowedRunner(ports, options);
  const out = await runPanel({ pool, accountId, runner: panel, timeoutMs: options.roundTimeoutMs ?? SEAT_ROUND_TIMEOUT_MS }, { workItemId });
  if (out.status === "refused") return { status: "refused", reason: out.reason };
  return { status: "completed", complete: out.complete, missingRoles: [...out.missingRoles], round2Ran: out.round2Ran };
}

/** Plain data for the worker and the workflow: the pipeline's own status word, and the ids the next step needs. */
export interface SpecForItemResult {
  status: string;
  reason?: string;
  stage?: string;
  version?: number;
  replayed?: boolean;
}

export async function runSpecForItem(pool: Pool, accountId: string, workItemId: string, ports: AdvanceRunPorts, options: SpecFlowOptions = {}): Promise<SpecForItemResult> {
  const { panel, writer } = createFollowedRunner(ports, options);
  // No `trigger`: the build is a separate, human-approved step (the driver starts it from `spec_ready` on approval).
  const out = await runSpecStep(
    { pool, accountId, runner: panel, writer, timeoutMs: options.roundTimeoutMs ?? REPLAY_PANEL_TIMEOUT_MS, writerTimeoutMs: options.pmTimeoutMs ?? PM_TIMEOUT_MS, ...(options.attempt ? { pmAttempt: options.attempt } : {}) },
    { workItemId },
  );
  switch (out.status) {
    case "published":
      return { status: "published", stage: out.stage, version: out.version, replayed: out.replayed };
    case "refused":
      return { status: "refused", reason: out.reason };
    case "needs_owner_action":
      return { status: "needs_owner_action", reason: out.reason };
    case "external_requires_human":
      return { status: "external_requires_human" };
  }
}
