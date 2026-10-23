import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordDriverEvent, toCode } from "@fx/core/src/work-items/driverEvents.js";
import { checkFixRound, maxFixRounds } from "@fx/spend";
import type { ExecutionTargetRegistry } from "@fx/runner";
import { escalate } from "../build/fixLoop.js";
import type { CiGate, CiWaitReason } from "./ciWait.js";
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
 *   environment_failure  (D#598 P7d) a reviewer could not run the tests (its environment failed, not the code): NO verdict is recorded,
 *                no fix round starts, and the driver stops with the fact `reviewer_environment`. The same for every account.
 *   reviewer_no_verdict  a required reviewer's runs on this head kept ending without a verdict (killed at a memory limit, a lost runner, cancelled,
 *                out of time) and the driver's bounded re-runs are used up. Its `fail` is not a verdict: nothing is recorded for it, no fix round
 *                starts, and the item goes to Needs a person (`escalated`, code `reviewer_no_verdict`, reasons: the role and how its last run ended).
 *                Genuine non-passes of the other reviewers are still recorded (never their passes: the round is not complete).
 *   ci_pending   (D#598 P7b) the head's CI or a repo-wide guard is still running: NOTHING is recorded, not even a needs-fix.
 *                The driver waits and asks again with the same verdicts; the decision is made once CI has finished.
 *   head_moved   (D#598 P7b) the pull request's head is no longer the reviewed one: NOTHING is recorded. The driver reviews the new head.
 *
 * Rounds are counted by the fix rounds that STARTED (the `fix_round_started` driver events), not by stage transitions:
 * two reviewers asking for changes on one head record two transitions but are ONE round. The fix loop's own transition
 * count is therefore not used here (`recordReviewVerdict` runs in its `deferred` mode).
 */

export type RoundDecision = "all_passed" | "fix" | "escalated" | "reviewer_fail" | "reviewer_no_verdict" | "incomplete" | "ci_pending" | "head_moved" | "environment_failure";

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
  /** Why CI is not finished (fixed words). Set for `ci_pending` only. */
  ciReasons?: CiWaitReason[];
}

/** Fix rounds started so far for one item (the driver events). */
export async function fixRoundsStarted(pool: Pool, accountId: string, workItemId: string): Promise<number> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'fix_round_started'", [accountId, workItemId]);
    return Number(rows[0]?.n ?? "0");
  });
}

/** The decision for gathered verdicts, with no database. Pure. */
export function decideRound(input: { requiredRoles: readonly VerdictRole[]; verdicts: readonly { role: VerdictRole; verdict: string; environmentFailure?: boolean; noVerdict?: boolean }[]; fixRoundsStarted: number }): RoundDecision {
  // A reviewer that could not run the tests has said nothing about the code: it is never a needs-fix (so never a fix round) and never a pass.
  if (input.verdicts.some((v) => v.environmentFailure === true)) return "environment_failure";
  // Nor has a reviewer whose run ended without a verdict: its `fail` is not a judgment, so it is never a reviewer_fail and never a fix round.
  if (input.verdicts.some((v) => v.noVerdict === true && input.requiredRoles.includes(v.role))) return "reviewer_no_verdict";
  const byRole = new Map(input.verdicts.map((v) => [v.role, v.verdict]));
  if (input.requiredRoles.some((r) => !byRole.has(r))) return "incomplete";
  const verdicts = input.requiredRoles.map((r) => byRole.get(r));
  if (verdicts.some((v) => v === "fail")) return "reviewer_fail";
  if (verdicts.some((v) => v !== "pass")) return checkFixRound(input.fixRoundsStarted + 1) === "escalate" ? "escalated" : "fix";
  return "all_passed";
}

/**
 * `ci` is required, not optional: a caller that does not pass one cannot record a verdict, so the wait cannot be skipped by omission.
 * The gate is read BEFORE any write; if it throws, nothing is recorded and the caller's step retries.
 */
export async function recordRound(pool: Pool, registry: ExecutionTargetRegistry, input: RoundInput, ci: CiGate): Promise<RoundResult> {
  const round = input.round ?? (await fixRoundsStarted(pool, input.accountId, input.workItemId));
  const wait = await ci.read({ accountId: input.accountId, workItemId: input.workItemId, prNumber: input.prNumber, headSha: input.headSha });
  if (wait.state === "head_moved") return { decision: "head_moved", round, recorded: [] };
  if (wait.state === "pending") return { decision: "ci_pending", round, recorded: [], ciReasons: wait.reasons };
  const decision = decideRound({ requiredRoles: input.requiredRoles, verdicts: input.verdicts, fixRoundsStarted: round });
  if (decision === "environment_failure") {
    const failed = input.verdicts.filter((v) => v.environmentFailure === true);
    await withTenant(pool, input.accountId, (client) =>
      recordDriverEvent(client, input.accountId, {
        workItemId: input.workItemId,
        kind: "stopped",
        dedupeKey: `reviewer_environment:${input.headSha}`,
        code: "reviewer_environment",
        reasons: [...new Set(failed.map((v) => toCode(v.role)))].slice(0, 4),
        headSha: input.headSha,
        prNumber: input.prNumber,
        round: Math.min(round, 20),
        runId: failed[0]!.runId,
      }),
    );
    return { decision, round, recorded: [] };
  }
  // Every verdict first, then the records: passes first, non-passes last (see verdicts.ts). An incomplete round records no pass.
  const { recorded } = await recordVerdictsInOrder(pool, registry, {
    accountId: input.accountId,
    workItemId: input.workItemId,
    headSha: input.headSha,
    prNumber: input.prNumber,
    round,
    verdicts: input.verdicts,
    skipPasses: decision === "incomplete" || decision === "reviewer_no_verdict",
  });

  if (decision === "escalated") {
    const runId = input.verdicts.find((v) => v.verdict !== "pass")!.runId;
    await withTenant(pool, input.accountId, async (client) => {
      await escalate(client, input.accountId, input.workItemId, runId, new Date());
      await recordDriverEvent(client, input.accountId, { workItemId: input.workItemId, kind: "escalated", dedupeKey: `max_fix_rounds:${input.headSha}`, code: "max_fix_rounds", headSha: input.headSha, prNumber: input.prNumber, round: Math.min(round, 20), runId });
    });
  } else if (decision === "reviewer_no_verdict") {
    const missing = input.verdicts.filter((v) => v.noVerdict === true && input.requiredRoles.includes(v.role));
    const runId = missing[0]!.runId;
    // reasons: per reviewer its role, then how its last run ended (`code_reviewer`, `resource_limit`), so the activity can say which one and why.
    const reasons = missing.flatMap((v) => [toCode(v.role), toCode(v.endCode ?? "no_verdict")]).slice(0, 8);
    await withTenant(pool, input.accountId, async (client) => {
      // A person's Approve at Needs a person reviews the pull request again; if the reviewer gives up again the item is already there, and Needs a person has
      // no edge to itself. Only the escalation event is new (it also restarts the re-run bound's count, see advanceReviewRuns).
      const at = await client.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1 AND account_id = $2", [input.workItemId, input.accountId]);
      if (at.rows[0]?.stage !== "needs_human") await escalate(client, input.accountId, input.workItemId, runId, new Date());
      await recordDriverEvent(client, input.accountId, { workItemId: input.workItemId, kind: "escalated", dedupeKey: `reviewer_no_verdict:${input.headSha}:${runId}`, code: "reviewer_no_verdict", reasons, headSha: input.headSha, prNumber: input.prNumber, round: Math.min(round, 20), runId });
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
