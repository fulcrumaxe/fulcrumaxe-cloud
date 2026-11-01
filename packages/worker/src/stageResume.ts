import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { recordDriverEvent, type WaitingStage } from "@fx/core/src/work-items/driverEvents.js";
import { checkHeadroom } from "@fx/spend";
import { STAGE_TERMINAL_STATUSES, stageApprovalGate } from "@fx/core/src/work-items/stageApprovalGate.js";
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
  /** The slot wake also lists these stages, for a planned PR child only (@fx/core's `StageGateEntry.childItemStages`). */
  childItemStages?: readonly string[];
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

/** What the slot wake reports: the counts, and when to look once more (see `sweepSlotWaiters`), or null. */
type SlotWakeCounts = { listed: number; started: number; failed: number; recheckAt: number | null };

/** Same value as RESERVATION_SWEEP_SECONDS and RESERVATION_ORPHAN_AFTER_SECONDS in @fx/pipeline (a test pins them). */
export const STAGE_RESUME_PASS_SECONDS = 900;
export const STAGE_RESUME_ORPHAN_AFTER_SECONDS = 600;
/**
 * A review parked for the runner's daily run limit (the pause code the review start answers; apps/web and @fx/pipeline's `RUNNER_DAILY_LIMIT_PAUSE` repeat it and a
 * test holds them equal). It is resumed by the clock: once a UTC midnight has passed since the wait the workflow itself recorded. The spend headroom is not read for it.
 */
export const RUNNER_DAILY_LIMIT_WAIT = "runner_daily_limit";
/** D#483 S5-k3b-2b: the parked capacity wait (packages/pipeline reservationPauses.ts CAPACITY_WAIT; a test holds the two equal). */
export const CAPACITY_WAIT = "waiting_for_capacity";
const LIST_LIMIT = 200;
/** Run statuses a run cannot leave (advance.ts ADVANCE_TERMINAL_STATUSES repeats the list and a test holds the two equal). */
export const STAGE_RESUME_TERMINAL_STATUSES: readonly string[] = STAGE_TERMINAL_STATUSES;

type Plan = { userId: string; actionId: string; haltEpoch: number; specVersion: number | null; attempt: number; head: { sha: string; prNumber: number | null; rereview: number } | null };
type PlanOrSkip = { plan: Plan } | { skip: string };

export function createStageResume(runnerPool: Pool, deps: StageResumeDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));

  /** Everything the restart depends on, read under the item's own tenant. The decision is @fx/core's `stageApprovalGate`, which the build card's sentence calls too. */
  async function planFor(entry: ParkedStageEntryInput, accountId: string, workItemId: string): Promise<PlanOrSkip> {
    return withTenant(runnerPool, accountId, async (client) => {
      // A stage that waits on one head of an open change resumes only for that head. The head, the pull request and the re-review round are on the waiting fact
      // (the workflow and every refresh write them); a push seen since the wait began, to a different head, ends the parking: the review of a new head is a new ask.
      const readHead =
        entry.headBound !== true
          ? undefined
          : async (): Promise<{ skip: string } | { head: NonNullable<Plan["head"]> }> => {
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
              return { head: { sha: latest.head_sha, prNumber: latest.pr_number, rereview: latest.round ?? 0 } };
            };
      const gate = await stageApprovalGate(client, accountId, workItemId, entry, readHead);
      if ("skip" in gate) return gate;
      let attempt = entry.nextAttempt(gate.keys);
      if (entry.attemptAfterFacts === true) {
        // Only the facts the workflow wrote (`wait:...`); the sweep's own refreshes and claims are not counted, so a pass does not move the number it will use.
        const written = await client.query<{ top: number | null }>(
          "SELECT max(attempt) AS top FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'stage_waiting' AND stage = $3 AND dedupe_key LIKE 'wait:%'",
          [accountId, workItemId, entry.stage],
        );
        const top = written.rows[0]?.top;
        if (top !== null && top !== undefined) attempt = Math.max(attempt, Number(top) + 1);
      }
      return { plan: { userId: gate.approval.userId, actionId: gate.approval.id, haltEpoch: gate.haltEpoch, specVersion: gate.specVersion, attempt, head: gate.head } };
    });
  }

  /** Whether a UTC midnight has passed since the newest wait the workflow itself recorded for this stage (`wait:` keys), by the clock the sweep was given. */
  async function runnerLimitReset(entry: ParkedStageEntryInput, accountId: string, workItemId: string): Promise<boolean> {
    const at = await withTenant(runnerPool, accountId, async (client) => {
      const r = await client.query<{ at: Date | null }>(
        "SELECT max(created_at) AS at FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'stage_waiting' AND stage = $3 AND code = $4 AND dedupe_key LIKE 'wait:%'",
        [accountId, workItemId, entry.stage, RUNNER_DAILY_LIMIT_WAIT],
      );
      return r.rows[0]?.at ?? null;
    });
    if (at === null) return false;
    const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
    return next <= now();
  }

  /** One waiting fact on the item (a refresh, or the claim). Deduped by `key`; answers whether this call wrote it. */
  async function fact(entry: ParkedStageEntryInput, accountId: string, workItemId: string, pause: string, attempt: number, key: string, head: Plan["head"] = null): Promise<boolean> {
    // A head-bound stage's refresh and claim carry the head, the pull request and the re-review round the wait was for, so the next pass reads the same wait.
    const onHead = head === null ? {} : { headSha: head.sha, ...(head.prNumber !== null ? { prNumber: head.prNumber } : {}), round: head.rereview };
    return withTenant(runnerPool, accountId, async (client) => (await recordDriverEvent(client, accountId, { workItemId, kind: "stage_waiting", stage: entry.stage, code: pause, attempt, dedupeKey: key, ...onHead })).recorded);
  }

  /**
   * Whether the limit that parked an item no longer holds, counting a pass that decides "not yet" (a refresh, or a skip) in `counts`.
   * The runner's daily limit is resumed by the clock only: before the reset the fact is refreshed (the card keeps saying so), after it the claim below starts the review.
   * The reset is read from the wait the WORKFLOW recorded, not from this sweep's own refreshes or claims, so a claim never pushes the next resume a day out.
   * Every spend pause is resumed by the read-only headroom check for the very reservation the restart will ask for.
   */
  async function mayResume(entry: ParkedStageEntryInput, c: { account_id: string; work_item_id: string; pause: string }, plan: Plan, bucket: number, counts: StageResumeCounts): Promise<boolean> {
    if (c.pause === RUNNER_DAILY_LIMIT_WAIT) {
      if (await runnerLimitReset(entry, c.account_id, c.work_item_id)) return true;
      await fact(entry, c.account_id, c.work_item_id, c.pause, plan.attempt, `sweep:${plan.actionId}:${bucket}`, plan.head);
      counts.refreshed += 1;
      return false;
    }
    // D#483 S5-k3b-2b: a parked capacity wait is restarted at once. The restarted workflow's first ask runs the spend check, then the queue: the sweep reads no headroom for it.
    if (c.pause === CAPACITY_WAIT) return true;
    const seat = await deps.resolveRunSeat({ accountId: c.account_id, role: entry.role, workItemId: c.work_item_id });
    if (!seat.ok) {
      counts.skipped += 1;
      log(JSON.stringify({ event: "stage_resume.skipped", stage: entry.stage, work_item_id: c.work_item_id, reason: `seat_${seat.reason}` }));
      return false;
    }
    const answer = await checkHeadroom(runnerPool, { accountId: c.account_id, ...seat.seat.spend });
    if (answer.decision !== "deny") return true;
    const pause = entry.pauseForDenial(answer.reason);
    if (pause === null) {
      counts.skipped += 1;
      log(JSON.stringify({ event: "stage_resume.skipped", stage: entry.stage, work_item_id: c.work_item_id, reason: `not_a_pause_${answer.reason}` }));
      return false;
    }
    // Still denied: no run row. The fact is refreshed so the card keeps naming the limit (and the pause window, three passes, does not run out).
    await fact(entry, c.account_id, c.work_item_id, pause, plan.attempt, `sweep:${plan.actionId}:${bucket}`, plan.head);
    counts.refreshed += 1;
    return false;
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
          if (!(await mayResume(entry, c, plan, bucket, counts))) continue;
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
    let slotRecheckAt: number | null = null;
    for (const entry of entries) {
      if (entry.stage !== "build") continue;
      const slots = await sweepSlotWaiters(entry);
      counts.slotListed = slots.listed;
      counts.slotStarted = slots.started;
      counts.failed += slots.failed;
      if (slots.recheckAt !== null) slotRecheckAt = slotRecheckAt === null ? slots.recheckAt : Math.min(slotRecheckAt, slots.recheckAt);
    }
    // Something is parked (or was just refreshed): look again in a pass. Otherwise the marker is cleared and the next writer sets it.
    const parkedDue = counts.listed > 0 ? now() + STAGE_RESUME_PASS_SECONDS * 1000 : null;
    return { ...counts, nextDueAt: parkedDue === null ? slotRecheckAt : slotRecheckAt === null ? parkedDue : Math.min(parkedDue, slotRecheckAt) };
  }

  /**
   * The slot wake. A build waits for a free slot inside its workflow (asking every minute for four hours). When that workflow is gone, nothing asks any more
   * and the item sits at Spec ready after its slot freed. This pass runs when a slot frees (recordStage marks the sweep pending) and starts the build of the
   * OLDEST orphaned waiter of each repository, once, under the approval it already has. An orphaned waiter is an item at Spec ready, not halted, whose latest
   * waiting fact is a slot reason at least STAGE_RESUME_ORPHAN_AFTER_SECONDS old (a live workflow refreshes it every minute). Everything `planFor` demands still
   * holds (a performed approval by an owner or admin, the Spec as approved, no live run, no refusal since): an item that needs a person's approval is left as it is.
   * It schedules no pass of its own: a pass that finds the slot still held leaves the waiters for the next slot that frees.
   */
  async function sweepSlotWaiters(entry: ParkedStageEntryInput): Promise<SlotWakeCounts> {
    const out: SlotWakeCounts = { listed: 0, started: 0, failed: 0, recheckAt: null };
    if (entry.stage !== "build" || !deps.buildWaitReason || deps.startAdvance === null) return out;
    const wait = deps.buildWaitReason;
    const bucket = Math.floor(now() / (STAGE_RESUME_PASS_SECONDS * 1000));
    let listed: { account_id: string; work_item_id: string; pause: string }[];
    // Fresh waiters are listed too (minimum age 0): one whose workflow died less than the orphan age ago looks alive, and the slot may free in that window.
    let fresh: { account_id: string; work_item_id: string; waited_at: Date }[] = [];
    try {
      const all = (await runnerPool.query<{ account_id: string; work_item_id: string; pause: string; waited_at: Date }>("SELECT account_id, work_item_id, pause, waited_at FROM work_item_list_parked_stage($1, $2::text[], $3::text[], $4, $5)", [entry.stage, [...entry.itemStages, ...(entry.childItemStages ?? [])], [...SLOT_WAIT_REASONS], 0, LIST_LIMIT])).rows;
      const orphanBefore = now() - STAGE_RESUME_ORPHAN_AFTER_SECONDS * 1000;
      listed = all.filter((r) => r.waited_at.getTime() <= orphanBefore);
      fresh = all.filter((r) => r.waited_at.getTime() > orphanBefore);
    } catch (err) {
      out.failed += 1;
      reportError(err, { stage: "advance.slot_wake_list" });
      log(JSON.stringify({ event: "slot_wake.list_failed", code: (err as { code?: string }).code ?? "error" }));
      return out;
    }
    out.listed = listed.length;
    // A fresh waiter that could get a slot right now is either being started by its live workflow (it leaves Spec ready within a minute) or its workflow is gone.
    // One look at the moment its fact turns old enough settles it; this is a single follow-up from the slot-free event, not a poll (a waiter still blocked adds none).
    for (const f of fresh) {
      try {
        if ((await wait(f.account_id, f.work_item_id)) !== null) continue;
        if ("skip" in (await planFor(entry, f.account_id, f.work_item_id))) continue;
        const due = f.waited_at.getTime() + STAGE_RESUME_ORPHAN_AFTER_SECONDS * 1000 + 30_000;
        out.recheckAt = out.recheckAt === null ? due : Math.min(out.recheckAt, due);
      } catch (err) {
        out.failed += 1;
        reportError(err, { stage: "advance.slot_wake_item" });
      }
    }
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
