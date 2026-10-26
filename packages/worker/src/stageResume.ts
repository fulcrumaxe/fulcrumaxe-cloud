import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { recordDriverEvent, type WaitingStage } from "@fx/core/src/work-items/driverEvents.js";
import { checkHeadroom } from "@fx/spend";
import { readReviewHold } from "@fx/core/src/work-items/reviewHold.js";
import { reportError } from "@fx/telemetry";
import type { SeatRequest, SeatResult } from "./seat.js";
import type { AdvanceStartArgs } from "./advance.js";
import { compareQueueOrder } from "@fx/core/src/work-items/queueOrder.js";
import { toQueueRank } from "@fx/core/src/work-items/priority.js";

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
 *   2. the approval that started the stage (the entry says its kind, and whether it may sit on the card this one replaced) is still the latest done request of that
 *      kind, its person is still an owner or admin, no newer request is waiting, no run of the item is live, and (for a stage that builds on a Spec) no Spec version was
 *      written after the approval (a changed Spec ends the parking: what runs is what was approved). Every earlier run of the stage must have ended `refused_spend`: a
 *      run that really started means the stage was allowed once, and what it came to is the workflow's own outcome, not something to start again every pass;
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
  /** The approval the restart runs under: its kind, and whether one on the card this one replaced counts (the pipeline's card for an issue replaces the webhook's). */
  approval: { kind: "advance_work_item" | "respec_work_item"; from: "self" | "origin" };
  /** The stage builds on a published Spec: the item needs one, and one written after the approval ends the parking. */
  needsSpec: boolean;
  /** The restarted workflow is a re-spec. */
  respec: boolean;
  /** The SQL LIKE patterns (default backslash escape) of the idempotency keys of the stage's runs for one item and approval (a head-bound stage: for the head its wait was for). */
  runKeyLikes(workItemId: string, actionId: string, headSha?: string | null): string[];
  /** D#483 S5-k1d: the stage waits on one head of an open change; the sweep resumes only while that head is still the head. Absent: not head-bound. */
  headBound?: boolean;
  /** D#483 S5-k1d: runs of the stage that really started are expected beside the denied ones (a review with several reviewers); not read as "the stage already ran". */
  startedRunsOk?: boolean;
  /** D#483 S5-k1d: the facts that, written after the latest waiting fact, end the sweep's claim on the item. Absent: `build_refused` and `stopped`. */
  progressKinds?: readonly string[];
  /** D#483 S5-k1e: begin above the attempts the workflow wrote on its own waiting facts too, not only above the run keys (the panel's asks leave facts and no run row). */
  attemptAfterFacts?: boolean;
  /** The next attempt number, given the idempotency keys of the stage's earlier runs for this approval (0 when there are none). */
  nextAttempt(keys: readonly string[]): number;
  /** A denial of the spend check as a pause name, or null when it is not one (the same mapping the start itself uses). */
  pauseForDenial(denial: string): string | null;
}

/**
 * The waits that mean "no build slot yet" (packages/pipeline buildSlots.ts BUILD_WAIT_REASONS; a test holds the two lists equal).
 * A build waits for a slot inside its workflow for at most four hours; this is the wake for the case where that workflow is gone when the slot frees.
 */
export const SLOT_WAIT_REASONS: readonly string[] = Object.freeze(["one_build_per_repo_until_d598", "waiting_for_build_slot_repo", "waiting_for_build_slot_account"]);

export interface StageResumeDeps {
  resolveRunSeat: (request: SeatRequest) => Promise<SeatResult>;
  /**
   * The pipeline's `readBuildWaitReason`: the reason an item's build would still wait for a slot right now, or null (it would get one). Absent: the slot wake is off.
   */
  buildWaitReason?: ((accountId: string, workItemId: string) => Promise<string | null>) | null;
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
  /** The slot wake: orphaned waiters listed, and workflows it started (at most one per repository per pass). */
  slotListed?: number;
  slotStarted?: number;
}

/** Same value as RESERVATION_SWEEP_SECONDS and RESERVATION_ORPHAN_AFTER_SECONDS in @fx/pipeline (a test pins them). */
export const STAGE_RESUME_PASS_SECONDS = 900;
export const STAGE_RESUME_ORPHAN_AFTER_SECONDS = 600;
const LIST_LIMIT = 200;
/** Run statuses a run cannot leave (advance.ts ADVANCE_TERMINAL_STATUSES, which imports this file, so the list is repeated and a test holds the two equal). */
export const STAGE_RESUME_TERMINAL_STATUSES: readonly string[] = Object.freeze(["succeeded", "failed", "timed_out", "killed_spend", "refused_spend", "cancelled"]);
const SESSION_RE = /^session:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

type Plan = { userId: string; actionId: string; haltEpoch: number; specVersion: number | null; attempt: number; head: { sha: string; prNumber: number | null; rereview: number } | null };
/** What a stage that has no `progressKinds` of its own treats as "it ended in a refusal that is not a limit". */
const DEFAULT_PROGRESS_KINDS: readonly string[] = Object.freeze(["build_refused", "stopped"]);
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
      // A review re-entered from Needs a person parks there. Only an item still held for a missing verdict is that review: any other cause of Needs a person is a build to
      // run again, and the workflow would start that instead of the review the old waiting fact was for.
      if (entry.stage === "review" && item.stage === "needs_human" && !(await readReviewHold(client, workItemId))) return { skip: "not_parked_here" };
      if (entry.needsSpec && (item.version === null || item.spec_at === null)) return { skip: "no_spec" };

      // The cards an approval of this stage may sit on: the item itself and, where the entry says so, the card this one replaced (retired with `superseded:<this item>`).
      const targets = [workItemId];
      if (entry.approval.from === "origin") {
        const origin = await client.query<{ work_item_id: string }>("SELECT DISTINCT work_item_id FROM work_item_transitions WHERE account_id = $1 AND to_stage = 'closed' AND source_ref = $2", [accountId, `superseded:${workItemId}`]);
        targets.push(...origin.rows.map((r) => r.work_item_id));
      }
      // Any request of this kind that is still waiting to be performed means a person is acting right now: leave it to them.
      const open = await client.query("SELECT 1 FROM run_action_requests WHERE account_id = $1 AND target_id = ANY($2::uuid[]) AND kind IN ('advance_work_item', 'respec_work_item') AND state IN ('accepted', 'claimed') LIMIT 1", [accountId, targets]);
      if (open.rows.length > 0) return { skip: "approval_in_flight" };
      const approval = (
        await client.query<{ id: string; requested_by: string; principal_kind: string; finished_at: Date }>(
          `SELECT id, requested_by, principal_kind, finished_at FROM run_action_requests
            WHERE account_id = $1 AND target_id = ANY($2::uuid[]) AND kind = $3 AND state = 'done' AND outcome ->> 'advance' = 'started'
            ORDER BY finished_at DESC, id DESC LIMIT 1`,
          [accountId, targets, entry.approval.kind],
        )
      ).rows[0];
      if (!approval) return { skip: "no_approval" };
      const who = SESSION_RE.exec(approval.requested_by);
      if (!who || approval.principal_kind !== "session") return { skip: "no_approval" };
      // The Spec the person approved is the newest one: one written after the approval was performed is a different Spec, and the person decides about it.
      if (entry.needsSpec && item.spec_at !== null && item.spec_at.getTime() > approval.finished_at.getTime()) return { skip: "spec_changed" };
      const member = await client.query<{ role: string }>("SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2", [accountId, who[1]]);
      const role = member.rows[0]?.role;
      if (role !== "owner" && role !== "admin") return { skip: "approver_gone" };
      // A live workflow or run is working on the item: nothing to resume.
      const live = await client.query<{ n: string }>("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND NOT (status = ANY($3::text[]))", [accountId, workItemId, [...STAGE_RESUME_TERMINAL_STATUSES]]);
      if (Number(live.rows[0]?.n ?? 0) > 0) return { skip: "run_live" };

      // A restart that ended in a refusal that is not a limit (or a stop) left a newer fact than the waiting one: that is not this sweep's to retry every pass.
      // Only a new waiting fact (a later limit pause) or a person's new approval makes the item this sweep's again. A review or a fix round also leaves its own
      // progress facts (the reviewers started, a verdict, a fix round), and any of them after the wait means the stage has moved on.
      const refusedAfterWait = await client.query(
        `SELECT 1 FROM work_item_driver_events e
          WHERE e.account_id = $1 AND e.work_item_id = $2 AND e.kind = ANY($3::text[])
            AND e.seq > COALESCE((SELECT max(w.seq) FROM work_item_driver_events w WHERE w.account_id = $1 AND w.work_item_id = $2 AND w.kind IN ('stage_waiting', 'build_waiting')), 0)
          LIMIT 1`,
        [accountId, workItemId, [...(entry.progressKinds ?? DEFAULT_PROGRESS_KINDS)]],
      );
      if (refusedAfterWait.rows.length > 0) return { skip: entry.progressKinds === undefined ? "refused_after_wait" : "moved_on_after_wait" };

      // A stage that waits on one head of an open change resumes only for that head. The head, the pull request and the re-review round are on the waiting fact
      // (the workflow and every refresh write them); a push seen since the wait began, to a different head, ends the parking: the review of a new head is a new ask.
      let head: Plan["head"] = null;
      if (entry.headBound === true) {
        const latest = (
          await client.query<{ head_sha: string | null; pr_number: number | null; round: number | null }>(
            "SELECT head_sha, pr_number, round FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind IN ('stage_waiting', 'build_waiting') ORDER BY seq DESC LIMIT 1",
            [accountId, workItemId],
          )
        ).rows[0];
        if (!latest || latest.head_sha === null) return { skip: "no_head" };
        const moved = await client.query(
          `SELECT 1 FROM work_item_driver_events p
            WHERE p.account_id = $1 AND p.work_item_id = $2 AND p.kind = 'pr_head_pushed' AND p.head_sha IS DISTINCT FROM $3
              AND p.seq > COALESCE((SELECT min(w.seq) FROM work_item_driver_events w WHERE w.account_id = $1 AND w.work_item_id = $2 AND w.kind = 'stage_waiting' AND w.stage = $4 AND w.head_sha = $3), 0)
            LIMIT 1`,
          [accountId, workItemId, latest.head_sha, entry.stage],
        );
        if (moved.rows.length > 0) return { skip: "head_moved" };
        head = { sha: latest.head_sha, prNumber: latest.pr_number, rereview: latest.round ?? 0 };
      }

      const keys = await client.query<{ idempotency_key: string; status: string | null }>(
        `SELECT k.idempotency_key, r.status FROM agent_run_idempotency_keys k LEFT JOIN agent_runs r ON r.account_id = k.account_id AND r.id = k.run_id
          WHERE k.account_id = $1 AND k.idempotency_key LIKE ANY($2::text[])`,
        [accountId, entry.runKeyLikes(workItemId, approval.id, head?.sha ?? null)],
      );
      // A run of this stage that really started (it did not end `refused_spend`) means the stage was allowed once: what came of it is the workflow's own outcome.
      // (A review starts several reviewers; a started one beside a denied one is the normal partial start, and the restart finds it by its key.)
      if (entry.startedRunsOk !== true && keys.rows.some((r) => r.status !== "refused_spend")) return { skip: "stage_already_ran" };
      let attempt = entry.nextAttempt(keys.rows.map((r) => r.idempotency_key));
      if (entry.attemptAfterFacts === true) {
        // Only the facts the workflow wrote (`wait:...`); the sweep's own refreshes and claims are not counted, so a pass does not move the number it will use.
        const written = await client.query<{ top: number | null }>(
          "SELECT max(attempt) AS top FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'stage_waiting' AND stage = $3 AND dedupe_key LIKE 'wait:%'",
          [accountId, workItemId, entry.stage],
        );
        const top = written.rows[0]?.top;
        if (top !== null && top !== undefined) attempt = Math.max(attempt, Number(top) + 1);
      }
      return { plan: { userId: who[1]!, actionId: approval.id, haltEpoch: item.halt_epoch, specVersion: item.version === null ? null : Number(item.version), attempt, head } };
    });
  }

  /** One waiting fact on the item (a refresh, or the claim). Deduped by `key`; answers whether this call wrote it. */
  async function fact(entry: ParkedStageEntryInput, accountId: string, workItemId: string, pause: string, attempt: number, key: string, head: Plan["head"] = null): Promise<boolean> {
    // A head-bound stage's refresh and claim carry the head, the pull request and the re-review round the wait was for, so the next pass reads the same wait.
    const onHead = head === null ? {} : { headSha: head.sha, ...(head.prNumber !== null ? { prNumber: head.prNumber } : {}), round: head.rereview };
    return withTenant(runnerPool, accountId, async (client) => (await recordDriverEvent(client, accountId, { workItemId, kind: "stage_waiting", stage: entry.stage, code: pause, attempt, dedupeKey: key, ...onHead })).recorded);
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
            await fact(entry, c.account_id, c.work_item_id, pause, plan.attempt, `sweep:${plan.actionId}:${bucket}`, plan.head);
            counts.refreshed += 1;
            continue;
          }
          if (deps.startAdvance === null) {
            counts.skipped += 1;
            continue;
          }
          // The claim: one per attempt per pass, so two passes at once (or a retried cron) start one workflow. A later pass may claim the same attempt again if the
          // workflow never made a run row (nothing then counts it as used).
          const claimed = await fact(entry, c.account_id, c.work_item_id, c.pause, plan.attempt, `resume:${plan.actionId}:${plan.attempt}:${bucket}`, plan.head);
          if (!claimed) {
            counts.skipped += 1;
            continue;
          }
          await deps.startAdvance({
            accountId: c.account_id,
            userId: plan.userId,
            workItemId: c.work_item_id,
            actionId: plan.actionId,
            haltEpoch: plan.haltEpoch,
            ...(entry.needsSpec ? { specVersion: plan.specVersion } : {}),
            ...(entry.respec ? { respec: true } : {}),
            ...(plan.attempt > 0 ? { startAttempt: plan.attempt } : {}),
            ...(plan.head !== null && plan.head.rereview > 0 ? { startRereview: plan.head.rereview } : {}),
          });
          counts.resumed += 1;
          log(JSON.stringify({ event: "stage_resume.resumed", stage: entry.stage, work_item_id: c.work_item_id, attempt: plan.attempt }));
        } catch (err) {
          counts.failed += 1;
          reportError(err, { stage: "advance.stage_resume_item" });
          log(JSON.stringify({ event: "stage_resume.item_failed", stage: entry.stage, work_item_id: c.work_item_id, code: (err as { code?: string }).code ?? "error" }));
        }
      }
    }
    // The slot wake runs on the same tick but never schedules another one (see sweepSlotWaiters).
    for (const entry of entries) {
      if (entry.stage !== "build") continue;
      const slots = await sweepSlotWaiters(entry);
      counts.slotListed = slots.listed;
      counts.slotStarted = slots.started;
      counts.failed += slots.failed;
    }
    // Something is parked (or was just refreshed): look again in a pass. Otherwise the marker is cleared and the next writer sets it.
    return { ...counts, nextDueAt: counts.listed > 0 ? now() + STAGE_RESUME_PASS_SECONDS * 1000 : null };
  }

  /**
   * The slot wake. A build waits for a free slot inside its workflow (asking every minute for four hours). When that workflow is gone, nothing asks any more
   * and the item sits at Spec ready after its slot freed. This pass runs when a slot frees (recordStage marks the sweep pending) and starts the build of the
   * OLDEST orphaned waiter of each repository, once, under the approval it already has. An orphaned waiter is an item at Spec ready, not halted, whose latest
   * waiting fact is a slot reason at least STAGE_RESUME_ORPHAN_AFTER_SECONDS old (a live workflow refreshes it every minute). Everything `planFor` demands still
   * holds (a performed approval by an owner or admin, the Spec as approved, no live run, no refusal since): an item that needs a person's approval is left as it is.
   * It schedules no pass of its own: a pass that finds the slot still held leaves the waiters for the next slot that frees.
   */
  async function sweepSlotWaiters(entry: ParkedStageEntryInput): Promise<{ listed: number; started: number; failed: number }> {
    const out = { listed: 0, started: 0, failed: 0 };
    if (entry.stage !== "build" || !deps.buildWaitReason || deps.startAdvance === null) return out;
    const wait = deps.buildWaitReason;
    const bucket = Math.floor(now() / (STAGE_RESUME_PASS_SECONDS * 1000));
    let listed: { account_id: string; work_item_id: string; pause: string }[];
    try {
      listed = (await runnerPool.query<{ account_id: string; work_item_id: string; pause: string }>("SELECT account_id, work_item_id, pause FROM work_item_list_parked_stage($1, $2::text[], $3::text[], $4, $5)", [entry.stage, [...entry.itemStages], [...SLOT_WAIT_REASONS], STAGE_RESUME_ORPHAN_AFTER_SECONDS, LIST_LIMIT])).rows;
    } catch (err) {
      out.failed += 1;
      reportError(err, { stage: "advance.slot_wake_list" });
      log(JSON.stringify({ event: "slot_wake.list_failed", code: (err as { code?: string }).code ?? "error" }));
      return out;
    }
    out.listed = listed.length;
    // Queue order inside a repository: the first item of the queue takes the slot.
    const keyed: { c: (typeof listed)[number]; repoId: string | null; key: { id: string; priority: number; queueRank: number | bigint | null; createdAt: Date } }[] = [];
    for (const c of listed) {
      try {
        const row = (
          await withTenant(runnerPool, c.account_id, (client) =>
            client.query<{ repo_id: string | null; priority: number; queue_rank: string | null; created_at: Date }>("SELECT repo_id, priority, queue_rank, created_at FROM work_items WHERE id = $1 AND account_id = $2", [c.work_item_id, c.account_id]),
          )
        ).rows[0];
        if (row) keyed.push({ c, repoId: row.repo_id, key: { id: c.work_item_id, priority: row.priority, queueRank: toQueueRank(row.queue_rank), createdAt: row.created_at } });
      } catch (err) {
        out.failed += 1;
        reportError(err, { stage: "advance.slot_wake_item" });
      }
    }
    keyed.sort((x, y) => compareQueueOrder(x.key, y.key));
    const startedRepos = new Set<string>();
    for (const { c, repoId } of keyed) {
      try {
        if (repoId !== null && startedRepos.has(`${c.account_id}:${repoId}`)) continue;
        const planned = await planFor(entry, c.account_id, c.work_item_id);
        if ("skip" in planned) {
          log(JSON.stringify({ event: "slot_wake.skipped", work_item_id: c.work_item_id, reason: planned.skip }));
          continue;
        }
        // Still no slot for it (held, or a better-ordered waiter is alive): the next slot that frees looks again.
        if ((await wait(c.account_id, c.work_item_id)) !== null) continue;
        const { plan } = planned;
        const claimed = await fact(entry, c.account_id, c.work_item_id, c.pause, plan.attempt, `slotwake:${plan.actionId}:${plan.attempt}:${bucket}`, plan.head);
        if (!claimed) continue;
        await deps.startAdvance({
          accountId: c.account_id,
          userId: plan.userId,
          workItemId: c.work_item_id,
          actionId: plan.actionId,
          haltEpoch: plan.haltEpoch,
          specVersion: plan.specVersion,
          ...(plan.attempt > 0 ? { startAttempt: plan.attempt } : {}),
        });
        if (repoId !== null) startedRepos.add(`${c.account_id}:${repoId}`);
        out.started += 1;
        log(JSON.stringify({ event: "slot_wake.started", work_item_id: c.work_item_id, attempt: plan.attempt }));
      } catch (err) {
        out.failed += 1;
        reportError(err, { stage: "advance.slot_wake_item" });
        log(JSON.stringify({ event: "slot_wake.item_failed", work_item_id: c.work_item_id, code: (err as { code?: string }).code ?? "error" }));
      }
    }
    return out;
  }

  return { sweepParkedStages, sweepSlotWaiters };
}

export type StageResume = ReturnType<typeof createStageResume>;
