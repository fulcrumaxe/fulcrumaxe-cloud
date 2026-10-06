import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import type { Scope } from '../src/registry.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { setMemberRole, removeMember } from '@fx/core/src/tenancy/membership.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { generateToken, verifyChecksum, TOKEN_FORMAT_RE, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { assertTokensAvailable } from '../src/routes/tokens.js';
import { TOKEN_GA_BLOCKERS } from '../src/tokens/ga-blockers.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('D#31 API-3b: API tokens, token principal, revocation', () => {
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

  afterEach(() => {
    // Restore, never delete: the suite runs in one process and settleMsFromEnv() waives its floor on NODE_ENV=test.
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    delete process.env.FX_API_TOKENS_ENABLED;
  });

  async function sessionRequest(
    url: string,
    identity: { userId: string; accountId: string },
    init: RequestInit = {},
  ): Promise<Request> {
    const token = await signSession(identity);
    const headers = new Headers(init.headers);
    headers.set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
    return new Request(url, { ...init, headers });
  }

  /**
   * D#31 API-3d: every call gets its OWN random source IP by default
   * (TEST-NET-2, RFC 5737) unless the caller sets `x-forwarded-for`
   * itself. Without this, the many 401-triggering calls already
   * scattered across this file's other criteria (6, 7, 9) would all
   * fall into the SAME `failed-auth:unknown` rate-limit bucket and could
   * flip an expected 401 into a 429 purely from unrelated tests piling
   * up in the same 60s window -- criterion 5's own dedicated test below
   * is the only place in this file that deliberately shares one IP
   * across calls.
   */
  function bearerRequest(url: string, plaintext: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${plaintext}`);
    if (!headers.has('x-forwarded-for')) {
      headers.set('x-forwarded-for', `198.51.${randomInt(0, 255)}.${randomInt(1, 255)}`);
    }
    return new Request(url, { ...init, headers });
  }

  async function dispatch(req: Request): Promise<Response> {
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }

  /** POST /api/v1/tokens as a session -- wraps the repeated JSON-body plumbing every creation-rule test needs. */
  async function createTokenHttp(
    identity: { accountId: string; userId: string },
    body: Record<string, unknown>,
  ): Promise<Response> {
    return dispatch(
      await sessionRequest('http://localhost/api/v1/tokens', identity, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  /** Mints via the real insertApiToken service, exercising the real hashing/storage path without an HTTP round trip. */
  async function mintToken(
    identity: { accountId: string; userId: string },
    opts: { scopes?: Scope[]; expiresInDays?: number } = {},
  ): Promise<{ id: string; plaintext: string }> {
    const scopes = opts.scopes ?? ['read'];
    const plaintext = generateToken();
    const expiresAt = new Date(Date.now() + (opts.expiresInDays ?? 90) * 24 * 60 * 60 * 1000);
    const inserted = await insertApiToken(appUserPool, {
      accountId: identity.accountId,
      createdBy: identity.userId,
      tokenHash: hashToken(plaintext),
      displayHint: displayHint(plaintext),
      scopes,
      expiresAt,
    });
    return { id: inserted.id, plaintext };
  }

  /** Inserts a row directly, bypassing insertApiToken's active-account check -- for tests needing an existing token on an already-paused account. */
  async function seedTokenDirect(
    identity: { accountId: string; userId: string },
    opts: { scopes?: Scope[] } = {},
  ): Promise<{ id: string; plaintext: string }> {
    const plaintext = generateToken();
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '90 days')
       RETURNING id`,
      [identity.accountId, identity.userId, hashToken(plaintext), displayHint(plaintext), opts.scopes ?? ['read']],
    );
    return { id: rows[0]!.id, plaintext };
  }

  describe('criterion 1: format', () => {
    it('1,000 generated tokens all match the fxat_ + 43 + 6 base62 shape and verify', () => {
      for (let i = 0; i < 1000; i++) {
        const t = generateToken();
        expect(t).toMatch(TOKEN_FORMAT_RE);
        expect(verifyChecksum(t)).toBe(true);
      }
    });

    it('changing any one character fails verifyChecksum (every position)', () => {
      const base = generateToken();
      for (let i = 5; i < base.length; i++) {
        const chars = base.split('');
        chars[i] = chars[i] === '0' ? '1' : '0';
        const mutated = chars.join('');
        expect(verifyChecksum(mutated)).toBe(false);
      }
    });
  });

  describe('criterion 2: storage', () => {
    it('token_hash is sha256(secret), never the plaintext, with a unique index', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { id, plaintext } = await mintToken({ accountId, userId });
      const { rows } = await admin.query<{ token_hash: string }>('SELECT token_hash FROM api_tokens WHERE id = $1', [
        id,
      ]);
      expect(rows[0]!.token_hash).toBe(hashToken(plaintext));
      expect(rows[0]!.token_hash).not.toBe(plaintext);
    });

    it('a real POST /api/v1/tokens response is the only place the secret appears, with no-store, and GET shows display_hint + last 4 chars', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const res = await createTokenHttp({ accountId, userId }, { scopes: ['read'] });
      expect(res.status).toBe(201);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      const body = (await res.json()) as { id: string; token: string; display_hint: string };
      expect(body.token).toMatch(TOKEN_FORMAT_RE);
      expect(body.display_hint).toBe(`fxat_...${body.token.slice(-4)}`);

      const listRes = await dispatch(await sessionRequest('http://localhost/api/v1/tokens', { accountId, userId }));
      const listBody = (await listRes.json()) as { data: { id: string; display_hint: string }[] };
      const mine = listBody.data.find((t) => t.id === body.id);
      expect(mine?.display_hint).toBe(body.display_hint);
      // The plaintext secret never appears anywhere in the DB.
      const { rows: dumpRows } = await admin.query<{ token_hash: string }>(
        'SELECT token_hash FROM api_tokens WHERE id = $1',
        [body.id],
      );
      expect(dumpRows[0]!.token_hash).not.toContain(body.token);
      const { rows: auditRows } = await admin.query<{ payload: unknown }>(
        `SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'api_token.created'`,
        [accountId],
      );
      expect(JSON.stringify(auditRows.map((r) => r.payload))).not.toContain(body.token);
      const { rows: idemRows } = await admin.query('SELECT response FROM idempotency_keys WHERE account_id = $1', [
        accountId,
      ]);
      expect(idemRows).toHaveLength(0); // createToken is idempotency: 'never' -- no row is ever written for it.
    });
  });

  describe('criterion 3: real input', () => {
    it('mints a read token, calls an API-3a read route with it, no Origin needed', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { plaintext } = await mintToken({ accountId, userId });
      const res = await dispatch(bearerRequest('http://localhost/api/v1/runs', plaintext));
      expect(res.status).toBe(200);
      const accountRes = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
      expect(accountRes.status).toBe(200);
    });

    it('POST /api/v1/tokens with a token -> 403 session_required, even with forged x-fx-scopes (criterion 13)', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { plaintext } = await mintToken({ accountId, userId });
      const res = await dispatch(
        bearerRequest('http://localhost/api/v1/tokens', plaintext, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-fx-token-id': randomUUID(),
            'x-fx-scopes': 'audit:read',
          },
          body: JSON.stringify({ scopes: ['read'] }),
        }),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('session_required');
    });

    // S6: the test above targets POST /api/v1/tokens (session-only), so it
    // 403s from the principal-kind check alone -- it can't fail even if a
    // token-accepting route started trusting these headers. This one hits
    // GET /api/v1/account (S+T(read)) with a token whose REAL scopes lack
    // "read"; a header-trusting regression would flip this to 200.
    it('a runs:cancel-only token forging x-fx-scopes: read and x-fx-token-id on GET /account -> 403 insufficient_scope (criterion 13, targets a token-accepting route)', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { plaintext } = await mintToken({ accountId, userId }, { scopes: ['runs:cancel'] });
      const res = await dispatch(
        bearerRequest('http://localhost/api/v1/account', plaintext, {
          headers: { 'x-fx-scopes': 'read', 'x-fx-token-id': randomUUID() },
        }),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('insufficient_scope');
    });

    // "text/plain -> 415": guarded by csrf.ts ahead of handleApiRequest -- covered by apps/web/test/csrf.test.ts.
  });

  // Criterion 5 (creator demotion/removal revokes tokens, API-3e) and
  // criterion 11 (per-token/tenant rate limits, API-3d's own
  // ratelimit.test.ts): follow-up PRs, split out for the 2,000-line
  // policy (C13). Old criterion 7 bullet 3 (per-IP failed-auth) landed
  // in this file, above -- see "criterion 7: rejected credentials".

  describe('criterion 6: account state', () => {
    it('paused: reads keep working, minting -> 409; closed: an existing token -> 401 invalid_token', async () => {
      const paused = await seedAccountWithMember(admin, { status: 'paused' });
      // A token can never be MINTED on a non-active account -- seeded directly.
      const pausedToken = await seedTokenDirect(paused);
      const readRes = await dispatch(bearerRequest('http://localhost/api/v1/account', pausedToken.plaintext));
      expect(readRes.status).toBe(200);
      const mintRes = await createTokenHttp(paused, { scopes: ['read'] });
      expect(mintRes.status).toBe(409);
      expect(((await mintRes.json()) as { error: { code: string } }).error.code).toBe('account_not_active');

      const closed = await seedAccountWithMember(admin);
      const closedToken = await mintToken(closed);
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [closed.accountId]);
      const res = await dispatch(bearerRequest('http://localhost/api/v1/account', closedToken.plaintext));
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_token');
    });
  });

  describe('criterion 7: rejected credentials', () => {
    it('unknown, expired, revoked and bad-checksum tokens all -> identical 401 invalid_token bodies', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const unknown = generateToken();
      const { plaintext: expiredPlaintext } = await mintToken({ accountId, userId }, { expiresInDays: 1 });
      await admin.query("UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [
        hashToken(expiredPlaintext),
      ]);
      const { plaintext: revokedPlaintext } = await mintToken({ accountId, userId });
      await admin.query("UPDATE api_tokens SET revoked_at = now(), revoked_reason = 'user_requested' WHERE token_hash = $1", [
        hashToken(revokedPlaintext),
      ]);
      const badChecksum = `${unknown.slice(0, -1)}${unknown.slice(-1) === '0' ? '1' : '0'}`;

      // request_id is stripped before comparing (a fresh one per response is expected, not a deviation).
      const bodies: { code: string; message: string }[] = [];
      for (const plaintext of [unknown, expiredPlaintext, revokedPlaintext, badChecksum]) {
        const res = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: { code: string; message: string; request_id: string } };
        expect(body.error.code).toBe('invalid_token');
        bodies.push({ code: body.error.code, message: body.error.message });
      }
      for (const b of bodies) {
        expect(b).toEqual(bodies[0]);
      }
    });

    it('?access_token= is ignored -- 401 unauthenticated', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { plaintext } = await mintToken({ accountId, userId });
      const res = await dispatch(new Request(`http://localhost/api/v1/account?access_token=${plaintext}`));
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthenticated');
    });

    // D#31 API-3d (C13c criterion 5, old criterion 7 bullet 3): "the
    // 21st failed token authentication from one IP within a minute ->
    // 429." Failures counted: unknown, expired, revoked and bad
    // checksum -- one shared IP, four failure shapes, so this also
    // proves the counter isn't keyed on WHY the token failed.
    it('the 21st failed token authentication from one IP within a minute -> 429; the first 20 still -> 401 invalid_token', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const unknown = generateToken();
      const { plaintext: expiredPlaintext } = await mintToken({ accountId, userId }, { expiresInDays: 1 });
      await admin.query("UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [
        hashToken(expiredPlaintext),
      ]);
      const { plaintext: revokedPlaintext } = await mintToken({ accountId, userId });
      await admin.query("UPDATE api_tokens SET revoked_at = now(), revoked_reason = 'user_requested' WHERE token_hash = $1", [
        hashToken(revokedPlaintext),
      ]);
      const badChecksum = `${unknown.slice(0, -1)}${unknown.slice(-1) === '0' ? '1' : '0'}`;
      const failureShapes = [unknown, expiredPlaintext, revokedPlaintext, badChecksum];
      const sharedIp = '203.0.113.44';

      for (let i = 0; i < 20; i++) {
        const plaintext = failureShapes[i % failureShapes.length]!;
        const res = await dispatch(
          bearerRequest('http://localhost/api/v1/account', plaintext, { headers: { 'x-forwarded-for': sharedIp } }),
        );
        expect(res.status, `attempt ${i + 1}`).toBe(401);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_token');
      }

      const res21 = await dispatch(
        bearerRequest('http://localhost/api/v1/account', unknown, { headers: { 'x-forwarded-for': sharedIp } }),
      );
      expect(res21.status).toBe(429);
      const body = (await res21.json()) as { error: { code: string } };
      expect(body.error.code).toBe('rate_limited');
      const retryAfter = res21.headers.get('Retry-After');
      expect(retryAfter).not.toBeNull();
      expect(Number.isInteger(Number(retryAfter))).toBe(true);

      // A DIFFERENT IP is not affected -- the bucket is per-IP, not global.
      const otherIpRes = await dispatch(
        bearerRequest('http://localhost/api/v1/account', unknown, { headers: { 'x-forwarded-for': '203.0.113.99' } }),
      );
      expect(otherIpRes.status).toBe(401);
    });

    // Fix round 1, S2 (should-fix, PR #159 review): an IPv6 client can
    // rotate its address within its own /64 -- the smallest block
    // residential/mobile ISPs typically hand out -- to dodge the per-IP
    // cap above if the bucket were keyed on the full /128 address.
    // `bucketKeyForFailedAuthIp` (ratelimit/limits.ts) keys on the /64
    // instead, so every address in one /64 shares one bucket.
    it('the failed-auth bucket is keyed on an IPv6 address\'s /64, not its full address -- rotating within one /64 does not reset the cap', async () => {
      const unknown = generateToken();
      // Same /64 (first four hextets 2001:db8:85a3:1234), different host bits.
      const sameBlockA = '2001:db8:85a3:1234::1';
      const sameBlockB = '2001:db8:85a3:1234:ffff:ffff:ffff:ffff';
      // A different /64 entirely.
      const otherBlock = '2001:db8:85a3:5678::1';

      for (let i = 0; i < 19; i++) {
        const ip = i % 2 === 0 ? sameBlockA : sameBlockB;
        const res = await dispatch(
          bearerRequest('http://localhost/api/v1/account', unknown, { headers: { 'x-forwarded-for': ip } }),
        );
        expect(res.status, `attempt ${i + 1}`).toBe(401);
      }
      // 20th combined failure, still within the cap of 20.
      const res20 = await dispatch(
        bearerRequest('http://localhost/api/v1/account', unknown, { headers: { 'x-forwarded-for': sameBlockB } }),
      );
      expect(res20.status).toBe(401);
      // 21st combined failure (same /64, third distinct host address used) -> 429.
      const res21 = await dispatch(
        bearerRequest('http://localhost/api/v1/account', unknown, {
          headers: { 'x-forwarded-for': '2001:db8:85a3:1234:1:2:3:4' },
        }),
      );
      expect(res21.status).toBe(429);

      // A DIFFERENT /64 is unaffected.
      const otherRes = await dispatch(
        bearerRequest('http://localhost/api/v1/account', unknown, { headers: { 'x-forwarded-for': otherBlock } }),
      );
      expect(otherRes.status).toBe(401);
    });
  });

  describe('criterion 8: creation rules', () => {
    it('a member requesting audit:read -> 403 insufficient_role', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'member' });
      const res = await createTokenHttp({ accountId, userId }, { scopes: ['audit:read'] });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('insufficient_role');
    });

    it.each(['runs:start', 'settings:write', 'billing:write', 'webhooks:write'])('the reserved scope %s -> 422', async (scope) => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      const res = await createTokenHttp({ accountId, userId }, { scopes: [scope] });
      expect(res.status).toBe(422);
    });

    it('a member requesting work_items:write -> 403 insufficient_role', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'member' });
      const res = await createTokenHttp({ accountId, userId }, { scopes: ['work_items:write'] });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('insufficient_role');
    });

    it('a member requesting discussions:write -> 201', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'member' });
      const res = await createTokenHttp({ accountId, userId }, { scopes: ['discussions:write'] });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { scopes: string[] }).scopes).toEqual(['discussions:write']);
    });

    it.each(['owner', 'admin'] as const)('%s requesting both write scopes -> 201', async (role) => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role });
      const res = await createTokenHttp({ accountId, userId }, { scopes: ['work_items:write', 'discussions:write'] });
      expect(res.status).toBe(201);
    });

    it('expires_in_days of 0 or 366 -> 422; omitted -> 90 days', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      for (const days of [0, 366]) {
        const res = await createTokenHttp({ accountId, userId }, { scopes: ['read'], expires_in_days: days });
        expect(res.status).toBe(422);
      }

      const before = Date.now();
      const res = await createTokenHttp({ accountId, userId }, { scopes: ['read'] });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { expires_at: string };
      const expiresInDays = (new Date(body.expires_at).getTime() - before) / (24 * 60 * 60 * 1000);
      expect(expiresInDays).toBeGreaterThan(89.9);
      expect(expiresInDays).toBeLessThan(90.1);
    });

    it('there is no PATCH on tokens', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      const res = await dispatch(
        await sessionRequest(`http://localhost/api/v1/tokens/${randomUUID()}`, { accountId, userId }, {
          method: 'PATCH',
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('criterion 9: revocation', () => {
    it('a token deleting itself -> 204, then its next request -> 401; deleting another id -> 403 session_required', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { id, plaintext } = await mintToken({ accountId, userId }, { scopes: ['read'] });
      const other = await mintToken({ accountId, userId });
      const otherRes = await dispatch(
        bearerRequest(`http://localhost/api/v1/tokens/${other.id}`, plaintext, { method: 'DELETE' }),
      );
      expect(otherRes.status).toBe(403);
      expect(((await otherRes.json()) as { error: { code: string } }).error.code).toBe('session_required');

      const res = await dispatch(bearerRequest(`http://localhost/api/v1/tokens/${id}`, plaintext, { method: 'DELETE' }));
      expect(res.status).toBe(204);
      const next = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
      expect(next.status).toBe(401);
    });

    it("a member session deleting another member's token -> 404", async () => {
      const { accountId, userId: ownerId } = await seedAccountWithMember(admin, { role: 'owner' });
      const memberId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberId, `${memberId}@x.test`]);
      await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [
        accountId,
        memberId,
        'member',
      ]);
      const ownerToken = await mintToken({ accountId, userId: ownerId });
      const res = await dispatch(
        await sessionRequest(`http://localhost/api/v1/tokens/${ownerToken.id}`, { accountId, userId: memberId }, {
          method: 'DELETE',
        }),
      );
      expect(res.status).toBe(404);
    });

    // S5: a non-UUID id used to reach `WHERE id = $2` and throw Postgres
    // 22P02 -> uncaught 500. Only reachable for a SESSION principal (a
    // token's self-only check already 403s a non-matching id first).
    it('a session deleting a non-UUID id -> 404 not_found, not 500 (S5)', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      const res = await dispatch(
        await sessionRequest('http://localhost/api/v1/tokens/not-a-uuid', { accountId, userId }, {
          method: 'DELETE',
        }),
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
    });

    it('revoke-mine revokes every token the user created', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const a = await mintToken({ accountId, userId });
      const b = await mintToken({ accountId, userId });
      const res = await dispatch(
        await sessionRequest('http://localhost/api/v1/tokens/revoke-mine', { accountId, userId }, {
          method: 'POST',
        }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as { revoked: number }).toEqual({ revoked: 2 });
      for (const t of [a, b]) {
        const dispatchRes = await dispatch(bearerRequest('http://localhost/api/v1/account', t.plaintext));
        expect(dispatchRes.status).toBe(401);
      }
    });
  });

  describe('criterion 10: tenant context and audit', () => {
    it("audit_log.actor is 'token:<id>' on self-revoke and 'session:<userId>' on session mint, with created_by in the payload", async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      await createTokenHttp({ accountId, userId }, { scopes: ['read'] });
      const { rows: createdRows } = await admin.query<{ actor: string }>(
        `SELECT actor FROM audit_log WHERE account_id = $1 AND action = 'api_token.created' ORDER BY created_at DESC LIMIT 1`,
        [accountId],
      );
      expect(createdRows[0]!.actor).toBe(`session:${userId}`);

      const { id, plaintext } = await mintToken({ accountId, userId });
      await dispatch(bearerRequest(`http://localhost/api/v1/tokens/${id}`, plaintext, { method: 'DELETE' }));
      const { rows: revokedRows } = await admin.query<{ actor: string; payload: { token_id: string } }>(
        `SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'api_token.revoked' ORDER BY created_at DESC LIMIT 1`,
        [accountId],
      );
      expect(revokedRows[0]!.actor).toBe(`token:${id}`);
      expect(revokedRows[0]!.payload.token_id).toBe(id);
    });

    it('100 reads produce at most one last_used_at UPDATE', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { id, plaintext } = await mintToken({ accountId, userId });
      const before = await admin.query<{ last_used_at: Date | null }>('SELECT last_used_at FROM api_tokens WHERE id = $1', [id]);
      expect(before.rows[0]!.last_used_at).toBeNull();

      for (let i = 0; i < 100; i++) {
        await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
      }
      const after = await admin.query<{ last_used_at: Date }>('SELECT last_used_at FROM api_tokens WHERE id = $1', [id]);
      expect(after.rows[0]!.last_used_at).not.toBeNull();
      // A second burst right after stays within the 60s throttle window.
      const secondBurstTimestamp = after.rows[0]!.last_used_at.getTime();
      for (let i = 0; i < 20; i++) {
        await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
      }
      const stillSame = await admin.query<{ last_used_at: Date }>('SELECT last_used_at FROM api_tokens WHERE id = $1', [id]);
      expect(stillSame.rows[0]!.last_used_at.getTime()).toBe(secondBurstTimestamp);
    });
  });

  // D#31 C13d (API-3e): criteria 3 and 4 -- "next request -> 401" is a
  // real HTTP behavior, verified live through the real dispatcher against
  // real Postgres, not just the revoked_at column. Criteria 1/2/4/5/6
  // (the transactional/audit side: same-transaction rollback, ROLE_RANK,
  // other-account isolation, the audit_log row) live in
  // packages/core/test/token-revocation.test.ts, this task's other
  // acceptance file.
  describe('D#31 C13d (API-3e): demoting/removing the creator revokes their tokens', () => {
    it('criterion 3: demoting the creator revokes their token; re-promoting leaves it revoked -- fails against fcec20d, where the live-role join brings it back', async () => {
      const { accountId, userId: creatorId } = await seedAccountWithMember(admin, { role: 'owner' });
      const secondOwnerId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [secondOwnerId, `${secondOwnerId}@x.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [
        accountId,
        secondOwnerId,
      ]);
      const { plaintext } = await mintToken({ accountId, userId: creatorId }, { scopes: ['read'] });

      const before = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
      expect(before.status).toBe(200);

      await setMemberRole(appUserPool, accountId, secondOwnerId, creatorId, 'member');
      const afterDemote = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
      expect(afterDemote.status).toBe(401);

      await setMemberRole(appUserPool, accountId, secondOwnerId, creatorId, 'owner');
      const afterRepromote = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
      expect(afterRepromote.status).toBe(401);
      expect(((await afterRepromote.json()) as { error: { code: string } }).error.code).toBe('invalid_token');
    });

    it('criterion 4: removing the creator revokes their token; re-adding leaves it revoked -- fails against fcec20d, where a re-added creator resolves again', async () => {
      const { accountId, userId: creatorId } = await seedAccountWithMember(admin, { role: 'owner' });
      const secondOwnerId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [secondOwnerId, `${secondOwnerId}@x.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [
        accountId,
        secondOwnerId,
      ]);
      const { plaintext } = await mintToken({ accountId, userId: creatorId }, { scopes: ['read'] });

      await removeMember(appUserPool, accountId, secondOwnerId, creatorId);
      const afterRemove = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
      expect(afterRemove.status).toBe(401);

      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [
        accountId,
        creatorId,
      ]);
      const afterReadd = await dispatch(bearerRequest('http://localhost/api/v1/account', plaintext));
      expect(afterReadd.status).toBe(401);
      expect(((await afterReadd.json()) as { error: { code: string } }).error.code).toBe('invalid_token');
    });
  });

  // Criterion 12 + C13b/C14c tripwire: production stays refused until
  // every id in TOKEN_GA_BLOCKERS is gone. "API-3f" (#155) and "API-3e"
  // (#158) have both already removed their own ids -- this PR (API-3d)
  // is the one that lands last (C13b/C14c: "the PR that lands last of
  // the three empties the list and also asserts case (c) without
  // injection"), so it empties the list and adds (f) below.
  describe('criterion 12 + C13b/C14c: FX_API_TOKENS_ENABLED gate and the GA-blocker tripwire', () => {
    it('(a) production without the flag -> 403 tokens_not_available', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      process.env.NODE_ENV = 'production';
      delete process.env.FX_API_TOKENS_ENABLED;
      const noFlag = await createTokenHttp({ accountId, userId }, { scopes: ['read'] });
      expect(noFlag.status).toBe(403);
      expect(((await noFlag.json()) as { error: { code: string } }).error.code).toBe('tokens_not_available');
    });

    // (c): a direct call, not HTTP -- the production handler has no
    // legitimate reason to accept a caller-controlled list override.
    it('(c) an injected empty blocker list -> assertTokensAvailable does not throw', () => {
      process.env.NODE_ENV = 'production';
      process.env.FX_API_TOKENS_ENABLED = '1';
      expect(() => assertTokensAvailable([])).not.toThrow();
    });

    it('(d) FX_API_TOKENS_ENABLED of "true", "yes" or " 1" in production -> 403 -- only exactly "1" counts', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      process.env.NODE_ENV = 'production';
      for (const value of ['true', 'yes', ' 1']) {
        process.env.FX_API_TOKENS_ENABLED = value;
        const res = await createTokenHttp({ accountId, userId }, { scopes: ['read'] });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('tokens_not_available');
      }
    });

    it('(e) TOKEN_GA_BLOCKERS pins to [] -- API-3d (D#31 C13c) is the last of the three to land and empties the list', () => {
      expect(TOKEN_GA_BLOCKERS).toEqual([]);
    });

    // (f) fix round 1 (C13b/C14c): whichever of API-3d/API-3e/API-3f
    // lands last also asserts case (c) WITHOUT injection -- the real
    // (now-empty) TOKEN_GA_BLOCKERS, not a caller-supplied override --
    // production plus the flag mints normally (201). This is the
    // positive half of criterion 12 in its final, no-more-blockers state.
    it('(f) production + FX_API_TOKENS_ENABLED=1, the REAL (empty) blocker list, no injection -> 201', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      process.env.NODE_ENV = 'production';
      process.env.FX_API_TOKENS_ENABLED = '1';
      const res = await createTokenHttp({ accountId, userId }, { scopes: ['read'] });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; token: string };
      expect(body.token).toMatch(TOKEN_FORMAT_RE);
    });
  });

});
