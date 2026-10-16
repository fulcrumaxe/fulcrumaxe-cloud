import type { PoolClient } from "pg";
import { MAX_CONFLICT_ROUNDS, MERGE_QUEUE_LEASE_SECONDS } from "./policy.js";
import { eligibilityContext, pickNext } from "./eligibility.js";
import { MergeQueueError, type MergeQueueEntry, type MergedBy, type PrFacts, type QueueState, type WorkKind } from "./types.js";

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

const COLUMNS = `id, account_id, repo_id, work_item_id, pr_number, head_sha, depends_on_pr_number, approved_at, state, phase, work_kind,
  work_run_id, slot_holder, lease_until, slot_taken_at, refresh_count, conflict_rounds, reason, merged_by, created_at, updated_at`;

/** Clears everything that only means something while an entry holds the slot or waits for work. */
const CLEAR_SLOT_AND_WORK = `phase = NULL, slot_holder = NULL, lease_until = NULL, slot_taken_at = NULL, work_kind = NULL, work_run_id = NULL`;

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SHA_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

interface Row {
  id: string;
  account_id: string;
  repo_id: string;
  work_item_id: string;
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
    workItemId: r.work_item_id,
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
  const next = pickNext(entries, eligibilityContext(entries, input.facts));
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
  | { ok: false; reason: "rounds_exhausted" };

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
      WHERE account_id = $1 AND id = $2 AND state = 'in_flight' AND slot_holder = $3 AND ($6 = 0 OR conflict_rounds < $7)
      RETURNING ${COLUMNS}`,
    [input.accountId, input.entryId, input.holder, input.kind, input.runId ?? null, counts, MAX_CONFLICT_ROUNDS],
  );
  if (entry) return { ok: true, entry };
  const current = await getEntry(client, input.accountId, input.entryId);
  if (current && current.state === "in_flight" && current.slotHolder === input.holder) return { ok: false, reason: "rounds_exhausted" };
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
      `UPDATE merge_queue_entries SET state = 'merged', merged_by = 'person', reason = NULL, ${CLEAR_SLOT_AND_WORK}
        WHERE account_id = $1 AND repo_id = $2 AND pr_number = $3 AND state IN ('in_review', 'queued', 'in_flight', 'awaiting_work', 'stopped')
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
  input: { accountId: string; entryId: string; holder: string; fromSha: string; toSha: string; baseSha: string },
): Promise<RecordRefreshResult> {
  assertSha(input.fromSha);
  assertSha(input.toSha);
  assertSha(input.baseSha);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO head_refreshes (account_id, repo_id, work_item_id, entry_id, from_sha, to_sha, base_sha)
     SELECT e.account_id, e.repo_id, e.work_item_id, e.id, $3, $4, $5
       FROM merge_queue_entries e
      WHERE e.account_id = $1 AND e.id = $2 AND e.state = 'in_flight' AND e.slot_holder = $6
     ON CONFLICT (account_id, entry_id, to_sha) DO NOTHING
     RETURNING id`,
    [input.accountId, input.entryId, input.fromSha, input.toSha, input.baseSha, input.holder],
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
