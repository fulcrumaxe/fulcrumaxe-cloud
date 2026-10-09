// Shared fetch helper for first-party apps (D#37 WS-F0b). Moved unchanged from
// the Developer app; no app copies it or imports another app's files.
//
// Every mutation carries Content-Type: application/json (the server rejects a
// cookie mutation without it, csrf_rejected) even when it has no body. No
// request sets Origin or Sec-Fetch-*. The one optional header is
// Idempotency-Key, through the fifth argument `{ idempotencyKey }` (a UUID);
// any other option name, or a key that is not a UUID, throws before fetch.
//
// Requests go through the shell live client's apiFetch (D#37 WS-LV2, C28 rule
// (i)): a 401 makes the client ask the server whether the session ended (one
// auth/me), and only the server's answer ends it. The caller still gets the
// ApiFailure, and no app shows its own "reload the page" text.
import { apiFetch } from "../../core/cloud-live.js";

export class ApiFailure extends Error {
  constructor(status, code, message, details, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    // Whole seconds from a Retry-After header (a 429), or 0 when the response carried none to use.
    this.retryAfter = retryAfter || 0;
    // "server_error" for any 5xx (the message is then a fixed sentence, whatever the server wrote); code stays the server's.
    this.kind = status >= 500 ? "server_error" : "";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Network behaviour (hardening H4b) ───────────────────────────────────────
// Every request has a deadline for the whole call (retries and waits included), so no window can spin
// forever: 15 s for a read, 30 s for a write. When it passes the call fails with ApiFailure(0, "timeout").
// Only a GET is retried, at most twice, with jittered backoff, on a network error or a gateway 502, 503, 504
// that carries no application error code; a 429 is never retried (a refused call still counts against the
// session limit; the caller counts down from retryAfter); a wait is never longer than the time left before the
// deadline. A write is never retried here (replaying a keyed write is the sign-in dialog's job, H4a).
// A network error is ApiFailure(0, "offline"); the shell shows the offline bar when it sees one. A 5xx is
// kind "server_error" with a fixed sentence (its code stays the server's own): nothing the server wrote is shown.
export const READ_DEADLINE_MS = 15000;
export const WRITE_DEADLINE_MS = 30000;
export const MAX_RETRIES = 2;
export const MAX_AUTO_WAIT_SECONDS = 10; // a longer Retry-After goes to the screen, it is not waited out here
const BACKOFF_BASE_MS = 400;
const RETRY_STATUS = new Set([502, 503, 504]);
export const OFFLINE_MESSAGE = "You're offline. Check your connection and try again.";
export const TIMEOUT_MESSAGE = "The server took too long to answer. Try again.";
export const SERVER_ERROR_MESSAGE = "Something went wrong on our side. Try again in a moment.";

/** 400 ms doubling per attempt, scaled by a random factor in [0.5, 1) so a crowd of tabs does not retry in step. */
export function backoffMs(attempt, rand = Math.random) {
  return Math.round(BACKOFF_BASE_MS * 2 ** attempt * (0.5 + 0.5 * rand()));
}

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

export async function api(method, path, body, signal, opts) {
  const init = { method, headers: { Accept: "application/json" } };
  if (opts !== undefined) {
    const bad = Object.keys(opts).some((k) => k !== "idempotencyKey") || (opts.idempotencyKey !== undefined && !(typeof opts.idempotencyKey === "string" && UUID.test(opts.idempotencyKey)));
    if (bad) throw new TypeError("api: the only option is idempotencyKey, and it must be a UUID");
    if (opts.idempotencyKey !== undefined) init.headers["Idempotency-Key"] = opts.idempotencyKey;
  }
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/json";
    if (body !== undefined) init.body = JSON.stringify(body);
  }
  const read = method === "GET";
  const deadlineMs = read ? READ_DEADLINE_MS : WRITE_DEADLINE_MS;
  const maxRetries = read ? MAX_RETRIES : 0;
  const started = Date.now();
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, deadlineMs);
  const onCallerAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  init.signal = ctl.signal;
  // Rejects when the call is aborted (deadline or caller), so a stuck fetch or body read still ends.
  const gone = new Promise((_, reject) => {
    if (ctl.signal.aborted) reject(abortError());
    else ctl.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
  gone.catch(() => {});
  const race = (p) => Promise.race([p, gone]);
  // Waits ms unless the deadline would pass first; false means "do not retry".
  const pause = async (ms) => {
    if (deadlineMs - (Date.now() - started) <= ms) return false;
    let t;
    try {
      await race(new Promise((r) => { t = setTimeout(r, ms); }));
    } finally {
      clearTimeout(t); // an abort mid-wait leaves no timer behind
    }
    return true;
  };
  try {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await race(apiFetch(path, init));
      } catch (e) {
        if (timedOut || (e && e.name === "AbortError")) throw e;
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        if (attempt < maxRetries && !offline && (await pause(backoffMs(attempt)))) continue;
        throw new ApiFailure(0, "offline", OFFLINE_MESSAGE);
      }
      let data = null;
      try {
        const text = await race(res.text());
        if (text) data = JSON.parse(text);
      } catch (e) {
        if (ctl.signal.aborted) throw e;
        data = null;
      }
      if (res.ok) return data;
      const retryAfter = parseRetryAfter(res.headers && typeof res.headers.get === "function" ? res.headers.get("Retry-After") : null);
      const err = data && data.error ? data.error : {};
      const appCode = typeof err.code === "string" && err.code !== "";
      // Only a gateway-level 502/503/504 with no application code is retried. A structured refusal (a code the
      // server chose) is an answer, not a fault. A 429 is never retried: a refused call still counts against
      // the session limit, so the caller shows the countdown from retryAfter instead.
      if (attempt < maxRetries && RETRY_STATUS.has(res.status) && !appCode) {
        // A busy server may name its own wait; never come back sooner than it asked.
        const wait = Math.max(backoffMs(attempt), Math.min(retryAfter, MAX_AUTO_WAIT_SECONDS) * 1000);
        if (await pause(wait)) continue;
      }
      if (res.status >= 500) {
        // Kind is server_error; the code stays the server's own so callers can pick their sentence. The
        // server's message and details never reach the screen.
        throw new ApiFailure(res.status, appCode ? err.code : "server_error", SERVER_ERROR_MESSAGE, undefined, retryAfter);
      }
      const failure = new ApiFailure(
        res.status,
        typeof err.code === "string" ? err.code : "http_" + res.status,
        typeof err.message === "string" ? err.message : "Request failed (" + res.status + ").",
        data && Array.isArray(data.details) ? data.details : undefined,
        retryAfter
      );
      // A runner route names its closed refusal beside the error (a short code and an entry index); never free text.
      if (data && typeof data.reason === "string" && /^[a-z_]{1,48}$/.test(data.reason)) failure.reason = data.reason;
      if (data && Number.isInteger(data.index) && data.index >= 0) failure.index = data.index;
      throw failure;
    }
  } catch (e) {
    if (timedOut) throw new ApiFailure(0, "timeout", TIMEOUT_MESSAGE);
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onCallerAbort);
  }
}

// ── 429 handling (BUILD-RIGHT rule 5) ───────────────────────────────────────
// The server answers a capped call with 429 and an integer Retry-After (seconds); api() puts it on
// ApiFailure.retryAfter. An app turns it into a sentence with retryWords() and keeps the control that made
// the call disabled until the wait is over with createRetryGate(). The sentence is built from the number
// only; nothing the server wrote is shown, and a missing Retry-After never shows "undefined" or "NaN".

export const DEFAULT_WAIT_SECONDS = 10;

/** A positive whole number of seconds from a Retry-After header value, or 0 when there is none to use. */
export function parseRetryAfter(value) {
  if (typeof value !== "string" || !/^\d{1,7}$/.test(value.trim())) return 0;
  return Number(value.trim());
}

/** "Try again in 8 seconds." / "Try again in 1 second." / "Try again in 5 minutes." */
export function retryWords(seconds) {
  const n = Number.isFinite(seconds) && seconds >= 1 ? Math.ceil(seconds) : DEFAULT_WAIT_SECONDS;
  if (n >= 120) {
    const minutes = Math.ceil(n / 60);
    return "Try again in " + minutes + (minutes === 1 ? " minute." : " minutes.");
  }
  return "Try again in " + n + (n === 1 ? " second." : " seconds.");
}

/** True for the failure the server sends when a cap is hit. */
export function isRateLimited(e) {
  return !!e && e.status === 429;
}

/** The seconds to wait for a rate-limited failure, never 0. */
export function waitSeconds(e) {
  return e && e.retryAfter >= 1 ? e.retryAfter : DEFAULT_WAIT_SECONDS;
}

/**
 * A countdown an app holds while a control must stay disabled. start(seconds) begins (or restarts) it and
 * calls onChange(remaining) at once and then every second until it reaches 0, when onChange(0) is the last
 * call. cancel() stops it without a final call. `remaining` is 0 when idle. Timers are injectable for tests.
 */
export function createRetryGate({ onChange, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let deadline = 0;
  let timer = null;
  let remaining = 0;

  function tick() {
    timer = null;
    remaining = Math.max(0, Math.ceil((deadline - now()) / 1000));
    onChange(remaining);
    if (remaining > 0) timer = setTimer(tick, 1000);
  }

  return {
    get remaining() {
      return remaining;
    },
    start(seconds) {
      if (timer !== null) clearTimer(timer);
      const n = Number.isFinite(seconds) && seconds >= 1 ? Math.ceil(seconds) : DEFAULT_WAIT_SECONDS;
      deadline = now() + n * 1000;
      tick();
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      remaining = 0;
    },
  };
}
