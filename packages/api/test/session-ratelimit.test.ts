import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import type { KekSource, ValidationHttpClient, ValidationOutcome, ValidationRequest } from '@fx/model-connection';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { setModelConnectionDeps } from '../src/routes/model-connection.js';
import { RateLimitedError } from '../src/errors.js';
import { PgRateLimitStore } from '../src/ratelimit/store.js';
import {
  DEFAULT_SESSION_WRITE_LIMIT,
  SESSION_LIMITS,
  enforceSessionRateLimits,
  pgSessionLimiter,
  sessionLimitFor,
  type SessionLimit,
} from '../src/ratelimit/session.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);

interface Identity {
  accountId: string;
  userId: string;
}

class FakeProvider implements ValidationHttpClient {
  calls: ValidationRequest[] = [];
  async validate(req: ValidationRequest): Promise<ValidationOutcome> {
    this.calls.push(req);
    return { kind: 'ok' };
  }
}

/**
 * Session callers are capped on the routes that call an outside service, start compute or write on each
 * call. Everything here runs through the real `handleApiRequest` dispatcher and the real
 * `session_rate_limit_check` function (migration 0700) against real Postgres; the only fake is the
 * model provider's HTTP client, which the model-connection service makes injectable.
 */
describe('session rate limits', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let provider: FakeProvider;

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
    await platformOpsPool.end();
    await appUserPool.end();
  });

  beforeEach(() => {
    provider = new FakeProvider();
    const kek = randomBytes(32);
    const kekSource: KekSource = { currentVersion: () => 1, keyFor: () => kek };
    setModelConnectionDeps({ platformOpsPool, kek: kekSource, httpClient: provider });
  });

  afterEach(() => {
    setModelConnectionDeps({});
  });

  async function sessionCall(identity: Identity, method: string, urlPath: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(identity)}` });
    let payload: string | undefined;
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      payload = JSON.stringify(body);
    }
    return handleApiRequest(
      new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: payload }),
      appUserPool,
      platformOpsPool,
      ROUTES,
    );
  }

  const owner = () => seedAccountWithMember(admin, { role: 'owner' });
  const testKey = (who: Identity) => sessionCall(who, 'POST', '/model-connection/test');

  /** Pretends `seconds` have passed for every window of this account's bucket `name` that is shorter than an hour. */
  async function ageShortWindows(accountId: string, name: string, seconds: number): Promise<void> {
    await admin.query(
      `UPDATE rate_limit_windows SET window_start = window_start - make_interval(secs => $2)
        WHERE bucket_key LIKE $1 AND bucket_key NOT LIKE '%:w3600'`,
      [`session%${accountId}%:${name}:w%`, seconds],
    );
  }

  async function bucketCount(key: string): Promise<number | null> {
    const { rows } = await admin.query<{ request_count: number }>(
      'SELECT request_count FROM rate_limit_windows WHERE bucket_key = $1',
      [key],
    );
    return rows[0]?.request_count ?? null;
  }

  async function connect(who: Identity): Promise<void> {
    const res = await sessionCall(who, 'PUT', '/model-connection', { provider: 'ai_gateway', key: `sk-fixture-${randomBytes(12).toString('hex')}` });
    expect(res.status).toBe(200);
  }

  describe('the model key test button (one per 10 s, 30 per hour, per account)', () => {
    it('the second click inside ten seconds is a 429 with the error envelope and an integer Retry-After, and never reaches the provider', async () => {
      const who = await owner();
      await connect(who);
      provider.calls.length = 0;

      const first = await testKey(who);
      expect(first.status).toBe(200);
      expect(provider.calls).toHaveLength(1);

      const second = await testKey(who);
      expect(second.status).toBe(429);
      const retryAfter = second.headers.get('retry-after');
      expect(retryAfter).toMatch(/^\d+$/);
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
      expect(Number(retryAfter)).toBeLessThanOrEqual(10);
      const body = (await second.json()) as { error: { code: string; message: string; request_id: string } };
      expect(body.error.code).toBe('rate_limited');
      expect(typeof body.error.request_id).toBe('string');
      expect(provider.calls).toHaveLength(1);
    });

    it('rapid repeats keep getting 429 and the provider is called once in total', async () => {
      const who = await owner();
      await connect(who);
      provider.calls.length = 0;
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push((await testKey(who)).status);
      expect(statuses).toEqual([200, 429, 429, 429, 429, 429, 429, 429]);
      expect(provider.calls).toHaveLength(1);
    });

    it('normal use passes: spaced clicks all succeed, then the 31st inside the hour is refused with a Retry-After of about an hour', async () => {
      const who = await owner();
      await connect(who);
      for (let i = 0; i < 30; i++) {
        const res = await testKey(who);
        expect(res.status, `click ${i + 1}`).toBe(200);
        await ageShortWindows(who.accountId, 'model-key-test', 11);
      }
      const over = await testKey(who);
      expect(over.status).toBe(429);
      expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(3000);
      expect(Number(over.headers.get('retry-after'))).toBeLessThanOrEqual(3600);
    });

    it('a click refused by the ten second window does not use up the hour allowance', async () => {
      const who = await owner();
      await connect(who);
      await testKey(who);
      for (let i = 0; i < 5; i++) expect((await testKey(who)).status).toBe(429);
      expect(await bucketCount(`session:${who.accountId}:model-key-test:w3600`)).toBe(1);
      expect(await bucketCount(`session:${who.accountId}:model-key-test:w10`)).toBe(6);
    });

    it('after the ten seconds pass the button works again', async () => {
      const who = await owner();
      await connect(who);
      expect((await testKey(who)).status).toBe(200);
      expect((await testKey(who)).status).toBe(429);
      await ageShortWindows(who.accountId, 'model-key-test', 11);
      expect((await testKey(who)).status).toBe(200);
    });

    it('saving a key is capped the same way, in its own bucket (a save does not block the test button)', async () => {
      const who = await owner();
      await connect(who);
      const again = await sessionCall(who, 'PUT', '/model-connection', { provider: 'ai_gateway', key: `sk-fixture-${randomBytes(12).toString('hex')}` });
      expect(again.status).toBe(429);
      expect(again.headers.get('retry-after')).toMatch(/^\d+$/);
      expect((await testKey(who)).status).toBe(200);
    });

    it('a member below admin is refused with 403 and that refusal is not counted', async () => {
      const member = await seedAccountWithMember(admin, { role: 'member' });
      const res = await testKey(member);
      expect(res.status).toBe(403);
      expect(await bucketCount(`session:${member.accountId}:model-key-test:w10`)).toBeNull();
    });
  });

  describe('buckets are per account', () => {
    it('one account exhausting its allowance does not touch another account', async () => {
      const a = await owner();
      const b = await owner();
      await connect(a);
      await connect(b);
      expect((await testKey(a)).status).toBe(200);
      expect((await testKey(a)).status).toBe(429);
      expect((await testKey(b)).status).toBe(200);
      expect(await bucketCount(`session:${b.accountId}:model-key-test:w10`)).toBe(1);
    });

    it('two users of one account share the account bucket (the provider is called once, not once each)', async () => {
      const a = await owner();
      await connect(a);
      const second = randomUUID();
      await seedUser(admin, second);
      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')", [a.accountId, second]);
      expect((await testKey(a)).status).toBe(200);
      expect((await testKey({ accountId: a.accountId, userId: second })).status).toBe(429);
    });

    it('the database function refuses a key naming another account, a wrong window, or a bad shape', async () => {
      const a = await owner();
      const b = await owner();
      const check = (as: Identity, key: string, window: number) =>
        withTenant(appUserPool, as.accountId, as.userId, (client) =>
          client.query('SELECT * FROM session_rate_limit_check($1, 5, $2)', [key, window]),
        );
      // Own account: fine.
      await expect(check(a, `session:${a.accountId}:probe:w60`, 60)).resolves.toBeDefined();
      // Another account's key, from tenant A's context.
      await expect(check(a, `session:${b.accountId}:probe:w60`, 60)).rejects.toThrow(/tenant context/);
      await expect(check(a, `session-user:${b.accountId}:${b.userId}:probe:w60`, 60)).rejects.toThrow(/tenant context/);
      // The key must end in the window it is counted under, and the window must be one of the three allowed.
      await expect(check(a, `session:${a.accountId}:probe:w60`, 10)).rejects.toThrow(/key shape or window/);
      await expect(check(a, `session:${a.accountId}:probe:w7`, 7)).rejects.toThrow(/window must be/);
      await expect(check(a, 'tenant:x', 60)).rejects.toThrow(/key shape or window/);
      // No tenant context at all.
      await expect(appUserPool.query('SELECT * FROM session_rate_limit_check($1, 5, 60)', [`session:${a.accountId}:probe:w60`])).rejects.toThrow(/tenant context/);
    });
  });

  describe('per-user buckets', () => {
    const rule: SessionLimit = { name: 'probe-user', account: [{ limit: 100, seconds: 60 }], user: [{ limit: 2, seconds: 60 }] };

    it('a user over their own cap is refused while another user of the same account still passes', async () => {
      const a = await owner();
      const other = randomUUID();
      await seedUser(admin, other);
      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [a.accountId, other]);
      const store = new PgRateLimitStore(appUserPool);
      await enforceSessionRateLimits(store, appUserPool, a, rule);
      await enforceSessionRateLimits(store, appUserPool, a, rule);
      await expect(enforceSessionRateLimits(store, appUserPool, a, rule)).rejects.toBeInstanceOf(RateLimitedError);
      await expect(enforceSessionRateLimits(store, appUserPool, { accountId: a.accountId, userId: other }, rule)).resolves.toBeUndefined();
    });

    it('pgSessionLimiter (the helper the plain web routes use) counts on the real store and refuses past the cap', async () => {
      const a = await owner();
      const limit = pgSessionLimiter(appUserPool, { name: 'probe-helper', account: [{ limit: 2, seconds: 10 }] });
      await limit(a);
      await limit(a);
      const err = await limit(a).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect((err as RateLimitedError).retryAfterSeconds).toBeLessThanOrEqual(10);
    });

    it('a store that fails is a failure, never an unlimited pass', async () => {
      const a = await owner();
      const broken = { checkAndIncrement: async () => { throw new Error('store down'); } };
      await expect(enforceSessionRateLimits(broken, appUserPool, a, rule)).rejects.toThrow('store down');
    });
  });

  describe('every other session write', () => {
    it('a session write with no rule of its own gets the default: 60 per minute per user, then 429 with Retry-After', async () => {
      const who = await owner();
      const statuses = new Set<number>();
      for (let i = 0; i < 60; i++) statuses.add((await sessionCall(who, 'DELETE', '/model-connection')).status);
      expect(statuses.has(429)).toBe(false);
      const over = await sessionCall(who, 'DELETE', '/model-connection');
      expect(over.status).toBe(429);
      expect(over.headers.get('retry-after')).toMatch(/^\d+$/);
      expect(((await over.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    });

    it('the GitHub install link is capped at 10 a minute per account even though it is a read', async () => {
      const who = await owner();
      for (let i = 0; i < 10; i++) expect((await sessionCall(who, 'GET', '/github/install-url?app_kind=team')).status, `call ${i + 1}`).not.toBe(429);
      const over = await sessionCall(who, 'GET', '/github/install-url?app_kind=team');
      expect(over.status).toBe(429);
      expect(over.headers.get('retry-after')).toMatch(/^\d+$/);
    });

    it('creating a repo link is capped at 10 a minute per account', async () => {
      const who = await owner();
      const body = { owner_gh_id: 1, name: 'x', visibility: 'private' };
      for (let i = 0; i < 10; i++) expect((await sessionCall(who, 'POST', '/repos/create-intent', body)).status, `call ${i + 1}`).not.toBe(429);
      expect((await sessionCall(who, 'POST', '/repos/create-intent', body)).status).toBe(429);
    });

    it('the Stripe routes share one budget of 10 a minute per account, and another account is not affected', async () => {
      const who = await owner();
      const other = await owner();
      for (let i = 0; i < 5; i++) {
        expect((await sessionCall(who, 'POST', '/billing/portal-session', {})).status).not.toBe(429);
        expect((await sessionCall(who, 'POST', '/billing/checkout-session', { plan: 'team', success_path: '/a', cancel_path: '/b' })).status).not.toBe(429);
      }
      expect((await sessionCall(who, 'POST', '/billing/portal-session', {})).status).toBe(429);
      expect((await sessionCall(other, 'POST', '/billing/portal-session', {})).status).not.toBe(429);
    });

    it('session reads are not capped by the write default', async () => {
      const who = await owner();
      for (let i = 0; i < 70; i++) expect((await sessionCall(who, 'GET', '/account')).status).toBe(200);
    });

    it('the rule a route gets: its own, else the write default, else none for a read', () => {
      expect(sessionLimitFor({ method: 'GET' })).toBeUndefined();
      expect(sessionLimitFor({ method: 'GET', sessionLimit: SESSION_LIMITS.githubInstallUrl })).toBe(SESSION_LIMITS.githubInstallUrl);
      expect(sessionLimitFor({ method: 'POST' })).toBe(DEFAULT_SESSION_WRITE_LIMIT);
      expect(sessionLimitFor({ method: 'PUT', sessionLimit: SESSION_LIMITS.modelKeyPut })).toBe(SESSION_LIMITS.modelKeyPut);
    });

    it('every route that calls an outside service or starts compute declares its own rule', () => {
      const own = new Map(ROUTES.filter((r) => r.sessionLimit).map((r) => [r.operationId, r.sessionLimit!.name]));
      expect(Object.fromEntries(own)).toEqual({
        getInstallUrl: 'github-install-url',
        createRepoIntent: 'github-create-intent',
        putModelConnection: 'model-key-put',
        testModelConnection: 'model-key-test',
        createPortalSession: 'stripe',
        createCheckoutSession: 'stripe',
        createSiteSetupCheckout: 'stripe',
        createSiteSyncCheckout: 'stripe',
        cancelSiteSync: 'stripe',
        testWebhookEndpoint: 'webhook-test',
        retryRun: 'run-retry',
        startPlanImport: 'plan-import',
      });
    });
  });

  describe('token callers are unchanged', () => {
    it('a token write is held to the token caps only: no session bucket is created for it', async () => {
      const who = await owner();
      const plaintext = generateToken();
      await insertApiToken(appUserPool, {
        accountId: who.accountId,
        createdBy: who.userId,
        tokenHash: hashToken(plaintext),
        displayHint: displayHint(plaintext),
        scopes: ['discussions:write'],
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      });
      const headers = new Headers({ authorization: `Bearer ${plaintext}`, 'content-type': 'application/json', 'x-forwarded-for': randomUUID() });
      // An empty body fails validation (422) after the limiter point, so the call reaches it without needing a discussion.
      const res = await handleApiRequest(
        new Request('http://localhost/api/v1/discussions', { method: 'POST', headers, body: '{}' }),
        appUserPool,
        platformOpsPool,
        ROUTES,
      );
      expect(res.status).not.toBe(429);
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM rate_limit_windows WHERE bucket_key LIKE $1", [`session%${who.accountId}%`]);
      expect(rows[0]!.n).toBe(0);
      const tokenRows = await admin.query("SELECT count(*)::int AS n FROM rate_limit_windows WHERE bucket_key = $1", [`tenant:${who.accountId}`]);
      expect(tokenRows.rows[0]!.n).toBe(1);
    });
  });
});
