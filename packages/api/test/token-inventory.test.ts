import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { z } from 'zod';
import { effectivePrincipals, SCOPES, type RouteEntry, type Scope } from '../src/registry.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember } from './helpers/seed.js';

/** Criterion 4: session-only entries reject any token; scoped token-accepting entries reject a token that lacks their scope. Iterates the real registry, so every later task is covered automatically. */
describe('token-inventory: generic session-only and scope enforcement over the real registry', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let accountId: string;
  let userId: string;
  // The scoped-entry cases use an account of their own: the per-tenant request cap is shared by every request of one
  // account, and the session-only and scoped cases together now outnumber it.
  let scopedAccountId: string;
  let scopedUserId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);

    // A plan with room: this test sends one request per registry entry from one account, and the starter plan's per-tenant cap (a minute's window) is smaller than the registry now is.
    const seeded = await seedAccountWithMember(admin, { role: 'owner', plan: 'scale' });
    accountId = seeded.accountId;
    userId = seeded.userId;
    const scoped = await seedAccountWithMember(admin, { role: 'owner' });
    scopedAccountId = scoped.accountId;
    scopedUserId = scoped.userId;
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  function concretePath(template: string): string {
    return template.replace(/\{[^}]+\}/g, randomUUID());
  }

  /** A fresh every-scope token per request: the per-token rate limit (60/min on the starter plan) would otherwise trip once the session-only routes outnumber it, and a 429 would hide the 403 under test. */
  async function mintAllScopesToken(): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId,
      createdBy: userId,
      tokenHash: hashToken(plaintext),
      displayHint: displayHint(plaintext),
      scopes: [...SCOPES],
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    return plaintext;
  }

  async function dispatchAsToken(entry: (typeof ROUTES)[number]): Promise<Response> {
    const allScopesToken = await mintAllScopesToken();
    const url = `http://localhost${concretePath(entry.path)}`;
    const headers = new Headers({ authorization: `Bearer ${allScopesToken}` });
    if (entry.bodySchema) {
      headers.set('content-type', 'application/json');
    }
    const init: RequestInit = { method: entry.method, headers };
    // Session-only entries reject on principal kind BEFORE body
    // validation (handler.ts order: principal -> kind -> scope -> role
    // -> body), so an empty JSON body is enough to reach that check.
    if (entry.bodySchema) init.body = '{}';
    return handleApiRequest(new Request(url, init), appUserPool, platformOpsPool, ROUTES);
  }

  describe('session-only entries reject an every-scope token', () => {
    const sessionOnlyEntries = ROUTES.filter((r) => !effectivePrincipals(r).includes('token'));

    it('the registry has at least one session-only entry (not vacuous)', () => {
      expect(sessionOnlyEntries.length).toBeGreaterThan(0);
    });

    it.each(sessionOnlyEntries.map((r) => [r.operationId, r] as const))(
      '%s -> 403 session_required for a token, regardless of scope',
      async (_name, entry) => {
        const res = await dispatchAsToken(entry);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('session_required');
      },
    );
  });

  describe('token-accepting entries with a declared scope reject a token that lacks it', () => {
    // tokenSelfOnly entries (DELETE /api/v1/tokens/{id}) admit any token
    // by design -- excluded, since they declare no scope to lack.
    const scopedTokenEntries = ROUTES.filter((r) => effectivePrincipals(r).includes('token') && r.scope);

    it('the registry has at least one scoped token-accepting entry (not vacuous)', () => {
      expect(scopedTokenEntries.length).toBeGreaterThan(0);
    });

    it.each(scopedTokenEntries.map((r) => [r.operationId, r] as const))(
      '%s -> 403 insufficient_scope for a token minted with every OTHER scope',
      async (_name, entry) => {
        const otherScopes = SCOPES.filter((s) => s !== entry.scope);
        const plaintext = generateToken();
        await insertApiToken(appUserPool, {
          accountId: scopedAccountId,
          createdBy: scopedUserId,
          tokenHash: hashToken(plaintext),
          displayHint: displayHint(plaintext),
          scopes: otherScopes.length > 0 ? otherScopes : ['read'],
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        });
        const url = `http://localhost${concretePath(entry.path)}`;
        const headers = new Headers({ authorization: `Bearer ${plaintext}` });
        if (entry.bodySchema) headers.set('content-type', 'application/json');
        const init: RequestInit = { method: entry.method, headers };
        if (entry.bodySchema) init.body = '{}';
        const res = await handleApiRequest(new Request(url, init), appUserPool, platformOpsPool, ROUTES);
        // Guards against a future scope-list change silently making this vacuous.
        expect(otherScopes.includes(entry.scope!)).toBe(false);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('insufficient_scope');
      },
    );
  });

  it('runs:start is never mintable (D#31 decision 1)', () => {
    for (const entry of ROUTES) {
      if (entry.startsRun) {
        expect(effectivePrincipals(entry)).not.toContain('token');
      }
    }
    expect(SCOPES).not.toContain('runs:start');
  });
});


/** API-15 / DS-3a-2 / DS-3a-3: only the five discussion and comment write routes accept a write scope so far. */
describe('token-inventory: write scopes open only the routes that declare them', () => {
  it('only the five discussion and comment writes declare discussions:write; only setWorkItemPriority and the three proposal decisions declare work_items:write', () => {
    expect(ROUTES.filter((r) => r.scope === 'work_items:write').map((r) => r.operationId).sort()).toEqual(['rejectProposal', 'restoreProposal', 'setWorkItemPriority', 'withdrawProposalApproval']);
    expect(ROUTES.filter((r) => r.scope === 'discussions:write').map((r) => r.operationId).sort()).toEqual(['createDiscussion', 'editComment', 'patchDiscussion', 'postComment', 'reviseDiscussion']);
  });

  it('the token-accepting routes and their scopes are exactly the known set', () => {
    const tokenRoutes = ROUTES.filter((r) => effectivePrincipals(r).includes('token')).map(
      (r) => `${r.operationId}:${r.tokenSelfOnly ? 'self' : r.scope}`,
    );
    const read = [
      'getAccount', 'listRuns', 'getRun', 'listWorkItems', 'getWorkItem', 'getStats', 'getWorkItemTimeline',
      'listWebhookEndpoints', 'getWebhookEndpoint', 'listWebhookDeliveries', 'listEvents', 'listRunEvents',
      'getModelConnection', 'listRepos', 'getRepo', 'getRepoSettings', 'getRepoPairing', 'listRoles', 'getUsage', 'getBudgets',
      'getRunLimits', 'getRunAction', 'exportRunEvents', 'listDiscussions', 'getDiscussion',
      'listComments', 'listProposals', 'getProposal', 'getLatestPlanImport', 'getRepoPlan', 'getRunnerConcurrency', 'getDiscoverySetting',
    ].map((id) => `${id}:read`);
    expect([...tokenRoutes].sort()).toEqual(
      [
        ...read, 'deleteToken:self', 'listAuditLog:audit:read', 'cancelRun:runs:cancel', 'cancelWorkItem:runs:cancel',
        'postComment:discussions:write', 'editComment:discussions:write',
        'createDiscussion:discussions:write', 'patchDiscussion:discussions:write', 'reviseDiscussion:discussions:write',
        'setWorkItemPriority:work_items:write', 'rejectProposal:work_items:write', 'restoreProposal:work_items:write', 'withdrawProposalApproval:work_items:write',
        'listCorrections:read', 'createCorrection:corrections:write',
      ].sort(),
    );
  });
});

/**
 * API-15: a synthetic route per write scope, dispatched through the real
 * handler with real tokens, proves the registry-level gate (scope, then the
 * creator's CURRENT role) without opening a real route.
 */
describe('token-inventory: synthetic write-scope routes through the real handler (API-15)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  function syntheticRoute(scope: Scope, minRole: 'member' | 'admin'): RouteEntry {
    return {
      method: 'GET',
      path: `/api/v1/synthetic-${scope.replace(':', '-')}`,
      operationId: `synthetic_${scope.replace(':', '_')}`,
      principals: ['session', 'token'],
      minRole,
      scope,
      idempotency: 'never',
      responseSchema: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: true };
      },
    };
  }

  const cases: { scope: Scope; minRole: 'member' | 'admin' }[] = [
    { scope: 'work_items:write', minRole: 'admin' },
    { scope: 'discussions:write', minRole: 'member' },
  ];

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function mint(accountId: string, userId: string, scopes: Scope[]): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId,
      createdBy: userId,
      tokenHash: hashToken(plaintext),
      displayHint: displayHint(plaintext),
      scopes,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    return plaintext;
  }

  async function call(route: RouteEntry, plaintext: string): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${plaintext}` });
    return handleApiRequest(
      new Request(`http://localhost${route.path}`, { method: route.method, headers }),
      appUserPool,
      platformOpsPool,
      [route],
    );
  }

  async function errorCode(res: Response): Promise<string> {
    return ((await res.json()) as { error: { code: string } }).error.code;
  }

  describe.each(cases)('$scope', ({ scope, minRole }) => {
    const route = syntheticRoute(scope, minRole);

    it('a token without the scope -> 403 insufficient_scope, even holding every other scope', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      const readOnly = await mint(accountId, userId, ['read']);
      const res = await call(route, readOnly);
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('insufficient_scope');

      const others = await mint(accountId, userId, SCOPES.filter((s) => s !== scope));
      const res2 = await call(route, others);
      expect(res2.status).toBe(403);
      expect(await errorCode(res2)).toBe('insufficient_scope');
    });

    it('a token holding the scope reaches the handler', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      const res = await call(route, await mint(accountId, userId, [scope]));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  it("work_items:write: a creator demoted below admin (revocation bypassed) is refused on the token's CURRENT role", async () => {
    const route = syntheticRoute('work_items:write', 'admin');
    const { accountId, userId } = await seedAccountWithMember(admin, { role: 'admin' });
    const plaintext = await mint(accountId, userId, ['work_items:write']);
    expect((await call(route, plaintext)).status).toBe(200);

    // Demote by raw SQL so the token is NOT revoked: the request-time role check is what is under test.
    await admin.query('UPDATE account_members SET role = $3 WHERE account_id = $1 AND user_id = $2', [accountId, userId, 'member']);
    const res = await call(route, plaintext);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('insufficient_role');
  });

  it('discussions:write: a creator removed from the account (revocation bypassed) is refused', async () => {
    const route = syntheticRoute('discussions:write', 'member');
    const { accountId, userId } = await seedAccountWithMember(admin, { role: 'member' });
    const plaintext = await mint(accountId, userId, ['discussions:write']);
    expect((await call(route, plaintext)).status).toBe(200);

    await admin.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
    const res = await call(route, plaintext);
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
  });
});
