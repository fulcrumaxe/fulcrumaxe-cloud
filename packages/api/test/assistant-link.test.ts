import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { createRecordingRunActionSignal } from '@fx/core/src/runActions/index.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { effectivePrincipals } from '../src/registry.js';
import { ROUTES } from '../src/routes/index.js';
import { runActionDeps } from '../src/routes/run-actions.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface Minted {
  id: string;
  token: string;
  scopes: string[];
  repo_id: string;
  client_id: string;
  expires_at: string;
}
interface Corr {
  id: string;
  status: string;
  content_hash: string;
  decided_via: string | null;
}

/**
 * D#597 CC-4: the delegation token and the device link, through the real dispatcher on real Postgres (RLS on, the real definers and
 * CHECKs). No outside service is called, so there is nothing to fake: every token here is made by the route under test.
 */
describe('D#597 CC-4: delegation token and device link', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const signal = createRecordingRunActionSignal();

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
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end()]);
  });
  beforeEach(() => {
    runActionDeps.getRunActionSignal = () => signal;
  });
  afterEach(() => {
    runActionDeps.getRunActionSignal = () => null;
  });

  /** `who` is a session identity or a bearer token. A request with `who` undefined carries no credential. */
  async function call(who: Identity | string | undefined, method: string, urlPath: string, body?: unknown) {
    const h = new Headers();
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else if (who) h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (body !== undefined) h.set('content-type', 'application/json');
    h.set('x-forwarded-for', `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`);
    return handleApiRequest(
      new Request(`http://localhost/api/v1${urlPath}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
      appUserPool,
      platformOpsPool,
      ROUTES,
    );
  }
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  const account = (role: 'owner' | 'admin' | 'member' = 'owner') => seedAccountWithMember(admin, { role });
  async function addMember(accountId: string, role: 'member' | 'admin'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, userId, role]);
    return { accountId, userId };
  }
  let ghRepo = 700_000_000;
  async function seedRepo(accountId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', 'widgets')`, [id, accountId, ghRepo++]);
    return id;
  }
  async function seedItem(accountId: string, repoId: string | null): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, priority) VALUES ($1, $2, $3, 'feature', 'internal', 'triaged', 2)`, [id, accountId, repoId]);
    return id;
  }
  async function mint(who: Identity, repoId: string, clientId = 'laptop-1'): Promise<Minted> {
    const res = await call(who, 'POST', '/assistant/tokens', { repo_id: repoId, client_id: clientId });
    expect(res.status).toBe(201);
    return (await res.json()) as Minted;
  }
  async function propose(token: string, item: string, kind: string, body: string): Promise<Corr> {
    const res = await call(token, 'POST', `/work-items/${item}/corrections`, { kind, body });
    expect(res.status).toBe(201);
    return (await res.json()) as Corr;
  }
  const status = async (id: string) => (await admin.query('SELECT status FROM work_item_corrections WHERE id = $1', [id])).rows[0].status as string;

  it('mints a token that lasts an hour at most, bound to the repo and client, with only read + corrections:write', async () => {
    const o = await account();
    const repo = await seedRepo(o.accountId);
    const t = await mint(o, repo, 'my.laptop');
    expect(t.scopes).toEqual(['read', 'corrections:write']);
    expect(t).toMatchObject({ repo_id: repo, client_id: 'my.laptop' });
    const left = new Date(t.expires_at).getTime() - Date.now();
    expect(left).toBeGreaterThan(55 * 60_000);
    expect(left).toBeLessThanOrEqual(60 * 60_000);
    const row = (await admin.query('SELECT delegated, repo_id, client_id, name FROM api_tokens WHERE id = $1', [t.id])).rows[0];
    expect(row).toMatchObject({ delegated: true, repo_id: repo, client_id: 'my.laptop', name: 'assistant my.laptop' });
    // a bad client id, and a repo that is not the caller's, are refused; an ordinary token cannot mint
    expect((await call(o, 'POST', '/assistant/tokens', { repo_id: repo, client_id: 'bad id!' })).status).toBe(422);
    const other = await account();
    expect((await call(o, 'POST', '/assistant/tokens', { repo_id: await seedRepo(other.accountId), client_id: 'x' })).status).toBe(404);
    expect(await code(await call(t.token, 'POST', '/assistant/tokens', { repo_id: repo, client_id: 'x' }))).toBe('session_required');
  });

  it('the database holds a delegation token to an hour and to its two scopes, whatever the caller sends', async () => {
    const o = await account();
    const repo = await seedRepo(o.accountId);
    const insert = (scopes: string, life: string) =>
      admin.query(
        `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at, delegated, repo_id, client_id)
         VALUES ($1, $2, $3, 'h', $4::text[], now() + $5::interval, true, $6, 'c')`,
        [o.accountId, o.userId, randomUUID().replace(/-/g, '').repeat(2), scopes, life, repo],
      );
    await expect(insert('{read}', '2 hours')).rejects.toThrow(/api_tokens_delegation_shape/);
    await expect(insert('{read,audit:read}', '30 minutes')).rejects.toThrow(/api_tokens_delegation_shape/);
    await insert('{read,corrections:write}', '59 minutes');
  });

  it('CC-4-1: a token older than an hour is 401; a token on another repo\'s item is 404', async () => {
    const o = await account();
    const repo = await seedRepo(o.accountId);
    const elsewhere = await seedRepo(o.accountId);
    const item = await seedItem(o.accountId, repo);
    const foreign = await seedItem(o.accountId, elsewhere);
    const bare = await seedItem(o.accountId, null);
    const t = await mint(o, repo);
    expect((await call(t.token, 'GET', `/work-items/${item}/corrections`)).status).toBe(200);
    for (const other of [foreign, bare, randomUUID()]) {
      expect((await call(t.token, 'GET', `/work-items/${other}/corrections`)).status).toBe(404);
      expect((await call(t.token, 'POST', `/work-items/${other}/corrections`, { kind: 'question', body: 'x' })).status).toBe(404);
    }
    const c = await propose(t.token, item, 'question', 'q');
    const other = await call(o, 'POST', `/work-items/${foreign}/corrections`, { kind: 'question', body: 'q2' });
    const c2 = (await other.json()) as Corr;
    expect((await call(t.token, 'POST', `/corrections/${c2.id}/accept`, { content_hash: c2.content_hash })).status).toBe(404);
    expect(await status(c2.id)).toBe('proposed');
    expect(await status(c.id)).toBe('proposed');
    // the clock moves past the hour: the same secret no longer resolves
    await admin.query(`UPDATE api_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1`, [t.id]);
    expect(await code(await call(t.token, 'GET', `/work-items/${item}/corrections`))).toBe('invalid_token');
  });

  it('CC-4-2: revoking the token, or removing the membership, makes the next call 401', async () => {
    const o = await account();
    const repo = await seedRepo(o.accountId);
    const item = await seedItem(o.accountId, repo);
    const revoked = await mint(o, repo);
    expect((await call(revoked.token, 'GET', `/work-items/${item}/corrections`)).status).toBe(200);
    expect((await call(o, 'DELETE', `/tokens/${revoked.id}`)).status).toBe(204);
    expect(await code(await call(revoked.token, 'GET', `/work-items/${item}/corrections`))).toBe('invalid_token');

    const m = await addMember(o.accountId, 'member');
    const gone = await mint(m, repo);
    expect((await call(gone.token, 'GET', `/work-items/${item}/corrections`)).status).toBe(200);
    await admin.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [m.accountId, m.userId]);
    expect(await code(await call(gone.token, 'GET', `/work-items/${item}/corrections`))).toBe('invalid_token');
    // the token can end itself
    const own = await mint(o, repo);
    expect((await call(own.token, 'DELETE', `/tokens/${own.id}`)).status).toBe(204);
  });

  describe('CC-4-3: the device link', () => {
    async function start(clientId = 'runner-a') {
      const res = await call(undefined, 'POST', '/assistant/link', { client_id: clientId });
      expect(res.status).toBe(201);
      return (await res.json()) as { device_code: string; user_code: string; expires_at: string; interval_seconds: number };
    }
    const poll = (deviceCode: string) => call(undefined, 'POST', '/assistant/link/poll', { device_code: deviceCode });

    it('pending until approved, then redeemed exactly once, even under concurrent polls', async () => {
      const o = await account();
      const repo = await seedRepo(o.accountId);
      const link = await start();
      expect(link.user_code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(((await (await poll(link.device_code)).json()) as { status: string }).status).toBe('pending');
      const ok = await call(o, 'POST', '/assistant/link/approve', { user_code: `${link.user_code.slice(0, 4)}-${link.user_code.slice(4).toLowerCase()}`, repo_id: repo });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ client_id: 'runner-a' });
      // a second approval of the same code finds nothing to approve
      expect((await call(o, 'POST', '/assistant/link/approve', { user_code: link.user_code, repo_id: repo })).status).toBe(404);

      const results = await Promise.all(Array.from({ length: 6 }, () => poll(link.device_code)));
      const won = results.filter((r) => r.status === 200);
      expect(won).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      for (const r of results.filter((x) => x.status === 409)) expect(await code(r)).toBe('link_already_redeemed');
      const issued = (await won[0]!.json()) as { status: string; token: Minted & { token_id: string } };
      expect(issued.status).toBe('approved');
      expect(issued.token).toMatchObject({ scopes: ['read', 'corrections:write'], repo_id: repo, client_id: 'runner-a' });
      expect(Number((await admin.query(`SELECT count(*) AS n FROM api_tokens WHERE client_id = 'runner-a' AND account_id = $1`, [o.accountId])).rows[0].n)).toBe(1);
      expect((await call(issued.token.token, 'GET', `/work-items/${await seedItem(o.accountId, repo)}/corrections`)).status).toBe(200);
      expect(await code(await poll(link.device_code))).toBe('link_already_redeemed');
      const audit = await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'api_token.created'`, [o.accountId]);
      expect(audit.rows[0].actor).toBe(`session:${o.userId}`);
      expect(audit.rows[0].payload).toMatchObject({ delegated: true });
      expect(JSON.stringify(audit.rows)).not.toContain(issued.token.token);
    });

    it('a code older than 10 minutes is expired, approved or not, and cannot be approved', async () => {
      const o = await account();
      const repo = await seedRepo(o.accountId);
      const stale = await start();
      await admin.query(`UPDATE assistant_link_codes SET expires_at = now() - interval '1 second' WHERE user_code = $1`, [stale.user_code]);
      expect(((await (await poll(stale.device_code)).json()) as { status: string }).status).toBe('expired');
      expect((await call(o, 'POST', '/assistant/link/approve', { user_code: stale.user_code, repo_id: repo })).status).toBe(404);

      const approved = await start();
      expect((await call(o, 'POST', '/assistant/link/approve', { user_code: approved.user_code, repo_id: repo })).status).toBe(200);
      await admin.query(`UPDATE assistant_link_codes SET expires_at = now() - interval '1 second' WHERE user_code = $1`, [approved.user_code]);
      expect(((await (await poll(approved.device_code)).json()) as { status: string }).status).toBe('expired');
      expect(Number((await admin.query(`SELECT count(*) AS n FROM api_tokens WHERE account_id = $1`, [o.accountId])).rows[0].n)).toBe(0);
    });

    it('an approver who has left makes the code expired; an unknown code is 404; nothing needs a credential but nothing is leaked', async () => {
      const o = await account();
      const m = await addMember(o.accountId, 'member');
      const repo = await seedRepo(o.accountId);
      const link = await start();
      expect((await call(m, 'POST', '/assistant/link/approve', { user_code: link.user_code, repo_id: repo })).status).toBe(200);
      await admin.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [m.accountId, m.userId]);
      expect(((await (await poll(link.device_code)).json()) as { status: string }).status).toBe('expired');
      expect((await poll(`fxdl_${'a'.repeat(43)}`)).status).toBe(404);
      expect((await call(undefined, 'POST', '/assistant/link', { client_id: 'no good' })).status).toBe(422);
      // approval needs a session: no credential, and a token, are refused
      expect((await call(undefined, 'POST', '/assistant/link/approve', { user_code: link.user_code, repo_id: repo })).status).toBe(401);
      expect(await code(await call((await mint(o, repo)).token, 'POST', '/assistant/link/approve', { user_code: link.user_code, repo_id: repo }))).toBe('session_required');
    });

    it('the web tier\'s login reaches the codes only through the functions', async () => {
      const link = await start('probe');
      await expect(appUserPool.query('SELECT * FROM assistant_link_codes')).rejects.toThrow(/permission denied/);
      await expect(appUserPool.query(`UPDATE assistant_link_codes SET redeemed_at = now() WHERE user_code = $1`, [link.user_code])).rejects.toThrow(/permission denied/);
      // the code the runner holds is stored only as its hash
      const rows = (await admin.query('SELECT device_hash FROM assistant_link_codes WHERE user_code = $1', [link.user_code])).rows;
      expect(rows[0].device_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].device_hash).not.toBe(link.device_code);
    });
  });

  it('CC-4-4: a member\'s token cannot accept (403); an admin\'s can, with the hash; a hash is required', async () => {
    const o = await account();
    const repo = await seedRepo(o.accountId);
    const item = await seedItem(o.accountId, repo);
    const m = await addMember(o.accountId, 'member');
    const a = await addMember(o.accountId, 'admin');
    const memberToken = await mint(m, repo);
    const adminToken = await mint(a, repo);
    expect(memberToken.scopes).toEqual(adminToken.scopes);

    const amend = await propose(memberToken.token, item, 'spec_amend', 'Also cover the retry path.');
    const denied = await call(memberToken.token, 'POST', `/corrections/${amend.id}/accept`, { content_hash: amend.content_hash });
    expect(denied.status).toBe(403);
    expect(await code(denied)).toBe('insufficient_role');
    expect((await call(memberToken.token, 'POST', `/corrections/${amend.id}/reject`, { content_hash: amend.content_hash })).status).toBe(403);
    expect(await status(amend.id)).toBe('proposed');

    const q = await propose(adminToken.token, item, 'question', 'Is the retry safe?');
    expect((await call(adminToken.token, 'POST', `/corrections/${q.id}/accept`)).status).toBe(422);
    expect((await call(adminToken.token, 'POST', `/corrections/${q.id}/accept`, { content_hash: 'b'.repeat(64) })).status).toBe(409);
    expect(await status(q.id)).toBe('proposed');
    const done = await call(adminToken.token, 'POST', `/corrections/${q.id}/accept`, { content_hash: q.content_hash });
    expect(done.status).toBe(200);
    expect(await status(q.id)).toBe('applied');
    expect(((await done.json()) as Corr).decided_via).toBe('terminal');
    // an ordinary token, even an admin's with every scope, is still refused
    const plain = generateToken();
    await insertApiToken(appUserPool, { accountId: a.accountId, createdBy: a.userId, tokenHash: hashToken(plain), displayHint: 'fxat_...test', scopes: ['read', 'corrections:write'], expiresAt: new Date(Date.now() + 86_400_000) });
    const q2 = await propose(adminToken.token, item, 'question', 'Again?');
    expect(await code(await call(plain, 'POST', `/corrections/${q2.id}/accept`, { content_hash: q2.content_hash }))).toBe('session_required');
  });

  it('CC-4-5: the routes that allow a delegation token are exactly these, and none of them can clear a halt, approve, merge, cancel or close', async () => {
    const delegation = ROUTES.filter((r) => (r.tokens ?? ['api']).includes('delegation')).map((r) => `${r.method} ${r.path}`).sort();
    expect(delegation).toEqual([
      'DELETE /api/v1/tokens/{id}',
      'GET /api/v1/work-items/{id}/corrections',
      'POST /api/v1/corrections/{id}/accept',
      'POST /api/v1/corrections/{id}/reject',
      'POST /api/v1/work-items/{id}/corrections',
    ]);
    const o = await account();
    const repo = await seedRepo(o.accountId);
    const item = await seedItem(o.accountId, repo);
    await admin.query(`UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1`, [item, randomUUID()]);
    const t = await mint(o, repo);
    const pause = await propose(t.token, item, 'pause', 'again');
    /** The per-token minute cap would answer 429 once the walk outgrows it, so each call gets its own token. */
    const fresh = async () => {
      const plaintext = generateToken();
      await insertApiToken(appUserPool, {
        accountId: o.accountId, createdBy: o.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read', 'corrections:write'],
        expiresAt: new Date(Date.now() + 3_000_000), delegation: { repoId: repo, clientId: 'walk' },
      });
      return plaintext;
    };
    for (const r of ROUTES.filter((x) => x.method !== 'GET' && x.operationId !== 'deleteToken' && effectivePrincipals(x).includes('token'))) {
      const urlPath = r.path.replace('/api/v1', '').replace('{id}', item);
      const res = await call(await fresh(), r.method, urlPath, r.bodySchema ? { content_hash: pause.content_hash } : undefined);
      const wanted = (r.tokens ?? ['api']).includes('delegation');
      if (!wanted) expect([401, 403, 404], `${r.operationId} -> ${res.status}`).toContain(res.status);
      if (!wanted && r.principals?.includes('token')) expect(await code(res), r.operationId).toBe('insufficient_scope');
      const after = (await admin.query('SELECT halted_at, stage FROM work_items WHERE id = $1', [item])).rows[0];
      expect(after.halted_at, r.operationId).not.toBeNull();
      expect(after.stage, r.operationId).toBe('triaged');
    }
    // the stage verbs and the older token routes refuse it by name
    expect(await code(await call(await fresh(), 'POST', `/work-items/${item}/approve`, {}))).toBe('session_required');
    expect(await code(await call(await fresh(), 'GET', '/work-items'))).toBe('insufficient_scope');
  });

  it('CC-4-6: a token of account B reads and writes nothing of account A, under the real database login', async () => {
    const a = await account();
    const b = await account();
    const repoA = await seedRepo(a.accountId);
    const repoB = await seedRepo(b.accountId);
    const itemA = await seedItem(a.accountId, repoA);
    const corrA = (await (await call(a, 'POST', `/work-items/${itemA}/corrections`, { kind: 'question', body: 'mine' })).json()) as Corr;
    const tb = await mint(b, repoB);
    expect((await call(tb.token, 'GET', `/work-items/${itemA}/corrections`)).status).toBe(404);
    expect((await call(tb.token, 'POST', `/work-items/${itemA}/corrections`, { kind: 'question', body: 'x' })).status).toBe(404);
    expect((await call(tb.token, 'POST', `/corrections/${corrA.id}/accept`, { content_hash: corrA.content_hash })).status).toBe(404);
    expect(await status(corrA.id)).toBe('proposed');
    expect(Number((await admin.query('SELECT count(*) AS n FROM work_item_corrections WHERE work_item_id = $1', [itemA])).rows[0].n)).toBe(1);
    // B cannot bind a link or a token to A's repo
    expect((await call(b, 'POST', '/assistant/tokens', { repo_id: repoA, client_id: 'x' })).status).toBe(404);
    const link = (await (await call(undefined, 'POST', '/assistant/link', { client_id: 'b-runner' })).json()) as { user_code: string };
    expect((await call(b, 'POST', '/assistant/link/approve', { user_code: link.user_code, repo_id: repoA })).status).toBe(404);
    expect((await admin.query(`SELECT approved_at FROM assistant_link_codes WHERE user_code = $1`, [link.user_code])).rows[0].approved_at).toBeNull();
    // B's own token row is invisible to A's session
    const listed = (await (await call(a, 'GET', '/tokens')).json()) as { data: { id: string }[] };
    expect(listed.data.map((x) => x.id)).not.toContain(tb.id);
  });
});
