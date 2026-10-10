import type { Pool } from "pg";
import type { ReportContext } from "@fx/telemetry";

/**
 * D#597 CC-8: the deterministic invariant sweep. Three rules over the platform's own rows catch a defect within about a minute, with no model
 * and no text: a rule that fires writes one alert (ours) and one fixed-code fact on the item (migration 0776), once per (rule, run).
 *
 *  - `stage_not_moved`:   an executor run succeeded with a pull request, yet its item is still in progress after the grace period;
 *  - `no_activity`:       a finished runner run has no activity row. Off until C42-1 is deployed (`I2_ENABLED`): before it, every runner run fires;
 *  - `usage_not_recorded`: the runner reported tokens, yet no usage row holds any for the run.
 *
 * One database function per rule, one statement each (find, record, answer the new alerts only), so a sweep is at most three queries. The rules
 * read only the platform's rows, so this file and everything it imports stay free of any model call (an import-graph test holds that).
 * Cross-tenant by design: it runs over the run-writer login, whose EXECUTE on the functions is the only way in.
 */

/** The rule switched on once C42-1 (the runner's activity ingest) is deployed. Flip it in the PR that deploys C42-1. */
export const I2_ENABLED = false;

/** A run must have been over this long before a rule may fire: the webhook normally moves a stage within seconds. With a 30 s pass, a defect is flagged within 60 s. */
export const GRACE_SECONDS = 30;
/** Runs that ended longer ago than this are no longer looked at (the alert, once raised, stays). */
export const WINDOW_SECONDS = 24 * 3600;
export const HIT_LIMIT = 100;

export const INVARIANTS = [
  { code: "stage_not_moved", fn: "platform_invariant_stage_not_moved", alert: "invariant_stage_not_moved", enabled: () => true },
  { code: "no_activity", fn: "platform_invariant_no_activity", alert: "invariant_no_activity", enabled: (on: { i2: boolean }) => on.i2 },
  { code: "usage_not_recorded", fn: "platform_invariant_usage_not_recorded", alert: "invariant_usage_not_recorded", enabled: () => true },
] as const;

export interface InvariantSweepResult {
  /** Rules that ran. */
  checked: number;
  /** New alerts raised in this sweep, per rule code. */
  raised: Record<string, number>;
  failed: number;
}

export interface InvariantSweepDeps {
  /** The run-writer login's pool. */
  pool: Pool;
  /** A coded error report: the code is one of OWN_ERROR_CODES, the error carries no text. */
  report: (err: unknown, ctx: ReportContext) => void;
  warn: (line: string) => void;
  i2Enabled?: boolean;
  graceSeconds?: number;
  windowSeconds?: number;
  limit?: number;
}

export interface InvariantSweeper {
  /** One sweep. For the cron only: it works across tenants. */
  sweepInvariants(): Promise<InvariantSweepResult>;
}

export async function sweepInvariants(deps: InvariantSweepDeps): Promise<InvariantSweepResult> {
  const on = { i2: deps.i2Enabled ?? I2_ENABLED };
  const out: InvariantSweepResult = { checked: 0, raised: {}, failed: 0 };
  for (const rule of INVARIANTS) {
    if (!rule.enabled(on)) continue;
    out.checked++;
    out.raised[rule.code] = 0;
    try {
      const { rows } = await deps.pool.query<{ account_id: string; work_item_id: string | null; run_id: string }>(
        `SELECT account_id, work_item_id, run_id FROM ${rule.fn}($1::int, $2::int, $3::int)`,
        [deps.limit ?? HIT_LIMIT, deps.graceSeconds ?? GRACE_SECONDS, deps.windowSeconds ?? WINDOW_SECONDS],
      );
      for (const row of rows) {
        out.raised[rule.code]!++;
        // Ids and the rule's name only: a fresh error, never text from a row.
        deps.warn(JSON.stringify({ event: "platform.invariant", invariant: rule.code, run_id: row.run_id, work_item_id: row.work_item_id }));
        deps.report(new Error("platform invariant"), { stage: "platform.invariant", code: rule.alert });
      }
    } catch {
      // fx-swallow-ok: counted as failed and logged as a fixed line (never the error's text); the other rules still run and the next sweep looks again
      out.failed++;
      deps.warn(JSON.stringify({ event: "platform.invariant_failed", invariant: rule.code }));
    }
  }
  return out;
}
