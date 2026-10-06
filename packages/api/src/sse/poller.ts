import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { realClock, type Clock } from "./clock.js";
import { LISTENER_IDLE_CLOSE_MS, defaultNudgeSource, isAccountId, type NudgeSource } from "./nudge.js";

/**
 * D#31 API-5 criterion 7 (poll economics), from the cost-analyst's fixes:
 *
 *   (a) ONE poller per process, fanned out in-process to every account's
 *       streams -- N streams on one account cost one poll, not N;
 *   (b) a change check before any read: a single `domain_event_watermarks`
 *       call (SECURITY DEFINER, platform_ops only -- migration 0639)
 *       returns only `max(seq)` and a "run live" flag per account for
 *       EVERY account due this tick. The full `withTenant` read of an
 *       account's events runs only when that account's watermark has
 *       moved past a subscriber's position;
 *   (c) 2 s while the account has a run in flight, 10 s otherwise.
 *
 * So an idle account costs one shared watermark query per tick and
 * nothing else, no matter how many streams it holds open.
 *
 * Tenant isolation: the watermark call sees other accounts' serials but
 * never returns them to anything except this module, which only ever
 * hands a subscriber rows read under `withTenant(pool, accountId, ...)` --
 * i.e. under domain_events' RLS policy, for the subscriber's OWN account.
 * A subscriber is attached to exactly one account feed, keyed by the
 * account id of its already-authenticated principal.
 */

/**
 * COMMIT-ORDER SAFETY (CWE-362). `domain_events.seq` is a bigserial: it is
 * assigned when a writer's INSERT runs, not when its transaction commits.
 * A slow writer can therefore hold serial 5 while a fast one takes serial
 * 6 and commits first; a reader that has seen 6 and remembers "after 6"
 * would skip 5 forever. Every read here therefore stops at a SETTLED
 * horizon: rows are handed out only while they are older than
 * `settleMs` (by `inserted_at`, the database clock at the INSERT that drew
 * `seq`, which no caller can set -- migration 0639), and reading stops at the first row still inside the window. A lower
 * serial whose transaction is still open is at most one settle window
 * behind the higher one, so by the time the higher row is released the
 * lower one has committed and is read first, in order.
 *
 * The assumption this rests on, stated plainly: an event-emitting
 * transaction commits within the settle window of its INSERT. The window is
 * `FX_EVENTS_SETTLE_MS` (default 1000 ms, digits only, 1000..60000; 0 only
 * under NODE_ENV=test). KNOWN LIMIT: a transaction held open longer than
 * the window after its INSERT can still lose a lower serial; the emitters
 * checked all write near the end of short transactions.
 */
export const DEFAULT_SETTLE_MS = 1_000;

/** Lowest accepted `FX_EVENTS_SETTLE_MS` outside NODE_ENV=test: 0 (or any tiny value) would switch the hold-back off. */
export const MIN_SETTLE_MS = 1_000;
/** Highest accepted `FX_EVENTS_SETTLE_MS`: a huge window would stall every stream and page. */
export const MAX_SETTLE_MS = 60_000;

const warnedSettleValues = new Set<string>();
function warnSettleOnce(raw: string, why: string): void {
  if (warnedSettleValues.has(raw)) return;
  warnedSettleValues.add(raw);
  console.warn(`FX_EVENTS_SETTLE_MS=${JSON.stringify(raw)} ignored (${why}); using ${DEFAULT_SETTLE_MS} ms`);
}

/**
 * The settle window in ms (CWE-1188: unsafe configuration must not silently disable the hold-back).
 * Digits only -- "0e0", "0.5", "0x10", "1e12", "-1", "NaN", "Infinity" and the like are rejected -- within
 * [MIN_SETTLE_MS, MAX_SETTLE_MS]; the floor is waived only when NODE_ENV is "test" (the suite runs at 0).
 * Anything else logs once and falls back to the default.
 */
export function settleMsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.FX_EVENTS_SETTLE_MS;
  if (raw === undefined) return DEFAULT_SETTLE_MS;
  if (!/^[0-9]+$/.test(raw)) {
    warnSettleOnce(raw, "not a plain non-negative integer");
    return DEFAULT_SETTLE_MS;
  }
  const n = Number(raw);
  const floor = env.NODE_ENV === "test" ? 0 : MIN_SETTLE_MS;
  if (!(n >= floor && n <= MAX_SETTLE_MS)) {
    warnSettleOnce(raw, `outside ${floor}..${MAX_SETTLE_MS}`);
    return DEFAULT_SETTLE_MS;
  }
  return n;
}

/** `domain_event_watermarks` refuses more than this many ids per call (migration 0639). */
export const WATERMARK_CHUNK = 1000;

export const ACTIVE_POLL_INTERVAL_MS = 2_000;
export const IDLE_POLL_INTERVAL_MS = 10_000;
const READ_BATCH = 200;
/** Consecutive failed polls after which an account's subscribers are told to give up. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Bound on catch-up reads within one tick, so a far-behind cursor cannot monopolise the loop. */
const MAX_READS_PER_TICK = 10;

/** D#31 API-5d: a nudged read waits one settle window plus this, so the newest row has aged out of the hold-back by then. */
export const NUDGE_WAKE_MARGIN_MS = 100;
/** Nudged ticks start on this grid, so one watermark call covers every account nudged inside a gap (and a storm cannot tight-loop). */
export const NUDGE_MIN_TICK_GAP_MS = 250;

/** One `domain_events` row as the streams need it. `seq` never leaves the server. */
export interface AccountEventRow {
  seq: bigint;
  id: string;
  type: string;
  subjectId: string | null;
  payload: unknown;
  createdAt: Date;
}

export interface AccountSubscriber {
  /** Called with rows strictly after this subscriber's position, in seq order. */
  onEvents(rows: AccountEventRow[]): void;
  /** Called once when polling for this account has failed repeatedly; the subscription is already removed. */
  onFail(err: unknown): void;
}

export interface AccountSubscription {
  unsubscribe(): void;
}

interface SubscriberState {
  afterSeq: bigint;
  handlers: AccountSubscriber;
}

interface Feed {
  accountId: string;
  subs: Set<SubscriberState>;
  nextDueAt: number;
  watermark: bigint;
  runActive: boolean;
  failures: number;
  /** When a nudged read is scheduled (still pending while in the future); at most one per feed. */
  nudgeAt: number | undefined;
  /** When this feed last took a nudged read; the next one waits one settle window after it. */
  lastNudgedReadAt: number;
}

export interface PollerOptions {
  /** app_user pool -- every event read goes through withTenant/RLS. */
  pool: Pool;
  /** platform_ops pool -- used ONLY for the watermark call. */
  platformOpsPool: Pool;
  clock?: Clock;
  activeIntervalMs?: number;
  idleIntervalMs?: number;
  /** Commit-order settle window in ms; defaults to `FX_EVENTS_SETTLE_MS` / 1000. */
  settleMs?: number;
  /** Wake-up source (D#31 API-5d). Defaults to the LISTEN connection for this process; `null` switches nudging off. */
  nudgeSource?: NudgeSource | null;
}

/** The account's newest serial right now, read under the account's own RLS scope. */
export async function headSeq(pool: Pool, accountId: string): Promise<bigint> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ head: string }>(
      "SELECT COALESCE(max(seq), 0)::text AS head FROM domain_events WHERE account_id = $1",
      [accountId],
    );
    return BigInt(rows[0]!.head);
  });
}

interface RawEventRow {
  seq_text: string;
  id: string;
  type: string;
  subject_id: string | null;
  payload: unknown;
  created_at: Date;
  settled: boolean;
}

async function queryEvents(
  pool: Pool,
  accountId: string,
  after: bigint,
  limit: number,
  upTo: bigint | undefined,
  settleMs: number,
): Promise<{ row: AccountEventRow; settled: boolean }[]> {
  const found = await withTenant(pool, accountId, async (client) => {
    const result = await client.query<RawEventRow>(
      // The output column is deliberately NOT named `seq`: Postgres resolves an ORDER BY name against
      // the output list first, so `seq::text AS seq ... ORDER BY seq` sorts lexicographically
      // ('10' < '9'), which reorders events and lets LIMIT cut the wrong rows.
      `SELECT seq::text AS seq_text, id, type, subject_id, payload, created_at,
              inserted_at <= clock_timestamp() - ($5::float8 * interval '1 millisecond') AS settled
         FROM domain_events
        WHERE account_id = $1 AND seq > $2 AND ($3::bigint IS NULL OR seq <= $3)
        ORDER BY domain_events.seq ASC
        LIMIT $4`,
      [accountId, after.toString(), upTo === undefined ? null : upTo.toString(), limit, settleMs],
    );
    return result.rows;
  });
  return found.map((r) => ({
    settled: r.settled,
    row: {
      seq: BigInt(r.seq_text),
      id: r.id,
      type: r.type,
      subjectId: r.subject_id,
      payload: r.payload,
      createdAt: r.created_at,
    },
  }));
}

/** Rows with `after < seq <= upTo` (upTo omitted: no upper bound), oldest first, under the account's RLS scope. NOT settle-aware: streams and JSON pages use `readSettledEventsAfter`. */
export async function readEventsAfter(
  pool: Pool,
  accountId: string,
  after: bigint,
  limit: number,
  upTo?: bigint,
): Promise<AccountEventRow[]> {
  return (await queryEvents(pool, accountId, after, limit, upTo, 0)).map((r) => r.row);
}

export interface SettledRead {
  /** The settled prefix, oldest first. Never includes a row inside the settle window, nor anything after one. */
  rows: AccountEventRow[];
  /** True when reading stopped at a row still inside the settle window: come back after the window. */
  held: boolean;
  /** True when the read filled `limit` (there may be more rows past the last one returned). */
  full: boolean;
}

/** The commit-order-safe read (see the header): rows up to the first one younger than `settleMs`. */
export async function readSettledEventsAfter(
  pool: Pool,
  accountId: string,
  after: bigint,
  limit: number,
  settleMs: number,
  upTo?: bigint,
): Promise<SettledRead> {
  const raw = await queryEvents(pool, accountId, after, limit, upTo, settleMs);
  const cut = raw.findIndex((r) => !r.settled);
  return {
    rows: (cut === -1 ? raw : raw.slice(0, cut)).map((r) => r.row),
    held: cut !== -1,
    full: raw.length >= limit,
  };
}

export class AccountPoller {
  private readonly pool: Pool;
  private readonly platformOpsPool: Pool;
  private readonly clock: Clock;
  private readonly activeIntervalMs: number;
  private readonly idleIntervalMs: number;
  private readonly settleMs: number;
  private readonly feeds = new Map<string, Feed>();
  private timer: unknown;
  private timerAt = Infinity;
  private ticking = false;
  private readonly nudgeSource: NudgeSource | undefined;
  private nudgeCloseTimer: unknown;
  private lastNudgeTickAt = -Infinity;

  constructor(opts: PollerOptions) {
    this.pool = opts.pool;
    this.platformOpsPool = opts.platformOpsPool;
    this.clock = opts.clock ?? realClock;
    this.activeIntervalMs = opts.activeIntervalMs ?? ACTIVE_POLL_INTERVAL_MS;
    this.idleIntervalMs = opts.idleIntervalMs ?? IDLE_POLL_INTERVAL_MS;
    this.settleMs = opts.settleMs ?? settleMsFromEnv();
    this.nudgeSource = opts.nudgeSource === undefined ? defaultNudgeSource(this.platformOpsPool) : (opts.nudgeSource ?? undefined);
  }

  /**
   * D#31 API-5d: an event that should reach this account's streams promptly has committed (any process).
   * Schedules the feed's next read one settle window + 100 ms after the notification arrived, on a shared
   * 250 ms grid: the settle rule is untouched (the read path is the same), at most one nudged read is
   * pending per feed and at most one runs per settle window, and one watermark call serves every account
   * nudged inside a gap. A payload that is not an account id, or an account with no feed here, costs nothing.
   */
  nudge(accountId: string): void {
    if (!isAccountId(accountId)) return;
    const feed = this.feeds.get(accountId.toLowerCase());
    if (!feed) return;
    const now = this.clock.now();
    if (feed.nudgeAt !== undefined && feed.nudgeAt > now) return; // one already pending covers it
    const earliest = Math.max(now + this.settleMs + NUDGE_WAKE_MARGIN_MS, feed.lastNudgedReadAt + this.settleMs, this.lastNudgeTickAt + NUDGE_MIN_TICK_GAP_MS);
    const at = Math.ceil(earliest / NUDGE_MIN_TICK_GAP_MS) * NUDGE_MIN_TICK_GAP_MS;
    feed.nudgeAt = at;
    feed.nextDueAt = Math.min(feed.nextDueAt, at);
    this.arm(feed.nextDueAt);
  }

  /** The listener came back after being down: read every feed once, on the same grid, to recover anything missed meanwhile. */
  private wakeAll(): void {
    const at = Math.ceil(Math.max(this.clock.now(), this.lastNudgeTickAt + NUDGE_MIN_TICK_GAP_MS) / NUDGE_MIN_TICK_GAP_MS) * NUDGE_MIN_TICK_GAP_MS;
    for (const feed of this.feeds.values()) {
      feed.nudgeAt = at;
      feed.nextDueAt = Math.min(feed.nextDueAt, at);
    }
    this.rearm();
  }

  private startNudging(): void {
    if (this.nudgeCloseTimer !== undefined) {
      this.clock.clearTimeout(this.nudgeCloseTimer);
      this.nudgeCloseTimer = undefined;
    }
    this.nudgeSource?.start({ onNudge: (id) => this.nudge(id), onRecovered: () => this.wakeAll() });
  }

  /** Closes the listener one minute after the last feed leaves (a quick reconnect of a stream reuses it). */
  private maybeStopNudging(): void {
    if (this.feeds.size > 0 || !this.nudgeSource || this.nudgeCloseTimer !== undefined) return;
    this.nudgeCloseTimer = this.clock.setTimeout(() => {
      this.nudgeCloseTimer = undefined;
      if (this.feeds.size === 0) this.nudgeSource?.stop();
    }, LISTENER_IDLE_CLOSE_MS);
  }

  /** Live counts, for tests and for proving a closed stream leaves nothing polling. */
  stats(): { feeds: number; subscribers: number; timerArmed: boolean } {
    let subscribers = 0;
    for (const feed of this.feeds.values()) subscribers += feed.subs.size;
    return { feeds: this.feeds.size, subscribers, timerArmed: this.timer !== undefined };
  }

  /** Used to start a no-cursor stream "from now". */
  headSeq(accountId: string): Promise<bigint> {
    return headSeq(this.pool, accountId);
  }

  /**
   * Attaches a subscriber to `accountId`'s feed, delivering rows with
   * `seq > afterSeq`. The first wake is immediate so a resume-from-cursor
   * replays without waiting a whole interval.
   */
  subscribe(accountId: string, afterSeq: bigint, handlers: AccountSubscriber): AccountSubscription {
    let feed = this.feeds.get(accountId);
    if (!feed) {
      feed = { accountId, subs: new Set(), nextDueAt: this.clock.now(), watermark: 0n, runActive: false, failures: 0, nudgeAt: undefined, lastNudgedReadAt: -Infinity };
      this.feeds.set(accountId, feed);
    }
    const state: SubscriberState = { afterSeq, handlers };
    feed.subs.add(state);
    feed.nextDueAt = Math.min(feed.nextDueAt, this.clock.now());
    this.arm(this.clock.now());
    this.startNudging();

    return {
      unsubscribe: () => {
        const f = this.feeds.get(accountId);
        if (!f) return;
        f.subs.delete(state);
        if (f.subs.size === 0) {
          this.feeds.delete(accountId);
        }
        if (this.feeds.size === 0) {
          this.disarm();
          this.maybeStopNudging();
        }
      },
    };
  }

  private disarm(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
      this.timerAt = Infinity;
    }
  }

  /** Ensures a tick is scheduled no later than `at`. */
  private arm(at: number): void {
    if (this.ticking) return; // tick() re-arms itself when it finishes
    if (this.timer !== undefined && this.timerAt <= at) return;
    this.disarm();
    this.timerAt = at;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.timerAt = Infinity;
      void this.tick();
    }, Math.max(0, at - this.clock.now()));
  }

  private rearm(): void {
    let earliest = Infinity;
    for (const feed of this.feeds.values()) {
      earliest = Math.min(earliest, feed.nextDueAt);
    }
    if (earliest !== Infinity) {
      this.arm(earliest);
    }
  }

  /** One poll cycle: at most one watermark query, then a tenant read per account whose watermark moved. Public so tests can drive it deterministically. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.clock.now();
      const due = [...this.feeds.values()].filter((f) => f.subs.size > 0 && f.nextDueAt <= now);
      if (due.length === 0) return;

      // D#31 API-5d: feeds whose nudged read is due take it now (recorded, so the next waits a settle window).
      const nudged = due.filter((f) => f.nudgeAt !== undefined && f.nudgeAt <= now);
      if (nudged.length > 0) this.lastNudgeTickAt = now;
      for (const feed of nudged) {
        feed.nudgeAt = undefined;
        feed.lastNudgedReadAt = now;
      }

      // The definer refuses more than WATERMARK_CHUNK ids per call, so a large fleet is polled in chunks.
      // A failing chunk fails only its own accounts; the rest of the tick proceeds.
      const rows: { account_id: string; max_seq: string; run_active: boolean }[] = [];
      const answered: Feed[] = [];
      for (let i = 0; i < due.length; i += WATERMARK_CHUNK) {
        const chunk = due.slice(i, i + WATERMARK_CHUNK);
        try {
          const result = await this.platformOpsPool.query<{ account_id: string; max_seq: string; run_active: boolean }>(
            "SELECT account_id, max_seq::text AS max_seq, run_active FROM domain_event_watermarks($1::uuid[])",
            [chunk.map((f) => f.accountId)],
          );
          rows.push(...result.rows);
          answered.push(...chunk);
        } catch (err) {
          for (const feed of chunk) this.noteFailure(feed, err, now);
        }
      }

      const byAccount = new Map(rows.map((r) => [r.account_id, r]));
      for (const feed of answered) {
        const row = byAccount.get(feed.accountId);
        if (!row) {
          this.noteFailure(feed, new Error("watermark missing"), now);
          continue;
        }
        feed.watermark = BigInt(row.max_seq);
        feed.runActive = row.run_active;
        feed.nextDueAt = now + (row.run_active ? this.activeIntervalMs : this.idleIntervalMs);
        if (feed.nudgeAt !== undefined) feed.nextDueAt = Math.min(feed.nextDueAt, feed.nudgeAt);
        try {
          await this.readIfMoved(feed);
          feed.failures = 0;
        } catch (err) {
          this.noteFailure(feed, err, now);
        }
      }
    } finally {
      this.ticking = false;
      this.rearm();
    }
  }

  private noteFailure(feed: Feed, err: unknown, now: number): void {
    feed.failures += 1;
    feed.nextDueAt = now + this.activeIntervalMs;
    if (feed.failures < MAX_CONSECUTIVE_FAILURES) return;
    this.feeds.delete(feed.accountId);
    for (const sub of feed.subs) {
      try {
        sub.handlers.onFail(err);
      } catch {
        // A misbehaving subscriber must not stop the others hearing it.
      }
    }
    feed.subs.clear();
    if (this.feeds.size === 0) {
      this.disarm();
      this.maybeStopNudging();
    }
  }

  /** The tenant read: only when some subscriber sits behind the account's watermark. */
  private async readIfMoved(feed: Feed): Promise<void> {
    for (let i = 0; i < MAX_READS_PER_TICK; i++) {
      const behind = [...feed.subs].filter((s) => s.afterSeq < feed.watermark);
      if (behind.length === 0) return;
      const minAfter = behind.reduce((m, s) => (s.afterSeq < m ? s.afterSeq : m), behind[0]!.afterSeq);

      const read = await readSettledEventsAfter(this.pool, feed.accountId, minAfter, READ_BATCH, this.settleMs, feed.watermark);
      const events = read.rows;
      // Everything up to the watermark has been read only when the batch was not full and nothing was held back.
      const complete = !read.full && !read.held;
      const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : minAfter;

      for (const sub of [...feed.subs]) {
        if (sub.afterSeq >= feed.watermark) continue;
        const mine = events.filter((e) => e.seq > sub.afterSeq);
        sub.afterSeq = complete ? feed.watermark : lastSeq > sub.afterSeq ? lastSeq : sub.afterSeq;
        if (mine.length > 0) {
          try {
            sub.handlers.onEvents(mine);
          } catch {
            // The stream's own error handling closes it; the poller must keep serving the rest.
          }
        }
      }
      if (complete) return;
      if (read.held) {
        // Rows inside the settle window: no point re-reading them now; look again once they have aged out.
        feed.nextDueAt = Math.min(feed.nextDueAt, this.clock.now() + Math.max(250, this.settleMs));
        return;
      }
    }
    // Still behind after the per-tick bound: come straight back next tick.
    feed.nextDueAt = this.clock.now();
  }
}

const shared = new WeakMap<Pool, AccountPoller>();

/** The process-wide poller for a platform_ops pool (one per pool, i.e. one per process in production). */
export function getSharedPoller(pool: Pool, platformOpsPool: Pool): AccountPoller {
  let poller = shared.get(platformOpsPool);
  if (!poller) {
    poller = new AccountPoller({ pool, platformOpsPool });
    shared.set(platformOpsPool, poller);
  }
  return poller;
}
