import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { providerCapacityOf } from "@fx/runner";

/**
 * D#483 S5-k3b-1: the capacity queue's helper. Our own capacity never refuses, stops or fails a customer's work: when every hosted sandbox slot is in use, or the
 * provider answers 429 to a create, the item waits here and starts when there is room. THIS FILE CHANGES NO START BEHAVIOUR: no start site calls it yet (S5-k3b-2
 * wires `advanceStartRun`, the close path and the claim triggers). It imports nothing from the plan-data package: the slot total is passed in as a function, so
 * the caller's reader (which throws when plan data has no figure) is the only source of the number.
 *
 * Where the work happens: the queue's four writes and its state read are SECURITY DEFINER functions (migration 0941). `capacity_enqueue` runs on the item's own
 * tenant session; claim, mark-started and the state read run on the run-writer login, across accounts. Nothing here deletes or updates a row directly.
 */

export const CAPACITY_CLASS = "hosted_sandbox" as const;

export const CAPACITY_SETTING_KEYS = { alertDepth: "capacity_queue.alert_depth", leaseSeconds: "capacity_queue.lease_seconds" } as const;
/** The provisional values that apply while the owner has written none (C5). They are starting values, not limits. */
export const CAPACITY_SETTING_DEFAULTS = { alertDepth: 20, leaseSeconds: 120 } as const;
/** The health line while any setting runs on its provisional value. */
export const CAPACITY_SETTINGS_DEFAULTED = "capacity_queue_settings_defaulted";

export interface CapacitySettings {
  alertDepth: number;
  leaseSeconds: number;
  /** The keys that have no stored row. */
  defaulted: string[];
  /** `capacity_queue_settings_defaulted` while any key is defaulted, else null. */
  health: typeof CAPACITY_SETTINGS_DEFAULTED | null;
}

/** The newest version of each key, or the provisional default when the owner has written none. */
export async function readCapacitySettings(pool: Pool): Promise<CapacitySettings> {
  const { rows } = await pool.query<{ key: string; value: number }>(`SELECT DISTINCT ON (key) key, value FROM capacity_queue_settings ORDER BY key, version DESC`);
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const defaulted = Object.values(CAPACITY_SETTING_KEYS).filter((k) => !stored.has(k));
  return {
    alertDepth: stored.get(CAPACITY_SETTING_KEYS.alertDepth) ?? CAPACITY_SETTING_DEFAULTS.alertDepth,
    leaseSeconds: stored.get(CAPACITY_SETTING_KEYS.leaseSeconds) ?? CAPACITY_SETTING_DEFAULTS.leaseSeconds,
    defaulted,
    health: defaulted.length > 0 ? CAPACITY_SETTINGS_DEFAULTED : null,
  };
}

export interface CapacityState {
  total: number;
  /** Live sandbox runs across every account, plus unexpired claims. */
  slotsInUse: number;
  /** Open entries (waiting or claimed). */
  waiting: number;
  headroom: number;
}

/** Headroom first: the slot total (the caller's plan-data reader; it throws when the figure is missing) less the slots in use. */
export async function readCapacityState(pool: Pool, slotTotal: () => number): Promise<CapacityState> {
  const total = slotTotal();
  const { rows } = await pool.query<{ o_slots_in_use: number; o_waiting: number }>(`SELECT o_slots_in_use, o_waiting FROM capacity_queue_state($1)`, [CAPACITY_CLASS]);
  const slotsInUse = Number(rows[0]!.o_slots_in_use);
  return { total, slotsInUse, waiting: Number(rows[0]!.o_waiting), headroom: Math.max(0, total - slotsInUse) };
}

/**
 * Capacity-full, for a create that failed: the provider's 429 (any code, or none). Any other status keeps today's failure path and is never queued (C21).
 * The status and code (if any) are recorded on the entry.
 */
export function classifyCreateFailure(err: unknown): { kind: "capacity_full"; status: 429; code: string | null } | { kind: "other" } {
  const full = providerCapacityOf(err);
  return full === null ? { kind: "other" } : { kind: "capacity_full", status: 429, code: full.code ?? null };
}

/** One alert at the crossing, not one per entry: the entry that makes the queue longer than the setting. It never refuses or drops an entry. */
export const crossesAlertDepth = (created: boolean, depthAfter: number, alertDepth: number): boolean => created && depthAfter === alertDepth + 1;

export interface EnqueueInput {
  repoId: string;
  workItemId: string;
  runKind: string;
  /** The provider answer that sent the item here, when it was one. */
  refusal?: { status: number; code?: string | null };
}

export interface QueueEntry {
  id: string;
  attempt: number;
  enqueuedAt: Date;
  /** False when the item already had an open entry. */
  created: boolean;
}

/** Queues the item on its own tenant (a second call is no new place; a claimed entry that comes back keeps its place and starts its next attempt). */
export async function enqueueForCapacity(pool: Pool, accountId: string, input: EnqueueInput): Promise<{ entry: QueueEntry; depth: number; alertDepth: number; alert: boolean }> {
  const entry = await withTenant(pool, accountId, async (c) => {
    const { rows } = await c.query<{ o_id: string; o_attempt: number; o_enqueued_at: Date; o_created: boolean }>(
      `SELECT o_id, o_attempt, o_enqueued_at, o_created FROM capacity_enqueue($1, $2, $3, $4, $5, $6)`,
      [input.repoId, input.workItemId, input.runKind, CAPACITY_CLASS, input.refusal?.status ?? null, input.refusal?.code ?? null],
    );
    const r = rows[0]!;
    return { id: r.o_id, attempt: r.o_attempt, enqueuedAt: r.o_enqueued_at, created: r.o_created };
  });
  const [{ rows }, settings] = await Promise.all([pool.query<{ o_waiting: number }>(`SELECT o_waiting FROM capacity_queue_state($1)`, [CAPACITY_CLASS]), readCapacitySettings(pool)]);
  const depth = Number(rows[0]!.o_waiting);
  return { entry, depth, alertDepth: settings.alertDepth, alert: crossesAlertDepth(entry.created, depth, settings.alertDepth) };
}

export interface ClaimedEntry {
  id: string;
  accountId: string;
  repoId: string;
  workItemId: string;
  runKind: string;
  attempt: number;
}

/** Claims entries in fair order, at most as many as there is headroom for (and `limit`), each under a lease of the stored length. */
export async function claimWithinHeadroom(pool: Pool, slotTotal: () => number, opts: { limit?: number } = {}): Promise<{ claimed: ClaimedEntry[]; state: CapacityState }> {
  const [state, settings] = [await readCapacityState(pool, slotTotal), await readCapacitySettings(pool)];
  const claimed: ClaimedEntry[] = [];
  for (let i = 0; i < Math.min(state.headroom, opts.limit ?? 25); i++) {
    const { rows } = await pool.query<{ o_id: string; o_account_id: string; o_repo_id: string; o_work_item_id: string; o_run_kind: string; o_attempt: number }>(
      `SELECT o_id, o_account_id, o_repo_id, o_work_item_id, o_run_kind, o_attempt FROM capacity_claim_next($1, $2)`,
      [CAPACITY_CLASS, settings.leaseSeconds],
    );
    const r = rows[0];
    if (!r) break;
    claimed.push({ id: r.o_id, accountId: r.o_account_id, repoId: r.o_repo_id, workItemId: r.o_work_item_id, runKind: r.o_run_kind, attempt: r.o_attempt});
  }
  return { claimed, state };
}

/** Records the run an attempt started. False when the attempt no longer holds the claim (re-queued, ended by a cancel) or the run is not the item's own. */
export async function markStarted(pool: Pool, entry: Pick<ClaimedEntry, "id" | "attempt">, runId: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(`SELECT capacity_mark_started($1, $2, $3) AS ok`, [entry.id, entry.attempt, runId]);
  return rows[0]!.ok;
}

/**
 * D#483 S5-k3b-2a: a claimed start the provider refused with 429 goes back. The same entry keeps its id and `enqueued_at` and starts its next attempt, with the
 * refusal recorded (C23). True when it went back; false when the run is not the entry's own, is not `cancelled`, or the item already holds another open entry
 * (nothing changes then). Runs on the run-writer login, like the claim.
 */
export async function requeueRefused(pool: Pool, entryId: string, runId: string, refusal: { status: number; code?: string | null }): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(`SELECT capacity_requeue_refused($1, $2, $3, $4) AS ok`, [entryId, runId, refusal.status, refusal.code ?? null]);
  return rows[0]!.ok;
}
