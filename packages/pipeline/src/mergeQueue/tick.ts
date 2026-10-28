import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { IllegalStageTransitionError, StageInputError } from "@fx/core/src/work-items/stages.js";
import { reportError } from "@fx/telemetry";
import { classifyCi, expectedSignalNames, type CiVerdict, type MergeBlockReason, type PullRequestMergeability } from "../build/mergeGate.js";
import type { PullRequestRef } from "../build/types.js";
import { guardMain, type MainGuardGitHubPort } from "./mainGuard.js";
import { MERGE_QUEUE_CI_WAIT_MINUTES } from "./policy.js";
import { runRefreshStep, refreshTip, type RefreshGitHubPort, type StartDeltaReview } from "./refresh.js";
import { adoptParkedSlot, listHeadRefreshes, markMerged, PARKED_PHASE, readQueue, reclaimExpiredLeases, releaseToQueue, renewSlot, returnToReview, stopEntry, takeSlot } from "./store.js";
import type { MergeQueueEntry, PrFacts } from "./types.js";

/**
 * D#519 MQ3-b: the queue tick for one repo. It is idempotent and safe to run at the same time as itself and as the sweep: the slot is a
 * database row (MQ2), so two ticks end with one holder and one merge call. One call does, in order:
 *
 *  1. RECHECK every queued entry's mergeability from GitHub at once, in parallel. `mergeable: null` / `unknown` is WAIT: the entry is
 *     left out of this take (no facts, so not eligible) and read again on the next tick; it is never a conflict and never clean. A real
 *     conflict (`mergeable: false`, `dirty`) goes to `onConflict` right away, without waiting to reach the head of the queue: a
 *     conflicted PR has no merge ref, so its CI would never start.
 *  2. TAKE the slot for the earliest eligible entry (MQ2), or adopt a holder that is parked (a tick that had to wait for CI and ended).
 *  3. RUN MQ3-a's refresh step, then the CI of the head it ended on: the newest check runs (`filter=latest`) on that exact head, with
 *     the expected-signal rule against the reviewed head. Green goes to the gate and the one merge call. Red RELEASES the slot with
 *     `ci_not_green` so the next eligible entry goes (one red PR never blocks the queue). Pending PARKS the slot, bounded by
 *     `MERGE_QUEUE_CI_WAIT_MINUTES` from the last refresh, then releases it with `ci_not_green`.
 *  4. After a merge, start again from 1: main moved, so every queued entry is rechecked against the new tip before the next merge.
 *     Merges are serial, each one against a main tip the refresh step just compared.
 *
 * Write-back entries (D#598 P5b) are left alone: they never get facts here, so they are never eligible for this tick (their merge is P5c's).
 */

export type QueueGateResult =
  | { outcome: "merged" }
  | { outcome: "merge_delegated" }
  | { outcome: "pr_not_open" }
  | { outcome: "head_moved" }
  | { outcome: "ready_human_merges"; reasons: readonly string[] };

export type TickGitHubPort = RefreshGitHubPort & MainGuardGitHubPort;

export interface QueueTickDeps {
  github: TickGitHubPort;
  /** Runs `fn` in a tenant transaction for the account (`withTenant`). Nothing is held across a GitHub call. */
  inTenant<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  ourLogin: string;
  /** The merge gate on `headSha` (production: `runMergeGateForItem`), given the signals that were green on the reviewed head. */
  gate(args: { entry: MergeQueueEntry; headSha: string; expectedSignals: readonly string[] }): Promise<QueueGateResult>;
  /** MQ3-a's port, bound by the caller to the real reviewer start. */
  startDeltaReview: StartDeltaReview;
  /**
   * MQ4's port: a real conflict. Called for a queued entry as soon as a recheck sees it, and for the holder when update-branch or the
   * merge reports one. Answers whether a fix round was started. Absent, or `false`: the entry stops with `merge_conflict`.
   */
  onConflict?(entry: MergeQueueEntry): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  pollIntervalMs?: number;
  pollLimit?: number;
  now?(): Date;
  /** Entries one call may work through (a merge, or a release that lets the next entry go) before it hands back; the sweep and the next trigger continue. */
  maxPasses?: number;
}

export type TickStep =
  | { step: "idle"; why: "slot_busy" | "nothing_eligible" | "lost_race" | "waiting_mergeability" }
  | { step: "merged"; entryId: string; prNumber: number }
  | { step: "parked"; entryId: string; why: "ci_pending" | "refresh_pending" | "main_ci_unknown" }
  /** The holder's slot is gone and nothing more is done with it this pass. */
  | { step: "released"; entryId: string; why: string };

export interface QueueTickResult {
  steps: TickStep[];
  /** Entries stopped by the recheck for a conflict, and entries whose read failed or is still computing (left for the next tick). */
  conflicted: string[];
  waiting: string[];
}

const stopCode = (reason: string): string => {
  const code = reason.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64);
  return /^[a-z]/.test(code) ? code : "merge_refused";
};

const isUnknown = (m: PullRequestMergeability): boolean => m.mergeable === null || m.mergeableState === "unknown";

export async function runQueueTick(deps: QueueTickDeps, input: { accountId: string; repoId: string }): Promise<QueueTickResult> {
  const out: QueueTickResult = { steps: [], conflicted: [], waiting: [] };
  for (let pass = 0; pass < (deps.maxPasses ?? 10); pass++) {
    const facts = await recheck(deps, input, out);
    const step = await takeAndRun(deps, input, facts);
    out.steps.push(step);
    // A merge moved main and a release let the next entry go: both recheck everyone and go on. Waiting ends the call.
    // A red or unreadable default branch ends the call too: every entry would meet the same answer (MQ-MAIN-RED-GUARD).
    if (step.step === "idle" || step.step === "parked" || (step.step === "released" && (step.why === "main_red" || step.why === "main_ci_unknown"))) break;
  }
  return out;
}

async function recheck(deps: QueueTickDeps, input: { accountId: string; repoId: string }, out: QueueTickResult): Promise<Map<string, PrFacts>> {
  const { accountId, repoId } = input;
  // A holder whose lease lapsed goes back to the queue FIRST, so it is rechecked with the rest and keeps its place ahead of later entries.
  const now = deps.now?.();
  await deps.inTenant(accountId, (c) => reclaimExpiredLeases(c, { accountId, repoId, ...(now ? { now } : {}) }));
  const queued = (await deps.inTenant(accountId, (c) => readQueue(c, accountId, repoId))).filter((e) => e.state === "queued" && e.entryKind === "work_item");
  const facts = new Map<string, PrFacts>();
  const conflicted: MergeQueueEntry[] = [];
  out.waiting = [];
  await Promise.all(
    queued.map(async (e) => {
      let m: PullRequestMergeability;
      try {
        m = await deps.github.getMergeability({ repoId, prNumber: e.prNumber });
      } catch (err) {
        // One PR that cannot be read must not stop the rest: it waits for the next tick, and is never eligible without facts.
        reportError(err, { stage: "merge_queue.recheck" });
        out.waiting.push(e.id);
        return;
      }
      if (m.state !== "open" || m.merged) facts.set(e.id, { open: false, draft: false });
      else if (m.mergeable === false && m.mergeableState === "dirty") conflicted.push(e);
      else if (isUnknown(m)) out.waiting.push(e.id);
      else facts.set(e.id, { open: true, draft: m.mergeableState === "draft" });
    }),
  );
  await Promise.all(conflicted.map((e) => handleConflict(deps, accountId, e, undefined).then(() => void out.conflicted.push(e.id))));
  return facts;
}

/** A real conflict. MQ4 (when wired) starts its fix round; otherwise the entry needs a person. Either way the slot is not held after. */
async function handleConflict(deps: QueueTickDeps, accountId: string, entry: MergeQueueEntry, holder: string | undefined): Promise<void> {
  if (deps.onConflict && (await deps.onConflict(entry))) return;
  await deps.inTenant(accountId, (c) => stopEntry(c, { accountId, entryId: entry.id, reason: "merge_conflict", ...(holder !== undefined ? { holder } : {}) }));
}

async function takeAndRun(deps: QueueTickDeps, input: { accountId: string; repoId: string }, facts: Map<string, PrFacts>): Promise<TickStep> {
  const { accountId, repoId } = input;
  const holder = `tick:${randomUUID()}`;
  const now = deps.now?.();
  const taken = await deps.inTenant(accountId, (c) => takeSlot(c, { accountId, repoId, holder, facts, ...(now ? { now } : {}) }));
  let entry = taken.taken;
  if (!entry && taken.skipped === "slot_busy") entry = await deps.inTenant(accountId, (c) => adoptParkedSlot(c, { accountId, repoId, holder, ...(now ? { now } : {}) }));
  if (!entry) return { step: "idle", why: taken.skipped === "slot_busy" || taken.skipped === "lost_race" ? taken.skipped : facts.size === 0 ? "waiting_mergeability" : "nothing_eligible" };
  const held = entry;
  const pr: PullRequestRef = { repoId, prNumber: held.prNumber };
  const release = async (why: string): Promise<TickStep> => ({ step: "released", entryId: held.id, why });

  // D#519 MQ-MAIN-RED-GUARD: no refresh, CI wait or merge while the default branch's newest result is red.
  const main = await guardMain({ github: deps.github, inTenant: deps.inTenant, ...(deps.now ? { now: deps.now } : {}) }, { accountId, entry: held, holder, pr });
  if (main) return main;

  const refresh = await runRefreshStep<QueueGateResult | { outcome: "parked" | "ci_red" | "ci_timeout" }>(
    {
      github: deps.github,
      inTenant: deps.inTenant,
      ourLogin: deps.ourLogin,
      gate: ({ headSha }) => ciThenGate(deps, accountId, held, holder, pr, headSha),
      startDeltaReview: deps.startDeltaReview,
      sleep: deps.sleep,
      ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
      ...(deps.pollLimit !== undefined ? { pollLimit: deps.pollLimit } : {}),
    },
    { accountId, entry: held, holder, pr },
  );

  let gate: QueueGateResult | { outcome: "parked" | "ci_red" | "ci_timeout" };
  switch (refresh.outcome) {
    case "not_behind":
      gate = refresh.gate;
      break;
    case "refreshed":
      gate = await ciThenGate(deps, accountId, held, holder, pr, refresh.toSha);
      break;
    case "conflict":
      await handleConflict(deps, accountId, held, holder);
      return release("merge_conflict");
    case "refresh_pending":
      await park(deps, accountId, held, holder);
      return { step: "parked", entryId: held.id, why: "refresh_pending" };
    case "pr_not_open":
      await deps.inTenant(accountId, (c) => releaseToQueue(c, { accountId, entryId: held.id, holder }));
      return release("pr_not_open");
    default:
      // needs_delta_review, refused_spend, foreign_head, branch_behind, slot_lost: the step already moved the entry and released the slot.
      return release(refresh.outcome);
  }

  switch (gate.outcome) {
    case "merged":
      await deps.inTenant(accountId, async (c) => {
        const merged = await markMerged(c, { accountId, entryId: held.id, mergedBy: "gate", holder });
        // MQ-WIRE-1: the merge is a fact about GitHub, so the item records it now, in the same transaction, as the pull_request webhook would (same stage
        // writer, same markers: build slot, planned-PR siblings, branch cleanup). A webhook that follows finds the item already merged and is a no-op.
        if (merged?.entryKind === "work_item" && merged.workItemId) await recordQueueMerge(c, merged.workItemId, held.id, deps.now?.() ?? new Date());
      });
      return { step: "merged", entryId: held.id, prNumber: held.prNumber };
    case "parked":
      return { step: "parked", entryId: held.id, why: "ci_pending" };
    case "ci_red":
    case "ci_timeout":
      return release("ci_not_green");
    case "head_moved":
      await deps.inTenant(accountId, (c) => returnToReview(c, { accountId, entryId: held.id }));
      return release("head_moved");
    case "pr_not_open":
      await deps.inTenant(accountId, (c) => releaseToQueue(c, { accountId, entryId: held.id, holder }));
      return release("pr_not_open");
    case "ready_human_merges":
      return afterRefusal(deps, accountId, held, holder, gate.reasons);
    default:
      await deps.inTenant(accountId, (c) => stopEntry(c, { accountId, entryId: held.id, reason: "merge_call_refused", holder }));
      return release("merge_call_refused");
  }
}

/** Moves the entry's item to `merged`. GitHub has already merged, so the entry's merged state never rolls back: an item that cannot legally move there (already merged, closed, not at a pull-request stage) or an `at` ahead of the database clock is refused by recordStage before it writes anything, and is left to the webhook and the slot sweep. */
async function recordQueueMerge(client: PoolClient, workItemId: string, entryId: string, at: Date): Promise<void> {
  try {
    await recordStage(client, { workItemId, toStage: "merged", at, source: "webhook", sourceRef: `merge_queue:${entryId}` });
  } catch (err) {
    // fx-swallow-ok: the queue entry's own merge stands; the webhook and the slot sweep still look at an item that could not move here
    if (!(err instanceof IllegalStageTransitionError || err instanceof StageInputError)) throw err;
  }
}

async function park(deps: QueueTickDeps, accountId: string, entry: MergeQueueEntry, holder: string): Promise<void> {
  await deps.inTenant(accountId, (c) => renewSlot(c, { accountId, entryId: entry.id, holder, phase: PARKED_PHASE }));
}

/** The gate refused for a reason. CI regressing under it waits again; a behind or conflicting branch goes back through the refresh; the rest needs a person. */
async function afterRefusal(deps: QueueTickDeps, accountId: string, entry: MergeQueueEntry, holder: string, reasons: readonly string[]): Promise<TickStep> {
  const has = (r: MergeBlockReason) => reasons.includes(r);
  if (has("ci_not_green")) {
    await park(deps, accountId, entry, holder);
    return { step: "parked", entryId: entry.id, why: "ci_pending" };
  }
  // A head with no reviewer rows at all is a head nobody reviewed (it moved after the gate read it): it goes back to review, not to a person.
  if (reasons.some((r) => r.startsWith("missing_run_"))) {
    await deps.inTenant(accountId, (c) => returnToReview(c, { accountId, entryId: entry.id }));
    return { step: "released", entryId: entry.id, why: "head_unreviewed" };
  }
  if (has("branch_behind")) {
    await deps.inTenant(accountId, (c) => releaseToQueue(c, { accountId, entryId: entry.id, holder }));
    return { step: "released", entryId: entry.id, why: "branch_behind" };
  }
  if (has("merge_conflict")) {
    await handleConflict(deps, accountId, entry, holder);
    return { step: "released", entryId: entry.id, why: "merge_conflict" };
  }
  const reason = stopCode(reasons[0] ?? "merge_call_refused");
  await deps.inTenant(accountId, (c) => stopEntry(c, { accountId, entryId: entry.id, reason, holder }));
  return { step: "released", entryId: entry.id, why: reason };
}

/**
 * Fresh CI for the head the refresh step ended on, then the gate. The snapshot is for this exact sha and lists the newest run of each
 * check (the port asks GitHub for `filter=latest`), so an older green run of a check that was re-run can never speak for the head. A
 * refreshed head must also show every signal that was green on the reviewed head.
 */
async function ciThenGate(
  deps: QueueTickDeps,
  accountId: string,
  entry: MergeQueueEntry,
  holder: string,
  pr: PullRequestRef,
  headSha: string,
): Promise<QueueGateResult | { outcome: "parked" | "ci_red" | "ci_timeout" }> {
  const refreshes = await deps.inTenant(accountId, (c) => listHeadRefreshes(c, accountId, entry.id));
  const expected = headSha === entry.headSha ? [] : expectedSignalNames(await deps.github.getCiSnapshot(pr, entry.headSha));
  const verdict: CiVerdict = classifyCi(await deps.github.getCiSnapshot(pr, headSha), headSha, expected);
  if (verdict === "red") {
    await deps.inTenant(accountId, (c) => stopEntry(c, { accountId, entryId: entry.id, reason: "ci_not_green", holder }));
    return { outcome: "ci_red" };
  }
  if (verdict === "pending") {
    // The wait is measured from the refresh that produced this head; a head nobody refreshed has waited since the slot was first taken.
    const since = refreshTip(entry.headSha, refreshes) === headSha ? refreshes.find((r) => r.toSha === headSha)?.createdAt : undefined;
    const started = (since ?? entry.slotTakenAt)?.getTime() ?? (deps.now?.() ?? new Date()).getTime();
    if ((deps.now?.() ?? new Date()).getTime() - started >= MERGE_QUEUE_CI_WAIT_MINUTES * 60_000) {
      await deps.inTenant(accountId, (c) => stopEntry(c, { accountId, entryId: entry.id, reason: "ci_not_green", holder }));
      return { outcome: "ci_timeout" };
    }
    await park(deps, accountId, entry, holder);
    return { outcome: "parked" };
  }
  // Mid-merge: no other tick may adopt this holder from here on.
  if (!(await deps.inTenant(accountId, (c) => renewSlot(c, { accountId, entryId: entry.id, holder, phase: "merge" })))) return { outcome: "pr_not_open" };
  return deps.gate({ entry, headSha, expectedSignals: expected });
}
