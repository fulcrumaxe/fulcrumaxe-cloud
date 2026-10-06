import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { ForbiddenError, NotFoundError } from '@fx/core/src/tenancy/errors.js';
import { SESSION_COOKIE_NAME, signSession, verifySession } from '@fx/core/src/auth/session.js';
import { bumpSessionEpoch, revokeSession } from '@fx/core/src/auth/identity.js';
import { handleApiHeadRequest, handleApiRequest } from '../src/handler.js';
import { DENY_REASONS, DenyError, mapError } from '../src/errors.js';
import type { RouteEntry } from '../src/registry.js';
import { seedAccountWithMember } from './helpers/seed.js';

/**
 * D#31 API-1b criterion 3 (real input, exercised here against the
 * dispatcher directly rather than a live `next start` server -- the
 * curl-against-`next start` transcripts required by the brief, and the
 * real `GET /api/v1/account` route these ran against on the original
 * `api-1-foundation` branch, are API-1c's) and criterion 4 (error
 * mapping).
 *
 * `handleApiRequest` dispatches whatever `RouteEntry[]` it is given
 * (defaulting to the real, still-empty `ROUTES` -- see `routes/index.ts`).
 * This suite exercises the dispatcher's own routing/authn/authz/error-
 * mapping mechanics against a synthetic, test-only route rather than any
 * real business route, the same way `inventory.test.ts` proves
 * `validateRegistry` against a synthetic `badRoute`.
 */
const testRoutes: RouteEntry[] = [
  {
    method: 'GET',
    path: '/api/v1/test-echo',
    operationId: 'testEcho',
    principals: ['session', 'token'],
    minRole: 'member',
    scope: 'read',
    idempotency: 'never',
    responseSchema: z.object({ accountId: z.string(), userId: z.string() }),
    async handler(ctx) {
      return { accountId: ctx.principal.accountId, userId: ctx.principal.userId };
    },
  },
];

// Security fix round item 1 (CWE-613): every test below that needs a
// live session now signs a REAL `__Host-fx_session` cookie with
// `signSession` and sends it as the `Cookie` header, exactly like a
// browser would -- `resolvePrincipal` (principal.ts) no longer trusts
// the `x-fx-user-id` / `x-fx-account-id` headers a hand-built `Request`
// could claim unchecked.
const FX_SESSION_SECRET = 's'.repeat(32);

/**
 * Also sets `x-fx-user-id` / `x-fx-account-id`, exactly as
 * `apps/web/middleware.ts`'s `sessionStep` would forward them for this
 * cookie: `verifySession` alone (no DB access) is all that step can do,
 * so it sets these headers for ANY cryptographically-valid,
 * not-yet-time-expired JWT -- including one that has since been
 * revoked, or signed under an epoch the DB has since bumped past.
 * Including them here means a test against the OLD (header-trusting)
 * `resolvePrincipal` sees exactly what a real revoked/stale-epoch
 * request would carry in production, not an under-specified request
 * that happens to 401 for the wrong reason (no headers at all).
 */
async function requestWithSessionCookie(
  url: string,
  token: string,
  identity: { userId: string; accountId: string },
  init: RequestInit = {},
): Promise<Request> {
  const headers = new Headers(init.headers);
  headers.set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
  headers.set('x-fx-user-id', identity.userId);
  headers.set('x-fx-account-id', identity.accountId);
  return new Request(url, { ...init, headers });
}

describe('handleApiRequest: dispatch, authn/authz and error mapping', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = FX_SESSION_SECRET;
  });

  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  it('401 unauthenticated with no credentials at all, and request_id equals X-Request-Id', async () => {
    const req = new Request('http://localhost/api/v1/test-echo');
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, testRoutes);
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await res.json()) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe('unauthenticated');
    expect(body.error.request_id).toBe(res.headers.get('X-Request-Id'));
  });

  it('200 with the handler-produced body for a valid session principal', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    const req = await requestWithSessionCookie('http://localhost/api/v1/test-echo', token, { userId, accountId });
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, testRoutes);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const body = await res.json();
    expect(body).toEqual({ accountId, userId });
  });

  it('401 invalid_token for a bearer token -- no token can be valid before API-3b', async () => {
    const req = new Request('http://localhost/api/v1/test-echo', {
      headers: { authorization: 'Bearer fxat_x' },
    });
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, testRoutes);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_token');
  });

  it('a session whose membership was removed after the cookie was issued -> 401 unauthenticated, not a stale role', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    await admin.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [
      accountId,
      userId,
    ]);
    const token = await signSession({ userId, accountId });
    const req = await requestWithSessionCookie('http://localhost/api/v1/test-echo', token, { userId, accountId });
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, testRoutes);
    expect(res.status).toBe(401);
  });

  /**
   * Security fix round item 1 (CWE-613 / OWASP A07, security review of
   * this PR). Fails on 002a5b6 (the reviewed head) with:
   *
   *   AssertionError: expected 200 to be 401
   *
   * because `resolvePrincipal` at that head builds the principal
   * straight from `x-fx-user-id` / `x-fx-account-id` -- headers
   * `apps/web/middleware.ts`'s `sessionStep` sets from `verifySession`
   * ALONE, with no re-check of `users.session_epoch` or per-session
   * revocation -- and never looks at the `Cookie` header at all. A hand
   * built `Request` carrying only those two headers (nothing a browser
   * could actually be tricked into sending unprompted, but exactly what
   * a compromised or stale downstream proxy/cache could replay) used to
   * authenticate as that user with no cookie, and therefore no epoch or
   * revocation check, in the picture at all.
   */
  it('x-fx-user-id / x-fx-account-id headers alone, with no session cookie, do not authenticate', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const req = new Request('http://localhost/api/v1/test-echo', {
      headers: { 'x-fx-user-id': userId, 'x-fx-account-id': accountId },
    });
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, testRoutes);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  /**
   * Security fix round item 1: a session revoked by a plain sign-out
   * (identity.ts's `revokeSession`, keyed on the JWT's own `sid`) must
   * not keep authenticating on `/api/v1/*` until its idle/absolute
   * deadline -- the exact "a stolen cookie stays usable after the
   * victim signs out" gap the security review found. Fails on 002a5b6
   * the same way the previous test does (200 instead of 401), for the
   * same underlying reason: the cookie was never even read.
   */
  it('a revoked session cookie -> 401 unauthenticated, even though the JWT itself still verifies', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    const verified = await verifySession(token);
    if (!verified) throw new Error('test setup: signed token failed to verify');
    await revokeSession(platformOpsPool, verified.sid, userId, new Date(Date.now() + 24 * 60 * 60 * 1000));

    const req = await requestWithSessionCookie('http://localhost/api/v1/test-echo', token, { userId, accountId });
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, testRoutes);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  /**
   * Security fix round item 1: "sign out everywhere" (D#37 WS-C
   * criterion 8) bumps `users.session_epoch` so every OTHER
   * still-cryptographically-valid session of that user stops
   * authenticating too, not just the one that signed out. Same
   * failure mode on 002a5b6 as the two tests above.
   */
  it('a session signed under a stale epoch -> 401 unauthenticated', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId }); // embeds epoch 0
    await bumpSessionEpoch(platformOpsPool, userId); // live epoch is now 1

    const req = await requestWithSessionCookie('http://localhost/api/v1/test-echo', token, { userId, accountId });
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, testRoutes);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  it('404 not_found for a path no registry entry declares', async () => {
    const req = new Request('http://localhost/api/v1/does-not-exist');
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, testRoutes);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('403 insufficient_role when the caller\'s role is below the entry\'s minRole', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin, { role: 'member' });
    const ownerOnlyRoutes: RouteEntry[] = [{ ...testRoutes[0]!, minRole: 'owner' }];
    const token = await signSession({ userId, accountId });
    const req = await requestWithSessionCookie('http://localhost/api/v1/test-echo', token, { userId, accountId });
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, ownerOnlyRoutes);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('insufficient_role');
  });

  it('a non-empty body on a route with no bodySchema -> 400 invalid_request', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    // testEcho is a GET route (bodyless by method, so GET/HEAD never
    // reach the body-reading code at all) -- a POST variant of the same
    // entry, still with no `bodySchema`, exercises it instead.
    const postRoutes: RouteEntry[] = [{ ...testRoutes[0]!, method: 'POST' }];
    const req = await requestWithSessionCookie('http://localhost/api/v1/test-echo', token, { userId, accountId }, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unexpected: true }),
    });
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, postRoutes);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('a request body over the byte cap -> 400 invalid_request, via Content-Length', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    const postRoutes: RouteEntry[] = [
      { ...testRoutes[0]!, method: 'POST', bodySchema: z.object({}).passthrough() },
    ];
    const oversized = 'x'.repeat(300 * 1024);
    const req = await requestWithSessionCookie('http://localhost/api/v1/test-echo', token, { userId, accountId }, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(oversized.length) },
      body: oversized,
    });
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, postRoutes);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  /**
   * Security fix round item (CWE-400, #126 security re-review, API-1c's
   * to fix). A chunked body sends no `Content-Length` at all, so the
   * header-based fast path above never fires -- the ONLY thing that can
   * still cap it is `readRequestBody`'s bounded stream read in
   * handler.ts. `chunkedBody` never terminates on its own (it is an
   * infinite generator); `handleApiRequest` must still resolve well
   * inside the test timeout, because a correct implementation stops
   * reading (and cancels the stream) the moment the running total
   * crosses the cap, rather than draining the whole thing first. Fails
   * -- by hanging past the test timeout -- against the pre-fix
   * `await req.text()`, which has no way to bail out of an unbounded
   * stream early.
   */
  it('a chunked (no Content-Length) body over the byte cap -> 400 invalid_request, without buffering the whole stream', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    const postRoutes: RouteEntry[] = [
      { ...testRoutes[0]!, method: 'POST', bodySchema: z.object({}).passthrough() },
    ];
    const chunk = new TextEncoder().encode('"' + 'x'.repeat(64 * 1024) + '",');
    let cancelled = false;
    const chunkedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Infinite: a correctly bounded reader must stop (and cancel)
        // after a handful of these, well before this generator would
        // ever run out on its own.
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = new Headers({
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      'x-fx-user-id': userId,
      'x-fx-account-id': accountId,
      'content-type': 'application/json',
    });
    const req = new Request('http://localhost/api/v1/test-echo', {
      method: 'POST',
      headers,
      body: chunkedBody,
      duplex: 'half',
    } as RequestInit);
    expect(req.headers.get('content-length')).toBeNull();

    const res = await handleApiRequest(req, appUserPool, platformOpsPool, postRoutes);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(cancelled).toBe(true);
  }, 10_000);

  /**
   * Companion fix, same finding: a route declaring no `bodySchema` at
   * all now rejects on the FIRST chunk of a body, rather than only
   * after the whole (here, infinite) stream has been read and turned
   * into a string.
   */
  it('a chunked body on a route with no bodySchema -> 400 invalid_request on the first chunk, without draining the stream', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    // No bodySchema, same as testRoutes[0]!, just POST instead of GET.
    const postRoutes: RouteEntry[] = [{ ...testRoutes[0]!, method: 'POST' }];
    const chunk = new TextEncoder().encode('"' + 'x'.repeat(1024) + '",');
    let cancelled = false;
    const chunkedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = new Headers({
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      'x-fx-user-id': userId,
      'x-fx-account-id': accountId,
      'content-type': 'application/json',
    });
    const req = new Request('http://localhost/api/v1/test-echo', {
      method: 'POST',
      headers,
      body: chunkedBody,
      duplex: 'half',
    } as RequestInit);

    const res = await handleApiRequest(req, appUserPool, platformOpsPool, postRoutes);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(cancelled).toBe(true);
  }, 10_000);

  /**
   * Security fix round item (CWE-755, #126 security re-review, API-1c's
   * to fix). `%E0%A4%A` is an incomplete percent-escape (a truncated
   * 3-byte UTF-8 sequence) -- `decodeURIComponent` throws `URIError` on
   * it. Fails on eb10e03 (pre-fix) with 500 `internal_error` instead of
   * 401, because the thrown `URIError` propagated up through
   * `resolvePrincipal` uncaught and `mapError` has no case for it.
   */
  it('a malformed % escape in the session cookie -> 401 unauthenticated, not 500', async () => {
    const req = new Request('http://localhost/api/v1/test-echo', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=%E0%A4%A` },
    });
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, testRoutes);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  /**
   * D#31 API-1c, live-checked against a real `next start`: left to a
   * runtime's automatic HEAD handling, a HEAD request against a real,
   * registered GET route 404s instead of behaving like GET with no
   * body, because the replayed request's method is still "HEAD" and
   * `matchRoute` keys on it. `handleApiHeadRequest` fixes this by
   * dispatching as GET, then stripping the body while keeping the
   * dispatcher's own status and headers -- so it gets the exact same
   * 200, Cache-Control and X-Request-Id the equivalent GET would.
   */
  it('handleApiHeadRequest: HEAD on a registered GET route -> 200, no body, same envelope as GET', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    const req = await requestWithSessionCookie('http://localhost/api/v1/test-echo', token, { userId, accountId });
    const res = await handleApiHeadRequest(req, appUserPool, platformOpsPool, testRoutes);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    const text = await res.text();
    expect(text).toBe('');
  });

  it('handleApiHeadRequest: HEAD on an unregistered path -> 404, same as GET would give', async () => {
    const req = new Request('http://localhost/api/v1/does-not-exist', { method: 'HEAD' });
    const res = await handleApiHeadRequest(req, appUserPool, platformOpsPool, testRoutes);
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    expect(await res.text()).toBe('');
  });

  /**
   * D#31 API-1c, live-checked against a real `next start`: under Next's
   * default automatic OPTIONS handling, the response never reaches
   * `handleApiRequest` at all -- a bare 204 (or 405) built only from the
   * exported method names, carrying neither Cache-Control nor
   * X-Request-Id. `apps/web/app/api/v1/[...path]/route.ts` now exports
   * OPTIONS as a straight `dispatch` (== `handleApiRequest`) instead, so
   * it gets the same envelope every other /api/v1 response gets. No
   * registry entry declares `OPTIONS`, so this 404s `not_found` through
   * the same error-mapping path every other unmatched method already
   * uses.
   */
  it('OPTIONS through handleApiRequest directly -> 404 not_found, WITH Cache-Control and X-Request-Id', async () => {
    const req = new Request('http://localhost/api/v1/test-echo', { method: 'OPTIONS' });
    const res = await handleApiRequest(req, appUserPool, platformOpsPool, testRoutes);
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  /**
   * D#31 API-1c: "the handler.ts idempotency wrap" is 1c's own ownership
   * item, distinct from `idempotency.ts` itself (whose `withIdempotency`
   * is unit-tested directly in idempotency.test.ts). This exercises the
   * wrap end to end THROUGH `handleApiRequest` -- header extraction,
   * `principalIdOf`, and the `Idempotent-Replayed` response header --
   * against a test-only POST entry, the same way criterion 7 describes.
   */
  it('handler.ts idempotency wrap: same Idempotency-Key + body + principal, through the real dispatcher -> replay with Idempotent-Replayed: true', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    let calls = 0;
    const postRoutes: RouteEntry[] = [
      {
        ...testRoutes[0]!,
        method: 'POST',
        idempotency: 'optional',
        bodySchema: z.object({}).passthrough(),
        async handler() {
          calls++;
          return { accountId, userId, n: calls };
        },
      },
    ];
    const makeReq = () =>
      requestWithSessionCookie('http://localhost/api/v1/test-echo', token, { userId, accountId }, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'k-handler-wrap' },
        body: JSON.stringify({ a: 1 }),
      });

    const first = await handleApiRequest(await makeReq(), appUserPool, platformOpsPool, postRoutes);
    expect(first.status).toBe(200);
    expect(first.headers.get('Idempotent-Replayed')).toBeNull();
    const firstBody = await first.json();

    const second = await handleApiRequest(await makeReq(), appUserPool, platformOpsPool, postRoutes);
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await second.json()).toEqual(firstBody);
    // The handler only actually ran once -- the second response is a
    // stored replay, not a second invocation.
    expect(calls).toBe(1);
  });

  it('handler.ts idempotency wrap: same key, a different body, through the real dispatcher -> 422 idempotency_key_reused', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    const postRoutes: RouteEntry[] = [
      { ...testRoutes[0]!, method: 'POST', idempotency: 'optional', bodySchema: z.object({}).passthrough() },
    ];
    const req1 = await requestWithSessionCookie('http://localhost/api/v1/test-echo', token, { userId, accountId }, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-handler-diff-body' },
      body: JSON.stringify({ a: 1 }),
    });
    const req2 = await requestWithSessionCookie('http://localhost/api/v1/test-echo', token, { userId, accountId }, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-handler-diff-body' },
      body: JSON.stringify({ a: 2 }),
    });

    const first = await handleApiRequest(req1, appUserPool, platformOpsPool, postRoutes);
    expect(first.status).toBe(200);

    const second = await handleApiRequest(req2, appUserPool, platformOpsPool, postRoutes);
    expect(second.status).toBe(422);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_key_reused');
  });

  /**
   * Fix round item 1 (CWE-706 / OWASP A04, security review of this PR).
   * `handler.ts:225` used to pass `entry.path` (the route TEMPLATE) into
   * `withIdempotency`, not the concrete requested path -- and
   * `idempotency.ts`'s completed-branch check never compared `path` (or
   * `method`) at all. Fails on 98c1182: the second call replays `/pa`'s
   * response with `Idempotent-Replayed: true` and status 200, and `/pb`'s
   * handler is never invoked (`pbCalls` stays 0).
   */
  it('handler.ts idempotency wrap: same key + body on TWO DIFFERENT routes, through the real dispatcher -> 422 on the second, and its own handler never runs', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    let paCalls = 0;
    let pbCalls = 0;
    const routes: RouteEntry[] = [
      {
        ...testRoutes[0]!,
        path: '/api/v1/pa',
        operationId: 'pa',
        method: 'POST',
        idempotency: 'optional',
        bodySchema: z.object({}).passthrough(),
        async handler() {
          paCalls++;
          return { accountId, userId };
        },
      },
      {
        ...testRoutes[0]!,
        path: '/api/v1/pb',
        operationId: 'pb',
        method: 'POST',
        idempotency: 'optional',
        bodySchema: z.object({}).passthrough(),
        async handler() {
          pbCalls++;
          return { accountId, userId };
        },
      },
    ];
    const key = 'k-handler-diff-route';
    const reqA = await requestWithSessionCookie('http://localhost/api/v1/pa', token, { userId, accountId }, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({}),
    });
    const reqB = await requestWithSessionCookie('http://localhost/api/v1/pb', token, { userId, accountId }, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({}),
    });

    const first = await handleApiRequest(reqA, appUserPool, platformOpsPool, routes);
    expect(first.status).toBe(200);

    const second = await handleApiRequest(reqB, appUserPool, platformOpsPool, routes);
    expect(second.status).toBe(422);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_key_reused');
    expect(paCalls).toBe(1);
    expect(pbCalls).toBe(0);
  });

  /**
   * Fix round item 1: the same route TEMPLATE with two different
   * concrete `{id}` values must not be treated as the same request --
   * `entry.path` (the template) is identical for both calls, which is
   * exactly why the concrete `url.pathname` has to be what's compared.
   * Fails on 98c1182 the same way the different-route case above does.
   */
  it('handler.ts idempotency wrap: same key + body on the same route TEMPLATE with two different {id}s -> 422 on the second, and its own handler never runs', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    const calls: string[] = [];
    const routes: RouteEntry[] = [
      {
        method: 'POST',
        path: '/api/v1/things/{id}/go',
        operationId: 'thingsGo',
        principals: ['session'],
        minRole: 'member',
        idempotency: 'optional',
        paramsSchema: z.object({ id: z.string() }),
        bodySchema: z.object({}).passthrough(),
        responseSchema: z.object({ id: z.string() }),
        async handler(_ctx, input) {
          // `entry` is widened to the default `RouteEntry` generics here
          // (like `parsedParams` in handler.ts itself), so `params.id` is
          // `string`, not statically guaranteed present -- the real request
          // always carries it since `paramsSchema` requires it.
          calls.push(input.params.id!);
          return { id: input.params.id! };
        },
      },
    ];
    const key = 'k-handler-diff-id';
    const reqAaa = await requestWithSessionCookie(
      'http://localhost/api/v1/things/aaa/go',
      token,
      { userId, accountId },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({}),
      },
    );
    const reqBbb = await requestWithSessionCookie(
      'http://localhost/api/v1/things/bbb/go',
      token,
      { userId, accountId },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({}),
      },
    );

    const first = await handleApiRequest(reqAaa, appUserPool, platformOpsPool, routes);
    expect(first.status).toBe(200);

    const second = await handleApiRequest(reqBbb, appUserPool, platformOpsPool, routes);
    expect(second.status).toBe(422);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_key_reused');
    expect(calls).toEqual(['aaa']);
  });

  /**
   * Fix round 2, item 1 (CWE-706 / OWASP A04, security re-review of this
   * PR). Round 1 bound the idempotency key to `url.pathname`, but a route
   * can also declare a `querySchema` (`handler.ts:199-201` parses it),
   * and the query wasn't part of the binding -- the same key + body sent
   * to the same path with a DIFFERENT query replayed the first response
   * instead of being treated as a different request. Fails on 8b1031c:
   * the second call gets a 200 replay of the first call's body with
   * `Idempotent-Replayed: true`, and its own handler is never invoked
   * (`calls` stays 1 instead of reaching 2).
   */
  it('handler.ts idempotency wrap: same key + body on the same path with a different query -> 422 on the second, and its own handler never runs', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    let calls = 0;
    const routes: RouteEntry[] = [
      {
        method: 'POST',
        path: '/api/v1/runs/{id}/cancel',
        operationId: 'runsCancel',
        principals: ['session'],
        minRole: 'member',
        idempotency: 'optional',
        paramsSchema: z.object({ id: z.string() }),
        querySchema: z.object({ force: z.string().optional() }).passthrough(),
        bodySchema: z.object({}).passthrough(),
        responseSchema: z.object({ id: z.string() }),
        async handler(_ctx, input) {
          calls++;
          return { id: input.params.id! };
        },
      },
    ];
    const key = 'k-handler-diff-query';
    const reqNoQuery = await requestWithSessionCookie(
      'http://localhost/api/v1/runs/r1/cancel',
      token,
      { userId, accountId },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({}),
      },
    );
    const reqForceQuery = await requestWithSessionCookie(
      'http://localhost/api/v1/runs/r1/cancel?force=true',
      token,
      { userId, accountId },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({}),
      },
    );

    const first = await handleApiRequest(reqNoQuery, appUserPool, platformOpsPool, routes);
    expect(first.status).toBe(200);

    const second = await handleApiRequest(reqForceQuery, appUserPool, platformOpsPool, routes);
    expect(second.status).toBe(422);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_key_reused');
    expect(calls).toBe(1);
  });

  /**
   * Companion to the query-binding test above: a repeated request with
   * the SAME query string must still replay, so binding the query
   * doesn't regress the ordinary same-request-twice case for a route
   * that happens to declare a `querySchema`.
   */
  it('handler.ts idempotency wrap: same key + body + query, repeated exactly -> replay with Idempotent-Replayed: true', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const token = await signSession({ userId, accountId });
    let calls = 0;
    const routes: RouteEntry[] = [
      {
        method: 'POST',
        path: '/api/v1/runs/{id}/cancel',
        operationId: 'runsCancel',
        principals: ['session'],
        minRole: 'member',
        idempotency: 'optional',
        paramsSchema: z.object({ id: z.string() }),
        querySchema: z.object({ force: z.string().optional() }).passthrough(),
        bodySchema: z.object({}).passthrough(),
        responseSchema: z.object({ id: z.string() }),
        async handler(_ctx, input) {
          calls++;
          return { id: input.params.id! };
        },
      },
    ];
    const key = 'k-handler-same-query';
    const makeReq = () =>
      requestWithSessionCookie(
        'http://localhost/api/v1/runs/r1/cancel?force=true',
        token,
        { userId, accountId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({}),
        },
      );

    const first = await handleApiRequest(await makeReq(), appUserPool, platformOpsPool, routes);
    expect(first.status).toBe(200);
    expect(first.headers.get('Idempotent-Replayed')).toBeNull();
    const firstBody = await first.json();

    const second = await handleApiRequest(await makeReq(), appUserPool, platformOpsPool, routes);
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await second.json()).toEqual(firstBody);
    expect(calls).toBe(1);
  });
});

describe('mapError: criterion 4 error mapping', () => {
  it('NotFoundError -> 404 not_found', () => {
    const { status, body } = mapError(new NotFoundError('x not found'), 'rid-1');
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.request_id).toBe('rid-1');
  });

  it('ForbiddenError -> 403 insufficient_role', () => {
    const { status, body } = mapError(new ForbiddenError('nope'), 'rid-1');
    expect(status).toBe(403);
    expect(body.error.code).toBe('insufficient_role');
  });

  it('a ZodError -> 422 validation_failed, with a {path, code} entry per issue', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = schema.safeParse({ name: 5, age: 'x' });
    expect(result.success).toBe(false);
    const { status, body } = mapError(result.error, 'rid-1');
    expect(status).toBe(422);
    expect(body.error.code).toBe('validation_failed');
    expect(body.details).toHaveLength(2);
    expect(body.details?.map((d) => d.path).sort()).toEqual(['age', 'name']);
  });

  it('each of the six H05 DenyReason values -> 409 with that exact code', () => {
    expect(DENY_REASONS).toHaveLength(6);
    for (const reason of DENY_REASONS) {
      const { status, body } = mapError(new DenyError(reason), 'rid-1');
      expect(status).toBe(409);
      expect(body.error.code).toBe(reason);
    }
  });

  it('an unrecognized Error -> 500 internal_error, leaking neither its message nor a stack', () => {
    const { status, body } = mapError(new Error('secret-ish text'), 'rid-1');
    expect(status).toBe(500);
    expect(body.error.code).toBe('internal_error');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret-ish text');
    expect(serialized).not.toContain('at ');
  });
});
