import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { recordDriverEvent, type WaitingStage } from "@fx/core/src/work-items/driverEvents.js";
import { checkHeadroom } from "@fx/spend";
import { reportError } from "@fx/telemetry";
import type { SeatRequest, SeatResult } from "./seat.js";
import type { AdvanceStartArgs } from "./advance.js";

/**
 * D#483 S5-k1b: the parked-stage sweep. One pass looks at every item whose start a spending limit denied for longer than its workflow waits, and starts the
 * stage again, with no person, once the limit allows it.
 *
 * What "parked" is. A start that a limit denies waits inside its workflow (asking every five minutes for four hours) and then the workflow ends
 * `<stage>_paused:<pause>`: not a failure, nothing stamped, the item where it was. Nothing records "parked". An item is parked when it sits at the stage's
 * position, is not halted, and its LATEST waiting fact names this stage and one of its pauses and is at least two asks old (a live workflow refreshes that fact
 * at every ask, so a fresh one means a workflow is still asking and this sweep leaves it alone). The list of such items is the cross-tenant definer
 * `work_item_list_parked_stage` (migration 0845); everything after it is read and decided under the item's own tenant.
 *
 * What one pass does with each listed item, in order, stopping at the first no:
 *   1. the stage's entry in the registry (apps/web hands the registry in; a stage with no entry is never listed here);
 *   2. the approval that started the stage is still the latest done `advance_work_item` request, its person is still an owner or admin, no newer request
 *      is waiting, no run of the item is live, and no Spec version was written after the approval (a changed Spec ends the parking: what is built is what was approved);
 *   3. the read-only headroom check, for the very reservation the restart will ask for (the seat the stage's role resolves to, and `checkHeadroom` of @fx/spend).
 *      A start that would still be denied by a limit writes NO run row: it refreshes the waiting fact (so the card keeps naming the limit for as long as it
 *      lasts) and nothing else. A denial that is not a pause (`account_not_active`) changes nothing;
 *   4. only when the answer is yes: a claim (one waiting fact per attempt per pass, so two passes at once start one workflow), then the workflow starts on the
 *      same approval at the next unused attempt, never the unsuffixed key.
 *
 * A pass that hits a failure on one item records it and goes on to the next; it never throws for one item.
 */

/** One stage's entry, as apps/web hands it in (the pipeline's registry; this package cannot import @fx/pipeline, so the shape is repeated and a test holds it equal). */
export interface ParkedStageEntryInput {
  stage: WaitingStage;
  itemStages: readonly string[];
  pauses: readonly string[];
  role: string;
  runKeyLike(workItemId: string, actionId: string): string;
  /** The next attempt number, given the idempotency keys of the stage's earlier runs for this approval (0 when there are none). */
  nextAttempt(keys: readonly string[]): number;
  /** A denial of the spend check as a pause name, or null when it is not one (the same mapping the start itself uses). */
  pauseForDenial(denial: string): string | null;
}

export interface StageResumeDeps {
  resolveRunSeat: (request: SeatRequest) => Promise<SeatResult>;
  startAdvance: ((args: AdvanceStartArgs) => Promise<void>) | null;
  now?: () => number;
  log?: (line: string) => void;
}

export interface StageResumeCounts {
  stages: number;
  listed: number;
  /** A limit still denies the start: the waiting fact was refreshed, no run row written. */
  refreshed: number;
  /** The workflow was started again. */
  resumed: number;
  /** Not resumed for a reason that is no failure (approval gone, Spec changed, a run is live, not a pause denial, claimed by another pass...). */
  skipped: number;
  failed: number;
}

/** Same value as RESERVATION_SWEEP_SECONDS and RESERVATION_ORPHAN_AFTER_SECONDS in @fx/pipeline (a test pins them). */
export const STAGE_RESUME_PASS_SECONDS = 900;
export const STAGE_RESUME_ORPHAN_AFTER_SECONDS = 600;
const LIST_LIMIT = 200;
/** Run statuses a run cannot leave (advance.ts ADVANCE_TERMINAL_STATUSES, which imports this file, so the list is repeated and a test holds the two equal). */
export const STAGE_RESUME_TERMINAL_STATUSES: readonly string[] = Object.freeze(["succeeded", "failed", "timed_out", "killed_spend", "refused_spend", "cancelled"]);
const SESSION_RE = /^session:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

type Plan = { userId: string; actionId: string; haltEpoch: number; specVersion: number; attempt: number };
type PlanOrSkip = { plan: Plan } | { skip: string };

export function createStageResume(runnerPool: Pool, deps: StageResumeDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));

  /** Everything the restart depends on, read under the item's own tenant. */
  async function planFor(entry: ParkedStageEntryInput, accountId: string, workItemId: string): Promise<PlanOrSkip> {
    return withTenant(runnerPool, accountId, async (client) => {
      const item = (
        await client.query<{ stage: string; provenance: string; halted: boolean; halt_epoch: number; version: number | null; spec_at: Date | null }>(
          `SELECT w.stage, w.provenance, w.halted_at IS NOT NULL AS halted, w.halt_epoch,
                  (SELECT max(s.version) FROM spec_versions s WHERE s.account_id = w.account_id AND s.work_item_id = w.id AND s.erased_at IS NULL) AS version,
                  (SELECT max(s.created_at) FROM spec_versions s WHERE s.account_id = w.account_id AND s.work_item_id = w.id) AS spec_at
             FROM work_items w WHERE w.id = $1 AND w.account_id = $2`,
          [workItemId, accountId],
        )
      ).rows[0];
      if (!item) return { skip: "item_gone" };
      if (item.halted) return { skip: "halted" };
      if (item.provenance !== "internal" || !entry.itemStages.includes(item.stage)) return { skip: "not_parked_here" };
      if (item.version === null || item.spec_at === null) return { skip: "no_spec" };

      // Any request of this kind that is still waiting to be performed means a person is acting right now: leave it to them.
      const open = await client.query("SELECT 1 FROM run_action_requests WHERE account_id = $1 AND target_id = $2 AND kind IN ('advance_work_item', 'respec_work_item') AND state IN ('accepted', 'claimed') LIMIT 1", [accountId, workItemId]);
      if (open.rows.length > 0) return { skip: "approval_in_flight" };
      const approval = (
        await client.query<{ id: string; requested_by: string; principal_kind: string; finished_at: Date }>(
          `SELECT id, requested_by, principal_kind, finished_at FROM run_action_requests
            WHERE account_id = $1 AND target_id = $2 AND kind = 'advance_work_item' AND state = 'done' AND outcome ->> 'advance' = 'started'
            ORDER BY finished_at DESC, id DESC LIMIT 1`,
          [accountId, workItemId],
        )
      ).rows[0];
      if (!approval) return { skip: "no_approval" };
      const who = SESSION_RE.exec(approval.requested_by);
      if (!who || approval.principal_kind !== "session") return { skip: "no_approval" };
      // The Spec the person approved is the newest one: one written after the approval was performed is a different Spec, and the person decides about it.
      if (item.spec_at.getTime() > approval.finished_at.getTime()) return { skip: "spec_changed" };
      const member = await client.query<{ role: string }>("SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2", [accountId, who[1]]);
      const role = member.rows[0]?.role;
      if (role !== "owner" && role !== "admin") return { skip: "approver_gone" };
      // A live workflow or run is working on the item: nothing to resume.
      const live = await client.query<{ n: string }>("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND NOT (status = ANY($3::text[]))", [accountId, workItemId, [...STAGE_RESUME_TERMINAL_STATUSES]]);
      if (Number(live.rows[0]?.n ?? 0) > 0) return { skip: "run_live" };

      // A restart that ended in a refusal that is not a limit (or a stop) left a newer fact than the waiting one: that is not this sweep's to retry every pass.
      // Only a new waiting fact (a later limit pause) or a person's new approval makes the item this sweep's again.
      const refusedAfterWait = await client.query(
        `SELECT 1 FROM work_item_driver_events e
          WHERE e.account_id = $1 AND e.work_item_id = $2 AND e.kind IN ('build_refused', 'stopped')
            AND e.seq > COALESCE((SELECT max(w.seq) FROM work_item_driver_events w WHERE w.account_id = $1 AND w.work_item_id = $2 AND w.kind IN ('stage_waiting', 'build_waiting')), 0)
          LIMIT 1`,
        [accountId, workItemId],
      );
      if (refusedAfterWait.rows.length > 0) return { skip: "refused_after_wait" };

      const keys = await client.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key LIKE $2 ESCAPE '\\'",
        [accountId, entry.runKeyLike(workItemId, approval.id)],
      );
      return { plan: { userId: who[1]!, actionId: approval.id, haltEpoch: item.halt_epoch, specVersion: Number(item.version), attempt: entry.nextAttempt(keys.rows.map((r) => r.idempotency_key)) } };
    });
  }

  /** One waiting fact on the item (a refresh, or the claim). Deduped by `key`; answers whether this call wrote it. */
  async function fact(entry: ParkedStageEntryInput, accountId: string, workItemId: string, pause: string, attempt: number, key: string): Promise<boolean> {
    return withTenant(runnerPool, accountId, async (client) => (await recordDriverEvent(client, accountId, { workItemId, kind: "stage_waiting", stage: entry.stage, code: pause, attempt, dedupeKey: key })).recorded);
  }

  async function sweepParkedStages(entries: readonly ParkedStageEntryInput[]): Promise<StageResumeCounts & { nextDueAt: number | null }> {
    const counts: StageResumeCounts = { stages: entries.length, listed: 0, refreshed: 0, resumed: 0, skipped: 0, failed: 0 };
    const bucket = Math.floor(now() / (STAGE_RESUME_PASS_SECONDS * 1000));
    for (const entry of entries) {
      let listed: { account_id: string; work_item_id: string; pause: string }[];
      try {
        listed = (
          await runnerPool.query<{ account_id: string; work_item_id: string; pause: string }>("SELECT account_id, work_item_id, pause FROM work_item_list_parked_stage($1, $2::text[], $3::text[], $4, $5)", [
            entry.stage,
            [...entry.itemStages],
            [...entry.pauses],
            STAGE_RESUME_ORPHAN_AFTER_SECONDS,
            LIST_LIMIT,
          ])
        ).rows;
      } catch (err) {
        counts.failed += 1;
        reportError(err, { stage: "advance.stage_resume_list" });
        log(JSON.stringify({ event: "stage_resume.list_failed", stage: entry.stage, code: (err as { code?: string }).code ?? "error" }));
        continue;
      }
      counts.listed += listed.length;
      for (const c of listed) {
        try {
          const planned = await planFor(entry, c.account_id, c.work_item_id);
          if ("skip" in planned) {
            counts.skipped += 1;
            log(JSON.stringify({ event: "stage_resume.skipped", stage: entry.stage, work_item_id: c.work_item_id, reason: planned.skip }));
            continue;
          }
          const { plan } = planned;
          const seat = await deps.resolveRunSeat({ accountId: c.account_id, role: entry.role, workItemId: c.work_item_id });
          if (!seat.ok) {
            counts.skipped += 1;
            log(JSON.stringify({ event: "stage_resume.skipped", stage: entry.stage, work_item_id: c.work_item_id, reason: `seat_${seat.reason}` }));
            continue;
          }
          const answer = await checkHeadroom(runnerPool, { accountId: c.account_id, ...seat.seat.spend });
          if (answer.decision === "deny") {
            const pause = entry.pauseForDenial(answer.reason);
            if (pause === null) {
              counts.skipped += 1;
              log(JSON.stringify({ event: "stage_resume.skipped", stage: entry.stage, work_item_id: c.work_item_id, reason: `not_a_pause_${answer.reason}` }));
              continue;
            }
            // Still denied: no run row. The fact is refreshed so the card keeps naming the limit (and the pause window, three passes, does not run out).
            await fact(entry, c.account_id, c.work_item_id, pause, plan.attempt, `sweep:${plan.actionId}:${bucket}`);
            counts.refreshed += 1;
            continue;
          }
          if (deps.startAdvance === null) {
            counts.skipped += 1;
            continue;
          }
          // The claim: one per attempt per pass, so two passes at once (or a retried cron) start one workflow. A later pass may claim the same attempt again if the
          // workflow never made a run row (nothing then counts it as used).
          const claimed = await fact(entry, c.account_id, c.work_item_id, c.pause, plan.attempt, `resume:${plan.actionId}:${plan.attempt}:${bucket}`);
          if (!claimed) {
            counts.skipped += 1;
            continue;
          }
          await deps.startAdvance({ accountId: c.account_id, userId: plan.userId, workItemId: c.work_item_id, actionId: plan.actionId, haltEpoch: plan.haltEpoch, specVersion: plan.specVersion, ...(plan.attempt > 0 ? { startAttempt: plan.attempt } : {}) });
          counts.resumed += 1;
          log(JSON.stringify({ event: "stage_resume.resumed", stage: entry.stage, work_item_id: c.work_item_id, attempt: plan.attempt }));
        } catch (err) {
          counts.failed += 1;
          reportError(err, { stage: "advance.stage_resume_item" });
          log(JSON.stringify({ event: "stage_resume.item_failed", stage: entry.stage, work_item_id: c.work_item_id, code: (err as { code?: string }).code ?? "error" }));
        }
      }
    }
    // Something is parked (or was just refreshed): look again in a pass. Otherwise the marker is cleared and the next writer sets it.
    return { ...counts, nextDueAt: counts.listed > 0 ? now() + STAGE_RESUME_PASS_SECONDS * 1000 : null };
  }

  return { sweepParkedStages };
}

export type StageResume = ReturnType<typeof createStageResume>;
