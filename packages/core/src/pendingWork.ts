import { createHash } from "node:crypto";

/**
 * D#454 H3c: the "work pending" marker that lets a sweep cron tick end without opening a database connection.
 *
 * The three sweeps (webhook outbox, run actions, compute settle) used to open a connection every minute, which kept
 * the staging Neon compute awake around the clock. Now a tick first reads a small marker from a no-DB store (Vercel
 * Runtime Cache in production, see apps/web/lib/pendingWorkStore.ts) and connects only when
 *   - the marker says work has been pending since a time that has passed ("marker"), or
 *   - a wall-clock slot boundary has passed since this sweep last connected, or the store cannot say ("backstop").
 *
 * The backstop is aligned to the wall clock, not to each sweep's own last run: every sweep that is due connects in the
 * first minutes of the same slot, so an idle deployment's database sees one short burst per slot and can sleep between
 * bursts. Slots are 30 minutes while any account has shown work in the last 24 hours (the "activity:any" key), else 60.
 *
 * The store is a hint, never the truth. Runtime Cache is regional and ephemeral: a read can miss because the entry
 * expired, was evicted, was written in another region, or the call failed or timed out (the client swallows errors
 * and answers "not found"). A miss therefore costs latency (up to the backstop), never correctness: the database rows
 * stay the durable signal, and every connecting tick re-derives the marker from them.
 *
 * Marker value: epoch milliseconds, "work is pending since this time". A writer stores now; a tick that finds work
 * still waiting (a webhook retry, a run action in backoff) stores the time that work becomes due.
 *
 * Nothing here is reachable by an anonymous caller: only server code that has just written a row sets a marker, and
 * the cron routes authenticate before they read one.
 */

export const SWEEP_NAMES = ["api-sweep", "run-action-sweep", "compute-settle-sweep", "reconcile", "runner-sweeper", "invariant-sweep", "handoff-sweep", "stage-resume-sweep", "setup-request-check", "branch-cleanup", "proposal-verify-sweep"] as const;
export type SweepName = (typeof SWEEP_NAMES)[number];

/** The backstop slot length while there has been work in the last ACTIVITY_WINDOW_MS. */
export const BACKSTOP_MS = 30 * 60_000;
/** The backstop slot length on a deployment with no work for ACTIVITY_WINDOW_MS. */
export const IDLE_BACKSTOP_MS = 60 * 60_000;
/** How far back "any work" looks when picking the slot length. */
export const ACTIVITY_WINDOW_MS = 24 * 60 * 60_000;
/** A sweep with no marker of its own that runs on every Nth slot (the reconciler: it never sets a marker). */
export const SLOW_SWEEP_SLOTS: Partial<Record<(typeof SWEEP_NAMES)[number], number>> = { reconcile: 4 };
/** The same limit while staging is paused (FX_STAGING_PAUSED=1): real pending work still connects, an idle sweep waits this long. */
export const PAUSED_BACKSTOP_MS = 12 * 60 * 60_000;

/** Pause switch for the staging project: exactly "1" pauses; unset or anything else is normal. */
export function isStagingPaused(env: Record<string, string | undefined> = process.env): boolean {
  return env.FX_STAGING_PAUSED === "1";
}

export function backstopMs(paused: boolean = isStagingPaused()): number {
  return paused ? PAUSED_BACKSTOP_MS : BACKSTOP_MS;
}

/** The wall-clock slot a time falls in. */
export function slotOf(time: number, slotMs: number): number {
  return Math.floor(time / slotMs);
}

/** The slot length for one sweep: the base slot times the sweep's own multiplier (1 for most). */
function sweepSlotMs(name: SweepName, baseMs: number): number {
  return baseMs * (SLOW_SWEEP_SLOTS[name] ?? 1);
}
/** A marker younger than this at the end of a tick is kept: its writer may not have committed before the tick read the rows. */
export const MARKER_GRACE_MS = 60_000;
/** How long a marker lives in the store; a connecting tick re-derives it long before (the backstop). */
export const MARKER_TTL_SECONDS = 2 * (BACKSTOP_MS / 1000);

/**
 * The store lifetime for a marker or a last-connected time: twice the backstop in force. A paused deployment must not
 * use the 30-minute figure, or "last connected" would expire after an hour, read as a miss, and count as overdue.
 */
export function markerTtlSeconds(paused: boolean = isStagingPaused()): number {
  return 2 * (backstopMs(paused) / 1000);
}

/**
 * The store lifetime for a last-connected time: it must outlive the longest slot a sweep can wait (the idle slot times the
 * slowest multiplier), or an idle sweep would read a miss and connect early. Paused keeps its 12 hour figure.
 */
export function lastRunTtlSeconds(paused: boolean = isStagingPaused()): number {
  if (paused) return markerTtlSeconds(true);
  const longest = IDLE_BACKSTOP_MS * Math.max(1, ...Object.values(SLOW_SWEEP_SLOTS).map((n) => n ?? 1));
  return 2 * (longest / 1000);
}

/** The slice of a key-value cache this module needs. `get` resolves null/undefined for a miss. */
export interface PendingStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: number, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PendingHooks {
  store: PendingStore;
  /** Asks for an early tick of a sweep that supports it (api-sweep). Fire and forget; must not throw. */
  kick?(name: SweepName): void;
  /** Keeps a pending write alive after the response (waitUntil). */
  keepAlive?(work: Promise<unknown>): void;
  /** Reports a store failure or timeout (a coded, capped error report). Optional; must not throw. */
  reportError?(err: unknown, stage: string): void;
}

// Next bundles the instrumentation hook and each route separately, so module state would not be shared; a global is.
const HOOKS_KEY = Symbol.for("fx.pendingWork.hooks");
type HookHolder = { [HOOKS_KEY]?: PendingHooks | null };

export function setPendingHooks(hooks: PendingHooks | null): void {
  (globalThis as HookHolder)[HOOKS_KEY] = hooks;
}

export function getPendingHooks(): PendingHooks | null {
  return (globalThis as HookHolder)[HOOKS_KEY] ?? null;
}

/**
 * Every store call is bounded: inside a Vercel function the cache is the request-context one, whose behaviour on a
 * stall is not documented, and an unbounded wait would hold a cron tick (or a writer's waitUntil) until maxDuration.
 * A timeout rejects, which every caller already treats as a store error (a tick connects; a writer's write is dropped).
 */
export const STORE_TIMEOUT_MS = 400;

function bounded<T>(work: Promise<T>, ms: number = STORE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('pending-work store timed out')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** A last-connect time further ahead than this is not believed (clock skew between instances is small). */
export const CLOCK_SKEW_MS = 60_000;

const markerKey = (name: SweepName): string => `pending:${name}`;
const lastRunKey = (name: SweepName): string => `lastrun:${name}`;
/** Epoch ms of the latest work any writer or tick saw; it picks the slot length. */
export const ACTIVITY_KEY = "activity:any";

function asTime(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Called by a writer right after it records work for `name`. Never throws and never waits on the store: it returns
 * the pending write for tests, and hands it to `keepAlive` so a frozen function still finishes it. Without hooks
 * installed it does nothing (the sweeps then connect on every tick, as before).
 * A `since` in the future (work that becomes due later) never overrides an earlier marker.
 */
export function markWorkPending(name: SweepName, opts: { since?: number; kick?: boolean; now?: number } = {}): Promise<void> {
  const hooks = getPendingHooks();
  if (!hooks) return Promise.resolve();
  const now = opts.now ?? Date.now();
  const since = opts.since ?? now;
  const write = (async () => {
    if (since > now) {
      const current = asTime(await bounded(Promise.resolve(hooks.store.get(markerKey(name)))));
      if (current !== null && current <= since) return;
    }
    await bounded(Promise.resolve(hooks.store.set(markerKey(name), since, markerTtlSeconds())));
    await recordActivity(hooks.store, now);
  })().catch((err: unknown) => {
    // The marker is a hint; the row just written is the durable signal and the backstop tick finds it. Worth seeing, though.
    hooks.reportError?.(err, "pending_work.write");
  });
  try {
    hooks.keepAlive?.(write);
    if (opts.kick) hooks.kick?.(name);
  } catch (err) {
    // A failing hook never reaches the writer.
    hooks.reportError?.(err, "pending_work.hook");
  }
  return write;
}

/** How long an account's runner-work values live in the store. A runner that missed them falls back to its slow claim. */
export const RUNNER_WORK_TTL_SECONDS = 24 * 60 * 60;

/** The cache key of the account's "latest bump" epoch: work became claimable at this time (ms). */
export function runnerWorkKeyFor(accountId: string): string {
  return `wake:acct:${accountId}`;
}
/** The cache key of the account's earliest not-yet-passed due time (ms): work that becomes claimable later (a `claimable_after`). */
export function runnerWorkDueKeyFor(accountId: string): string {
  return `wake-due:acct:${accountId}`;
}

/**
 * One stdout line for a failed runner-work write. Deliberately NOT `hooks.reportError`: that path opens a database
 * connection (capped error rows), and this signal exists so an idle account never needs one.
 */
function logRunnerWorkFailure(stage: string, err: unknown): void {
  try {
    console.log(JSON.stringify({ event: "runner_work.mark_failed", stage, error: err instanceof Error ? err.message : String(err) }));
  } catch {
    // fx-swallow-ok: a logger that throws must never reach the writer
  }
}

function runnerWorkWrite(hooks: PendingHooks, work: () => Promise<void>): Promise<void> {
  const write = work().catch((err: unknown) => {
    // fx-swallow-ok: a lost hint, logged to stdout (never the database); the runner's slow claim finds the work
    logRunnerWorkFailure("runner_work.write", err);
  });
  try {
    hooks.keepAlive?.(write);
  } catch (err) {
    // fx-swallow-ok: a failing hook never reaches the writer; logged to stdout (not the database) by the helper
    logRunnerWorkFailure("runner_work.hook", err);
  }
  return write;
}

/**
 * Called by a writer right after the row that makes runner work claimable has COMMITTED. Two values per account, both
 * in the no-DB store where a cheap wake check reads them:
 *  - no `since` (or one that has passed): the epoch is set to that time, "latest bump";
 *  - a `since` in the future (work claimable later, such as a `claimable_after`): the DUE value keeps the MINIMUM
 *    not-yet-passed due time. A later time does not replace an earlier one still in the future.
 * Dropping a later due time is safe only because the consumer re-derives it: when the server answers a runner claim it
 * reads the next future `claimable_after` of the account's runner runs from the database and calls `remarkRunnerDue`
 * (see the claim in packages/worker/src/runnerClaims.ts). The get-then-set here is not atomic, so two concurrent marks
 * can leave the later value; that is acceptable for a hint, because the same re-derivation corrects it and the runner's
 * slow claim is the safety net.
 * Same contract as `markWorkPending`: never throws, never waits on the store, bounded, a no-op without hooks. A failed
 * write is a lost hint and is logged to stdout, never to the database.
 */
export function markRunnerWork(accountId: string, opts: { since?: number; now?: number } = {}): Promise<void> {
  const hooks = getPendingHooks();
  if (!hooks || typeof accountId !== "string" || accountId === "") return Promise.resolve();
  const now = opts.now ?? Date.now();
  const since = opts.since ?? now;
  return runnerWorkWrite(hooks, async () => {
    if (since > now) {
      const due = asTime(await bounded(Promise.resolve(hooks.store.get(runnerWorkDueKeyFor(accountId)))));
      if (due !== null && due > now && due <= since) return;
      await bounded(Promise.resolve(hooks.store.set(runnerWorkDueKeyFor(accountId), since, RUNNER_WORK_TTL_SECONDS)));
      return;
    }
    // The run of bumps this one belongs to (see runnerWorkFirstKeyFor). A failed read only starts a new run: the epoch write below never waits on it.
    const look = (key: string): Promise<number | null> => bounded(Promise.resolve(hooks.store.get(key))).then(asTime, () => null);
    const [prev, first] = await Promise.all([look(runnerWorkKeyFor(accountId)), look(runnerWorkFirstKeyFor(accountId))]);
    const chained = prev !== null && first !== null && first <= prev && prev <= since && since - prev < RUNNER_WORK_CHAIN_GAP_MS;
    await bounded(Promise.resolve(hooks.store.set(runnerWorkKeyFor(accountId), since, RUNNER_WORK_TTL_SECONDS)));
    if (!chained) await bounded(Promise.resolve(hooks.store.set(runnerWorkFirstKeyFor(accountId), since, RUNNER_WORK_TTL_SECONDS)));
  });
}

/**
 * D#6 RUNNER-PING: bumps less than this apart form one run, and the account's FIRST-bump value keeps the start of the run. Without it, work marked
 * every minute would keep the epoch younger than the 90-second reply window for ever, and a dead runner would never be noticed.
 */
export const RUNNER_WORK_CHAIN_GAP_MS = 90_000;

/** The cache key of the first bump of the account's current run of bumps (ms); `runnerWorkKeyFor` holds the latest. */
export function runnerWorkFirstKeyFor(accountId: string): string {
  return `wake-first:acct:${accountId}`;
}

/** The cache key of the last "Check runner now" a person sent to this runner (ms). */
export function runnerCheckKeyFor(runnerId: string): string {
  return `wake-check:rid:${runnerId}`;
}

/**
 * D#6 RUNNER-PING: records that a person asked this runner to answer now. Awaited and bounded; resolves false when there is no store or the write
 * failed, so the route can say the check could not be sent. The value lives a day: a "Not responding" stays until the runner is heard from again.
 */
export async function recordRunnerCheck(runnerId: string, sentAt: number): Promise<boolean> {
  const hooks = getPendingHooks();
  if (!hooks || runnerId === "") return false;
  try {
    await bounded(Promise.resolve(hooks.store.set(runnerCheckKeyFor(runnerId), sentAt, RUNNER_WORK_TTL_SECONDS)));
    return true;
  } catch (err) {
    // fx-swallow-ok: the route answers 503 check_unavailable on false; logged to stdout (not the database) by the helper
    logRunnerWorkFailure("runner_check.write", err);
    return false;
  }
}

/** What the fleet read needs to tell a runner that does not answer: the account's latest and first bump, and each runner's last check (ms). */
export interface RunnerReplyHints {
  epoch: number | null;
  first: number | null;
  checks: ReadonlyMap<string, number>;
}

/** Reads those hints in one parallel round, with NO database access. Never throws: a miss or a failure is simply no value (nothing is flagged). */
export async function readRunnerReplyHints(accountId: string, runnerIds: readonly string[]): Promise<RunnerReplyHints> {
  const hooks = getPendingHooks();
  const none: RunnerReplyHints = { epoch: null, first: null, checks: new Map() };
  if (!hooks || accountId === "") return none;
  const get = (key: string): Promise<number | null> => bounded(Promise.resolve(hooks.store.get(key))).then(asTime, (err: unknown) => (logRunnerWorkFailure("runner_reply.read", err), null));
  const ids = [...new Set(runnerIds)].filter((id) => id !== "");
  const [epoch, first, ...checks] = await Promise.all([get(runnerWorkKeyFor(accountId)), get(runnerWorkFirstKeyFor(accountId)), ...ids.map((id) => get(runnerCheckKeyFor(id)))]);
  const found = new Map<string, number>();
  ids.forEach((id, i) => {
    const at = checks[i];
    if (at !== null && at !== undefined) found.set(id, at);
  });
  return { epoch: epoch ?? null, first: first ?? null, checks: found };
}

/**
 * The consumer's half: sets the DUE value to `nextDueAt`, the earliest `claimable_after` still in the future that the
 * database reported for the account's runner runs, replacing whatever was stored (the database is the truth, the stored
 * value only a hint). With null (nothing left in the future) the stored value is DELETED, so a due time that has passed
 * does not make every later idle claim look again. Same failure contract as `markRunnerWork`: a failed write or delete
 * is swallowed and logged to stdout.
 */
export function remarkRunnerDue(accountId: string, nextDueAt: number | null): Promise<void> {
  const hooks = getPendingHooks();
  if (!hooks || accountId === "") return Promise.resolve();
  if (nextDueAt === null) return runnerWorkWrite(hooks, () => bounded(Promise.resolve(hooks.store.delete(runnerWorkDueKeyFor(accountId)))));
  return runnerWorkWrite(hooks, () => bounded(Promise.resolve(hooks.store.set(runnerWorkDueKeyFor(accountId), nextDueAt, RUNNER_WORK_TTL_SECONDS))));
}

/** Reads the stored due time for an account (null on a miss, an error or no store). Never throws; no database. */
export async function readRunnerDue(accountId: string): Promise<number | null> {
  const hooks = getPendingHooks();
  if (!hooks) return null;
  try {
    return asTime(await bounded(Promise.resolve(hooks.store.get(runnerWorkDueKeyFor(accountId)))));
  } catch (err) {
    // fx-swallow-ok: a missed hint read; logged to stdout (not the database) and the caller treats it as "no stored value"
    logRunnerWorkFailure("runner_work.read", err);
    return null;
  }
}

/**
 * D#6 RUNNER-WAKE R3b: the wake check's ALLOW record, one per runner. The wake check answers only while this record exists AND names the
 * token's key and account, so anything that loses the record (an eviction, its TTL, a write the client dropped, another region) refuses: the
 * decision fails CLOSED. The runner then makes its ordinary claim, which re-checks everything in the database and writes the record again.
 *
 * It is written after a hello or claim that minted a grant (that request was just verified against the database), and DELETED after every
 * database change that should stop the runner. Its TTL is one hour, refreshed by every claim that grants, and never past the moment the key
 * reaches the 90-day age limit. Keyed on the runner id, never on the token text (which has more than one spelling).
 *
 * There are no deny keys: they would live in the same cache, which answers null for a miss and drops a failed write silently, so they could
 * only ever fail open. A dropped delete is bounded by the one-hour TTL (and the second delete below).
 */
/** One hour: a wake runner claims at least once per 30-minute slot (plus up to 5 min), and every such claim rewrites the record. */
export const WAKE_ALLOW_MAX_TTL_SECONDS = 60 * 60;

/** The allow record's key. */
export function wakeAllowKeyFor(runnerId: string): string {
  return `wake-ok:rid:${runnerId}`;
}

/**
 * The allow record's value: a 48-bit digest of the key and account the runner was last verified with (the store holds numbers). It only has to
 * tell the runner's current key and account from others: the token reaching it is already MAC-checked and signed by the key it names.
 */
export function wakeAllowValue(jkt: string, accountId: string): number {
  return createHash("sha256").update(`wake-ok:v1:${jkt}:${accountId}`, "utf8").digest().readUIntBE(0, 6);
}

/**
 * Writes the allow record for a runner a hello or claim has just verified and given a grant. `keyValidUntil` is when its key reaches the age
 * limit: the record never outlives it, and none is written once it has passed. Awaited by the caller (bounded by the store timeout), never throws:
 * a lost write only means the next wake check answers 503 and the runner claims as usual.
 */
export async function allowRunnerWake(runner: { runnerId: string; jkt: string; accountId: string; keyValidUntil: Date }, now: number = Date.now()): Promise<void> {
  const hooks = getPendingHooks();
  if (!hooks || runner.runnerId === "") return;
  const ttl = Math.min(WAKE_ALLOW_MAX_TTL_SECONDS, Math.floor((runner.keyValidUntil.getTime() - now) / 1000));
  if (!(ttl > 0)) return;
  const value = wakeAllowValue(runner.jkt, runner.accountId);
  await runnerWorkWrite(hooks, async () => bounded(Promise.resolve(hooks.store.set(wakeAllowKeyFor(runner.runnerId), value, ttl))));
}

/** A claim that was already past its database check when a revoke committed can still write the record after it: the second delete, this long after, catches it. */
export const WAKE_REVOKE_SECOND_DELETE_MS = 5_000;

/**
 * Deletes the allow records of these runners. Called right AFTER the database change that stops them has committed (a revoke, a removal, a
 * revoke-all, a membership change, a key rotation, an account close), and awaited, so the next wake check already refuses. The deletes run again
 * `WAKE_REVOKE_SECOND_DELETE_MS` later (kept alive past the response), for an in-flight claim that verified before the commit and writes the record
 * after it. Never throws. The Runtime Cache client swallows a failed call, so a dropped delete may go unnoticed: the record then lives at most its
 * one-hour TTL, in which the runner learns only whether its account has work; every claim is still refused by the database.
 */
export async function revokeRunnerWake(runnerIds: readonly string[]): Promise<void> {
  const hooks = getPendingHooks();
  if (!hooks) return;
  const ids = [...new Set(runnerIds)].filter((id) => id !== "");
  if (ids.length === 0) return;
  const deletes = (): Promise<unknown> => Promise.all(ids.map((id) => runnerWorkWrite(hooks, async () => bounded(Promise.resolve(hooks.store.delete(wakeAllowKeyFor(id)))))));
  await deletes();
  if (!hooks.keepAlive) return;
  try {
    hooks.keepAlive(new Promise<void>((resolve) => setTimeout(resolve, WAKE_REVOKE_SECOND_DELETE_MS)).then(deletes));
  } catch (err) {
    // fx-swallow-ok: no request context for the second delete; the first one already ran. stdout only.
    logRunnerWorkFailure("runner_wake.second_delete", err);
  }
}

/** What the wake check reads for one verified token, all from the no-DB store. */
export type RunnerWakeState =
  | { ok: true; allowed: "match" | "missing" | "mismatch"; epoch: number | null; dueAt: number | null }
  | { ok: false; reason: "no_store" | "store_error" };

/**
 * Reads, in one parallel round of three and with NO database access, the runner's allow record and the account's epoch and due time. Only `match`
 * may be answered: `missing` (a miss, an eviction, a dropped write, another region) and `mismatch` (another key or account) refuse, and so does
 * `store_error` (a store that throws, or our own timeout). Never throws; a failure is logged to stdout only.
 */
export async function readRunnerWakeState(ids: { runnerId: string; jkt: string; accountId: string }): Promise<RunnerWakeState> {
  const hooks = getPendingHooks();
  if (!hooks) return { ok: false, reason: "no_store" };
  const get = (key: string): Promise<unknown> => bounded(Promise.resolve(hooks.store.get(key)));
  try {
    const [allow, epoch, due] = await Promise.all([get(wakeAllowKeyFor(ids.runnerId)), get(runnerWorkKeyFor(ids.accountId)), get(runnerWorkDueKeyFor(ids.accountId))]);
    const allowed = allow === null || allow === undefined ? "missing" : allow === wakeAllowValue(ids.jkt, ids.accountId) ? "match" : "mismatch";
    return { ok: true, allowed, epoch: asTime(epoch), dueAt: asTime(due) };
  } catch (err) {
    // fx-swallow-ok: answered as store_error, which the wake check refuses (fail closed); logged to stdout, never the database
    logRunnerWorkFailure("runner_wake.read", err);
    return { ok: false, reason: "store_error" };
  }
}

/** Notes that work exists (a writer just recorded some, or a tick found some): this keeps the slots at 30 minutes. */
async function recordActivity(store: PendingStore, now: number): Promise<void> {
  await bounded(Promise.resolve(store.set(ACTIVITY_KEY, now, ACTIVITY_WINDOW_MS / 1000)));
}

export type MarkerRead = "hit" | "miss" | "error";
export type GateReason = "marker" | "backstop" | "no_store" | "kick" | "none";

export interface TickGate {
  name: SweepName;
  connect: boolean;
  reason: GateReason;
  /** "hit": a marker was present; "miss": none (or unusable); "error": the store failed. */
  marker: MarkerRead;
  markerValue: number | null;
  lastRun: MarkerRead;
  /** FX_STAGING_PAUSED was "1" when the gate was read. */
  paused: boolean;
  /**
   * The backstop slot length that decided a backstop or none verdict. A tick that skipped inside its half-hour slot never read the
   * activity key, so it reports the half-hour figure (the shortest slot that could apply); absent on a marker, kick or paused verdict.
   */
  slotMs?: number;
}

async function read(store: PendingStore, key: string): Promise<{ state: MarkerRead; value: number | null }> {
  try {
    const value = asTime(await bounded(Promise.resolve(store.get(key))));
    return value === null ? { state: "miss", value: null } : { state: "hit", value };
  } catch (err) {
    getPendingHooks()?.reportError?.(err, "pending_work.read");
    return { state: "error", value: null };
  }
}

/** Decides, with NO database access, whether this tick connects. Reads the marker before anything else. */
export async function readTickGate(name: SweepName, now: number = Date.now(), paused: boolean = isStagingPaused()): Promise<TickGate> {
  const hooks = getPendingHooks();
  if (!hooks) return { name, connect: true, reason: "no_store", marker: "miss", markerValue: null, lastRun: "miss", paused };
  const [marker, last] = await Promise.all([read(hooks.store, markerKey(name)), read(hooks.store, lastRunKey(name))]);
  const base = { name, marker: marker.state, markerValue: marker.value, lastRun: last.state, paused };
  if (marker.value !== null && marker.value <= now) return { ...base, connect: true, reason: "marker" };
  // No usable "last connected" time (a cold region, an eviction, an error) counts as overdue: fail toward doing the work.
  // It still connects in the slot window rather than at a random minute, because every due sweep connects at a slot start.
  const activeMs = sweepSlotMs(name, BACKSTOP_MS);
  if (last.value === null || last.value > now + CLOCK_SKEW_MS) return { ...base, connect: true, reason: "backstop", slotMs: activeMs };
  // Paused keeps the plain elapsed-time rule (12 hours since this sweep's last connect): it is already rare, and slots add nothing.
  if (paused) return now - last.value >= PAUSED_BACKSTOP_MS ? { ...base, connect: true, reason: "backstop" } : { ...base, connect: false, reason: "none" };
  // Every 60-minute slot boundary is also a 30-minute one, so a sweep not yet due on 30-minute slots is not due on
  // 60-minute slots either: the activity key is read only when it can change the answer.
  if (slotOf(last.value, activeMs) >= slotOf(now, activeMs)) return { ...base, connect: false, reason: "none", slotMs: activeMs };
  const activity = await read(hooks.store, ACTIVITY_KEY);
  const recent = activity.value !== null && now - activity.value < ACTIVITY_WINDOW_MS;
  // An unreadable activity key counts as busy (the shorter slot): fail toward doing the work.
  const slotMs = recent || activity.state === "error" ? activeMs : sweepSlotMs(name, IDLE_BACKSTOP_MS);
  return slotOf(last.value, slotMs) < slotOf(now, slotMs) ? { ...base, connect: true, reason: "backstop", slotMs } : { ...base, connect: false, reason: "none", slotMs };
}

/**
 * Called after a tick that connected. `nextDueAt` is when work known to remain becomes due (epoch ms), or null when
 * nothing remains. The marker is rewritten or cleared only if it still holds the value this tick read, so a writer that
 * stored a marker meanwhile is never overwritten; a marker newer than MARKER_GRACE_MS is kept even when nothing
 * remains, because its writer may not have committed yet. All store failures are swallowed.
 */
export async function finishTick(gate: TickGate, nextDueAt: number | null, now: number = Date.now()): Promise<void> {
  const hooks = getPendingHooks();
  if (!hooks) return;
  const { store } = hooks;
  try {
    await bounded(Promise.resolve(store.set(lastRunKey(gate.name), now, lastRunTtlSeconds(gate.paused))));
    const current = await read(store, markerKey(gate.name));
    if (current.value !== gate.markerValue) return; // a writer got there first
    if (nextDueAt !== null) {
      await bounded(Promise.resolve(store.set(markerKey(gate.name), Math.max(nextDueAt, 1), markerTtlSeconds(gate.paused))));
    } else if (current.value !== null && now - current.value >= MARKER_GRACE_MS) {
      await bounded(Promise.resolve(store.delete(markerKey(gate.name))));
    }
  } catch (err) {
    // A failed rewrite leaves the old marker or none: the next tick connects at worst. Worth seeing, though.
    hooks.reportError?.(err, "pending_work.finish");
  }
}

export interface GateLine {
  event: "cron.gate";
  sweep: SweepName;
  marker: MarkerRead;
  last_run: MarkerRead;
  reason: GateReason;
  connected: boolean;
  /** Staging pause switch state; while true the backstop is `backstop_ms` = 12 hours. */
  paused: boolean;
  /** The backstop slot length in force for this tick (see TickGate.slotMs); 12 hours while paused. */
  backstop_ms: number;
  /** Only when connected: whether the sweep found anything to do. */
  work_found?: boolean;
}

/**
 * One structured line per tick, skipped or not. Reading the hit rate from these lines: among lines with
 * `work_found: true`, `reason: "marker"` is a marker that did its job and `reason: "backstop"` is work the marker
 * missed (cold region, eviction, or a writer with no hook). `marker: "error"` counts store failures.
 */
export function gateLine(gate: TickGate, workFound?: boolean): string {
  const line: GateLine = { event: "cron.gate", sweep: gate.name, marker: gate.marker, last_run: gate.lastRun, reason: gate.reason, connected: gate.connect, paused: gate.paused, backstop_ms: gate.slotMs ?? backstopMs(gate.paused) };
  if (workFound !== undefined) line.work_found = workFound;
  return JSON.stringify(line);
}

export interface GatedOutcome<T> {
  result: T;
  workFound: boolean;
  /** When work known to remain becomes due (epoch ms), else null. */
  nextDueAt: number | null;
}

/**
 * Runs one tick behind the gate. `run` is the only place that may touch the database. Returns null when the tick was
 * skipped. Logs one `cron.gate` line either way.
 */
export async function runGatedTick<T>(
  name: SweepName,
  run: () => Promise<GatedOutcome<T>>,
  log: (line: string) => void = (line) => console.log(line),
  now: () => number = Date.now,
  opts: { force?: boolean } = {},
): Promise<{ result: T } | null> {
  let gate = await readTickGate(name, now(), isStagingPaused());
  // A signed kick is itself the signal: it connects whatever the marker says, and still tidies the marker after.
  if (opts.force && !gate.connect) gate = { ...gate, connect: true, reason: "kick" };
  if (!gate.connect) {
    log(gateLine(gate));
    return null;
  }
  const outcome = await run();
  log(gateLine(gate, outcome.workFound));
  const hooks = getPendingHooks();
  if (outcome.workFound && hooks) await recordActivity(hooks.store, now()).catch((err: unknown) => hooks.reportError?.(err, "pending_work.finish"));
  await finishTick(gate, outcome.nextDueAt, now());
  return { result: outcome.result };
}
