/**
 * D#454 H3c: the "work pending" marker that lets a sweep cron tick end without opening a database connection.
 *
 * The three sweeps (webhook outbox, run actions, compute settle) used to open a connection every minute, which kept
 * the staging Neon compute awake around the clock. Now a tick first reads a small marker from a no-DB store (Vercel
 * Runtime Cache in production, see apps/web/lib/pendingWorkStore.ts) and connects only when
 *   - the marker says work has been pending since a time that has passed ("marker"), or
 *   - no tick has connected for BACKSTOP_MS, or the store cannot say ("backstop").
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

export const SWEEP_NAMES = ["api-sweep", "run-action-sweep", "compute-settle-sweep", "reconcile", "runner-sweeper"] as const;
export type SweepName = (typeof SWEEP_NAMES)[number];

/** The longest a tick may go without connecting, whatever the marker says. */
export const BACKSTOP_MS = 30 * 60_000;
/** The same limit while staging is paused (FX_STAGING_PAUSED=1): real pending work still connects, an idle sweep waits this long. */
export const PAUSED_BACKSTOP_MS = 12 * 60 * 60_000;

/** Pause switch for the staging project: exactly "1" pauses; unset or anything else is normal. */
export function isStagingPaused(env: Record<string, string | undefined> = process.env): boolean {
  return env.FX_STAGING_PAUSED === "1";
}

export function backstopMs(paused: boolean = isStagingPaused()): number {
  return paused ? PAUSED_BACKSTOP_MS : BACKSTOP_MS;
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
  const overdue = last.value === null || last.value > now + CLOCK_SKEW_MS || now - last.value >= backstopMs(paused);
  return overdue ? { ...base, connect: true, reason: "backstop" } : { ...base, connect: false, reason: "none" };
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
    await bounded(Promise.resolve(store.set(lastRunKey(gate.name), now, markerTtlSeconds(gate.paused))));
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
  const line: GateLine = { event: "cron.gate", sweep: gate.name, marker: gate.marker, last_run: gate.lastRun, reason: gate.reason, connected: gate.connect, paused: gate.paused, backstop_ms: backstopMs(gate.paused) };
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
  await finishTick(gate, outcome.nextDueAt, now());
  return { result: outcome.result };
}
