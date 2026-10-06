import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { apiLimitsFor } from '@fx/spend';
import { loadPlanData, resetPlanDataCache } from '@fx/plan-data';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { effectivePrincipals, type Scope } from '../src/registry.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import {
  RATE_CLASSES,
  bucketKeyForAnonIp,
  bucketKeyForFailedAuthIp,
  FAILED_AUTH_LIMIT_PER_IP_PER_MINUTE,
} from '../src/ratelimit/limits.js';
import type { RateLimitDecision, RateLimitStore } from '../src/ratelimit/store.js';
import { sessionLimitFor } from '../src/ratelimit/session.js';
import { seedAccountWithMember } from './helpers/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = path.join(__dirname, '..', 'openapi.json');

/**
 * D#31 API-3d (Correction C13c): rate limits (token, tenant, per-IP
 * failed-auth) live through the real `handleApiRequest` dispatcher
 * against real Postgres (`packages/db/migrations/0622_rate_limits.sql`'s
 * `rate_limit_check`). Criterion 5 (the per-IP failed-auth limit) has
 * its own test in `tokens.test.ts`, alongside `criterion 7: rejected
 * credentials`, where the old criterion-7-bullet-3 placeholder already
 * lived. Criterion 9 (the ga-blockers pin) is also in `tokens.test.ts`,
 * next to the rest of the C13b tripwire tests.
 */
describe('D#31 API-3d: token, tenant and failed-auth rate limits', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });

  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function sessionRequest(
    url: string,
    identity: { userId: string; accountId: string },
  ): Promise<Request> {
    const token = await signSession(identity);
    const headers = new Headers();
    headers.set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
    return new Request(url, { headers });
  }

  /** A fresh, per-call source IP -- this file only exercises the
   * token/tenant buckets, never the failed-auth-by-IP one, so every
   * request here uses a distinct address to keep the two concerns
   * completely decoupled. */
  function bearerRequest(url: string, plaintext: string): Request {
    const headers = new Headers();
    headers.set('authorization', `Bearer ${plaintext}`);
    headers.set('x-forwarded-for', randomUUID());
    return new Request(url, { headers });
  }

  async function dispatch(req: Request): Promise<Response> {
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }

  async function mintToken(
    identity: { accountId: string; userId: string },
    opts: { scopes?: Scope[] } = {},
  ): Promise<{ id: string; plaintext: string }> {
    const plaintext = generateToken();
    const inserted = await insertApiToken(appUserPool, {
      accountId: identity.accountId,
      createdBy: identity.userId,
      tokenHash: hashToken(plaintext),
      displayHint: displayHint(plaintext),
      scopes: opts.scopes ?? ['read'],
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    return { id: inserted.id, plaintext };
  }

  // The caps come from the plan data under test (the public scaled fixture).
  const TOKEN_CAP = apiLimitsFor('starter').perTokenPerMinute;

  describe('criteria 1, 3: per-token cap, session unaffected', () => {
    it('the request past the per-token cap in a minute -> 429 rate_limited with an integer Retry-After; a concurrent session still gets 200', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { plaintext } = await mintToken({ accountId, userId });

      let lastStatus = 0;
      for (let i = 0; i < TOKEN_CAP; i++) {
        const res = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
        lastStatus = res.status;
      }
      expect(lastStatus).toBe(200); // the last request is still within the Starter cap.

      const resOver = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
      expect(resOver.status).toBe(429);
      const body = (await resOver.json()) as { error: { code: string } };
      expect(body.error.code).toBe('rate_limited');
      const retryAfter = resOver.headers.get('Retry-After');
      expect(retryAfter).not.toBeNull();
      expect(Number.isInteger(Number(retryAfter))).toBe(true);
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);

      // Criterion 3: a session on the SAME account, at the same time, is
      // never charged to the token (or tenant) bucket.
      const sessionRes = await dispatch(await sessionRequest('http://localhost/api/v1/account', { accountId, userId }));
      expect(sessionRes.status).toBe(200);
    });
  });

  describe('criterion 2: the tenant bucket counts across tokens', () => {
    it('a full per-token cap via token A and via token B (both within their own cap) then one more combined request via a fresh token C -> 429', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const a = await mintToken({ accountId, userId });
      const b = await mintToken({ accountId, userId });
      const c = await mintToken({ accountId, userId });
      // The scenario needs two full token caps to fill the tenant cap exactly.
      expect(apiLimitsFor('starter').perTenantPerMinute).toBe(2 * TOKEN_CAP);

      for (let i = 0; i < TOKEN_CAP; i++) {
        const res = await dispatch(bearerRequest('http://localhost/api/v1/account', a.plaintext));
        expect(res.status).toBe(200);
      }
      for (let i = 0; i < TOKEN_CAP; i++) {
        const res = await dispatch(bearerRequest('http://localhost/api/v1/account', b.plaintext));
        expect(res.status).toBe(200);
      }
      // Token C has made ZERO requests of its own -- its own per-token
      // bucket is nowhere near its own cap. Only the shared TENANT
      // bucket (now full) can explain a 429 here.
      const resOver = await dispatch(bearerRequest('http://localhost/api/v1/account', c.plaintext));
      expect(resOver.status).toBe(429);
      const body = (await resOver.json()) as { error: { code: string } };
      expect(body.error.code).toBe('rate_limited');
    });
  });

  describe('criterion 4: the limit is plan data, not a constant in limits.ts', () => {
    afterEach(() => {
      // Restore Starter's figure so later tests in this file (and
      // any run after it in the same process) see the documented cap.
      loadPlanData().plans.starter.apiLimits.perTokenPerMinute = TOKEN_CAP;
    });

    it('lowering the Starter perTokenPerMinute in the plan data changes the enforced limit', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { plaintext } = await mintToken({ accountId, userId });

      loadPlanData().plans.starter.apiLimits.perTokenPerMinute = 3;

      for (let i = 0; i < 3; i++) {
        const res = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
        expect(res.status).toBe(200);
      }
      const res4 = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
      expect(res4.status).toBe(429);
    });
  });

  describe('plan data unavailable', () => {
    it('a token request is refused 503 plan_data_unavailable (never unlimited, never a default cap), with no figure in the body', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { plaintext } = await mintToken({ accountId, userId });
      const saved = process.env.FX_PLAN_DATA;
      try {
        delete process.env.FX_PLAN_DATA;
        resetPlanDataCache();
        const res = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
        expect(res.status).toBe(503);
        const text = await res.text();
        expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe('plan_data_unavailable');
        expect(text).not.toMatch(/undefined|null|NaN/);
      } finally {
        if (saved !== undefined) process.env.FX_PLAN_DATA = saved;
        resetPlanDataCache();
      }
    });
  });

  describe('criterion 6: fail-closed', () => {
    class ThrowingStore implements RateLimitStore {
      async checkAndIncrement(): Promise<RateLimitDecision> {
        throw new Error('injected rate-limit-store failure');
      }
    }

    it('a rate-limit-store failure refuses a token request with a 5xx, never unlimited; a session request is unaffected', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { plaintext } = await mintToken({ accountId, userId });
      const store = new ThrowingStore();

      const tokenRes = await handleApiRequest(
        bearerRequest('http://localhost/api/v1/account', plaintext),
        appUserPool,
        platformOpsPool,
        ROUTES,
        store,
      );
      expect(tokenRes.status).toBeGreaterThanOrEqual(500);
      const body = (await tokenRes.json()) as { error: { code: string } };
      expect(body.error.code).not.toBe('rate_limited'); // it never gets far enough to decide allowed/denied.

      const sessionRes = await handleApiRequest(
        await sessionRequest('http://localhost/api/v1/account', { accountId, userId }),
        appUserPool,
        platformOpsPool,
        ROUTES,
        store,
      );
      expect(sessionRes.status).toBe(200); // sessions never call the store at all.
    });
  });

  describe('criterion 7: registry coverage', () => {
    it('every entry whose principals include token declares a rateClass that limits.ts knows', () => {
      const tokenEntries = ROUTES.filter((r) => effectivePrincipals(r).includes('token'));
      expect(tokenEntries.length).toBeGreaterThan(0); // not vacuous.
      for (const entry of tokenEntries) {
        expect(RATE_CLASSES, `${entry.method} ${entry.path} (${entry.operationId})`).toContain(entry.rateClass);
      }
    });
  });

  describe('criterion 8: openapi.json documents 429 on every token-accepting operation', () => {
    it('the committed document declares a 429 (shared Error schema) for every token-accepting operation, and none for session-only reads without a cap', () => {
      const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
        paths: Record<string, Record<string, { operationId: string; security: Record<string, unknown>[]; responses: Record<string, { content?: Record<string, { schema?: unknown }>; headers?: Record<string, unknown> }> }>>;
      };
      let checked = 0;
      for (const methods of Object.values(doc.paths)) {
        for (const operation of Object.values(methods)) {
          const acceptsToken = operation.security.some((s) => 'token' in s);
          if (acceptsToken) {
            checked++;
            expect(operation.responses['429'], operation.operationId).toBeDefined();
            expect(operation.responses['429']!.content?.['application/json']?.schema).toEqual({
              $ref: '#/components/schemas/Error',
            });
          } else if (sessionLimitFor(ROUTES.find((r) => r.operationId === operation.operationId)!) !== undefined) {
            // A session-only route with a session cap (every write, and any read that declares one) documents the 429 and its Retry-After.
            expect(operation.responses['429'], operation.operationId).toBeDefined();
            expect(operation.responses['429']!.headers?.['Retry-After'], operation.operationId).toBeDefined();
          } else if (!ROUTES.find((r) => r.operationId === operation.operationId)?.extraResponses?.['429']) {
            // A session-only read with no cap and no 429 of its own documents none.
            expect(operation.responses['429'], operation.operationId).toBeUndefined();
          }
        }
      }
      expect(checked).toBeGreaterThan(0); // not vacuous.
    });
  });

  /**
   * Fix round 1 (PR #159 review): M1 and M2 attack `rate_limit_check`
   * directly, as raw app_user SQL, deliberately bypassing
   * `PgRateLimitStore`/`limits.ts` entirely -- both findings are about
   * what the SECURITY DEFINER function itself does or doesn't enforce,
   * independent of whether the current application code happens to call
   * it safely. Each test manages its own transaction directly (`BEGIN` /
   * `set_config` / `ROLLBACK` on a checked-out client, or `withTenant`
   * with no enclosing `.catch`) rather than swallowing a
   * `withTenant(...)` rejection -- the #155 review's M5 finding: an
   * outer `.catch` around the whole `withTenant` call would mask BOTH
   * the expected rejection AND a wrongly-succeeding call's assertion
   * failure identically, so the test could never fail no matter what
   * the definer allowed.
   */
  describe('M1 (fix round 1, must-fix): rate_limit_check validates its own input', () => {
    it('a negative limit raises and leaves any existing row for that key unchanged', async () => {
      const key = `failed-auth:${randomUUID()}`;
      // Establish a real row first (limit large enough to always allow).
      await appUserPool.query('SELECT * FROM rate_limit_check($1, $2)', [key, 1000]);
      const before = await admin.query('SELECT window_start, request_count FROM rate_limit_windows WHERE bucket_key = $1', [key]);
      expect(before.rows).toHaveLength(1);

      await expect(appUserPool.query('SELECT * FROM rate_limit_check($1, $2)', [key, -1])).rejects.toThrow();

      const after = await admin.query('SELECT window_start, request_count FROM rate_limit_windows WHERE bucket_key = $1', [key]);
      expect(after.rows).toEqual(before.rows);
    });

    it('an over-length bucket key raises and writes no row', async () => {
      const key = `failed-auth:${'9'.repeat(250)}`;
      await expect(appUserPool.query('SELECT * FROM rate_limit_check($1, $2)', [key, 1])).rejects.toThrow();
      const row = await admin.query('SELECT 1 FROM rate_limit_windows WHERE bucket_key = $1', [key]);
      expect(row.rows).toHaveLength(0);
    });

    it('STRICT: a NULL bucket key or a NULL limit returns no row rather than executing the body -- PgRateLimitStore then throws "no row" (fail-closed), never "allowed"', async () => {
      const nullKey = await appUserPool.query('SELECT * FROM rate_limit_check($1, $2)', [null, 1]);
      expect(nullKey.rows).toHaveLength(0);

      const key = `failed-auth:${randomUUID()}`;
      const nullLimit = await appUserPool.query('SELECT * FROM rate_limit_check($1, $2)', [key, null]);
      expect(nullLimit.rows).toHaveLength(0);
      const row = await admin.query('SELECT 1 FROM rate_limit_windows WHERE bucket_key = $1', [key]);
      expect(row.rows).toHaveLength(0); // STRICT short-circuited before ever touching the table.
    });

    it('a bucket key that matches none of the four known shapes raises', async () => {
      await expect(
        appUserPool.query('SELECT * FROM rate_limit_check($1, $2)', [`unknown-shape:${randomUUID()}`, 1]),
      ).rejects.toThrow();
    });
  });

  describe('M2 (fix round 1, must-fix): rate_limit_check binds every non-failed-auth key to the caller\'s own tenant', () => {
    it('reproduces the reviewer\'s live attack: under tenant A, 130 calls against tenant B\'s bucket key all raise, and B\'s real bucket is untouched; B\'s fresh token still works', async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const bToken = await mintToken(b);
      const key = `tenant:${b.accountId}`;

      // Establish B's own real bucket the legitimate way first, so
      // "untouched" has a concrete row to compare against.
      const before = await dispatch(bearerRequest('http://localhost/api/v1/account', bToken.plaintext));
      expect(before.status).toBe(200);
      const beforeRow = await admin.query(
        'SELECT window_start, request_count FROM rate_limit_windows WHERE bucket_key = $1',
        [key],
      );
      expect(beforeRow.rows).toHaveLength(1);

      for (let i = 0; i < 130; i++) {
        await withTenant(appUserPool, a.accountId, async (client) => {
          await expect(client.query('SELECT * FROM rate_limit_check($1, $2)', [key, 1])).rejects.toThrow();
        });
      }

      const afterRow = await admin.query(
        'SELECT window_start, request_count FROM rate_limit_windows WHERE bucket_key = $1',
        [key],
      );
      expect(afterRow.rows).toEqual(beforeRow.rows);

      // B's own fresh token still works -- the attack did not drain B's cap.
      const freshB = await mintToken(b);
      const freshRes = await dispatch(bearerRequest('http://localhost/api/v1/account', freshB.plaintext));
      expect(freshRes.status).toBe(200);
    });

    it('under tenant A, a token: bucket key naming B\'s token also raises, and B\'s token bucket stays absent', async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const bToken = await mintToken(b);
      const key = `token:${bToken.id}`;

      await withTenant(appUserPool, a.accountId, async (client) => {
        await expect(client.query('SELECT * FROM rate_limit_check($1, $2)', [key, 1])).rejects.toThrow();
      });

      const row = await admin.query('SELECT 1 FROM rate_limit_windows WHERE bucket_key = $1', [key]);
      expect(row.rows).toHaveLength(0);
    });

    it('a tenant: key naming the caller\'s OWN tenant is accepted (no false positive from the M2 fix)', async () => {
      const a = await seedAccountWithMember(admin);
      const key = `tenant:${a.accountId}`;
      const result = await withTenant(appUserPool, a.accountId, async (client) => {
        return client.query('SELECT allowed FROM rate_limit_check($1, $2)', [key, 1000]);
      });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].allowed).toBe(true);
    });

    it('a failed-auth bucket key is rejected when a tenant context IS set (accepted only pre-tenant-context)', async () => {
      const a = await seedAccountWithMember(admin);
      const key = `failed-auth:${randomUUID()}`;
      await withTenant(appUserPool, a.accountId, async (client) => {
        await expect(client.query('SELECT * FROM rate_limit_check($1, $2)', [key, 1])).rejects.toThrow();
      });
      // Confirm the SAME key is fine with no tenant context (sanity: the
      // rejection above was the tenant guard, not something else wrong
      // with the key).
      const outsideTenant = await appUserPool.query('SELECT allowed FROM rate_limit_check($1, $2)', [key, 1]);
      expect(outsideTenant.rows).toHaveLength(1);
    });
  });

  describe('S1 (fix round 1, should-fix): a scope- or role-rejected 403 still counts against the token/tenant buckets', () => {
    it('scope-rejected 403s up to the per-token cap exhaust it; the next is 429 rate_limited, not 403', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      // GET /api/v1/account requires scope "read" -- this token only has "runs:cancel".
      const { plaintext } = await mintToken({ accountId, userId }, { scopes: ['runs:cancel'] });

      for (let i = 0; i < TOKEN_CAP; i++) {
        const res = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
        expect(res.status, `attempt ${i + 1}`).toBe(403);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('insufficient_scope');
      }

      const resOver = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
      expect(resOver.status).toBe(429);
      const body = (await resOver.json()) as { error: { code: string } };
      expect(body.error.code).toBe('rate_limited');
    });
  });

  // D#37 WS-D fix round 1, MUST 1 (PR #172 review): POST /api/rum
  // (apps/web) had no rate limit or abuse bound at all. Fixed by reusing
  // this same `rate_limit_check` function via a new `anon:` bucket-key
  // shape (0626_rate_limit_anon_ip.sql) rather than a second limiter --
  // apps/web has no route registry of its own the way packages/api does,
  // so these tests drive `rate_limit_check` and `bucketKeyForAnonIp`
  // directly instead of through `dispatch`/`handleApiRequest`.
  describe('D#37 WS-D fix round 1 (MUST 1): the anon: bucket for POST /api/rum and other unauthenticated, non-auth-failure per-IP routes', () => {
    // Mirrors apps/web/app/api/rum/route.ts's own per-IP cap. Kept as a
    // literal here (this package has no dependency on apps/web) -- also a
    // convenient round number to drive `rate_limit_check` with directly,
    // the same way this file's other describes use small, self-contained
    // limits rather than reaching into a real plan's numbers.
    const RUM_LIMIT = 60;

    async function checkAnon(routeName: string, ip: string, limit = RUM_LIMIT): Promise<RateLimitDecision> {
      const { rows } = await appUserPool.query<{ allowed: boolean; retry_after_seconds: number }>(
        'SELECT allowed, retry_after_seconds FROM rate_limit_check($1, $2)',
        [bucketKeyForAnonIp(routeName, ip), limit],
      );
      return { allowed: rows[0]!.allowed, retryAfterSeconds: rows[0]!.retry_after_seconds };
    }

    it("the beacon's real traffic (one POST per page load) is far below the bound: 5 requests from one IP all stay allowed", async () => {
      const ip = randomUUID();
      for (let i = 0; i < 5; i++) {
        const decision = await checkAnon('rum', ip);
        expect(decision.allowed, `request ${i + 1}`).toBe(true);
      }
    });

    it('the 61st request from one IP in a minute -> not allowed, with an integer Retry-After; a different IP is unaffected', async () => {
      const ip = randomUUID();
      for (let i = 0; i < RUM_LIMIT; i++) {
        const decision = await checkAnon('rum', ip);
        expect(decision.allowed, `request ${i + 1}`).toBe(true);
      }

      const over = await checkAnon('rum', ip);
      expect(over.allowed).toBe(false);
      expect(Number.isInteger(over.retryAfterSeconds)).toBe(true);
      expect(over.retryAfterSeconds).toBeGreaterThanOrEqual(1);

      const otherIp = randomUUID();
      const otherDecision = await checkAnon('rum', otherIp);
      expect(otherDecision.allowed).toBe(true);
    });

    it('the runner-register bucket (D#6 R2b: 10 a minute per address, apps/web/lib/runnerRoutes.ts) is accepted by rate_limit_check and cuts off at the 11th, separately from rum', async () => {
      const REGISTER_LIMIT = 10; // the literal apps/web/lib/runnerRoutes.ts exports as REGISTER_LIMIT_PER_IP_PER_MINUTE
      const ip = randomUUID();
      for (let i = 0; i < REGISTER_LIMIT; i++) expect((await checkAnon('runner-register', ip, REGISTER_LIMIT)).allowed, `request ${i + 1}`).toBe(true);
      const over = await checkAnon('runner-register', ip, REGISTER_LIMIT);
      expect(over.allowed).toBe(false);
      expect(over.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect((await checkAnon('rum', ip)).allowed).toBe(true);
    });

    it("is keyed on an IPv6 address's /64, not its full address -- rotating within one /64 does not reset the cap", async () => {
      // Same /64 (first four hextets 2001:db8:cafe:aaaa), different host bits.
      const sameBlockA = '2001:db8:cafe:aaaa::1';
      const sameBlockB = '2001:db8:cafe:aaaa:ffff:ffff:ffff:ffff';
      // A different /64 entirely.
      const otherBlock = '2001:db8:cafe:bbbb::1';

      for (let i = 0; i < RUM_LIMIT - 1; i++) {
        const ip = i % 2 === 0 ? sameBlockA : sameBlockB;
        const decision = await checkAnon('rum', ip);
        expect(decision.allowed, `request ${i + 1}`).toBe(true);
      }
      // RUM_LIMIT-th combined request, still within the cap.
      const atLimit = await checkAnon('rum', sameBlockB);
      expect(atLimit.allowed).toBe(true);
      // One more (a third distinct host address in the same /64) -> over the cap.
      const over = await checkAnon('rum', '2001:db8:cafe:aaaa:1:2:3:4');
      expect(over.allowed).toBe(false);

      // A DIFFERENT /64 is unaffected.
      const otherDecision = await checkAnon('rum', otherBlock);
      expect(otherDecision.allowed).toBe(true);
    });

    it("is a namespace separate from failed-auth: -- flooding the anon:rum bucket for an IP does not touch that same IP's failed-auth budget", async () => {
      const ip = randomUUID();
      for (let i = 0; i < RUM_LIMIT; i++) {
        await checkAnon('rum', ip);
      }
      const rumOver = await checkAnon('rum', ip);
      expect(rumOver.allowed).toBe(false);

      // The SAME address's failed-auth bucket is untouched -- still well
      // within FAILED_AUTH_LIMIT_PER_IP_PER_MINUTE (20), proving the two
      // caps never share one counter.
      const { rows } = await appUserPool.query<{ allowed: boolean }>(
        'SELECT allowed FROM rate_limit_check($1, $2)',
        [bucketKeyForFailedAuthIp(ip), FAILED_AUTH_LIMIT_PER_IP_PER_MINUTE],
      );
      expect(rows[0]!.allowed).toBe(true);
    });

    it('an anon: bucket key is rejected when a tenant context IS set (accepted only pre-tenant-context, same as failed-auth:)', async () => {
      const { accountId } = await seedAccountWithMember(admin);
      const key = bucketKeyForAnonIp('rum', randomUUID());
      await expect(
        withTenant(appUserPool, accountId, async (client) => {
          await client.query('SELECT * FROM rate_limit_check($1, $2)', [key, RUM_LIMIT]);
        }),
      ).rejects.toThrow();
    });

    it('an anon: key naming a DIFFERENT route namespace does not share a bucket with "rum"', async () => {
      const ip = randomUUID();
      for (let i = 0; i < RUM_LIMIT; i++) {
        await checkAnon('rum', ip);
      }
      const rumOver = await checkAnon('rum', ip);
      expect(rumOver.allowed).toBe(false);

      const otherRouteDecision = await checkAnon('some-other-anon-route', ip);
      expect(otherRouteDecision.allowed).toBe(true);
    });
  });
});
