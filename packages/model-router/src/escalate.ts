import { MODEL_TIER_ORDER, tierRank } from './types.js';
import type { ModelId } from './types.js';
import { floorFor, meetsFloor } from './floors.js';

/** The run-status causes that trigger escalation. `killed_spend` is
 * deliberately excluded -- "spend kills do not escalate" (Spec H22). Any
 * other outcome (e.g. 'succeeded', 'cancelled') is also a no-op here. */
export type EscalationCause = 'fail' | 'timed_out' | 'needs-fix';

export interface PreviousRun {
  /** The role the previous (and next) run executes under -- required so
   * escalate() can enforce that role's security floor itself, rather than
   * relying on a caller to re-clamp its result afterwards (security fix
   * round: escalation used to bypass ROLE_FLOORS entirely). */
  role: string;
  model: ModelId;
  tableVersion: number;
  /** The run's own terminal status, when that's what triggers escalation. */
  runStatus?: 'fail' | 'timed_out' | 'killed_spend' | 'succeeded' | 'cancelled';
  /** The review verdict, when that's what triggers escalation. */
  reviewVerdict?: 'pass' | 'needs-fix';
}

export interface EscalationResult {
  model: ModelId;
  reason: string;
  tableVersion: number;
}

function causeFor(previousRun: PreviousRun): EscalationCause | null {
  if (previousRun.reviewVerdict === 'needs-fix') return 'needs-fix';
  if (previousRun.runStatus === 'fail') return 'fail';
  if (previousRun.runStatus === 'timed_out') return 'timed_out';
  return null;
}

/**
 * Escalation goes up exactly one tier: Haiku 4.5 -> Sonnet 5 -> Opus 5 ->
 * Opus 5 stays Opus 5 (Spec H22). Returns null when previousRun's outcome
 * does not trigger escalation (a spend kill, or any non-failing outcome).
 * `escalated_from_run_id` is set by the caller (H09/H09b), not here --
 * this function only knows the previous run's model and outcome, not its
 * id.
 *
 * Security fix round (CWE-20/CWE-693): `tierRank()` returns -1 for any
 * model string it doesn't recognize. Previously, `Math.min(-1 + 1, ...)`
 * resolved that straight to Haiku 4.5 -- for ANY unrecognized previous
 * model, including a floored role's. escalate() now throws instead of
 * silently treating an unknown model as the bottom tier, and clamps its
 * result with the same `meetsFloor`/`floorFor` logic route() uses, so a
 * floored role's run can never escalate to (or through) a model below its
 * floor.
 */
export function escalate(previousRun: PreviousRun): EscalationResult | null {
  const cause = causeFor(previousRun);
  if (cause === null) return null;

  const currentRank = tierRank(previousRun.model);
  if (currentRank === -1) {
    throw new Error(
      `escalate(): unknown model "${String(previousRun.model)}" -- refusing to guess a tier for role "${previousRun.role}"`,
    );
  }

  const nextRank = Math.min(currentRank + 1, MODEL_TIER_ORDER.length - 1);
  let model = MODEL_TIER_ORDER[nextRank] as ModelId;

  // Floors always win here too, exactly as in route() -- escalation must
  // never be a route around a role's security floor.
  if (!meetsFloor(previousRun.role, model)) {
    model = floorFor(previousRun.role) as ModelId;
  }

  return {
    model,
    reason: `escalated: ${cause}`,
    tableVersion: previousRun.tableVersion,
  };
}
