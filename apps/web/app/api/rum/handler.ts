import { NextRequest, NextResponse } from "next/server";
import type { Pool } from "pg";
import { createPool } from "@fx/db/src/pool";
import { PgRateLimitStore, type RateLimitStore } from "@fx/api/src/ratelimit/store.js";
import { bucketKeyForAnonIp, clientIpFromRequest } from "@fx/api/src/ratelimit/limits.js";
import { applySecurityHeaders } from "../../../lib/shell/headers";

/**
 * D#37 WS-D criterion 5: `performance.mark('boot:signin-visible')` and
 * `performance.mark('boot:desktop-ready')` are sent once per page load to
 * `POST /api/rum` -- JSON, same-origin, no PII: only the two named marks,
 * a coarse viewport class, and the connection's effectiveType. Same-origin
 * enforcement is the blanket CSRF rule every non-GET `/api/*` route
 * already gets from middleware.ts -- this route adds nothing of its own
 * there.
 *
 * "Stores nothing else": like csp-report/route.ts, this is operational
 * telemetry (a boot-timing sample), not tenant data -- one structured
 * console line is what LIVE-NEEDS's "production p75 from /api/rum after a
 * week" is aggregated from, not a database row scoped per account.
 *
 * The byte-limited reader mirrors csp-report/route.ts's own
 * `readBodyWithByteLimit` (CWE-400: never buffer past the limit
 * regardless of what `Content-Length` claims) -- a RUM payload is tiny
 * (one or two marks plus two short strings), so the cap here is smaller.
 *
 * Fix round 1, MUST 1 (a review of this PR flagged this route as a gap):
 * this route was unauthenticated and had no request-frequency cap of any
 * kind -- a scripted client could flood it indefinitely at zero cost,
 * generating unbounded log volume and function-invocation cost. Bounded
 * by reusing D#31's own `rate_limit_check` (packages/db/migrations/
 * 0622_rate_limits.sql, extended by 0626_rate_limit_anon_ip.sql with a
 * new `anon:` bucket-key shape) rather than a second limiter -- the
 * review's own instruction was "reuse the existing mechanism if one
 * fits... do not invent a second limiter if one fits." This also reuses
 * the SAME IPv6 /64 collapsing the failed-auth-by-IP cap already applies
 * (`bucketKeyForAnonIp`, packages/api/src/ratelimit/limits.ts), kept in
 * its OWN `anon:rum:` namespace so a rum flood can never burn down the
 * budget real failed sign-in attempts from the same address are charged
 * against, or vice versa.
 *
 * The rate-limit check runs FIRST, before the body is even read: over
 * the cap, this returns 429 and writes nothing (the console.log below is
 * never reached). `RUM_LIMIT_PER_IP_PER_MINUTE` (60) is far above the
 * beacon's real per-IP traffic -- exactly one POST per page load
 * (core/boot-metrics.js's `sent` guard) -- while still bounding a flood.
 * A rate-limit-store failure is never caught here: it propagates to
 * Next's own generic 500 handling, the same fail-closed stance
 * `RateLimitStore`'s own contract documents (packages/api/src/ratelimit/
 * store.ts) -- never served unlimited just because the store is down.
 *
 * Split into this handler.ts plus a thin route.ts wrapper (matching
 * auth/invitations/accept/{route,handler}.ts's own split elsewhere in
 * this app): Next's App Router type-checks a route file's exported
 * `POST`/`GET`/etc. against its own generated `RouteContext` type for
 * the second argument, and separately rejects any OTHER named export
 * from a route.ts file at all -- `handleRumPost`'s injectable `deps`
 * parameter (needed for route.test.ts) satisfies neither rule, so it
 * lives here instead, with route.ts exporting only a zero-extra-args
 * `POST`.
 */
const MAX_BODY_BYTES = 4 * 1024;
const ALLOWED_MARK_NAMES = new Set(["boot:signin-visible", "boot:desktop-ready"]);
const RUM_LIMIT_PER_IP_PER_MINUTE = 60;

/** Injectable for tests (see route.test.ts) -- production always gets the
 * real Postgres-backed store via `defaultDeps()` below. */
export interface RumDeps {
  rateLimitStore: RateLimitStore;
  clientIp: (req: NextRequest) => string;
}

let cachedAppUserPool: Pool | undefined;
function appUserPool(): Pool {
  if (!cachedAppUserPool) {
    const url = process.env.DATABASE_URL_APP_USER;
    if (!url) {
      throw new Error("DATABASE_URL_APP_USER must be set");
    }
    cachedAppUserPool = createPool(url);
  }
  return cachedAppUserPool;
}

let cachedStore: RateLimitStore | undefined;
function defaultDeps(): RumDeps {
  if (!cachedStore) {
    cachedStore = new PgRateLimitStore(appUserPool());
  }
  return { rateLimitStore: cachedStore, clientIp: clientIpFromRequest };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

async function readBodyWithByteLimit(req: NextRequest, limit: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function handleRumPost(req: NextRequest, deps: RumDeps = defaultDeps()): Promise<NextResponse> {
  const ip = deps.clientIp(req);
  const decision = await deps.rateLimitStore.checkAndIncrement(
    bucketKeyForAnonIp("rum", ip),
    RUM_LIMIT_PER_IP_PER_MINUTE,
  );
  if (!decision.allowed) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
      ),
    );
  }

  const contentType = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "application/json") {
    return applySecurityHeaders(NextResponse.json({ error: "unsupported_media_type" }, { status: 415 }));
  }

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return applySecurityHeaders(NextResponse.json({ error: "payload_too_large" }, { status: 413 }));
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyWithByteLimit(req, MAX_BODY_BYTES);
  } catch {
    bytes = new Uint8Array(0);
  }
  if (bytes === null) {
    return applySecurityHeaders(NextResponse.json({ error: "payload_too_large" }, { status: 413 }));
  }

  let body: unknown = null;
  try {
    const text = new TextDecoder().decode(bytes);
    body = text ? JSON.parse(text) : null;
  } catch {
    // Best-effort telemetry -- a malformed body never fails the request.
  }

  const marks: Array<{ name: string; startTime: number }> = [];
  const rawMarks = body && typeof body === "object" ? (body as Record<string, unknown>).marks : undefined;
  if (Array.isArray(rawMarks)) {
    for (const m of rawMarks) {
      if (
        m &&
        typeof m === "object" &&
        ALLOWED_MARK_NAMES.has((m as Record<string, unknown>).name as string) &&
        isFiniteNumber((m as Record<string, unknown>).startTime)
      ) {
        marks.push({ name: (m as { name: string }).name, startTime: (m as { startTime: number }).startTime });
      }
    }
  }

  const rawViewport = body && typeof body === "object" ? (body as Record<string, unknown>).viewport : undefined;
  const viewport = rawViewport === "phone" ? "phone" : "desktop";

  const rawConnection = body && typeof body === "object" ? (body as Record<string, unknown>).connection : undefined;
  const connection = typeof rawConnection === "string" ? rawConnection.slice(0, 16) : "unknown";

  // One structured line, no PII beyond the three fields above -- never
  // written to any table (see the file header).
  console.log(JSON.stringify({ event: "boot_rum", marks, viewport, connection }));

  return applySecurityHeaders(new NextResponse(null, { status: 204 }));
}
