import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { toQueueRank } from "@fx/core/src/work-items/priority.js";
import { compareQueueOrder } from "@fx/core/src/work-items/queueOrder.js";
import { effectiveModeSql, isRunnerMode } from "@fx/runner";

/**
 * D#483 S5-c1: build slots from the person's own concurrency setting.
 *
 * A hosted account has no product or plan-tier cap on builds. How many items it builds at once, and how many on one repository, are two
 * numbers the person sets (`build_concurrency_settings`, migration 0830). With no setting the starting values apply: 2 per repository
 * and 4 per account. THIS MODULE DELIBERATELY IMPORTS NOTHING FROM THE PLAN-DATA PACKAGE (a test reads the import list): no plan tier can
 * set or lower a limit here.
 *
 * What holds a slot: an item at `in_progress`, `pr_opened`, `changes_requested` or `review_passed`. The driver moves an item into
 * `in_progress` only by taking a slot (`takeBuildSlot`), under the account's advisory lock, so two builds starting at once cannot both
 * pass a limit that has room for one.
 *
 * Scopes:
 *  - repository: every item that holds a slot on the repository counts, hosted or runner. The person's repository value applies, but
 *    until D#598 lands (migration order at merge, stacking, rebase) it is clamped to one build per repository
 *    (`ONE_BUILD_PER_REPO_UNTIL_D598`; S5-j removes that clamp). The reason is then `one_build_per_repo_until_d598`.
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

/** Until D#598 lands, one build per repository whatever the person's repository value is. S5-j removes this line. */
export const ONE_BUILD_PER_REPO_UNTIL_D598 = 1;

/** The stages in which an item holds a build slot. */
export const BUILD_SLOT_STAGES: readonly string[] = Object.freeze(["in_progress", "pr_opened", "changes_requested", "review_passed"]);

export const BUILD_WAIT_REASONS = ["one_build_per_repo_until_d598", "waiting_for_build_slot_repo", "waiting_for_build_slot_account"] as const;
export type BuildWaitReason = (typeof BUILD_WAIT_REASONS)[number];

export const isBuildWaitReason = (reason: unknown): reason is BuildWaitReason => typeof reason === "string" && (BUILD_WAIT_REASONS as readonly string[]).includes(reason);

export interface BuildLimits {
  /** The person's repository value (or the starting value). */
  repoValue: number;
  /** What actually applies to a repository now: the value, clamped. */
  repoLimit: number;
  accountValue: number;
}

export function resolveBuildLimits(set: { accountValue: number | null; repoValue: number | null }): BuildLimits {
  const repoValue = set.repoValue ?? START_BUILDS_PER_REPO;
  return { repoValue, repoLimit: Math.min(repoValue, ONE_BUILD_PER_REPO_UNTIL_D598), accountValue: set.accountValue ?? START_BUILDS_PER_ACCOUNT };
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
  const repoReason: BuildWaitReason = i.limits.repoValue > i.limits.repoLimit ? "one_build_per_repo_until_d598" : "waiting_for_build_slot_repo";
  if (i.repoHeld >= i.limits.repoLimit) return { granted: false, reason: repoReason };
  if (i.hosted && i.accountHeldHosted >= i.limits.accountValue) return { granted: false, reason: "waiting_for_build_slot_account" };
  if (i.repoWaiterAhead) return { granted: false, reason: repoReason };
  if (i.hosted && i.accountWaiterAhead) return { granted: false, reason: "waiting_for_build_slot_account" };
  return { granted: true };
}

/** The workflow asks again this often while it waits (apps/web workItemAdvance BUILD_SLOT_POLL_MS; a test holds the two together). */
export const BUILD_SLOT_POLL_SECONDS = 60;
/** An item counts as waiting only while its latest `build_waiting` fact is younger than this: three polls. */
export const WAITER_WINDOW_SECONDS = 3 * BUILD_SLOT_POLL_SECONDS;

/**
 * Items waiting for a slot, derived from the wait itself: at a start stage, not halted, with a `build_waiting` fact (one per poll, written by
 * the worker when the start found no slot) younger than the window. A build that failed (Needs a person), a workflow that died, a give-up or a
 * start all stop the polls, so the item stops counting within the window and never holds a free slot back.
 */
const waiterSql = (): string => `
  SELECT w.id, w.priority, w.queue_rank, w.created_at, w.repo_id, ${effectiveModeSql("w", "r")} AS mode,
         (SELECT count(*) FROM work_items h WHERE h.account_id = w.account_id AND h.repo_id = w.repo_id AND h.stage = ANY($3::text[])) AS repo_held
    FROM work_items w
    JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
   WHERE w.account_id = $1 AND w.id <> $2
     AND w.stage IN ('spec_ready', 'needs_human') AND w.halted_at IS NULL
     AND EXISTS (
       SELECT 1 FROM work_item_driver_events e
        WHERE e.account_id = w.account_id AND e.work_item_id = w.id AND e.kind = 'build_waiting'
          AND e.created_at > now() - make_interval(secs => $4::int)
     )
   LIMIT 500`;

interface ItemRow {
  id: string;
  stage: string;
  repo_id: string | null;
  priority: number;
  queue_rank: string | null;
  created_at: Date;
  mode: string;
}

/** The decision for one item as the database stands now. Read only; the caller holds the account lock when it must be exact. */
export async function decideBuildSlot(client: PoolClient, accountId: string, workItemId: string): Promise<SlotDecision> {
  const item = (
    await client.query<ItemRow>(
      `SELECT w.id, w.stage, w.repo_id, w.priority, w.queue_rank, w.created_at, ${effectiveModeSql("w", "r")} AS mode
         FROM work_items w LEFT JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
        WHERE w.id = $1 AND w.account_id = $2`,
      [workItemId, accountId],
    )
  ).rows[0];
  // An item that already holds a slot keeps it (a replay of its own start); a missing item or one with no repo is the caller's refusal to make.
  if (!item || item.repo_id === null || BUILD_SLOT_STAGES.includes(item.stage)) return { granted: true };

  const setting = async (repoId: string | null): Promise<number | null> => {
    const { rows } = await client.query<{ max_builds: number }>(
      `SELECT max_builds FROM build_concurrency_settings
        WHERE account_id = $1 AND repo_id IS NOT DISTINCT FROM $2::uuid ORDER BY version DESC LIMIT 1`,
      [accountId, repoId],
    );
    return rows[0] ? Number(rows[0].max_builds) : null;
  };
  const limits = resolveBuildLimits({ accountValue: await setting(null), repoValue: await setting(item.repo_id) });
  const hosted = !isRunnerMode(item.mode);

  const repoHeld = Number(
    (await client.query<{ n: string }>("SELECT count(*) AS n FROM work_items WHERE account_id = $1 AND repo_id = $2 AND stage = ANY($3::text[]) AND id <> $4", [accountId, item.repo_id, [...BUILD_SLOT_STAGES], workItemId])).rows[0]!.n,
  );
  const accountHeldHosted = hosted
    ? Number(
        (
          await client.query<{ n: string }>(
            `SELECT count(*) AS n FROM work_items w JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
              WHERE w.account_id = $1 AND w.stage = ANY($2::text[]) AND w.id <> $3 AND ${effectiveModeSql("w", "r")} NOT IN ('runner_local', 'runner_verified')`,
            [accountId, [...BUILD_SLOT_STAGES], workItemId],
          )
        ).rows[0]!.n,
      )
    : 0;

  const me = { id: item.id, priority: item.priority, queueRank: toQueueRank(item.queue_rank), createdAt: item.created_at };
  const waiters = (
    await client.query<{ id: string; priority: number; queue_rank: string | null; created_at: Date; repo_id: string; mode: string; repo_held: string }>(waiterSql(), [accountId, workItemId, [...BUILD_SLOT_STAGES], WAITER_WINDOW_SECONDS])
  ).rows.filter((w) => compareQueueOrder({ id: w.id, priority: w.priority, queueRank: toQueueRank(w.queue_rank), createdAt: w.created_at }, me) < 0);

  return decideSlot({
    limits,
    hosted,
    repoHeld,
    accountHeldHosted,
    repoWaiterAhead: waiters.some((w) => w.repo_id === item.repo_id),
    accountWaiterAhead: waiters.some((w) => !isRunnerMode(w.mode) && Number(w.repo_held) < limits.repoLimit),
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
