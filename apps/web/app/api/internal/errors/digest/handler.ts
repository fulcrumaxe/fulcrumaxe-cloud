import { createHash, timingSafeEqual } from "node:crypto";
import { RateLimitedError } from "@fx/api/src/errors.js";
import { clientIpFromRequest, enforceFailedAuthRateLimit } from "@fx/api/src/ratelimit/limits.js";
import { PgRateLimitStore } from "@fx/api/src/ratelimit/store.js";
import { appUserPool, platformOpsPool } from "@fx/api/src/sse/pools.js";
import { DIGEST_CALLS_PER_HOUR, readErrorEvents, takeDigestSlot, type DigestSlot, type ErrorEventsRead } from "@fx/db/src/errorDigest.js";
import { readLapTimes } from "@fx/reconcile";
import { buildDigest, DIGEST_DEFAULT_WINDOW_HOURS, DIGEST_MAX_WINDOW_HOURS, reportError, type DigestLap } from "@fx/telemetry";

/**
 * D#454 H1f: the operator's error digest. `GET /api/internal/errors/digest[?window_hours=N]` answers, for the last N hours
 * (default 24, at most 48), each error class with its count and first and last time seen, the new classes, the jumps, the
 * overflow class when present and every reconciler job's lap time. The rules are @fx/telemetry's `buildDigest`; the reads
 * are @fx/db's `readErrorEvents` and @fx/reconcile's `readLapTimes`. This file is the wiring and the door.
 *
 * Auth is the bearer FX_OPS_DIGEST_TOKEN and nothing else: no cookie, no API token, and not CRON_SECRET (a cron caller is not
 * the operator). The comparison hashes both sides and uses `timingSafeEqual` over the equal-length digests.
 *   - Token unset or shorter than 32 characters: 503 `digest_disabled`, for every caller. Never open by default.
 *   - A missing or wrong header: the existing failed-auth-per-IP limit (20 a minute) is charged and the answer is 401, or 429 once
 *     over it. These calls never touch the operator's budget, so a stranger cannot use up the operator's quota.
 *   - A right header: charged to the digest's own budget of 60 an hour (rate_limit_windows, one platform-wide bucket); over it,
 *     429 with Retry-After. The budget and the database are reached only after the header has matched.
 * A failure of the limiter or of a read is not turned into an answer from the data: it is reported as an error class and the
 * request fails with 500, never served unlimited.
 */
export const DIGEST_ROUTE = "/api/internal/errors/digest";
/** A token shorter than this is treated as unset: a guessable operator token is worse than none. */
export const MIN_TOKEN_LENGTH = 32;

export interface DigestRead extends ErrorEventsRead {
  laps: DigestLap[];
}

export interface DigestDeps {
  /** FX_OPS_DIGEST_TOKEN. */
  token: string | undefined;
  /** Charges one failed-auth attempt to the caller's address; throws RateLimitedError once over the limit. */
  failedAuth(clientIp: string): Promise<void>;
  /** Charges one authenticated call to the digest's own hourly budget. Called only after the header matched. */
  takeSlot(): Promise<DigestSlot>;
  /** Reads the rows and the lap times. Called only after the header matched and the budget allowed it. */
  read(windowHours: number): Promise<DigestRead>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const tooMany = (retryAfterSeconds: number): Response => json(429, { error: "rate_limited" }, { "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))) });

function authorized(header: string | null, token: string): boolean {
  if (!header) return false;
  // Hash both sides so the comparison is constant-length whatever the header holds.
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const actual = createHash("sha256").update(header).digest();
  return timingSafeEqual(expected, actual);
}

/** `window_hours`: absent is the default; otherwise 1 to 48 as plain digits. Null when it is anything else. */
export function parseWindowHours(value: string | null): number | null {
  if (value === null) return DIGEST_DEFAULT_WINDOW_HOURS;
  if (!/^[0-9]{1,2}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= DIGEST_MAX_WINDOW_HOURS ? n : null;
}

let cachedStore: PgRateLimitStore | undefined;

/** The real dependencies. The pools are built when first used, which is after the header has matched (or, for failed auth, on the first stranger). */
export function digestDepsFromEnv(env: Record<string, string | undefined> = process.env): DigestDeps {
  return {
    token: env.FX_OPS_DIGEST_TOKEN?.trim() || undefined,
    failedAuth: (ip) => enforceFailedAuthRateLimit((cachedStore ??= new PgRateLimitStore(appUserPool())), ip),
    takeSlot: () => takeDigestSlot(platformOpsPool(), DIGEST_CALLS_PER_HOUR),
    read: async (windowHours) => {
      const [events, laps] = await Promise.all([readErrorEvents(platformOpsPool(), windowHours), readLapTimes(platformOpsPool())]);
      return {
        ...events,
        laps: laps.map((l) => ({ name: l.name, intervalSeconds: l.intervalSeconds, lapSeconds: l.lapSeconds, neverCompleted: l.neverCompleted, breach: l.breach })),
      };
    },
  };
}

export async function digestHandler(req: Request, deps: DigestDeps = digestDepsFromEnv()): Promise<Response> {
  // Building the deps opens no connection, so a disabled digest touches nothing.
  const token = deps.token;
  if (token === undefined || token.length < MIN_TOKEN_LENGTH) return json(503, { error: "digest_disabled" });

  if (!authorized(req.headers.get("authorization"), token)) {
    try {
      await deps.failedAuth(clientIpFromRequest(req));
    } catch (err) {
      if (err instanceof RateLimitedError) return tooMany(err.retryAfterSeconds);
      throw err;
    }
    return json(401, { error: "unauthenticated" });
  }

  try {
    const slot = await deps.takeSlot();
    if (!slot.allowed) return tooMany(slot.retryAfterSeconds);
    // Read after the budget is charged, so a bad window costs a call like any other.
    const windowHours = parseWindowHours(new URL(req.url).searchParams.get("window_hours"));
    if (windowHours === null) return json(400, { error: "invalid_window" });
    const { now, rows, laps } = await deps.read(windowHours);
    return json(200, buildDigest({ rows, laps, now, windowHours }));
  } catch (err) {
    reportError(err, { stage: "digest", route: DIGEST_ROUTE });
    return json(500, { error: "internal_error" });
  }
}
