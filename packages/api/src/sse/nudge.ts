import { randomBytes } from "node:crypto";
import { Client, type Pool } from "pg";
import { isStagingPaused } from "@fx/core/src/pendingWork.js";
import { reportError } from "@fx/telemetry";
import { realClock, type Clock } from "./clock.js";

/**
 * D#31 API-5d: the wake-up for an idle account's feed.
 *
 * The migration-0652 trigger sends `NOTIFY fx_account_nudge, '<account id>'` when a session.revoked or
 * api_token.* event commits. Each process keeps ONE dedicated `pg.Client` (never a pooled connection)
 * LISTENing on that channel and hands each account id to the poller, which schedules that account's next
 * read (poller.ts `nudge()`). The payload is the account id only; the poller still reads events only
 * through `withTenant` under the subscriber's own account, so a forged NOTIFY can cause at most one bounded
 * extra poll of one account.
 *
 * Failure is never silent loss: when the listener cannot connect, is pointed at a pooled host, misses its
 * probe or drops, it is DEGRADED, and the poller simply keeps polling at 2 s / 10 s as before. On recovery
 * the poller reads every feed once to pick up whatever was missed while the connection was down.
 */
export const NUDGE_CHANNEL = "fx_account_nudge";

/** The event types the migration-0652 trigger notifies for. Must equal the trigger's WHEN list (a test compares them). */
export const NUDGE_EVENT_TYPES = ["session.revoked", "api_token.created", "api_token.revoked"] as const;

/** A probe that has not come back through the LISTEN connection in this long marks the listener degraded. */
export const PROBE_TIMEOUT_MS = 5_000;
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
/** The listener closes this long after the last feed leaves the process. */
export const LISTENER_IDLE_CLOSE_MS = 60_000;

const PROBE_PREFIX = "probe:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAccountId(payload: string): boolean {
  return UUID_RE.test(payload);
}

/** What the poller talks to. Tests substitute a fake. */
export interface NudgeSource {
  /** Opens the listener (idempotent). */
  start(handlers: NudgeHandlers): void;
  /** Closes it (idempotent). */
  stop(): void;
}

export interface NudgeHandlers {
  /** A payload arrived; the poller validates it as a UUID. */
  onNudge(accountId: string): void;
  /** The listener is back after being down: wake every feed once. */
  onRecovered(): void;
}

export interface NudgeListenerOptions {
  /** Connection string for the dedicated LISTEN client. Never logged. */
  url: string;
  /** A different connection than the listener's, used to send the probe (the platform_ops pool). */
  probePool: Pool;
  clock?: Clock;
  /** Log sink; receives only fixed state strings and Postgres error codes. */
  log?: (line: string) => void;
  random?: () => number;
}

/** The URL the listener uses: `DATABASE_URL_EVENTS_LISTEN`, otherwise `DATABASE_URL_PLATFORM_OPS`. */
export function nudgeUrlFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.DATABASE_URL_EVENTS_LISTEN || env.DATABASE_URL_PLATFORM_OPS || undefined;
}

/** Neon's pooled host (PgBouncer, transaction mode) cannot carry LISTEN. */
export function isPooledUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes("-pooler");
  } catch {
    // fx-swallow-ok: an unparsable URL is answered as pooled, so the listener degrades to polling instead of guessing
    return true; // unparseable: refuse rather than guess
  }
}

type State = "stopped" | "connecting" | "connected" | "degraded";

export class NudgeListener implements NudgeSource {
  private readonly url: string;
  private readonly probePool: Pool;
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private readonly random: () => number;
  private state: State = "stopped";
  private loggedState: string | undefined;
  private handlers: NudgeHandlers | undefined;
  private client: Client | undefined;
  private timers = new Set<unknown>();
  private probeId: string | undefined;
  private probeDone: (() => void) | undefined;
  private backoffMs = RECONNECT_MIN_MS;
  private connectedAt = 0;
  private hadTrouble = false;
  /** Bumped on every (re)connect attempt, on degrade and on stop(), so callbacks from an old attempt do nothing. */
  private epoch = 0;

  constructor(opts: NudgeListenerOptions) {
    this.url = opts.url;
    this.probePool = opts.probePool;
    this.clock = opts.clock ?? realClock;
    this.log = opts.log ?? ((line) => console.warn(line));
    this.random = opts.random ?? Math.random;
  }

  /** "connected" only after the probe came back. */
  status(): State {
    return this.state;
  }

  start(handlers: NudgeHandlers): void {
    this.handlers = handlers;
    if (this.state !== "stopped") return;
    void this.connect();
  }

  stop(): void {
    this.epoch++;
    this.state = "stopped";
    this.loggedState = undefined;
    this.hadTrouble = false;
    this.backoffMs = RECONNECT_MIN_MS;
    this.clearTimers();
    this.dropClient();
  }

  private clearTimers(): void {
    for (const t of this.timers) this.clock.clearTimeout(t);
    this.timers.clear();
  }

  private timer(fn: () => void, ms: number): void {
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(handle);
      fn();
    }, ms);
    this.timers.add(handle);
  }

  private dropClient(): void {
    const client = this.client;
    this.client = undefined;
    this.probeId = undefined;
    this.probeDone = undefined;
    if (client) {
      client.removeAllListeners();
      client.on("error", () => {}); // an error while closing must not crash the process
      client.end().catch(() => {});
    }
  }

  private logOnce(line: string): void {
    if (this.loggedState === line) return;
    this.loggedState = line;
    this.log(line);
  }

  private async connect(): Promise<void> {
    const epoch = ++this.epoch;
    this.state = "connecting";
    if (isPooledUrl(this.url)) {
      this.degrade(epoch, "pooled-host");
      return;
    }
    const client = new Client({ connectionString: this.url, connectionTimeoutMillis: PROBE_TIMEOUT_MS });
    this.client = client;
    client.on("error", (err: unknown) => this.degrade(epoch, errorCode(err)));
    client.on("end", () => this.degrade(epoch, "connection-closed"));
    client.on("notification", (msg) => this.onNotification(epoch, msg.payload));
    try {
      await client.connect();
      if (epoch !== this.epoch) return;
      await client.query(`LISTEN ${NUDGE_CHANNEL}`);
      if (epoch !== this.epoch) return;
      await this.probe(epoch);
    } catch (err) {
      reportError(err, { stage: "sse.nudge_connect" });
      this.degrade(epoch, errorCode(err));
      return;
    }
    if (epoch !== this.epoch) return;
    this.clearTimers(); // the probe's timeout
    this.state = "connected";
    this.connectedAt = this.clock.now();
    this.logOnce("nudge listener: connected");
    if (this.hadTrouble) {
      this.hadTrouble = false;
      this.handlers?.onRecovered();
    }
  }

  /** Sends a probe from a different connection and waits for it to arrive on this one. */
  private probe(epoch: number): Promise<void> {
    const id = `${PROBE_PREFIX}${randomBytes(8).toString("hex")}`;
    this.probeId = id;
    return new Promise<void>((resolve, reject) => {
      this.probeDone = resolve;
      this.timer(() => {
        if (epoch === this.epoch && this.probeId === id) reject(new Error("probe-timeout"));
      }, PROBE_TIMEOUT_MS);
      this.probePool.query("SELECT pg_notify($1, $2)", [NUDGE_CHANNEL, id]).catch(reject);
    });
  }

  private onNotification(epoch: number, payload: string | undefined): void {
    if (epoch !== this.epoch || payload === undefined) return;
    if (payload.startsWith(PROBE_PREFIX)) {
      if (payload === this.probeId) {
        this.probeId = undefined;
        this.probeDone?.();
      }
      return; // a probe payload never wakes a feed
    }
    if (this.state === "connected") this.handlers?.onNudge(payload);
  }

  private degrade(epoch: number, code: string): void {
    if (epoch !== this.epoch || this.state === "stopped") return;
    this.epoch++; // ignore anything else the dead attempt reports
    this.dropClient();
    this.clearTimers();
    if (this.state === "connected" && this.clock.now() - this.connectedAt >= RECONNECT_MAX_MS) {
      this.backoffMs = RECONNECT_MIN_MS; // it was stable for a while: start the backoff over
    }
    this.state = "degraded";
    this.hadTrouble = true;
    this.logOnce(`nudge listener: degraded (${code})`);
    const delay = Math.round(this.backoffMs * (0.5 + this.random() * 0.5));
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    this.timer(() => void this.connect(), delay);
  }
}

/** Only a Postgres/system error code is ever logged, never the message (which can carry the host or user). */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "error";
}

/**
 * The listener for a process, built from the environment; undefined when no URL is configured (or under NODE_ENV=test, where suites build their own).
 * Also undefined while staging is paused (FX_STAGING_PAUSED=1): no LISTEN connection and no probe are ever opened, so the
 * poller runs exactly as it does for a degraded listener, polling each feed at its normal 2 s / 10 s cadence.
 */
export function defaultNudgeSource(probePool: Pool, env: Record<string, string | undefined> = process.env): NudgeSource | undefined {
  if (env.NODE_ENV === "test") return undefined;
  if (isStagingPaused(env)) return undefined;
  const url = nudgeUrlFromEnv(env);
  return url ? new NudgeListener({ url, probePool }) : undefined;
}
