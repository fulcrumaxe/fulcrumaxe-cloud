import { MAX_CREATED_SKEW_SECONDS, WAKE_PATH, WAKE_REPLY_MEDIA_TYPE, WAKE_TOKEN_LIFETIME_SECONDS, WakeReply } from "@fulcrumaxe/runner-protocol";
import { readRunnerWakeState } from "@fx/core/src/pendingWork.js";
import { RunnerHttpError, errorResponse, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyKeyBoundRequest } from "./verifyRunnerRequest.js";
import { configuredWakeKey, verifyWakeToken } from "./wakeToken.js";
import type { RunnerSeenWriter } from "./wakeSeen.js";

export { WAKE_PATH };

/**
 * What the wake check needs. There is deliberately no pool here: the type itself keeps the database out of this path. apps/web builds it
 * without `runnerDeps()`, whose auth deps own the pools.
 */
export interface WakeDeps {
  /** The configured public origin (FX_APP_ORIGIN): the URL the signature is checked against. Unset is 503. */
  origin: string | undefined;
  /** The HMAC key the tokens are minted with (FX_RUNNER_WAKE_KEY). Missing, short or throwing is 503: the check is off. */
  wakeKey?: (() => Buffer | null) | null;
  /** Writes the runner's last-heard time (one per process: it remembers its own last writes). Absent: nothing is written, the check still answers. */
  seenWriter?: RunnerSeenWriter | null;
  /** The clock. Tests inject a fixed one. */
  now?: () => Date;
  /** Where the one-line JSON diagnostics go (default: `console.log`). Never the database. */
  log?: (line: string) => void;
}

const UNAUTHORIZED = (): RunnerHttpError => new RunnerHttpError(401, "unauthorized", "the request is not signed by a registered runner");
/** Each liveness store call is bounded like the pending-work store's, so a stalled cache cannot hold the request. */
const SEEN_TIMEOUT_MS = 400;
const BEARER = /^Bearer ([A-Za-z0-9_.-]{1,1100})$/;

/** True when the `Accept` field lists `application/json` with a q above 0. An absent field, `*\/*` or any other type is not enough (406). */
export function acceptsWakeJson(accept: string | undefined): boolean {
  if (accept === undefined) return false;
  return accept.split(",").some((range) => {
    const [type, ...params] = range.split(";").map((part) => part.trim().toLowerCase());
    if (type !== WAKE_REPLY_MEDIA_TYPE) return false;
    const q = params.find((param) => param.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

const asMs = (value: number | null): number | null => {
  if (value === null) return null;
  const ms = Math.floor(value);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
};

function line(deps: WakeDeps, entry: Record<string, unknown>): void {
  try {
    (deps.log ?? ((text: string) => console.log(text)))(JSON.stringify(entry));
  } catch {
    // fx-swallow-ok: a logger that throws must never fail the wake check
  }
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("wake seen store timed out")), SEEN_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Refreshes the runner's last-heard time through the one writer (`runnerSeenWriter`), bounded. Never throws. */
async function recordSeen(deps: WakeDeps, runnerId: string, now: Date): Promise<void> {
  const write = deps.seenWriter;
  if (!write) return;
  try {
    await bounded(write(runnerId, now));
  } catch (error) {
    // fx-swallow-ok: a lost liveness hint; the runner's slot claim stamps the database. stdout only, never error_events.
    line(deps, { event: "runner_wake.seen_failed", error_name: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * D#6 RUNNER-WAKE R3b: GET /api/runner/wake, the cheap "is there work for my account" check, with NO database connection on any path.
 * In order, and every refusal before the reads:
 *  1. only GET, and only for an `Accept` that lists `application/json` (406 otherwise; a stream type can later share the path);
 *  2. no configured wake key is 503 `not_configured` (no grant can have been minted that this cloud could check);
 *  3. an empty body, and the token in `Authorization: Bearer`; the token's MAC and expiry are checked (`verifyWakeToken`), and an expiry later
 *     than a fresh token's is refused too;
 *  4. the request must be signed, in the usual runner scheme, by the key the token names (`verifyKeyBoundRequest`): a token alone is 401;
 *  5. the runner's ALLOW record must exist and name the token's key and account (written by a hello or claim that granted, deleted by every
 *     revoke path; one hour TTL). No record is 503 `wake_unavailable` (fail closed: the runner claims, and the database decides); a record for
 *     another key or account is 401. The key is the runner id, never the token text (it has several spellings);
 *  6. the runner's last-heard time is refreshed (at most once a minute), and the reply is exactly `{epoch, due_at}` for the token's own
 *     account. The account comes only from the verified token, never from the request.
 * Errors are logged to stdout only: the usual reporter counts error classes in Postgres, which would open the connection this path avoids.
 */
export async function runnerWake(deps: WakeDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  try {
    return await wake(deps, req);
  } catch (error) {
    // fx-swallow-ok: a refusal keeps its fixed answer; anything else is a bare 500, logged to stdout (never reportError: it writes error_events)
    if (error instanceof RunnerHttpError) return errorResponse(error);
    line(deps, { event: "runner_wake.unhandled", error_name: error instanceof Error ? error.name : "unknown" });
    return errorResponse(new RunnerHttpError(500, "internal", "internal error"));
  }
}

async function wake(deps: WakeDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  if (req.method !== "GET") throw new RunnerHttpError(405, "method_not_allowed", "use GET");
  if (!acceptsWakeJson(req.headers.accept)) throw new RunnerHttpError(406, "not_acceptable", "this path answers application/json only");
  const key = configuredWakeKey(deps.wakeKey);
  if (key === null) throw new RunnerHttpError(503, "not_configured", "the wake check is not configured");
  if (req.body.byteLength > 0) throw new RunnerHttpError(400, "invalid_message", "the wake check takes no body");

  const bearer = BEARER.exec(req.headers.authorization ?? "");
  if (!bearer) throw UNAUTHORIZED();
  const now = deps.now?.() ?? new Date();
  const payload = verifyWakeToken(key, bearer[1]!, now);
  if (payload === null) throw UNAUTHORIZED();
  // Every token is minted with exactly the lifetime; one that claims longer was not minted by this code.
  if (payload.exp > Math.floor(now.getTime() / 1000) + WAKE_TOKEN_LIFETIME_SECONDS + MAX_CREATED_SKEW_SECONDS) throw UNAUTHORIZED();

  await verifyKeyBoundRequest({ origin: deps.origin, now: () => now }, WAKE_PATH, req, { jkt: payload.jkt, x: payload.jwk_x });

  const state = await readRunnerWakeState({ runnerId: payload.rid, jkt: payload.jkt, accountId: payload.acct });
  // Fail closed: no allow record (a miss reads the same as an eviction, a dropped write or another region) answers nothing; the runner claims.
  if (!state.ok || state.allowed === "missing") throw new RunnerHttpError(503, "wake_unavailable", "the wake check cannot answer now; claim as usual");
  if (state.allowed !== "match") throw UNAUTHORIZED();

  await recordSeen(deps, payload.rid, now);
  const body = WakeReply.parse({ epoch: asMs(state.epoch) ?? 0, due_at: asMs(state.dueAt) });
  return { status: 200, body, headers: { "cache-control": "no-store", vary: "accept, authorization" } };
}
