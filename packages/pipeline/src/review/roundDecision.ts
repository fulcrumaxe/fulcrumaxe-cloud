import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { checkFixRound, maxFixRounds } from "@fx/spend";
import type { ExecutionTargetRegistry } from "@fx/runner";
import { escalate } from "../build/fixLoop.js";
import { recordVerdictsInOrder, type GatheredVerdict, type RecordedVerdict, type VerdictRole } from "./verdicts.js";

/**
 * D#483 P3: one review round's verdicts recorded, and what the driver does next.
 *
 *   all_passed   every required role passed on this head: the merge gate is next.
 *   fix          at least one `needs-fix` (and no `fail`), and the item still has a fix round left: start one.
 *   escalated    the item has used its maxFixRounds(): it is now `needs_human` (the escalation event is emitted too).
 *   reviewer_fail  a reviewer said `fail` (wrong approach, or it could not review): no fix round is worth starting. The
 *                item stays at Changes requested and the driver stops, with the stop recorded.
 *   incomplete   a required role has no verdict (it could not be started): nothing is decided, the driver stops.
 *
 * Rounds are counted by the fix rounds that STARTED (the `fix_round_started` driver events), not by stage transitions:
 * two reviewers asking for changes on one head record two transitions but are ONE round. The fix loop's own transition
 * count is therefore not used here (`recordReviewVerdict` runs in its `deferred` mode).
 */

export type RoundDecision = "all_passed" | "fix" | "escalated" | "reviewer_fail" | "incomplete";

export interface RoundInput {
  accountId: string;
  workItemId: string;
  headSha: string;
  prNumber: number;
  /** Fix rounds already started for this item. Read from the driver events when absent (the driver does not pass it: it survives a restart). */
  round?: number;
  /** The roles whose verdicts the merge gate will require on this head. */
  requiredRoles: readonly VerdictRole[];
  verdicts: readonly GatheredVerdict[];
}

export interface RoundResult {
  decision: RoundDecision;
  /** Fix rounds already started when this decision was made. */
  round: number;
  recorded: RecordedVerdict[];
  /** The fix round this decision would start (1-based). Set for `fix`. */
  nextRound?: number;
}

/** Fix rounds started so far for one item (the driver events). */
export async function fixRoundsStarted(pool: Pool, accountId: string, workItemId: string): Promise<number> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'fix_round_started'", [accountId, workItemId]);
    return Number(rows[0]?.n ?? "0");
  });
}

/** The decision for gathered verdicts, with no database. Pure. */
export function decideRound(input: { requiredRoles: readonly VerdictRole[]; verdicts: readonly { role: VerdictRole; verdict: string }[]; fixRoundsStarted: number }): RoundDecision {
  const byRole = new Map(input.verdicts.map((v) => [v.role, v.verdict]));
  if (input.requiredRoles.some((r) => !byRole.has(r))) return "incomplete";
  const verdicts = input.requiredRoles.map((r) => byRole.get(r));
  if (verdicts.some((v) => v === "fail")) return "reviewer_fail";
  if (verdicts.some((v) => v !== "pass")) return checkFixRound(input.fixRoundsStarted + 1) === "escalate" ? "escalated" : "fix";
  return "all_passed";
}

export async function recordRound(pool: Pool, registry: ExecutionTargetRegistry, input: RoundInput): Promise<RoundResult> {
  const round = input.round ?? (await fixRoundsStarted(pool, input.accountId, input.workItemId));
  const decision = decideRound({ requiredRoles: input.requiredRoles, verdicts: input.verdicts, fixRoundsStarted: round });
  // Every verdict first, then the records: passes first, non-passes last (see verdicts.ts). An incomplete round records no pass.
  const { recorded } = await recordVerdictsInOrder(pool, registry, {
    accountId: input.accountId,
    workItemId: input.workItemId,
    headSha: input.headSha,
    prNumber: input.prNumber,
    round,
    verdicts: input.verdicts,
    skipPasses: decision === "incomplete",
  });

  if (decision === "escalated") {
    const runId = input.verdicts.find((v) => v.verdict !== "pass")!.runId;
    await withTenant(pool, input.accountId, async (client) => {
      await escalate(client, input.accountId, input.workItemId, runId, new Date());
      await recordDriverEvent(client, input.accountId, { workItemId: input.workItemId, kind: "escalated", dedupeKey: `max_fix_rounds:${input.headSha}`, code: "max_fix_rounds", headSha: input.headSha, prNumber: input.prNumber, round: Math.min(round, 20), runId });
    });
  } else if (decision === "reviewer_fail") {
    const runId = input.verdicts.find((v) => v.verdict === "fail")!.runId;
    await withTenant(pool, input.accountId, (client) =>
      recordDriverEvent(client, input.accountId, { workItemId: input.workItemId, kind: "escalated", dedupeKey: `reviewer_fail:${input.headSha}`, code: "reviewer_fail", headSha: input.headSha, prNumber: input.prNumber, round: Math.min(round, 20), runId }),
    );
  }
  return { decision, round, recorded, ...(decision === "fix" ? { nextRound: round + 1 } : {}) };
}

export { maxFixRounds };
