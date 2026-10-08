import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getRun } from "@fx/core/src/runs/read.js";
import { listRunEvents } from "@fx/core/src/events/read.js";
import { verifySession } from "@fx/core/src/auth/session.js";
import { getSessionEpochAndRevocation } from "@fx/core/src/auth/identity.js";
import { NotFoundError, ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { reportError } from "@fx/telemetry";
import { handleApiRequest, pathOf } from "../handler.js";
import { ApiError, CrossSiteRefusedError, InsufficientScopeError, SessionRequiredError, mapError } from "../errors.js";
import { principalIdOf, resolvePrincipal, type Principal } from "../principal.js";
import { enforceTokenRateLimits } from "../ratelimit/limits.js";
import { PgRateLimitStore, type RateLimitStore } from "../ratelimit/store.js";
import { ROLE_RANK } from "../registry.js";
import { hashToken } from "../tokens/resolve.js";
import { EVENT_ROUTE_ACCESS } from "../routes/events.js";
import { realClock, type Clock } from "./clock.js";
import { extractCredential, isCrossSiteCookieOpen, type StreamCredential } from "./credentials.js";
import { isCursorStale, openCursor, parseRunCursor, sealCursor, type CursorEnv } from "./cursor.js";
import {
  acquireLease,
  recheckSessionMembership,
  recheckToken,
  releaseLease,
  StreamLimitError,
  type LeaseSubject,
} from "./leases.js";
import { getSharedPoller, type AccountEventRow, type AccountPoller } from "./poller.js";
import { HEARTBEAT_FRAME, MAX_RUN_EVENT_DATA_BYTES, accountEventCursor, capRunEventForWire, frame, isStreamVisible, toAccountEventDTO, toRunEventDTO } from "./views.js";

/**
 * D#31 API-5: the two SSE routes, `GET /api/v1/events` (the account
 * stream) and `GET /api/v1/runs/{id}/events` (one run's output). Both
 * route files call `handleEventsRequest`; it picks JSON mode
 * (`Accept: application/json`, served by the registry through the normal
 * dispatcher) or opens a stream.
 *
 * The lifecycle, all on one injectable `Clock`:
 *   - heartbeat comment every 25 s;
 *   - `event: idle` and close after 5 minutes with no events;
 *   - close at a lifetime drawn uniformly from [720, 780] s, under the
 *     800 s ceiling and jittered so tabs opened together (an outage
 *     recovery) do not reconnect in lockstep;
 *   - every 60 s re-check the principal (session epoch, session
 *     revocation, membership; or token revocation/expiry/creator role)
 *     and renew the lease in the same statement; on failure send
 *     `event: revoked` and close;
 *   - on client abort, stop polling at once;
 *   - backpressure (CWE-770): the per-stream queue is bounded in BYTES
 *     (`MAX_QUEUED_BYTES`). A run replay waits for room; a consumer that
 *     does not drain for `STALL_TIMEOUT_MS`, or falls further behind than
 *     one frame's slack, is dropped with `controller.error()` (the queued
 *     frames are discarded). A drop is a full exit, like any other: it stops
 *     every timer and RELEASES the lease at once. Whether the server ever
 *     closes the socket afterwards is up to the host, and under Next it
 *     did not do so promptly (a never-reading socket stayed ESTABLISHED
 *     40 s after the drop, and `req.signal` never fired), so nothing here
 *     may wait for a close event that might not come. Run event payloads over
 *     `MAX_RUN_EVENT_DATA_BYTES` go out as a truncation marker;
 *   - run streams cost two tenant queries per cycle (`getRun`, then
 *     `listRunEvents`), each 2 s: status BEFORE events is what makes a
 *     terminal status include every event. Sharing that read across
 *     streams on one run is a tracked follow-up, not done here;
 *   - the run stream sends `event: end` and closes once the run is
 *     terminal.
 */

export const HEARTBEAT_INTERVAL_MS = 25_000;
export const IDLE_TIMEOUT_MS = 5 * 60_000;
export const RECHECK_INTERVAL_MS = 60_000;
export const RUN_POLL_INTERVAL_MS = 2_000;
export const LIFETIME_MIN_MS = 720_000;
export const LIFETIME_MAX_MS = 780_000;
const RUN_PAGE = 200;
/**
 * A consumer that lets more than this many BYTES pile up unread is dropped
 * rather than buffered without bound (CWE-770; counting frames let 256
 * large frames through). Comfortably above one capped run event
 * (`MAX_RUN_EVENT_DATA_BYTES`, 64 KiB) plus its framing.
 */
export const MAX_QUEUED_BYTES = 1024 * 1024;
/**
 * A producer that waits for room (`waitForRoom`) may still add one frame past
 * the bound, and a heartbeat or account event may follow; the queue is only
 * given up on when it is this far over.
 */
const WRITE_SLACK_BYTES = 2 * MAX_RUN_EVENT_DATA_BYTES;
/**
 * How long a run stream waits for a full queue to drain before it gives up
 * on the consumer (a stall timer: a slow-but-alive reader is waited for, a
 * stuck one is not). Injectable through `StreamDeps.stallTimeoutMs`.
 */
export const STALL_TIMEOUT_MS = 30_000;
/** A run stream gives up after this many consecutive failed cycles, like the account poller (transient DB errors are retried). */
const RUN_CYCLE_MAX_FAILURES = 3;

/** `agent_runs.status` values after which no run event can follow (0610_work_item_stages.sql). */
export const TERMINAL_RUN_STATUSES: readonly string[] = [
  "refused_spend",
  "succeeded",
  "failed",
  "timed_out",
  "killed_spend",
  "cancelled",
];

/** Uniform over [720 s, 780 s], in ms. `random` is injectable for the 1,000-draw test. */
export function drawLifetimeMs(random: () => number = Math.random): number {
  return LIFETIME_MIN_MS + Math.floor(random() * (LIFETIME_MAX_MS - LIFETIME_MIN_MS + 1));
}

export type StreamTarget = { kind: "account" } | { kind: "run"; runId: string };

export interface StreamDeps {
  /** app_user pool. */
  pool: Pool;
  /** platform_ops pool: session epoch/revocation lookups and the watermark call only. */
  platformOpsPool: Pool;
  clock?: Clock;
  random?: () => number;
  poller?: AccountPoller;
  rateLimitStore?: RateLimitStore;
  env?: CursorEnv;
  runPollIntervalMs?: number;
  /** See `STALL_TIMEOUT_MS`. */
  stallTimeoutMs?: number;
}

function wantsJson(req: Request): boolean {
  const accept = (req.headers.get("accept") ?? "").toLowerCase();
  return accept.includes("application/json") && !accept.includes("text/event-stream");
}

function errorResponse(err: unknown, requestId: string): Response {
  const { status, body, headers } = mapError(err, requestId);
  const out = new Headers({
    "content-type": "application/json",
    "Cache-Control": "private, no-store",
    "X-Request-Id": requestId,
  });
  for (const [name, value] of Object.entries(headers ?? {})) out.set(name, value);
  if (err instanceof StreamLimitError) {
    out.set("Retry-After", String(Math.max(1, Math.ceil(err.retryAfterSeconds))));
  }
  return new Response(JSON.stringify(body), { status, headers: out });
}

/**
 * The entry point both route files call. JSON mode delegates to the
 * ordinary dispatcher (the registry entries in routes/events.ts do the
 * work, with every guarantee `handler.ts` gives any route). Stream mode
 * authenticates and authorizes the SAME way -- principal, token/tenant
 * rate limits, kind, scope, role -- and returns errors as the standard
 * JSON envelope BEFORE any stream byte is sent (a 404 for another
 * account's run, a 422 for a bad cursor, a 429 over the cap).
 */
export async function handleEventsRequest(req: Request, target: StreamTarget, deps: StreamDeps): Promise<Response> {
  if (wantsJson(req)) {
    return handleApiRequest(req, deps.pool, deps.platformOpsPool, undefined, deps.rateLimitStore);
  }
  const requestId = randomUUID();
  try {
    return await openStream(req, target, deps, requestId);
  } catch (err) {
    const res = errorResponse(err, requestId);
    // A 4xx (a bad cursor, a missing run, a cap) is the caller's answer; a 5xx is ours.
    if (res.status >= 500) reportError(err, { stage: "sse.open", route: pathOf(req) });
    return res;
  }
}

async function authenticate(req: Request, deps: StreamDeps): Promise<Principal> {
  const store = deps.rateLimitStore ?? new PgRateLimitStore(deps.pool);
  const principal = await resolvePrincipal(req, deps.pool, deps.platformOpsPool, store);
  if (principal.kind === "token") {
    await enforceTokenRateLimits(store, deps.pool, {
      accountId: principal.accountId,
      tokenBucketKey: principalIdOf(principal),
    });
  }
  if (!EVENT_ROUTE_ACCESS.principals.includes(principal.kind)) {
    throw new SessionRequiredError();
  }
  if (principal.kind === "token" && !principal.scopes.includes(EVENT_ROUTE_ACCESS.scope)) {
    throw new InsufficientScopeError();
  }
  if (ROLE_RANK[principal.role] < ROLE_RANK[EVENT_ROUTE_ACCESS.minRole]) {
    throw new ForbiddenError(`requires role >= ${EVENT_ROUTE_ACCESS.minRole}, got ${principal.role}`);
  }
  return principal;
}

async function openStream(req: Request, target: StreamTarget, deps: StreamDeps, requestId: string): Promise<Response> {
  const clock = deps.clock ?? realClock;
  const env = deps.env ?? process.env;
  // A cross-site page must not be able to spend a victim's stream slots with the victim's cookie:
  // refused before authentication, before any lease and before any byte.
  const early = extractCredential(req);
  if (early?.kind === "session" && isCrossSiteCookieOpen(req)) {
    throw new CrossSiteRefusedError();
  }
  const principal = await authenticate(req, deps);
  const credential = extractCredential(req);
  if (!credential) {
    // resolvePrincipal succeeded, so a credential exists; this is a defensive fail-closed.
    throw new Error("stream: authenticated request carried no credential");
  }

  // Everything that can be refused is refused here, before a lease is
  // taken and before any byte is written.
  const lastEventId = req.headers.get("last-event-id");
  let accountStart: { afterSeq: bigint; resync: boolean } | undefined;
  let runStart: { afterSeq: number; status: string } | undefined;
  const poller = deps.poller ?? getSharedPoller(deps.pool, deps.platformOpsPool);

  if (target.kind === "account") {
    if (lastEventId) {
      const claims = openCursor(lastEventId, principal.accountId, env);
      if (isCursorStale(claims, clock.now())) {
        accountStart = { afterSeq: await poller.headSeq(principal.accountId), resync: true };
      } else {
        accountStart = { afterSeq: claims.serial, resync: false };
      }
    } else {
      accountStart = { afterSeq: await poller.headSeq(principal.accountId), resync: false };
    }
    // Fail closed on a missing key now, not after the stream is open.
    sealCursor({ accountId: principal.accountId, serial: accountStart.afterSeq, issuedAtMs: clock.now() }, env);
  } else {
    const afterSeq = lastEventId ? parseRunCursor(lastEventId) : 0;
    // 404 for a missing run, another account's run, or a malformed id -- all identical, all before a byte.
    const run = await getRun({ pool: deps.pool, principal }, target.runId);
    runStart = { afterSeq, status: run.status };
  }

  const subject: LeaseSubject = {
    kind: principal.kind,
    accountId: principal.accountId,
    principalKey: principal.kind === "token" ? principal.tokenId! : principal.userId,
  };
  const leaseId = await acquireLease(deps.pool, subject, clock.now());

  try {
    return buildStreamResponse({
      deps,
      clock,
      env,
      poller,
      principal,
      credential,
      subject,
      leaseId,
      target,
      accountStart,
      runStart,
      requestId,
      signal: req.signal,
    });
  } catch (err) {
    await releaseLease(deps.pool, subject, leaseId);
    throw err;
  }
}

interface BuildArgs {
  deps: StreamDeps;
  clock: Clock;
  env: CursorEnv;
  poller: AccountPoller;
  principal: Principal;
  credential: StreamCredential;
  subject: LeaseSubject;
  leaseId: string;
  target: StreamTarget;
  accountStart: { afterSeq: bigint; resync: boolean } | undefined;
  runStart: { afterSeq: number; status: string } | undefined;
  requestId: string;
  signal: AbortSignal;
}

function buildStreamResponse(a: BuildArgs): Response {
  const { deps, clock, env, principal, subject } = a;
  const encoder = new TextEncoder();
  const random = deps.random ?? Math.random;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let leaseId = a.leaseId;
  let subscription: { unsubscribe(): void } | undefined;
  const handles: Record<"life" | "heart" | "idle" | "recheck" | "run" | "stall", unknown> = {
    stall: undefined,
    life: undefined,
    heart: undefined,
    idle: undefined,
    recheck: undefined,
    run: undefined,
  };
  const clear = (name: keyof typeof handles): void => {
    if (handles[name] !== undefined) {
      clock.clearTimeout(handles[name]);
      handles[name] = undefined;
    }
  };

  const onAbort = (): void => finish();

  /** Producers waiting for the consumer to make room; `pull()` wakes them. */
  const roomWaiters: ((room: boolean) => void)[] = [];
  function wakeWaiters(room: boolean): void {
    clear("stall");
    for (const wake of roomWaiters.splice(0)) wake(room);
  }

  /**
   * Backpressure for a producer that can emit a burst (a run replay page).
   * Resolves true when the queue has room, false when the stream is over or
   * the consumer stopped draining for `stallTimeoutMs` (then it is dropped).
   * With this the queue holds at most `MAX_QUEUED_BYTES` plus one frame.
   */
  function waitForRoom(): Promise<boolean> {
    if (closed) return Promise.resolve(false);
    if (controller.desiredSize === null || controller.desiredSize > 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      roomWaiters.push(resolve);
      if (handles.stall === undefined) {
        handles.stall = clock.setTimeout(() => {
          handles.stall = undefined;
          drop();
        }, deps.stallTimeoutMs ?? STALL_TIMEOUT_MS);
      }
    });
  }

  /**
   * The one place a stream is torn down. `closed` guards it, so every exit
   * path (client abort, `cancel`, lifetime end, idle, revoked, error, run
   * end, and a slow-consumer drop) reaches it exactly once: timers stop,
   * the account subscription ends, and the lease is released.
   */
  function shutDown(): void {
    closed = true;
    wakeWaiters(false);
    for (const name of Object.keys(handles) as (keyof typeof handles)[]) clear(name);
    subscription?.unsubscribe();
    subscription = undefined;
    a.signal.removeEventListener("abort", onAbort);
    void releaseLease(deps.pool, subject, leaseId);
  }

  function finish(finalFrame?: string): void {
    if (closed) return;
    if (finalFrame) {
      try {
        controller.enqueue(encoder.encode(finalFrame));
      } catch {
        // fx-swallow-ok: the consumer is already gone, so there is nobody to send the final frame to
      }
    }
    shutDown();
    try {
      controller.close();
    } catch {
      // fx-swallow-ok: the controller is already closed or cancelled; closing it twice is harmless
    }
  }

  /**
   * A consumer that does not read is dropped, not buffered without bound.
   * `controller.error()` (not `close()`, which would keep every queued frame)
   * discards the queue at once. The drop is a full exit, so the lease is
   * released HERE, not when the socket closes: nothing guarantees a close
   * event ever reaches this code. Under `next start` a stalled socket stays
   * open until the client reads again, then the host closes it itself
   * without firing `req.signal`, so a lease held "until the socket closes"
   * kept being renewed by the recheck timer until the drawn lifetime.
   */
  function drop(): void {
    if (closed) return;
    shutDown();
    try {
      controller.error(new Error("stream consumer too slow"));
    } catch {
      // fx-swallow-ok: the controller is already errored or cancelled; the drop has happened either way
    }
  }

  function write(text: string): void {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      // fx-swallow-ok: enqueue throws when the consumer has gone away; the stream finishes, which is the answer
      finish();
      return;
    }
    if (controller.desiredSize !== null && controller.desiredSize < -WRITE_SLACK_BYTES) drop();
  }

  function markActivity(): void {
    if (closed) return;
    clear("idle");
    handles.idle = clock.setTimeout(() => finish(frame({ event: "idle", data: {} })), IDLE_TIMEOUT_MS);
  }

  function scheduleHeartbeat(): void {
    handles.heart = clock.setTimeout(() => {
      write(HEARTBEAT_FRAME);
      if (!closed) scheduleHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** One principal re-check; the lease renewal rides on its tenant statement. */
  async function recheck(): Promise<"ok" | "revoked" | "lease_lost"> {
    const nowMs = clock.now();
    let outcome;
    if (a.credential.kind === "token") {
      outcome = await recheckToken(deps.pool, subject, hashToken(a.credential.bearer), leaseId, nowMs);
    } else {
      const session = await verifySession(a.credential.cookie);
      if (!session || session.userId !== principal.userId || session.accountId !== principal.accountId) {
        return "revoked";
      }
      const live = await getSessionEpochAndRevocation(deps.platformOpsPool, session.userId, session.sid);
      if (!live || live.epoch !== session.epoch || live.revoked) {
        return "revoked";
      }
      outcome = await recheckSessionMembership(deps.pool, subject, leaseId, nowMs);
    }
    if (outcome.status === "revoked") return "revoked";
    // A demotion ends the stream even though the lower role could still read it: the client
    // reconnects and re-authenticates at the role it now holds.
    if (ROLE_RANK[outcome.role] < ROLE_RANK[principal.role]) return "revoked";
    if (!outcome.renewed) {
      // The lease row is gone (expired while this process was starved). Take a fresh one under the caps, or stop.
      let fresh: string;
      try {
        fresh = await acquireLease(deps.pool, subject, clock.now());
      } catch (err) {
        if (err instanceof ApiError) return "lease_lost";
        throw err;
      }
      if (closed) {
        // finish() ran while this re-check was in flight and released the OLD lease id: do not strand the new one.
        await releaseLease(deps.pool, subject, fresh);
        return "ok";
      }
      leaseId = fresh;
    }
    return "ok";
  }

  let rechecking = false;
  let recheckAgain = false;

  /** One re-check and what follows it: schedule the next tick, or end the stream. */
  async function runRecheck(): Promise<void> {
    if (closed) return;
    if (rechecking) {
      // One already in flight may have read the state from before this trigger: run once more when it ends.
      recheckAgain = true;
      return;
    }
    rechecking = true;
    try {
      const result = await recheck();
      if (closed) return;
      if (result === "ok") {
        scheduleRecheck();
      } else {
        finish(frame({ event: "revoked", data: { reason: result === "lease_lost" ? "lease_lost" : "principal" } }));
      }
    } catch (err) {
      reportError(err, { stage: "sse.recheck", route: "/api/v1/events" });
      finish(frame({ event: "error", data: { code: "internal_error" } }));
    } finally {
      rechecking = false;
      if (recheckAgain) {
        recheckAgain = false;
        if (!closed) {
          clear("recheck");
          void runRecheck();
        }
      }
    }
  }

  function scheduleRecheck(): void {
    clear("recheck");
    handles.recheck = clock.setTimeout(() => {
      handles.recheck = undefined;
      void runRecheck();
    }, RECHECK_INTERVAL_MS);
  }

  /** API-5c: an event that names THIS credential's own revocation runs the principal re-check now, not at the next tick. */
  function endsMyCredential(row: AccountEventRow): boolean {
    if (row.subjectId === null) return false;
    if (a.credential.kind === "token") return row.type === "api_token.revoked" && row.subjectId === principal.tokenId;
    return row.type === "session.revoked" && row.subjectId === principal.userId;
  }

  let runFailures = 0;

  async function runCycle(knownStatus?: string): Promise<void> {
    if (closed) return;
    const runId = (a.target as { runId: string }).runId;
    const ctx = { pool: deps.pool, principal };
    try {
      // Status first, events second: a terminal status observed BEFORE the
      // event read means that read includes every event the run ever wrote.
      const status = knownStatus ?? (await getRun(ctx, runId)).status;
      let afterSeq = runCursor;
      for (;;) {
        const page = await listRunEvents(ctx, runId, {
          afterSeq,
          limit: RUN_PAGE,
          // A stalled stream holds at most about MAX_QUEUED_BYTES + one page of these, not RUN_PAGE full-size events.
          byteBounds: { payloadCapBytes: MAX_RUN_EVENT_DATA_BYTES, pageBudgetBytes: MAX_QUEUED_BYTES },
        });
        if (closed) return;
        for (const event of page.data) {
          if (!(await waitForRoom())) return;
          write(frame({ id: String(event.seq), event: "run_event", data: capRunEventForWire(toRunEventDTO(event)) }));
          afterSeq = event.seq;
          if (closed) return;
        }
        if (page.data.length > 0) markActivity();
        runCursor = afterSeq;
        if (page.next_after_seq === null) break;
      }
      if (closed) return;
      runFailures = 0;
      if (TERMINAL_RUN_STATUSES.includes(status)) {
        finish(frame({ event: "end", data: { status } }));
        return;
      }
    } catch (err) {
      if (closed) return;
      if (!(err instanceof NotFoundError)) reportError(err, { stage: "sse.run_cycle", route: "/api/v1/runs/_/events" });
      // A missing run ends the stream at once; a transient failure is retried like the account poller does.
      if (err instanceof NotFoundError || ++runFailures >= RUN_CYCLE_MAX_FAILURES) {
        finish(frame({ event: "error", data: { code: err instanceof NotFoundError ? "not_found" : "internal_error" } }));
        return;
      }
    }
    if (!closed) {
      handles.run = clock.setTimeout(() => {
        handles.run = undefined;
        void runCycle();
      }, deps.runPollIntervalMs ?? RUN_POLL_INTERVAL_MS);
    }
  }

  let runCursor = a.runStart?.afterSeq ?? 0;

  function onAccountEvents(rows: AccountEventRow[]): void {
    if (closed) return;
    try {
      if (rows.some(endsMyCredential)) {
        clear("recheck");
        void runRecheck();
      }
      for (const row of rows.filter(isStreamVisible)) {
        write(
          frame({
            id: accountEventCursor(row, principal.accountId, env),
            event: row.type,
            data: toAccountEventDTO(row),
          }),
        );
      }
      if (rows.some(isStreamVisible)) markActivity();
    } catch (err) {
      reportError(err, { stage: "sse.account_events", route: "/api/v1/events" });
      finish(frame({ event: "error", data: { code: "internal_error" } }));
    }
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
        write(": ok\n\n");
        arm();
      },
      pull() {
        wakeWaiters(true);
      },
      cancel() {
        finish();
      },
    },
    { highWaterMark: MAX_QUEUED_BYTES, size: (chunk) => chunk?.byteLength ?? 0 },
  );

  function arm(): void {
    if (a.signal.aborted) {
      finish();
      return;
    }
    a.signal.addEventListener("abort", onAbort, { once: true });
    handles.life = clock.setTimeout(() => finish(), drawLifetimeMs(random));
    scheduleHeartbeat();
    scheduleRecheck();
    markActivity();

    if (a.target.kind === "account") {
      const start = a.accountStart!;
      // An id-only frame gives the client a valid resume point before any event exists.
      const headCursor = sealCursor({ accountId: principal.accountId, serial: start.afterSeq, issuedAtMs: clock.now() }, env);
      if (start.resync) {
        write(frame({ id: headCursor, event: "resync", data: {} }));
      } else {
        write(`id: ${headCursor}\n\n`);
      }
      subscription = a.poller.subscribe(principal.accountId, start.afterSeq, {
        onEvents: onAccountEvents,
        onFail: () => finish(frame({ event: "error", data: { code: "internal_error" } })),
      });
    } else {
      void runCycle(a.runStart!.status);
    }
  }

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Request-Id": a.requestId,
    },
  });
}
