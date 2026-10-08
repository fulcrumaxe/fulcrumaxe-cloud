import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { reportError } from "@fx/telemetry";
import { effectivePrincipals, matchRoute, RawBody, ROLE_RANK, type RouteEntry } from "./registry.js";
import { ROUTES } from "./routes/index.js";
import { principalIdOf, resolvePrincipal } from "./principal.js";
import { ApiError, InsufficientScopeError, SessionRequiredError, mapError } from "./errors.js";
import { withIdempotency } from "./idempotency.js";
import { enforceTokenRateLimits } from "./ratelimit/limits.js";
import { enforceSessionRateLimits, sessionLimitFor } from "./ratelimit/session.js";
import { PgRateLimitStore, type RateLimitStore } from "./ratelimit/store.js";

/**
 * Security fix round item 5 (CWE-400, security review of this PR): no
 * Spec-defined cap exists for a generic `/api/v1` request body (only
 * H21's own 1 MB-in/64 KB-read webhook-relay path names a number, and
 * that's a different surface). 256 KiB is a conservative default for a
 * JSON API body -- comfortably above any request shape a v1 route
 * declares today, small enough that a client can't force this dispatcher
 * to buffer an arbitrarily large string in memory before validation
 * even runs. Named here, once, rather than inlined at the read site
 * below, so a future route with a genuine reason for a larger body has
 * one constant to reconsider instead of a magic number to rediscover.
 */
const MAX_REQUEST_BODY_BYTES = 256 * 1024;

/**
 * Security fix round item (CWE-400, #126 security re-review, API-1c's
 * to fix): `await req.text()` reads the ENTIRE body into memory before
 * anything checks its size -- the `Content-Length`-based check above it
 * only fires when the client bothers to send an accurate header. A
 * chunked request (`Transfer-Encoding: chunked`, no `Content-Length` at
 * all) sailed straight past that check and got fully buffered by
 * `req.text()` regardless of how large it actually was; the byte-length
 * re-check only ran AFTER the whole thing was already in memory. This
 * reads the stream itself in bounded chunks and stops -- cancelling the
 * underlying stream rather than draining it -- the moment the running
 * total exceeds `capBytes`, so an over-cap chunked body is rejected
 * without ever buffering more than `capBytes` (plus at most one chunk)
 * of it.
 *
 * Also folds in the companion fix: a route declaring no `bodySchema` at
 * all (`entry.bodySchema` undefined) doesn't accept a body, and is now
 * rejected on the FIRST non-empty chunk read -- before any more of a
 * possibly large or slow stream is consumed -- rather than only after
 * the whole body had already been buffered and turned into a string
 * (the previous check, further down in `handleApiRequest`, ran on the
 * fully-read `rawBody`).
 */
async function readRequestBody(req: Request, entry: RouteEntry, capBytes: number): Promise<string> {
  const stream = req.body;
  if (!stream) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;

      if (!entry.bodySchema && total === 0) {
        await reader.cancel().catch(() => {
          // Best-effort: the ApiError thrown below is what matters.
        });
        throw new ApiError(400, "invalid_request", "this route does not accept a request body");
      }

      total += value.byteLength;
      if (total > capBytes) {
        await reader.cancel().catch(() => {
          // Best-effort: the ApiError thrown below is what matters.
        });
        throw new ApiError(400, "invalid_request", `request body exceeds the ${capBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) return "";
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * Deliberately the Fetch API's own `Request`/`Response` (Node's global
 * implementation, not anything from `next/server`) -- `packages/api` has
 * no dependency on `next` at all. `NextRequest` and `NextResponse`
 * (Next's own subclasses) are both structurally assignable to/from these,
 * so `apps/web/app/api/v1/[...path]/route.ts` passes its `NextRequest`
 * straight in and returns this function's plain `Response` straight back
 * out -- Next's App Router accepts a bare `Response` from a route handler
 * with no wrapping required. Kept this way so `test/handler.test.ts` can
 * build requests with plain `new Request(...)`, no Next runtime needed.
 */
function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  replayed?: boolean,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({
    "content-type": "application/json",
    // "Headers: every /api/v1 response except openapi.json sends
    // Cache-Control: private, no-store and X-Request-Id, and never sends
    // Access-Control-*" -- this function is the one place every dispatched
    // response is built, so that's true by construction.
    "Cache-Control": "private, no-store",
    "X-Request-Id": requestId,
  });
  if (replayed) {
    headers.set("Idempotent-Replayed", "true");
  }
  // D#31 API-3d: a 429's Retry-After (mapError's own `headers`) -- the
  // only current source of extraHeaders.
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      headers.set(name, value);
    }
  }
  // DELETE /tokens/{id} -> 204 (criterion 9): the Fetch Response
  // constructor throws on a non-null body with a null-body status
  // (204/205/304, WHATWG Fetch spec).
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

/** D#45 S8: a `RawBody` served as it is produced, with the envelope headers every `/api/v1` response carries. */
function streamResponse(raw: RawBody, requestId: string): Response {
  const headers = new Headers({
    "content-type": raw.contentType,
    "Cache-Control": "private, no-store",
    "X-Request-Id": requestId,
  });
  for (const [name, value] of Object.entries(raw.headers)) {
    headers.set(name, value);
  }
  const iterator = raw.chunks[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return new Response(body, { status: 200, headers });
}

/** The request's path, for a report; undefined when the URL does not parse (the reporter then files it under `/`). */
export function pathOf(req: Request): string | undefined {
  try {
    return new URL(req.url).pathname;
  } catch {
    // fx-swallow-ok: an unparsable request URL only costs the route label; the report still goes ahead
    return undefined;
  }
}

/**
 * D#31 API-1: the single dispatcher every method on the catch-all route
 * (`apps/web/app/api/v1/[...path]/route.ts`) delegates to. Routing,
 * authn/authz, idempotency and error mapping all happen here, once, so
 * every current and future registry entry gets the same guarantees
 * without re-implementing them. `entry.handler` (in `routes/*.ts`) is
 * left to do only the actual work.
 *
 * By the time this runs, `apps/web/lib/shell/csrf.ts` (registered first
 * in middleware) has already decided the CSRF/credential-shape questions
 * C1 owns -- ambiguous credentials, a non-Bearer scheme on `/api/v1/*`,
 * and Content-Type on a cookie- or bearer-authenticated mutation. This
 * function only has to route, authenticate (session vs. token), check
 * role/scope, wrap the call in idempotency, and map errors.
 *
 * Idempotency (criterion 7, API-1c): `withIdempotency`
 * (`packages/api/src/idempotency.ts`) wraps `entry.handler` here, after
 * role/scope checks and the bounded body read, so a replay never runs
 * the real work twice and a reused key under a different body or
 * principal is rejected before `entry.handler` sees it.
 *
 * `routes` defaults to the real registry; a caller (namely
 * `test/handler.test.ts`) can pass its own synthetic list instead, so
 * this dispatcher's own routing/authn/authz/error-mapping behavior is
 * testable without depending on any specific business route being
 * registered yet.
 *
 * `platformOpsPool` (security fix round item 1, CWE-613): passed
 * straight through to `resolvePrincipal`, which needs it to re-check a
 * session cookie's epoch and per-session revocation against the live DB
 * state -- see `principal.ts`'s own doc comment for why the app_user
 * pool alone can't do that.
 *
 * `rateLimitStore` (D#31 API-3d): defaults to a real `PgRateLimitStore`
 * over `pool`. A caller (`test/ratelimit.test.ts`'s fail-closed case)
 * injects a store whose `checkAndIncrement` throws, to prove criterion
 * 6's "never served unlimited" without needing 61 real requests.
 */
export async function handleApiRequest(
  req: Request,
  pool: Pool,
  platformOpsPool: Pool,
  routes: readonly RouteEntry[] = ROUTES,
  rateLimitStore: RateLimitStore = new PgRateLimitStore(pool),
): Promise<Response> {
  const requestId = randomUUID();
  try {
    const url = new URL(req.url);
    const match = matchRoute(routes, req.method, url.pathname);
    if (!match) {
      throw new ApiError(404, "not_found", "not found");
    }
    const { entry, params } = match;

    const principal = await resolvePrincipal(req, pool, platformOpsPool, rateLimitStore);

    // D#31 API-3d (C13c criteria 1-4, 6), fix round 1 S1 (should-fix,
    // CWE-770): token and tenant per-minute caps. Session traffic never
    // reaches this (criterion 3) -- gated on principal.kind alone.
    // Charged right after the principal resolves and BEFORE the
    // kind/scope/role checks below, so a request a token was always
    // going to get rejected for (session_required, insufficient_scope,
    // or insufficient_role -- all 403s) still counts against its
    // buckets. The original ordering ran this AFTER those checks, which
    // let a token send unlimited scope- or role-rejected requests for
    // free: each one still costs a resolvePrincipal round trip (and, for
    // a Bearer credential, the api_tokens lookup inside it) with no cap
    // at all.
    if (principal.kind === "token") {
      await enforceTokenRateLimits(rateLimitStore, pool, {
        accountId: principal.accountId,
        tokenBucketKey: principalIdOf(principal),
      });
    }

    const allowedKinds = effectivePrincipals(entry);
    if (!allowedKinds.includes(principal.kind)) {
      throw new SessionRequiredError();
    }
    if (principal.kind === "token") {
      // tokenSelfOnly (registry.ts) admits any token past this check;
      // the route's own handler enforces the self-only id rule.
      if (!entry.tokenSelfOnly && (!entry.scope || !principal.scopes.includes(entry.scope))) {
        throw new InsufficientScopeError();
      }
    }
    if (ROLE_RANK[principal.role] < ROLE_RANK[entry.minRole]) {
      throw new ForbiddenError(`requires role >= ${entry.minRole}, got ${principal.role}`);
    }

    const isBodyless = req.method === "GET" || req.method === "HEAD";

    // Session callers: the token caps above never reach them, so a signed-in browser (or a script
    // holding its cookie) was unlimited on the routes that call an outside service, start compute or write
    // on each call. Charged after the role check (a 403 costs the caller nothing here) and before the
    // body is read or any handler runs.
    if (principal.kind === "session") {
      const sessionLimit = sessionLimitFor(entry);
      if (sessionLimit) {
        await enforceSessionRateLimits(rateLimitStore, pool, principal, sessionLimit);
      }
    }

    let rawBody = "";
    if (!isBodyless) {
      // Security fix round item 5 (CWE-400): reject on the declared
      // Content-Length before reading anything, when the client sends
      // one and it already exceeds the cap -- cheaper than reading
      // first, though not something a caller can be forced to send
      // accurately (a chunked body sends none at all), hence
      // `readRequestBody`'s own bounded-read enforcement below, which
      // is the real guarantee.
      const contentLength = req.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
        throw new ApiError(400, "invalid_request", `request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit`);
      }
      rawBody = await readRequestBody(req, entry, MAX_REQUEST_BODY_BYTES);
    }
    let parsedBody: unknown;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        throw new ApiError(400, "invalid_request", "request body is not valid JSON");
      }
    }

    const body = entry.bodySchema ? entry.bodySchema.parse(parsedBody) : parsedBody;
    const query = entry.querySchema
      ? entry.querySchema.parse(Object.fromEntries(url.searchParams))
      : undefined;
    // `entry` is a widened `RouteEntry` (the array erases each route's own
    // Params/Query/Body generics), so `paramsSchema.parse` returns `unknown`
    // here regardless of the specific route -- this cast is the one place
    // that widening is bridged back before calling `entry.handler`, whose
    // OWN generic type checked this at the point each route module defined it.
    const parsedParams = (entry.paramsSchema ? entry.paramsSchema.parse(params) : params) as Record<
      string,
      string
    >;

    // Idempotency (criterion 7): wraps entry.handler exactly the way
    // every route -- present and future -- gets it, the same way
    // routing/authn/authz/error-mapping are applied once here rather
    // than per route module.
    //
    // Fix round item 1 (CWE-706 / OWASP A04, security review of this
    // PR): `entry.path` is the route TEMPLATE (e.g.
    // `/api/v1/things/{id}/go`), not the concrete request the caller
    // actually made -- two different concrete requests that both match
    // the same template (or two different routes entirely) would bind
    // the idempotency key to the same stored value on that dimension.
    // `url.pathname` is the real, normalized request path, so it's what
    // `withIdempotency`'s completed-branch comparison now checks.
    //
    // Fix round 2, item 1 (CWE-706 / OWASP A04, security re-review of
    // this PR): `url.pathname` alone still left the query string out of
    // the binding, even though `query` (parsed just above from
    // `url.searchParams`) is as much a part of what the handler acts on
    // as the path is -- a route with both a `querySchema` and an
    // idempotency key could have the same key+body replay a DIFFERENT
    // query's response. `url.search` is WHATWG `URL`'s own normalized
    // serialization of the query string (leading `?` included, empty
    // string when there is none), so appending it here binds the full
    // request target the same way `url.pathname` already binds the path.
    let handlerReplayed = false;
    const idempotencyResult = await withIdempotency(
      pool,
      {
        accountId: principal.accountId,
        principalId: principalIdOf(principal),
        method: entry.method,
        path: url.pathname + url.search,
        mode: entry.idempotency,
        headerKey: req.headers.get("idempotency-key"),
        rawBody,
      },
      async () => {
        const responseBody = await entry.handler(
          {
            pool,
            principal,
            idempotencyKey: req.headers.get("idempotency-key"),
            markReplayed: () => {
              handlerReplayed = true;
            },
          },
          { params: parsedParams, query, body },
        );
        return { status: entry.successStatus ?? 200, body: responseBody };
      },
    );

    if (idempotencyResult.body instanceof RawBody) {
      if (!entry.rawResponse) throw new Error(`${entry.operationId} returned a RawBody without declaring rawResponse`);
      return streamResponse(idempotencyResult.body, requestId);
    }
    return jsonResponse(idempotencyResult.body, idempotencyResult.status, requestId, idempotencyResult.replayed || handlerReplayed);
  } catch (err) {
    const { status, body, headers } = mapError(err, requestId);
    // A 4xx is the caller's answer. A 5xx is ours: its class (stage, route template, allowlisted code) goes to the
    // reporter, never the message the envelope deliberately withholds.
    if (status >= 500) reportError(err, { stage: "api.dispatch", route: pathOf(req) });
    return jsonResponse(body, status, requestId, undefined, headers);
  }
}

/**
 * D#31 API-1c (live-checked against a real `next start`, per the #126
 * reviewer's flag on HEAD/OPTIONS envelope headers): left to a runtime's
 * own automatic HEAD handling (Next.js's included), a HEAD request
 * commonly replays the ORIGINAL request -- method still "HEAD" -- against
 * whichever handler it maps HEAD to. `matchRoute` keys on `req.method`,
 * so a route registered only as GET 404s on HEAD instead of behaving
 * like GET with no body. Confirmed live: `HEAD /api/v1/account` (a real,
 * registered GET route, valid session cookie) returned 404 `not_found`
 * under Next's default automatic handling.
 *
 * This wraps `handleApiRequest` the way a caller (e.g.
 * `apps/web/app/api/v1/[...path]/route.ts`'s own `HEAD` export) should
 * for a HEAD request: dispatches as GET so routing/authn/authz/
 * idempotency all run exactly as they would for the equivalent GET, then
 * strips the body while keeping the dispatcher's own status and headers
 * (`Cache-Control`, `X-Request-Id`, etc.) -- so HEAD gets the same
 * envelope every other `/api/v1` response gets, per "The v1 contract" >
 * Headers. A path with no GET entry still 404s, unchanged.
 */
export async function handleApiHeadRequest(
  req: Request,
  pool: Pool,
  platformOpsPool: Pool,
  routes: readonly RouteEntry[] = ROUTES,
  rateLimitStore: RateLimitStore = new PgRateLimitStore(pool),
): Promise<Response> {
  const getReq = new Request(req.url, { headers: req.headers, method: "GET" });
  const res = await handleApiRequest(getReq, pool, platformOpsPool, routes, rateLimitStore);
  return new Response(null, { status: res.status, headers: res.headers });
}
