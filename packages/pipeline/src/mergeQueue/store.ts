import type { PoolClient } from "pg";
import { listHeadRemovals } from "@fx/core/src/work-items/driverEvents.js";
import { isQueuedSql, removalRetryAllowed, removedByPerson } from "@fx/core/src/work-items/mergeReadiness.js";
import { MAX_CONFLICT_ROUNDS, MERGE_QUEUE_LEASE_SECONDS } from "./policy.js";
import { eligibilityContext, pickNext } from "./eligibility.js";
import { MergeQueueError, type ConflictRound, type EntryKind, type MergeQueueEntry, type MergedBy, type PrFacts, type QueueState, type WorkKind } from "./types.js";

/**
 * D#519 MQ2: the merge queue's persistence (migration 0824). Every function takes a `PoolClient` that is already inside a tenant
 * transaction (`withTenant`), so the caller decides what commits together. Nothing here holds a lock or a connection past its own
 * transaction: the slot is a row (state `in_flight`, a holder and a lease), and "at most one holder per repo" is the database's
 * partial unique index, not this code.
 *
 * Time. `now` is injectable everywhere it matters (the lease, its expiry); left out, the database's clock is used. A caller that
 * injects it must inject the same clock for the take, the renewals and the sweep.
 *
 * What this file does not do: read GitHub, run the gate, refresh a branch, start an agent run. The tick that does those is MQ3.
 */

type Queryable = Pick<PoolClient, "query">;

const COLUMNS = `id, account_id, repo_id, entry_kind, work_item_id, plan_writeback_id, pr_number, head_sha, depends_on_pr_number, approved_at, state, phase, work_kind,
  work_run_id, slot_holder, lease_until, slot_taken_at, refresh_count, conflict_rounds, reason, merged_by, created_at, updated_at`;

/** Clears everything that only means something while an entry holds the slot or waits for work. */
const CLEAR_SLOT_AND_WORK = `phase = NULL, slot_holder = NULL, lease_until = NULL, slot_taken_at = NULL, work_kind = NULL, work_run_id = NULL`;

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** The fixed stop code of an entry a person took out of the host's queue (no automatic retry follows a person's removal). */
export const HOST_DEQUEUED_REASON = "removed_from_merge_queue";
/** The fixed stop code of an entry the host's queue took out a second time for the same head: the one automatic retry is used up. */
export const HOST_RETRY_USED_REASON = "merge_queue_retry_used";
const SHA_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

interface Row {
  id: string;
  account_id: string;
  repo_id: string;
  entry_kind: EntryKind;
  work_item_id: string | null;
  plan_writeback_id: string | null;
  pr_number: number;
  head_sha: string;
  depends_on_pr_number: number | null;
  approved_at: Date;
  state: QueueState;
  phase: string | null;
  work_kind: WorkKind | null;
  work_run_id: string | null;
  slot_holder: string | null;
  lease_until: Date | null;
  slot_taken_at: Date | null;
  refresh_count: number;
  conflict_rounds: number;
  reason: string | null;
  merged_by: MergedBy | null;
  created_at: Date;
  updated_at: Date;
}

function toEntry(r: Row): MergeQueueEntry {
  return {
    id: r.id,
    accountId: r.account_id,
    repoId: r.repo_id,
    entryKind: r.entry_kind,
    workItemId: r.work_item_id,
    planWritebackId: r.plan_writeback_id,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    dependsOnPrNumber: r.depends_on_pr_number,
    approvedAt: r.approved_at,
    state: r.state,
    phase: r.phase,
    workKind: r.work_kind,
    workRunId: r.work_run_id,
    slotHolder: r.slot_holder,
    leaseUntil: r.lease_until,
    slotTakenAt: r.slot_taken_at,
    refreshCount: r.refresh_count,
    conflictRounds: r.conflict_rounds,
    reason: r.reason,
    mergedBy: r.merged_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function one(client: Queryable, sql: string, params: unknown[]): Promise<MergeQueueEntry | null> {
  const { rows } = await client.query<Row>(sql, params);
  return rows[0] ? toEntry(rows[0]) : null;
}

async function many(client: Queryable, sql: string, params: unknown[]): Promise<MergeQueueEntry[]> {
  const { rows } = await client.query<Row>(sql, params);
  return rows.map(toEntry);
}

function assertCode(code: string): void {
  if (!CODE_RE.test(code)) throw new MergeQueueError("bad_input");
}

function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) throw new MergeQueueError("bad_input");
}

function assertLease(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new MergeQueueError("bad_input");
}

/** `null` makes the SQL fall back to the database clock. */
const nowParam = (now: Date | undefined): Date | null => now ?? null;

// ---- reads ---------------------------------------------------------------------------------------------------------------------

export async function getEntry(client: Queryable, accountId: string, entryId: string): Promise<MergeQueueEntry | null> {
  return one(client, `SELECT ${COLUMNS} FROM merge_queue_entries WHERE account_id = $1 AND id = $2`, [accountId, entryId]);
}

export async function getEntryByWorkItem(client: Queryable, accountId: string, workItemId: string): Promise<MergeQueueEntry | null> {
  return one(client, `SELECT ${COLUMNS} FROM merge_queue_entries WHERE account_id = $1 AND work_item_id = $2`, [accountId, workItemId]);
}

/**
 * A repo's queue in order: every entry that is not final, plus the final ones some live stacked child still names as its parent (a
 * merged parent is what makes the child eligible; a closed one is what stops it).
 */
export async function readQueue(client: Queryable, accountId: string, repoId: string): Promise<MergeQueueEntry[]> {
  return many(
    client,
    `SELECT ${COLUMNS} FROM merge_queue_entries
      WHERE account_id = $1 AND repo_id = $2
        AND (state IN ('in_review', 'queued', 'in_flight', 'awaiting_work', 'stopped')
             OR pr_number IN (SELECT depends_on_pr_number FROM merge_queue_entries
                               WHERE account_id = $1 AND repo_id = $2 AND depends_on_pr_number IS NOT NULL
                                 AND state IN ('queued', 'awaiting_work', 'in_review', 'stopped')))
      ORDER BY approved_at, pr_number`,
    [accountId, repoId],
  );
}

/**
 * How many entries are ahead of this one in its repo's queue, computed at read time (never stored): the holder of the slot, and every
 * queued or waiting-for-work entry that sorts earlier. It is the number behind "Waiting to merge: {n} ahead of it".
 */
export async function countAhead(client: Queryable, accountId: string, entryId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM merge_queue_entries me
       JOIN merge_queue_entries o ON o.account_id = me.account_id AND o.repo_id = me.repo_id AND o.id <> me.id
      WHERE me.account_id = $1 AND me.id = $2
        AND (o.state = 'in_flight'
             OR (o.state IN ('queued', 'awaiting_work') AND (o.approved_at, o.pr_number) < (me.approved_at, me.pr_number)))`,
    [accountId, entryId],
  );
  return rows[0]?.n ?? 0;
}

// ---- enqueue -------------------------------------------------------------------------------------------------------------------

export interface EnqueueInput {
  accountId: string;
  repoId: string;
  workItemId: string;
  prNumber: number;
  /** The head the reviewers passed. */
  headSha: string;
  /** The open PR this one is stacked on, when its base branch is not the default branch. */
  dependsOnPrNumber?: number | null;
  /** The moment the item's reviewers first all passed. Used only when the entry is created; an existing entry keeps its own. */
  approvedAt: Date;
}

export type EnqueueOutcome =
  /** A new entry. */
  | "created"
  /** An existing entry went back to `queued` (a new reviewed head, or it was waiting in review). It kept its `approved_at`. */
  | "requeued"
  /** Nothing to do: the same head is already queued, in flight, waiting for work, or stopped. */
  | "unchanged"
  /** The entry is final (merged, closed or cancelled). Nothing was changed. */
  | "final";

/**
 * Puts an approved item's PR in its repo's queue. Idempotent per work item, so a replayed workflow step is harmless, and a work item
 * has one entry for its whole life: coming back from a fix keeps `approved_at`, which is what keeps its place.
 *
 * Calling it for an entry that is not final but sits on a different head means the item was reviewed again on a new head: the entry
 * goes back to `queued` on that head and lets go of any slot or fix round it held.
 */
export async function enqueueEntry(client: Queryable, input: EnqueueInput): Promise<{ entry: MergeQueueEntry; outcome: EnqueueOutcome }> {
  if (!Number.isInteger(input.prNumber) || input.prNumber < 1) throw new MergeQueueError("bad_input");
  assertSha(input.headSha);
  const dependsOn = input.dependsOnPrNumber ?? null;
  if (dependsOn !== null && (!Number.isInteger(dependsOn) || dependsOn < 1 || dependsOn === input.prNumber)) throw new MergeQueueError("bad_input");

  const created = await one(
    client,
    `INSERT INTO merge_queue_entries (account_id, repo_id, work_item_id, pr_number, head_sha, depends_on_pr_number, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (account_id, work_item_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.accountId, input.repoId, input.workItemId, input.prNumber, input.headSha, dependsOn, input.approvedAt],
  );
  if (created) return { entry: created, outcome: "created" };

  const existing = await one(client, `SELECT ${COLUMNS} FROM merge_queue_entries WHERE account_id = $1 AND work_item_id = $2 FOR UPDATE`, [
    input.accountId,
    input.workItemId,
  ]);
  if (!existing) throw new MergeQueueError("bad_input"); // deleted between the two statements; the step retries
  if (existing.repoId !== input.repoId || existing.prNumber !== input.prNumber) throw new MergeQueueError("entry_pr_mismatch");
  if (existing.state === "merged" || existing.state === "closed" || existing.state === "cancelled") return { entry: existing, outcome: "final" };

  const sameHead = existing.headSha === input.headSha && existing.dependsOnPrNumber === dependsOn;
  if (sameHead && (existing.state === "queued" || existing.state === "in_flight" || existing.state === "awaiting_work" || existing.state === "stopped")) {
    return { entry: existing, outcome: "unchanged" };
  }

  const requeued = await one(
    client,
    `UPDATE merge_queue_entries
        SET state = 'queued', head_sha = $3, depends_on_pr_number = $4, reason = NULL, ${CLEAR_SLOT_AND_WORK}
      WHERE account_id = $1 AND id = $2 AND state IN ('in_review', 'queued', 'in_flight', 'awaiting_work', 'stopped')
      RETURNING ${COLUMNS}`,
    [input.accountId, existing.id, input.headSha, dependsOn],
  );
  if (!requeued) throw new MergeQueueError("bad_input"); // it became final under us; the step retries and reports `final`
  return { entry: requeued, outcome: "requeued" };
}

// ---- the slot ------------------------------------------------------------------------------------------------------------------

/**
 * Returns the slot of every entry in the repo whose lease has lapsed to `queued`, at its original position. Compare-and-set on the
 * row, so a holder that renewed in time is left alone and a tick racing the sweep cannot both reclaim and keep.
 */
export async function reclaimExpiredLeases(client: Queryable, input: { accountId: string; repoId: string; now?: Date }): Promise<MergeQueueEntry[]> {
  return many(
    client,
    `UPDATE merge_queue_entries
        SET state = 'queued', ${CLEAR_SLOT_AND_WORK}
      WHERE account_id = $1 AND repo_id = $2 AND state = 'in_flight' AND lease_until <= COALESCE($3::timestamptz, now())
      RETURNING ${COLUMNS}`,
    [input.accountId, input.repoId, nowParam(input.now)],
  );
}

/**
 * A stacked child whose parent PR ended without merging can never merge as it is: it stops with `merge_dependency_closed`. It stays
 * a stop (a person's call), not a silent wait.
 */
export async function stopOrphanedDependents(client: Queryable, input: { accountId: string; repoId: string }): Promise<MergeQueueEntry[]> {
  return many(
    client,
    `UPDATE merge_queue_entries c
        SET state = 'stopped', reason = 'merge_dependency_closed', ${CLEAR_SLOT_AND_WORK}
      WHERE c.account_id = $1 AND c.repo_id = $2 AND c.state IN ('queued', 'awaiting_work') AND c.depends_on_pr_number IS NOT NULL
        AND EXISTS (SELECT 1 FROM merge_queue_entries p
                     WHERE p.account_id = c.account_id AND p.repo_id = c.repo_id AND p.pr_number = c.depends_on_pr_number
                       AND p.state IN ('closed', 'cancelled'))
      RETURNING ${COLUMNS}`,
    [input.accountId, input.repoId],
  );
}

export interface TakeSlotInput {
  accountId: string;
  repoId: string;
  /** Names this attempt. Only the holder it names can renew or release. */
  holder: string;
  /** What GitHub just said about each queued entry's PR, by entry id. An entry without facts is not eligible. */
  facts: ReadonlyMap<string, PrFacts>;
  now?: Date;
  leaseSeconds?: number;
}

export type TakeSlotResult = {
  /** The entry that now holds the slot, or null. */
  taken: MergeQueueEntry | null;
  /** Why nothing was taken: another entry holds a live lease, nothing is eligible, or a concurrent attempt got there first. */
  skipped: "slot_busy" | "nothing_eligible" | "lost_race" | null;
  /** Entries whose lapsed lease this call returned to the queue. */
  reclaimed: MergeQueueEntry[];
  /** Stacked children this call stopped because their parent ended unmerged. */
  stopped: MergeQueueEntry[];
};

/**
 * One attempt to take the repo's merge slot, for the earliest eligible entry. It first returns lapsed leases to the queue and stops
 * orphaned stacked children, then picks by `approved_at` and PR number. Safe to run at the same time as itself, the sweep, or another
 * tick: the take is a compare-and-set on the entry (`state = 'queued'`), and the partial unique index refuses a second holder even if
 * two attempts chose different entries.
 */
export async function takeSlot(client: Queryable, input: TakeSlotInput): Promise<TakeSlotResult> {
  const leaseSeconds = input.leaseSeconds ?? MERGE_QUEUE_LEASE_SECONDS;
  assertLease(leaseSeconds);
  if (input.holder.length < 1 || input.holder.length > 100) throw new MergeQueueError("bad_input");

  const reclaimed = await reclaimExpiredLeases(client, input);
  const stopped = await stopOrphanedDependents(client, input);
  const entries = await readQueue(client, input.accountId, input.repoId);

  if (entries.some((e) => e.state === "in_flight")) return { taken: null, skipped: "slot_busy", reclaimed, stopped };
  const next = pickNext(entries, eligibilityContext(entries, input.facts, input.now));
  if (!next) return { taken: null, skipped: "nothing_eligible", reclaimed, stopped };

  await client.query("SAVEPOINT merge_queue_take");
  try {
    const taken = await one(
      client,
      `UPDATE merge_queue_entries
          SET state = 'in_flight', slot_holder = $3, slot_taken_at = COALESCE($4::timestamptz, now()),
              lease_until = COALESCE($4::timestamptz, now()) + make_interval(secs => $5), phase = NULL
        WHERE account_id = $1 AND id = $2 AND state = 'queued'
        RETURNING ${COLUMNS}`,
      [input.accountId, next.id, input.holder, nowParam(input.now), leaseSeconds],
    );
    await client.query("RELEASE SAVEPOINT merge_queue_take");
    // Zero rows: another attempt moved the entry (took it, or sent it to review) between our read and our write.
    return taken ? { taken, skipped: null, reclaimed, stopped } : { taken: null, skipped: "lost_race", reclaimed, stopped };
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT merge_queue_take");
    // The partial unique index: another entry of this repo took the slot first.
    if ((err as { code?: string }).code === "23505") return { taken: null, skipped: "slot_busy", reclaimed, stopped };
    throw err;
  }
}

/**
 * The holder's heartbeat: moves the lease out to now + `leaseSeconds` (and records the phase it is in). Answers null when the holder
 * has lost the slot (its lease lapsed, or the entry was reclaimed, released or ended): the caller must stop at once and do nothing
 * with the PR. A lapsed lease is never revived by a late renewal.
 */
export async function renewSlot(
  client: Queryable,
  input: { accountId: string; entryId: string; holder: string; phase?: string | null; now?: Date; leaseSeconds?: number },
): Promise<MergeQueueEntry | null> {
  const leaseSeconds = input.leaseSeconds ?? MERGE_QUEUE_LEASE_SECONDS;
  assertLease(leaseSeconds);
  if (input.phase != null) assertCode(input.phase);
  return one(
    client,
    `UPDATE merge_queue_entries
        SET lease_until = COALESCE($4::timestamptz, now()) + make_interval(secs => $5), phase = COALESCE($6, phase)
      WHERE account_id = $1 AND id = $2 AND state = 'in_flight' AND slot_holder = $3 AND lease_until > COALESCE($4::timestamptz, now())
      RETURNING ${COLUMNS}`,
    [input.accountId, input.entryId, input.holder, nowParam(input.now), leaseSeconds, input.phase ?? null],
  );
}

/** The phase of a holder whose tick ended while it waits (for CI, or for GitHub to apply a refresh). No tick is working on it, so the next one may adopt it. */
export const PARKED_PHASE = "parked";

/**
 * D#519 MQ3-b: a tick that must wait (CI still running, GitHub not done) ends and keeps the slot, so entries behind it cannot overtake.
 * The next tick, from a webhook or the sweep, takes it over here: a compare-and-set on `phase = 'parked'` with a live lease, so of two
 * ticks racing for it exactly one wins, and a tick that is mid-merge (any other phase) is never taken over. Null when nothing is parked.
 */
export async function adoptParkedSlot(client: Queryable, input: { accountId: string; repoId: string; holder: string; now?: Date; leaseSeconds?: number }): Promise<MergeQueueEntry | null> {
  const leaseSeconds = input.leaseSeconds ?? MERGE_QUEUE_LEASE_SECONDS;
  assertLease(leaseSeconds);
  return one(
    client,
    `UPDATE merge_queue_entries
        SET slot_holder = $3, phase = NULL, lease_until = COALESCE($4::timestamptz, now()) + make_interval(secs => $5)
      WHERE account_id = $1 AND repo_id = $2 AND state = 'in_flight' AND phase = '${PARKED_PHASE}' AND lease_until > COALESCE($4::timestamptz, now())
      RETURNING ${COLUMNS}`,
    [input.accountId, input.repoId, input.holder, nowParam(input.now), leaseSeconds],
  );
}

/**
 * A stopped `ci_not_green` entry returns to the queue, at its original position, when a check or status finishes on its head (or on a
 * head it was refreshed to) or on its pull request. Every other stop stays a stop: only a person ends those.
 */
export async function requeueCiStopped(client: Queryable, input: { accountId: string; repoId: string; prNumbers?: readonly number[]; headSha?: string }): Promise<MergeQueueEntry[]> {
  if (input.headSha !== undefined) assertSha(input.headSha);
  return many(
    client,
    `UPDATE merge_queue_entries e SET state = 'queued', reason = NULL, ${CLEAR_SLOT_AND_WORK}
      WHERE e.account_id = $1 AND e.repo_id = $2 AND e.state = 'stopped' AND e.reason = 'ci_not_green'
        AND (e.pr_number = ANY($3::int[]) OR e.head_sha = $4 OR EXISTS (SELECT 1 FROM head_refreshes h WHERE h.account_id = e.account_id AND h.entry_id = e.id AND h.to_sha = $4))
      RETURNING ${COLUMNS}`,
    [input.accountId, input.repoId, [...(input.prNumbers ?? [])], input.headSha ?? null],
  );
}

/** The holder gives the slot back; the entry stays queued at its original position. Null when the caller no longer holds it. */
export async function releaseToQueue(client: Queryable, input: { accountId: string; entryId: string; holder: string }): Promise<MergeQueueEntry | null> {
  return one(
    client,
    `UPDATE merge_queue_entries SET state = 'queued', ${CLEAR_SLOT_AND_WORK}
      WHERE account_id = $1 AND id = $2 AND state = 'in_flight' AND slot_holder = $3
      RETURNING ${COLUMNS}`,
    [input.accountId, input.entryId, input.holder],
  );
}

export type ReleaseForWorkResult =
  | { ok: true; entry: MergeQueueEntry }
  /** The caller no longer holds the slot. */
  | { ok: false; reason: "slot_lost" }
  /** A `conflict` or `renumber` round would pass MAX_CONFLICT_ROUNDS. Nothing was changed. */
  | { ok: false; reason: "rounds_exhausted" }
  /** A plan write-back never starts an agent run (R-598-P5b-3); the database refuses it as well. Nothing was changed. */
  | { ok: false; reason: "not_a_work_item_entry" };

/**
 * Starting any agent run for an entry (a conflict fix, a renumber, a delta review) goes through here, in the SAME transaction that
 * records the round the caller makes: the slot is released and the work is recorded by one UPDATE, so no moment exists in which the
 * entry holds the slot while an agent runs, and none in which a run exists with the slot gone and nothing noting it.
 *
 * The entry becomes `awaiting_work`: ineligible, at its original position, until `finishWork`. `conflict` and `renumber` rounds count
 * against MAX_CONFLICT_ROUNDS; a third is refused here as well as by the caller's own check.
 */
export async function releaseForWork(
  client: Queryable,
  input: { accountId: string; entryId: string; holder: string; kind: WorkKind; runId?: string | null },
): Promise<ReleaseForWorkResult> {
  const counts = input.kind === "conflict" || input.kind === "renumber" ? 1 : 0;
  const entry = await one(
    client,
    `UPDATE merge_queue_entries
        SET state = 'awaiting_work', phase = NULL, slot_holder = NULL, lease_until = NULL, slot_taken_at = NULL,
            work_kind = $4, work_run_id = $5, conflict_rounds = conflict_rounds + $6
      WHERE account_id = $1 AND id = $2 AND state = 'in_flight' AND slot_holder = $3 AND entry_kind = 'work_item' AND ($6 = 0 OR conflict_rounds < $7)
      RETURNING ${COLUMNS}`,
    [input.accountId, input.entryId, input.holder, input.kind, input.runId ?? null, counts, MAX_CONFLICT_ROUNDS],
  );
  if (entry) return { ok: true, entry };
  const current = await getEntry(client, input.accountId, input.entryId);
  if (current && current.state === "in_flight" && current.slotHolder === input.holder) {
    return { ok: false, reason: current.entryKind === "plan_writeback" ? "not_a_work_item_entry" : "rounds_exhausted" };
  }
  return { ok: false, reason: "slot_lost" };
}

/**
 * The agent run and its CI are done: the entry is eligible again at its original position. `headSha` is the head the work produced
 * (the reviewed head after a delta review), when it changed. Null when the entry is not waiting for work.
 */
export async function finishWork(client: Queryable, input: { accountId: string; entryId: string; headSha?: string }): Promise<MergeQueueEntry | null> {
  if (input.headSha !== undefined) assertSha(input.headSha);
  return one(
    client,
    `UPDATE merge_queue_entries SET state = 'queued', head_sha = COALESCE($3, head_sha), ${CLEAR_SLOT_AND_WORK}
      WHERE account_id = $1 AND id = $2 AND state = 'awaiting_work'
      RETURNING ${COLUMNS}`,
    [input.accountId, input.entryId, input.headSha ?? null],
  );
}

// ---- ending an entry -----------------------------------------------------------------------------------------------------------

/**
 * The gate merged the PR (`mergedBy: "gate"`, which needs the slot's holder) or a person merged it outside the queue
 * (`mergedBy: "person"`, from any live state). Final; the slot, if held, is released by the same write.
 */
export async function markMerged(
  client: Queryable,
  input: { accountId: string; entryId: string; mergedBy: MergedBy; holder?: string },
): Promise<MergeQueueEntry | null> {
  if (input.mergedBy === "gate" && !input.holder) throw new MergeQueueError("bad_input");
  return one(
    client,
    `UPDATE merge_queue_entries SET state = 'merged', merged_by = $3, reason = NULL, ${CLEAR_SLOT_AND_WORK}
      WHERE account_id = $1 AND id = $2 AND state IN ('in_review', 'queued', 'in_flight', 'awaiting_work', 'stopped')
        AND ($3 <> 'gate' OR (state = 'in_flight' AND slot_holder = $4))
      RETURNING ${COLUMNS}`,
    [input.accountId, input.entryId, input.mergedBy, input.holder ?? null],
  );
}

/**
 * The entry needs a person. `reason` is a fixed block code (never text from GitHub or a model). If the entry holds the slot and
 * `holder` is given, it must be that holder. Releases the slot.
 */
export async function stopEntry(client: Queryable, input: { accountId: string; entryId: string; reason: string; holder?: string }): Promise<MergeQueueEntry | null> {
  assertCode(input.reason);
  return one(
    client,
    `UPDATE merge_queue_entries SET state = 'stopped', reason = $3, ${CLEAR_SLOT_AND_WORK}
      WHERE account_id = $1 AND id = $2 AND state IN ('in_review', 'queued', 'in_flight', 'awaiting_work')
        AND ($4::text IS NULL OR state <> 'in_flight' OR slot_holder = $4)
      RETURNING ${COLUMNS}`,
    [input.accountId, input.entryId, input.reason, input.holder ?? null],
  );
}

/** The item is back in review (a person pushed, or a person merged the default branch into it). The entry keeps `approved_at` and lets go of the slot. */
export async function returnToReview(client: Queryable, input: { accountId: string; entryId: string }): Promise<MergeQueueEntry | null> {
  return one(
    client,
    `UPDATE merge_queue_entries SET state = 'in_review', reason = NULL, ${CLEAR_SLOT_AND_WORK}
      WHERE account_id = $1 AND id = $2 AND state IN ('queued', 'in_flight', 'awaiting_work', 'stopped')
      RETURNING ${COLUMNS}`,
    [input.accountId, input.entryId],
  );
}

/**
 * A pull request ended outside the queue: a person merged it (`merged: true`, recorded as merged by a person) or closed it. Finds the
 * entry by PR number; null when there is none or it is already final. Dependants become eligible (merged) or stop (closed) on the
 * next take.
 */
export async function settlePullRequest(
  client: Queryable,
  input: { accountId: string; repoId: string; prNumber: number; merged: boolean },
): Promise<MergeQueueEntry | null> {
  if (input.merged) {
    return one(
      client,
      // A pull request the host's queue merged (the webhook has written `merged_via_queue` before it settles the entry, or the item still reads as queued) was put there by the gate, so the queue's merge is the gate's; any other merge is a person's.
      `UPDATE merge_queue_entries e SET state = 'merged', reason = NULL, ${CLEAR_SLOT_AND_WORK},
              merged_by = CASE WHEN e.work_item_id IS NOT NULL AND (${isQueuedSql("e.account_id", "e.work_item_id", "e.pr_number")}
                                 OR EXISTS (SELECT 1 FROM work_item_driver_events n WHERE n.account_id = e.account_id AND n.work_item_id = e.work_item_id AND n.kind = 'merged_via_queue' AND n.pr_number = e.pr_number))
                               THEN 'gate' ELSE 'person' END
        WHERE e.account_id = $1 AND e.repo_id = $2 AND e.pr_number = $3 AND e.state IN ('in_review', 'queued', 'in_flight', 'awaiting_work', 'stopped')
        RETURNING ${COLUMNS}`,
      [input.accountId, input.repoId, input.prNumber],
    );
  }
  return one(
    client,
    `UPDATE merge_queue_entries SET state = 'closed', reason = NULL, ${CLEAR_SLOT_AND_WORK}
      WHERE account_id = $1 AND repo_id = $2 AND pr_number = $3 AND state IN ('in_review', 'queued', 'in_flight', 'awaiting_work', 'stopped')
      RETURNING ${COLUMNS}`,
    [input.accountId, input.repoId, input.prNumber],
  );
}

/**
 * D#694 B6-3: the entries of a repo whose pull request is waiting in the host's merge queue, in queue order. Derived from the item's driver facts (mergeReadiness.ts
 * `isQueuedSql`), never stored: the entry stays `queued`, holds no slot (the unique in-flight index allows one, and the host's queue takes several), and the tick counts
 * these against the rule's `max_entries_to_build` and leaves them out of every take.
 */
export async function readHostQueued(client: Queryable, accountId: string, repoId: string): Promise<Array<{ entryId: string; prNumber: number }>> {
  const { rows } = await client.query<{ id: string; pr_number: number }>(
    `SELECT e.id, e.pr_number FROM merge_queue_entries e
      WHERE e.account_id = $1 AND e.repo_id = $2 AND e.state = 'queued' AND e.entry_kind = 'work_item' AND e.work_item_id IS NOT NULL AND ${isQueuedSql("e.account_id", "e.work_item_id", "e.pr_number")}
      ORDER BY e.approved_at, e.pr_number`,
    [accountId, repoId],
  );
  return rows.map((r) => ({ entryId: r.id, prNumber: r.pr_number }));
}

/** The entries of a repo whose item is halted: the take leaves them out, so nothing is enqueued, retried or merged for an item a person stopped. */
export async function readHaltedEntries(client: Queryable, accountId: string, repoId: string): Promise<ReadonlySet<string>> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT e.id FROM merge_queue_entries e JOIN work_items w ON w.account_id = e.account_id AND w.id = e.work_item_id
      WHERE e.account_id = $1 AND e.repo_id = $2 AND e.state = 'queued' AND w.halted_at IS NOT NULL`,
    [accountId, repoId],
  );
  return new Set(rows.map((r) => r.id));
}

export type HostRemovalVerdict =
  /** No removal of the head last enqueued for this pull request. */
  | { verdict: "none" }
  /** The first removal by GitHub: queue it again once. */
  | { verdict: "retry"; headSha: string }
  /** A person took it out: no automatic action follows. */
  | { verdict: "removed"; headSha: string }
  /** The second removal of the same head: the one automatic retry is used up. */
  | { verdict: "exhausted"; headSha: string };

/**
 * D#694 B6-3: what the facts say about the head last enqueued for the entry's own pull request, decided from the driver facts alone (never from a counter and never
 * from whether the webhook's settle ran). Removals of any other pull request of the item, or of another head, are not counted.
 */
export async function removalVerdict(client: Queryable, entry: Pick<MergeQueueEntry, "accountId" | "workItemId" | "prNumber">): Promise<HostRemovalVerdict> {
  if (entry.workItemId === null) return { verdict: "none" };
  const { rows } = await client.query<{ head_sha: string | null }>(
    `SELECT head_sha FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'merge_enqueued' AND pr_number = $3 ORDER BY seq DESC LIMIT 1`,
    [entry.accountId, entry.workItemId, entry.prNumber],
  );
  const headSha = rows[0]?.head_sha ?? null;
  if (headSha === null) return { verdict: "none" };
  const removals = await listHeadRemovals(client, entry.accountId, entry.workItemId, headSha, entry.prNumber);
  if (removals.length === 0) return { verdict: "none" };
  if (removalRetryAllowed(removals)) return { verdict: "retry", headSha };
  return { verdict: removedByPerson(removals[removals.length - 1]!.reasons) ? "removed" : "exhausted", headSha };
}

const removalStopReason = (v: "removed" | "exhausted"): string => (v === "removed" ? HOST_DEQUEUED_REASON : HOST_RETRY_USED_REASON);

export type HostDequeueSettled =
  /** The first removal by GitHub of a head: the entry stays queued, no longer reads as waiting there, and the next take runs the gate on the same head again. */
  | { outcome: "retry"; entry: MergeQueueEntry }
  /** A person took it out: the entry stops (reason `removed_from_merge_queue`) and waits for a person to queue it again. */
  | { outcome: "removed"; entry: MergeQueueEntry }
  /** The second removal of the same head: the one automatic retry is used. The entry stops (reason `merge_queue_retry_used`); the caller hands the item to a person. */
  | { outcome: "exhausted"; entry: MergeQueueEntry }
  | { outcome: "ignored" };

/**
 * D#694 B6-3 (replacing B6-2's stop): the host's queue removed a pull request without merging it. The webhook's fast path for `removalVerdict`; the tick decides the same
 * from the same facts when it takes the entry, so a settle that never ran changes nothing. Applies to the `queued` entry of this repository and pull request whose last
 * enqueued head is the one removed; a head the item has moved on from, an entry that is not waiting there, a final entry and a replay change nothing. Scoped to `repo_id`.
 */
export async function settleHostDequeue(client: Queryable, input: { accountId: string; repoId: string; prNumber: number; headSha: string }): Promise<HostDequeueSettled> {
  assertSha(input.headSha);
  const entry = await one(
    client,
    `SELECT ${COLUMNS} FROM merge_queue_entries e WHERE e.account_id = $1 AND e.repo_id = $2 AND e.pr_number = $3 AND e.state = 'queued' AND e.work_item_id IS NOT NULL`,
    [input.accountId, input.repoId, input.prNumber],
  );
  if (!entry) return { outcome: "ignored" };
  const v = await removalVerdict(client, entry);
  if (v.verdict === "none" || v.headSha !== input.headSha) return { outcome: "ignored" };
  if (v.verdict === "retry") return { outcome: "retry", entry };
  const stopped = await one(
    client,
    `UPDATE merge_queue_entries SET state = 'stopped', reason = $3, ${CLEAR_SLOT_AND_WORK} WHERE account_id = $1 AND id = $2 AND state = 'queued' RETURNING ${COLUMNS}`,
    [input.accountId, entry.id, removalStopReason(v.verdict)],
  );
  return stopped ? { outcome: v.verdict, entry: stopped } : { outcome: "ignored" };
}

/**
 * D#694 B6-3: the take-time guard. For the entry that now holds the slot, `removalVerdict`; a person's removal or a used-up retry of the head the entry is about to be
 * gated on stops it (releasing the slot) instead of enqueueing it again. Answers the stopped entry and the verdict, or null to go on.
 */
export async function stopOnRemovals(client: Queryable, input: { entry: MergeQueueEntry; holder: string }): Promise<{ verdict: "removed" | "exhausted"; entry: MergeQueueEntry; headSha: string } | null> {
  const v = await removalVerdict(client, input.entry);
  // The head the entry is gated on (and so the one enqueued) is the reviewed head followed through its verified refreshes.
  const tip = refreshTip(input.entry.headSha, await listHeadRefreshes(client, input.entry.accountId, input.entry.id));
  if ((v.verdict !== "removed" && v.verdict !== "exhausted") || v.headSha !== tip) return null;
  const stopped = await stopEntry(client, { accountId: input.entry.accountId, entryId: input.entry.id, reason: removalStopReason(v.verdict), holder: input.holder });
  return stopped ? { verdict: v.verdict, entry: stopped, headSha: v.headSha } : null;
}

/** The item was cancelled: its entry ends, its slot (if any) is released. The caller cancels any running fix round through the runner's own cancel. */
export async function cancelWorkItemEntry(
  client: Queryable,
  input: { accountId: string; workItemId: string; reason?: string },
): Promise<MergeQueueEntry | null> {
  const reason = input.reason ?? "work_item_cancelled";
  assertCode(reason);
  return one(
    client,
    `UPDATE merge_queue_entries SET state = 'cancelled', reason = $3, ${CLEAR_SLOT_AND_WORK}
      WHERE account_id = $1 AND work_item_id = $2 AND state IN ('in_review', 'queued', 'in_flight', 'awaiting_work', 'stopped')
      RETURNING ${COLUMNS}`,
    [input.accountId, input.workItemId, reason],
  );
}

/** The App was uninstalled or the repo disconnected: every live entry of the repo ends as `cancelled` with `repo_disconnected`. */
export async function cancelRepoEntries(client: Queryable, input: { accountId: string; repoId: string; reason?: string }): Promise<MergeQueueEntry[]> {
  const reason = input.reason ?? "repo_disconnected";
  assertCode(reason);
  return many(
    client,
    `UPDATE merge_queue_entries SET state = 'cancelled', reason = $3, ${CLEAR_SLOT_AND_WORK}
      WHERE account_id = $1 AND repo_id = $2 AND state IN ('in_review', 'queued', 'in_flight', 'awaiting_work', 'stopped')
      RETURNING ${COLUMNS}`,
    [input.accountId, input.repoId, reason],
  );
}

// ---- refreshes -----------------------------------------------------------------------------------------------------------------

export type RecordRefreshResult =
  | { recorded: true; entry: MergeQueueEntry }
  /** This refresh (the same new head) was already recorded; nothing changed. */
  | { recorded: false; reason: "duplicate" }
  /** The caller does not hold the slot. */
  | { recorded: false; reason: "not_holder" };

/**
 * Records a platform refresh the caller has already verified (MQ3 checks the two parents and the App's identity first): one
 * `head_refreshes` row and one step on the entry's refresh counter, together. Only the slot's holder may record one, and recording
 * the same new head twice counts once.
 */
export async function recordHeadRefresh(
  client: Queryable,
  input: { accountId: string; entryId: string; holder: string; fromSha: string; toSha: string; baseSha: string; filesOverlap?: boolean },
): Promise<RecordRefreshResult> {
  assertSha(input.fromSha);
  assertSha(input.toSha);
  assertSha(input.baseSha);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO head_refreshes (account_id, repo_id, work_item_id, entry_id, from_sha, to_sha, base_sha, files_overlap)
     SELECT e.account_id, e.repo_id, e.work_item_id, e.id, $3, $4, $5, $7
       FROM merge_queue_entries e
      WHERE e.account_id = $1 AND e.id = $2 AND e.state = 'in_flight' AND e.slot_holder = $6
     ON CONFLICT (account_id, entry_id, to_sha) DO NOTHING
     RETURNING id`,
    // No answer reads as overlapping: a row nobody classified carries nothing (migration 0862).
    [input.accountId, input.entryId, input.fromSha, input.toSha, input.baseSha, input.holder, input.filesOverlap ?? true],
  );
  if (rows.length === 0) {
    const current = await getEntry(client, input.accountId, input.entryId);
    return current && current.state === "in_flight" && current.slotHolder === input.holder
      ? { recorded: false, reason: "duplicate" }
      : { recorded: false, reason: "not_holder" };
  }
  const entry = await one(
    client,
    `UPDATE merge_queue_entries SET refresh_count = refresh_count + 1 WHERE account_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [input.accountId, input.entryId],
  );
  if (!entry) throw new MergeQueueError("bad_input");
  return { recorded: true, entry };
}

export interface HeadRefreshRow {
  fromSha: string;
  toSha: string;
  baseSha: string;
  filesOverlap: boolean;
  /** When the row was written (MQ3-b measures the bounded CI wait from the last refresh). Absent on a hand-built row. */
  createdAt?: Date;
}

/**
 * C4 2.4: the delta review of this refresh was skipped because the merge touched none of the PR's files. Written once, by the step that
 * decided it; the gate then lets the reviewed head's passes carry across this hop (see `loadEffectiveRunsOnSha`).
 */
export async function markDeltaSkipped(client: Queryable, input: { accountId: string; entryId: string; toSha: string }): Promise<boolean> {
  assertSha(input.toSha);
  const r = await client.query(`UPDATE head_refreshes SET delta_review_skipped = 'main_side_only' WHERE account_id = $1 AND entry_id = $2 AND to_sha = $3`, [input.accountId, input.entryId, input.toSha]);
  return r.rowCount === 1;
}

/** The refreshes recorded for one entry, oldest first. */
/** The head the entry has reached through verified refreshes: from the reviewed head, follow `from -> to` rows. */
export function refreshTip(reviewedHead: string, refreshes: readonly HeadRefreshRow[]): string {
  let cur = reviewedHead;
  const seen = new Set([cur]);
  for (;;) {
    const next = refreshes.find((r) => r.fromSha === cur);
    if (!next || seen.has(next.toSha)) return cur;
    seen.add(next.toSha);
    cur = next.toSha;
  }
}

export async function listHeadRefreshes(client: Queryable, accountId: string, entryId: string): Promise<HeadRefreshRow[]> {
  const { rows } = await client.query<{ from_sha: string; to_sha: string; base_sha: string; files_overlap: boolean; created_at: Date }>(
    `SELECT from_sha, to_sha, base_sha, files_overlap, created_at FROM head_refreshes WHERE account_id = $1 AND entry_id = $2 ORDER BY created_at, id`,
    [accountId, entryId],
  );
  return rows.map((r) => ({ fromSha: r.from_sha, toSha: r.to_sha, baseSha: r.base_sha, filesOverlap: r.files_overlap, createdAt: r.created_at }));
}

/**
 * D#519 MQ3-a: the entry's record that the step asked GitHub to update the branch from `fromSha` (null clears it). Written BEFORE the
 * update-branch call, by the slot holder; read by a later step to decide whether a head it did not leave behind can be our own refresh
 * that finished after a crash. A head nobody asked for is never treated as one. False when the caller no longer holds the slot.
 */
export async function markRefreshRequested(client: Queryable, input: { accountId: string; entryId: string; holder: string; fromSha: string | null }): Promise<boolean> {
  if (input.fromSha !== null) assertSha(input.fromSha);
  const { rows } = await client.query<{ id: string }>(
    `UPDATE merge_queue_entries SET refresh_requested_from = $4
      WHERE account_id = $1 AND id = $2 AND state = 'in_flight' AND slot_holder = $3
      RETURNING id`,
    [input.accountId, input.entryId, input.holder, input.fromSha],
  );
  return rows.length === 1;
}

/** The head the last recorded update-branch request was made from, or null. */
export async function readRefreshRequested(client: Queryable, accountId: string, entryId: string): Promise<string | null> {
  const { rows } = await client.query<{ refresh_requested_from: string | null }>(
    `SELECT refresh_requested_from FROM merge_queue_entries WHERE account_id = $1 AND id = $2`,
    [accountId, entryId],
  );
  return rows[0]?.refresh_requested_from ?? null;
}

/** Notes the run a round started on an entry that is already `awaiting_work` (the run is started after the slot is released). */
export async function attachWorkRun(client: Queryable, input: { accountId: string; entryId: string; runId: string }): Promise<MergeQueueEntry | null> {
  return one(client, `UPDATE merge_queue_entries SET work_run_id = $3 WHERE account_id = $1 AND id = $2 AND state = 'awaiting_work' RETURNING ${COLUMNS}`, [input.accountId, input.entryId, input.runId]);
}

// ---- plan write-back entries (D#598 P5b, migration 0825) -------------------------------------------------------------------------

export interface EnqueuePlanWritebackInput {
  accountId: string;
  repoId: string;
  /** The platform's record in `plan_writebacks`. One entry per record for its whole life. */
  planWritebackId: string;
  prNumber: number;
  /** The head the platform pushed. */
  headSha: string;
  /** The moment the platform first pushed that head. A one-time stamp, as for any entry: a coalesced push does not change it. */
  approvedAt: Date;
}

/**
 * Puts the platform's write-back PR in its repo's queue, with no work item. Idempotent per `planWritebackId`: a replayed step finds the
 * entry and changes nothing. The yield rule and the head rule live in eligibility.ts; nothing here starts an agent run.
 */
export async function enqueuePlanWriteback(
  client: Queryable,
  input: EnqueuePlanWritebackInput,
): Promise<{ entry: MergeQueueEntry; outcome: "created" | "unchanged" }> {
  if (!Number.isInteger(input.prNumber) || input.prNumber < 1) throw new MergeQueueError("bad_input");
  assertSha(input.headSha);
  const created = await one(
    client,
    `INSERT INTO merge_queue_entries (account_id, repo_id, entry_kind, plan_writeback_id, pr_number, head_sha, approved_at)
     VALUES ($1, $2, 'plan_writeback', $3, $4, $5, $6)
     ON CONFLICT (account_id, plan_writeback_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.accountId, input.repoId, input.planWritebackId, input.prNumber, input.headSha, input.approvedAt],
  );
  if (created) return { entry: created, outcome: "created" };
  const existing = await getEntryByPlanWriteback(client, input.accountId, input.planWritebackId);
  if (!existing) throw new MergeQueueError("bad_input"); // deleted between the two statements; the step retries
  if (existing.repoId !== input.repoId || existing.prNumber !== input.prNumber) throw new MergeQueueError("entry_pr_mismatch");
  return { entry: existing, outcome: "unchanged" };
}

export async function getEntryByPlanWriteback(client: Queryable, accountId: string, planWritebackId: string): Promise<MergeQueueEntry | null> {
  return one(client, `SELECT ${COLUMNS} FROM merge_queue_entries WHERE account_id = $1 AND plan_writeback_id = $2`, [accountId, planWritebackId]);
}

/**
 * Step one of a coalescing push to the write-back branch: take the entry out of the queue's reach (`in_review`: not eligible, keeps its
 * stamp) so the slot cannot be taken while the head moves. Only a `queued` entry can be held: a `stopped` entry stays stopped for a person (a
 * push never puts it back in the queue), and one that holds the slot or is final answers null. The caller must not push on null.
 */
export async function holdWritebackForPush(client: Queryable, input: { accountId: string; planWritebackId: string }): Promise<MergeQueueEntry | null> {
  return one(
    client,
    `UPDATE merge_queue_entries SET state = 'in_review', reason = NULL, ${CLEAR_SLOT_AND_WORK}
      WHERE account_id = $1 AND plan_writeback_id = $2 AND state = 'queued'
      RETURNING ${COLUMNS}`,
    [input.accountId, input.planWritebackId],
  );
}

/** Step two: the push landed (`headSha` is the new recorded head) or failed (`headSha` omitted: the entry returns on its old head). */
export async function releaseWritebackAfterPush(
  client: Queryable,
  input: { accountId: string; planWritebackId: string; headSha?: string },
): Promise<MergeQueueEntry | null> {
  if (input.headSha !== undefined) assertSha(input.headSha);
  return one(
    client,
    `UPDATE merge_queue_entries SET state = 'queued', head_sha = COALESCE($3, head_sha), reason = NULL, ${CLEAR_SLOT_AND_WORK}
      WHERE account_id = $1 AND plan_writeback_id = $2 AND state = 'in_review'
      RETURNING ${COLUMNS}`,
    [input.accountId, input.planWritebackId, input.headSha ?? null],
  );
}

/** Ends a write-back's entry: `merged` (a person merged it), `closed` (closed unmerged) or `cancelled` (the platform replaced it). Null if already final. */
export async function endWritebackEntry(
  client: Queryable,
  input: { accountId: string; planWritebackId: string; how: "merged" | "closed" | "cancelled"; reason?: string },
): Promise<MergeQueueEntry | null> {
  if (input.how === "cancelled") {
    const reason = input.reason ?? "writeback_replaced";
    assertCode(reason);
    return one(
      client,
      `UPDATE merge_queue_entries SET state = 'cancelled', reason = $3, ${CLEAR_SLOT_AND_WORK}
        WHERE account_id = $1 AND plan_writeback_id = $2 AND state IN ('in_review', 'queued', 'in_flight', 'stopped')
        RETURNING ${COLUMNS}`,
      [input.accountId, input.planWritebackId, reason],
    );
  }
  return one(
    client,
    `UPDATE merge_queue_entries
        SET state = $3, merged_by = CASE WHEN $3 = 'merged' THEN 'person' ELSE NULL END, reason = NULL, ${CLEAR_SLOT_AND_WORK}
      WHERE account_id = $1 AND plan_writeback_id = $2 AND state IN ('in_review', 'queued', 'in_flight', 'stopped')
      RETURNING ${COLUMNS}`,
    [input.accountId, input.planWritebackId, input.how],
  );
}

// ---- conflict rounds (D#519 MQ4-a, migration 0948) ---------------------------------------------------------------------------------

interface RoundRow {
  id: string;
  account_id: string;
  repo_id: string;
  work_item_id: string;
  entry_id: string | null;
  round: number;
  from_sha: string;
  base_sha: string;
  base_ref: string;
  conflict_files: string[];
  run_id: string | null;
  to_sha: string | null;
  outcome: string | null;
  created_at: Date;
  ended_at: Date | null;
}

const ROUND_COLUMNS = `id, account_id, repo_id, work_item_id, entry_id, round, from_sha, base_sha, base_ref, conflict_files, run_id, to_sha, outcome, created_at, ended_at`;

const toRound = (r: RoundRow): ConflictRound => ({
  id: r.id,
  accountId: r.account_id,
  repoId: r.repo_id,
  workItemId: r.work_item_id,
  entryId: r.entry_id,
  round: r.round,
  fromSha: r.from_sha,
  baseSha: r.base_sha,
  baseRef: r.base_ref,
  conflictFiles: r.conflict_files,
  runId: r.run_id,
  toSha: r.to_sha,
  outcome: r.outcome,
  createdAt: r.created_at,
  endedAt: r.ended_at,
});

async function oneRound(client: Queryable, sql: string, params: unknown[]): Promise<ConflictRound | null> {
  const { rows } = await client.query<RoundRow>(sql, params);
  return rows[0] ? toRound(rows[0]) : null;
}

export type StartConflictWorkResult =
  | { ok: true; entry: MergeQueueEntry; round: ConflictRound }
  /** The named holder no longer holds the slot, or the entry is not `queued` (or `in_flight`). Nothing was changed. */
  | { ok: false; reason: "not_startable" }
  /** The entry has used MAX_CONFLICT_ROUNDS. Nothing was changed: no round row, and the entry is as it was. */
  | { ok: false; reason: "rounds_exhausted" }
  | { ok: false; reason: "not_a_work_item_entry" };

/**
 * A conflict round starts: a `queued` entry (it holds no slot), or the `in_flight` one `holder` holds, becomes `awaiting_work` with kind `conflict`, its
 * round counter steps, and the round's row is written, all by ONE statement, so no reader sees one without the others and a holder's slot is free in the
 * same transaction that records the round. A third round is refused here as well as by the caller. `fromSha` is the entry's head as stored. A path that
 * fails the database's path rule raises its `check_violation`; nothing is written then either.
 */
export async function startConflictWork(
  client: Queryable,
  input: { accountId: string; entryId: string; holder?: string; baseSha: string; baseRef: string; conflictFiles: readonly string[] },
): Promise<StartConflictWorkResult> {
  assertSha(input.baseSha);
  const { rows } = await client.query<Row & { round_id: string }>(
    `WITH e AS (
       UPDATE merge_queue_entries
          SET state = 'awaiting_work', phase = NULL, slot_holder = NULL, lease_until = NULL, slot_taken_at = NULL,
              work_kind = 'conflict', work_run_id = NULL, conflict_rounds = conflict_rounds + 1
        WHERE account_id = $1 AND id = $2 AND entry_kind = 'work_item' AND conflict_rounds < $3
          AND (state = 'queued' OR (state = 'in_flight' AND slot_holder = $4::text))
        RETURNING ${COLUMNS}
     ), r AS (
       INSERT INTO merge_conflict_rounds (account_id, repo_id, work_item_id, entry_id, round, from_sha, base_sha, base_ref, conflict_files)
       SELECT e.account_id, e.repo_id, e.work_item_id, e.id, e.conflict_rounds, e.head_sha, $5, $6, $7::text[] FROM e
       RETURNING id
     )
     SELECT e.*, r.id AS round_id FROM e, r`,
    [input.accountId, input.entryId, MAX_CONFLICT_ROUNDS, input.holder ?? null, input.baseSha, input.baseRef, [...input.conflictFiles]],
  );
  if (rows[0]) {
    const round = await oneRound(client, `SELECT ${ROUND_COLUMNS} FROM merge_conflict_rounds WHERE account_id = $1 AND id = $2`, [input.accountId, rows[0].round_id]);
    if (!round) throw new MergeQueueError("bad_input");
    return { ok: true, entry: toEntry(rows[0]), round };
  }
  const current = await getEntry(client, input.accountId, input.entryId);
  if (current && current.entryKind === "plan_writeback") return { ok: false, reason: "not_a_work_item_entry" };
  const startable = current !== null && (current.state === "queued" || (current.state === "in_flight" && current.slotHolder === (input.holder ?? null)));
  return { ok: false, reason: startable && current.conflictRounds >= MAX_CONFLICT_ROUNDS ? "rounds_exhausted" : "not_startable" };
}

/** The round's agent run, set once. Null when the round is unknown or already has one. */
export async function recordRoundRun(client: Queryable, input: { accountId: string; roundId: string; runId: string }): Promise<ConflictRound | null> {
  return oneRound(client, `UPDATE merge_conflict_rounds SET run_id = $3 WHERE account_id = $1 AND id = $2 AND run_id IS NULL RETURNING ${ROUND_COLUMNS}`, [input.accountId, input.roundId, input.runId]);
}

/** The head the round pushed, set once. Null when the round is unknown or already has one. */
export async function recordRoundHead(client: Queryable, input: { accountId: string; roundId: string; toSha: string }): Promise<ConflictRound | null> {
  assertSha(input.toSha);
  return oneRound(client, `UPDATE merge_conflict_rounds SET to_sha = $3 WHERE account_id = $1 AND id = $2 AND to_sha IS NULL RETURNING ${ROUND_COLUMNS}`, [input.accountId, input.roundId, input.toSha]);
}

/** The round's outcome (a fixed code) and its end time, set once. Null when the round is unknown or already ended. */
export async function endRound(client: Queryable, input: { accountId: string; roundId: string; outcome: string }): Promise<ConflictRound | null> {
  assertCode(input.outcome);
  return oneRound(client, `UPDATE merge_conflict_rounds SET outcome = $3, ended_at = now() WHERE account_id = $1 AND id = $2 AND outcome IS NULL RETURNING ${ROUND_COLUMNS}`, [input.accountId, input.roundId, input.outcome]);
}

/** The resolved round's work is now its delta review: `awaiting_work`/`conflict` becomes `awaiting_work`/`delta_review`. Null when the entry is not in that state. */
export async function switchToDeltaReview(client: Queryable, input: { accountId: string; entryId: string }): Promise<MergeQueueEntry | null> {
  return one(
    client,
    `UPDATE merge_queue_entries SET work_kind = 'delta_review', work_run_id = NULL
      WHERE account_id = $1 AND id = $2 AND state = 'awaiting_work' AND work_kind = 'conflict'
      RETURNING ${COLUMNS}`,
    [input.accountId, input.entryId],
  );
}

/** A work item's rounds, oldest first. */
export async function listConflictRounds(client: Queryable, accountId: string, workItemId: string): Promise<ConflictRound[]> {
  const { rows } = await client.query<RoundRow>(`SELECT ${ROUND_COLUMNS} FROM merge_conflict_rounds WHERE account_id = $1 AND work_item_id = $2 ORDER BY round`, [accountId, workItemId]);
  return rows.map(toRound);
}
