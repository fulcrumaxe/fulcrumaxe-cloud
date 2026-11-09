import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { toQueueRank } from "@fx/core/src/work-items/priority.js";
import { holdsSlotSql } from "@fx/core/src/work-items/slotRelease.js";
import { compareQueueOrder } from "@fx/core/src/work-items/queueOrder.js";
import { effectiveModeSql, isRunnerMode } from "@fx/runner";
import { repoRunnerCanAttestOrder } from "../mergeQueue/runnerOrderCapability.js";
import { WAITING_STAGE_POSITIONS, type WaitingStage } from "./waitingStages.js";

/**
 * D#483 S5-c1: build slots from the person's own concurrency setting.
 *
 * A hosted account has no product or plan-tier cap on builds. How many items it builds at once, and how many on one repository, are two
 * numbers the person sets (`build_concurrency_settings`, migration 0830). With no setting the starting values apply: 2 per repository
 * and 4 per account. THIS MODULE DELIBERATELY IMPORTS NOTHING FROM THE PLAN-DATA PACKAGE (a test reads the import list): no plan tier can
 * set or lower a limit here.
 *
 * What holds a slot: an item at `in_progress`, `pr_opened`, `changes_requested` or `review_passed`, unless its pull request is stopped for a person (core `slotRelease.ts`: the
 * newest driver fact is a stop only a person can restart; it counts again as soon as a later fact is written). The driver moves an item into
 * `in_progress` only by taking a slot (`takeBuildSlot`), under the account's advisory lock, so two builds starting at once cannot both
 * pass a limit that has room for one.
 *
 * Scopes:
 *  - repository: every item that holds a slot on the repository counts, hosted or runner. The person's repository value is the limit,
 *    read from the current setting at each claim (never stamped on an item), so lowering it cancels nothing: running items keep their
 *    slots and only the next claim waits. (D#483 S5-j lifted the one-build-per-repository clamp once D#519 and D#598 P3c landed.)
 *  - account: the person's account value, counted over HOSTED items only. A repository on a runner is not held by it; the runner's own
 *    resource-aware admission (D#6 C43) decides how many of its runs proceed.
 *
 * The wait reason is DERIVED each time it is read, from the setting rows and the live stages. Nothing records "this item is waiting".
 *
 * Order: when a slot is free, the first item in the queue order (`priority`, then `queue_rank`, then age) takes it. A better-ordered item
 * that is waiting (see `waiterSql`) makes a worse-ordered one give way; a waiter that is itself held by its repository's limit does not
 * hold up the account's slot.
 */

/** The starting values for an account that has never set a number. They are starting values, not limits. */
export const START_BUILDS_PER_REPO = 2;
export const START_BUILDS_PER_ACCOUNT = 4;

/** The stages in which an item holds a build slot. */
export const BUILD_SLOT_STAGES: readonly string[] = Object.freeze(["in_progress", "pr_opened", "changes_requested", "review_passed"]);

export const BUILD_WAIT_REASONS = ["waiting_for_build_slot_repo", "waiting_for_build_slot_account"] as const;
export type BuildWaitReason = (typeof BUILD_WAIT_REASONS)[number];

export const isBuildWaitReason = (reason: unknown): reason is BuildWaitReason => typeof reason === "string" && (BUILD_WAIT_REASONS as readonly string[]).includes(reason);

/**
 * The one reason the applied repository limit can sit below the person's stored value (D#483 C34 R-C34-F1): a `runner_local` repository can't be read from the
 * cloud, so the merge check can't attest order for it until its runner says it can. It is a throughput limit, not a safety claim, and the stored value is kept.
 */
export const RUNNER_ORDER_UNATTESTED = "runner_order_unattested" as const;
export const RUNNER_UNATTESTED_LIMIT = 1;

export interface BuildLimits {
  /** What applies to the repository: the person's value (or the starting value), or 1 for a `runner_local` repository whose runner can't attest order yet. */
  repoLimit: number;
  accountValue: number;
  /** Why `repoLimit` is below the stored value (or would be), else null. */
  clampReason: typeof RUNNER_ORDER_UNATTESTED | null;
}

/** `runnerClamped`: see `runnerClampedRepoIds`. Hosted and hosted-paired repositories are never clamped: the merge check holds order for them. */
export function resolveBuildLimits(set: { accountValue: number | null; repoValue: number | null; runnerClamped?: boolean }): BuildLimits {
  const value = set.repoValue ?? START_BUILDS_PER_REPO;
  const clamped = set.runnerClamped === true;
  return { repoLimit: clamped ? Math.min(value, RUNNER_UNATTESTED_LIMIT) : value, accountValue: set.accountValue ?? START_BUILDS_PER_ACCOUNT, clampReason: clamped ? RUNNER_ORDER_UNATTESTED : null };
}

/**
 * Which repositories are held to one build. A `runner_local` repository lifts only when it is PAIRED and a usable runner (not revoked, paused or draining) that covers it lists `ordered_facts_v1`:
 * its merges then take the go phase, which judges order from the runner's fact. An unpaired one has no go phase and keeps the gate's conservative stop (`runner_ordered_unsupported` with a
 * live sibling), so a second build there would only stop at merge. `alsoRunnerLocal`: repositories the caller already knows to be `runner_local` for the item at hand (an item placed on a
 * runner); the same rule applies to them. Read per repository at each call, never assumed.
 */
export async function runnerClampedRepoIds(client: PoolClient, accountId: string, repoIds: readonly string[], alsoRunnerLocal: ReadonlySet<string> = new Set()): Promise<Set<string>> {
  if (repoIds.length === 0) return new Set();
  const { rows } = await client.query<{ id: string }>("SELECT id FROM repos WHERE account_id = $1 AND id = ANY($2::uuid[]) AND execution_mode = 'runner_local'", [accountId, [...repoIds]]);
  const local = [...new Set([...rows.map((r) => r.id), ...repoIds.filter((id) => alsoRunnerLocal.has(id))])];
  if (local.length === 0) return new Set();
  const paired = new Set((await client.query<{ repo_id: string }>("SELECT repo_id FROM repo_pairing WHERE account_id = $1 AND repo_id = ANY($2::uuid[])", [accountId, local])).rows.map((r) => r.repo_id));
  const clamped = new Set<string>();
  for (const id of local) if (!paired.has(id) || !(await repoRunnerCanAttestOrder(client, accountId, id, true))) clamped.add(id);
  return clamped;
}

export interface SlotInputs {
  limits: BuildLimits;
  /** The candidate's repository runs on our sandbox (the account value applies) and not on a runner. */
  hosted: boolean;
  /** Items holding a slot, other than the candidate. */
  repoHeld: number;
  accountHeldHosted: number;
  /** A better-ordered item is waiting on this repository. */
  repoWaiterAhead: boolean;
  /** A better-ordered hosted item is waiting that its own repository's limit would let start. */
  accountWaiterAhead: boolean;
}

export type SlotDecision = { granted: true } | { granted: false; reason: BuildWaitReason };

/** Pure: the whole decision, from counts. */
export function decideSlot(i: SlotInputs): SlotDecision {
  if (i.repoHeld >= i.limits.repoLimit) return { granted: false, reason: "waiting_for_build_slot_repo" };
  if (i.hosted && i.accountHeldHosted >= i.limits.accountValue) return { granted: false, reason: "waiting_for_build_slot_account" };
  if (i.repoWaiterAhead) return { granted: false, reason: "waiting_for_build_slot_repo" };
  if (i.hosted && i.accountWaiterAhead) return { granted: false, reason: "waiting_for_build_slot_account" };
  return { granted: true };
}

/** The workflow asks again this often while it waits (apps/web workItemAdvance BUILD_SLOT_POLL_MS; a test holds the two together). */
export const BUILD_SLOT_POLL_SECONDS = 60;
/** An item counts as waiting only while its latest `build_waiting` fact is younger than this: three polls. */
export const WAITER_WINDOW_SECONDS = 3 * BUILD_SLOT_POLL_SECONDS;

/**
 * Items waiting for a slot, derived from the wait itself: at a start stage, not halted, whose LATEST waiting fact (one per poll, written by the worker
 * when the start found no slot; `stage_waiting` for the build stage since D#483 S5-k1b, `build_waiting` before it, and the latest of the two counts) is a slot
 * reason and younger than the window. A fact of another stage (`classify`, `spec`, ...) never counts here. D#483 S5-k1: the same fact also names a spend pause
 * (`account_budget_reached` and the other three); an item paused for a limit holds no slot back from the items behind it. A build that failed (Needs a person), a workflow that died, a give-up or a
 * start all stop the polls, so the item stops counting within the window and never holds a free slot back.
 */
const waiterSql = (): string => `
  SELECT w.id, w.priority, w.queue_rank, w.created_at, w.repo_id, ${effectiveModeSql("w", "r")} AS mode,
         (SELECT count(*) FROM work_items h WHERE h.account_id = w.account_id AND h.repo_id = w.repo_id AND ${holdsSlotSql("h", "$3::text[]")}) AS repo_held,
         COALESCE((SELECT s.max_builds FROM build_concurrency_settings s WHERE s.account_id = w.account_id AND s.repo_id = w.repo_id ORDER BY s.version DESC LIMIT 1), $8::int) AS repo_limit
    FROM work_items w
    JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
   WHERE w.account_id = $1 AND w.id <> $2
     AND w.stage = ANY($7::text[]) AND w.halted_at IS NULL
     AND EXISTS (
       SELECT 1 FROM (
         SELECT x.code, x.stage, x.created_at FROM work_item_driver_events x
          WHERE x.account_id = w.account_id AND x.work_item_id = w.id AND x.kind IN ('build_waiting', 'stage_waiting')
          ORDER BY x.seq DESC LIMIT 1
       ) e
        WHERE COALESCE(e.stage, 'build') = $6::text
          AND e.created_at > now() - make_interval(secs => $4::int)
          AND e.code = ANY($5::text[])
     )
   LIMIT 500`;

export interface SlotWaiterRow {
  id: string;
  priority: number;
  queue_rank: string | null;
  created_at: Date;
  repo_id: string;
  mode: string;
  repo_held: string;
  /** The waiter's OWN repository's limit (its current setting, else the starting value): each repository has its own number. */
  repo_limit: number;
}

/**
 * The items (other than `exceptItemId`) whose LATEST waiting fact names `stage` and a slot reason and is fresh, sitting at that stage's positions. Only the build
 * stage waits for a slot today; the stage argument is what keeps a fact of another stage (a classify wait) from counting here, and the reverse (a test fixes both).
 */
export async function listSlotWaiters(client: PoolClient, accountId: string, exceptItemId: string, stage: WaitingStage): Promise<SlotWaiterRow[]> {
  return (await client.query<SlotWaiterRow>(waiterSql(), [accountId, exceptItemId, [...BUILD_SLOT_STAGES], WAITER_WINDOW_SECONDS, [...BUILD_WAIT_REASONS], stage, [...WAITING_STAGE_POSITIONS[stage]], START_BUILDS_PER_REPO])).rows;
}

interface ItemRow {
  id: string;
  stage: string;
  repo_id: string | null;
  priority: number;
  queue_rank: string | null;
  created_at: Date;
  mode: string;
}

/** What the decision and the free-slot read both need, as the database stands now: the item's limits and how many slots are held. Null for a missing item or one with no repository. */
async function readSlotCounts(client: PoolClient, accountId: string, workItemId: string): Promise<{ item: ItemRow & { repo_id: string }; limits: BuildLimits; hosted: boolean; repoHeld: number; accountHeldHosted: number } | null> {
  const item = (
    await client.query<ItemRow>(
      `SELECT w.id, w.stage, w.repo_id, w.priority, w.queue_rank, w.created_at, ${effectiveModeSql("w", "r")} AS mode
         FROM work_items w LEFT JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
        WHERE w.id = $1 AND w.account_id = $2`,
      [workItemId, accountId],
    )
  ).rows[0];
  if (!item || item.repo_id === null) return null;
  const repoId = item.repo_id;
  const setting = async (id: string | null): Promise<number | null> => {
    const { rows } = await client.query<{ max_builds: number }>(
      `SELECT max_builds FROM build_concurrency_settings
        WHERE account_id = $1 AND repo_id IS NOT DISTINCT FROM $2::uuid ORDER BY version DESC LIMIT 1`,
      [accountId, id],
    );
    return rows[0] ? Number(rows[0].max_builds) : null;
  };
  // Read per repository and per item at each claim: a runner_local item on a runner that can't attest order yet is held to one build (C34 R-C34-F1).
  const runnerClamped = (await runnerClampedRepoIds(client, accountId, [repoId], item.mode === "runner_local" ? new Set([repoId]) : new Set())).has(repoId);
  const limits = resolveBuildLimits({ accountValue: await setting(null), repoValue: await setting(repoId), runnerClamped });
  const hosted = !isRunnerMode(item.mode);
  const repoHeld = Number(
    (await client.query<{ n: string }>(`SELECT count(*) AS n FROM work_items h WHERE h.account_id = $1 AND h.repo_id = $2 AND ${holdsSlotSql("h", "$3::text[]")} AND h.id <> $4`, [accountId, repoId, [...BUILD_SLOT_STAGES], workItemId])).rows[0]!.n,
  );
  const accountHeldHosted = hosted
    ? Number(
        (
          await client.query<{ n: string }>(
            `SELECT count(*) AS n FROM work_items w JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
              WHERE w.account_id = $1 AND ${holdsSlotSql("w", "$2::text[]")} AND w.id <> $3 AND ${effectiveModeSql("w", "r")} NOT IN ('runner_local', 'runner_verified')`,
            [accountId, [...BUILD_SLOT_STAGES], workItemId],
          )
        ).rows[0]!.n,
      )
    : 0;
  return { item: { ...item, repo_id: repoId }, limits, hosted, repoHeld, accountHeldHosted };
}

/**
 * How many more builds could start right now for the item's repository (and, for a hosted item, its account), ignoring who is waiting. The slot wake starts at most this many
 * orphaned waiters per repository per pass (D#483 S5-j). A read, not a promise: each start still goes through the claim.
 */
export async function readFreeBuildSlots(pool: Pool, accountId: string, workItemId: string): Promise<number> {
  return withTenant(pool, accountId, async (client) => {
    const c = await readSlotCounts(client, accountId, workItemId);
    if (c === null) return 0;
    return Math.max(0, Math.min(c.limits.repoLimit - c.repoHeld, c.hosted ? c.limits.accountValue - c.accountHeldHosted : Number.MAX_SAFE_INTEGER));
  });
}

/** The decision for one item as the database stands now. Read only; the caller holds the account lock when it must be exact. */
export async function decideBuildSlot(client: PoolClient, accountId: string, workItemId: string): Promise<SlotDecision> {
  const counts = await readSlotCounts(client, accountId, workItemId);
  // An item that already holds a slot keeps it (a replay of its own start); a missing item or one with no repo is the caller's refusal to make.
  if (counts === null || BUILD_SLOT_STAGES.includes(counts.item.stage)) return { granted: true };
  const { item, limits, hosted, repoHeld, accountHeldHosted } = counts;

  const me = { id: item.id, priority: item.priority, queueRank: toQueueRank(item.queue_rank), createdAt: item.created_at };
  const waiters = (await listSlotWaiters(client, accountId, workItemId, "build")).filter((w) => compareQueueOrder({ id: w.id, priority: w.priority, queueRank: toQueueRank(w.queue_rank), createdAt: w.created_at }, me) < 0);

  return decideSlot({
    limits,
    hosted,
    repoHeld,
    accountHeldHosted,
    repoWaiterAhead: waiters.some((w) => w.repo_id === item.repo_id),
    accountWaiterAhead: waiters.some((w) => !isRunnerMode(w.mode) && Number(w.repo_held) < Number(w.repo_limit)),
  });
}

export type SlotClaim<T> = { granted: true; value: T } | { granted: false; reason: BuildWaitReason };

/** How long a claim keeps trying for the account's lock before it answers "wait" (the holder is starting a run, which takes seconds). */
export const SLOT_LOCK_PATIENCE_MS = 20_000;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `move` only if the item can take a slot, with the decision and `move` inside ONE transaction that holds the account's advisory
 * lock. `move` makes the item hold the slot (the run start and the stage move to `in_progress`), so a second claim reads the first one's
 * result. `needsSlot: false` (a replay of an item already at `in_progress`) skips the decision.
 *
 * The lock is TRIED, never waited on while holding a connection: a claim that does not get it gives its connection back and tries again after
 * a short, growing pause. The holder needs a second connection for the run start, so claims that sat on connections waiting for the lock
 * could starve it (ten starts on a pool of ten). After `SLOT_LOCK_PATIENCE_MS` the claim answers that the account is busy starting other
 * builds (`waiting_for_build_slot_account`) and the workflow's next poll asks again.
 */
export async function takeBuildSlot<T>(pool: Pool, accountId: string, workItemId: string, move: (client: PoolClient) => Promise<T>, options: { needsSlot?: boolean } = {}): Promise<SlotClaim<T>> {
  const deadline = Date.now() + SLOT_LOCK_PATIENCE_MS;
  for (let attempt = 0; ; attempt++) {
    const outcome = await withTenant(pool, accountId, async (client): Promise<SlotClaim<T> | null> => {
      if (options.needsSlot !== false) {
        const got = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`fx:build_slots:${accountId}`]);
        if (!got.rows[0]!.ok) return null;
        const decision = await decideBuildSlot(client, accountId, workItemId);
        if (!decision.granted) return decision;
      }
      return { granted: true, value: await move(client) };
    });
    if (outcome !== null) return outcome;
    if (Date.now() >= deadline) return { granted: false, reason: "waiting_for_build_slot_account" };
    await pause(Math.min(25 * (attempt + 1), 500) + Math.floor(Math.random() * 25));
  }
}

/**
 * The reason an item is waiting for a slot right now, or null when it would get one (or already holds one). Derived at read time; for
 * the wait sentences S6-b shows. Takes no lock, so it is a fair picture and not a promise.
 */
export async function readBuildWaitReason(pool: Pool, accountId: string, workItemId: string): Promise<BuildWaitReason | null> {
  const decision = await withTenant(pool, accountId, (client) => decideBuildSlot(client, accountId, workItemId));
  return decision.granted ? null : decision.reason;
}
