import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { contextRuleResponseSchema, contextRuleRoutes } from '../src/routes/context-rules.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);

/** D#600 CX-5a: GET /api/v1/context-rules against real Postgres (RLS forced on the store): what it lists, what it hides, who may call it. */
describe('GET /api/v1/context-rules (D#600 CX-5a)', { timeout: 60_000 }, () => {
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

  async function get(query: string, identity?: { userId: string; accountId: string }): Promise<Response> {
    const headers = new Headers();
    if (identity) headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession({ userId: identity.userId, accountId: identity.accountId })}`);
    return handleApiRequest(new Request(`http://localhost/api/v1/context-rules${query}`, { headers }), appUserPool, platformOpsPool, ROUTES);
  }

  async function world() {
    const m = await seedAccountWithMember(admin, { role: 'member' });
    const repoId = randomUUID();
    const itemId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team')`, [repoId, m.accountId, Math.floor(Math.random() * 1e9)]);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance) VALUES ($1, $2, $3, 'feature', 'running', 'internal')`, [itemId, m.accountId, repoId]);
    const rule = async (scope: 'repo' | 'item', kind: 'pin' | 'exclude', path: string) => {
      await admin.query(
        `INSERT INTO context_rules (account_id, scope, repo_id, work_item_id, kind, path, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [m.accountId, scope, scope === 'repo' ? repoId : null, scope === 'item' ? itemId : null, kind, path, m.userId],
      );
    };
    return { ...m, repoId, itemId, rule };
  }

  it('registers one session-only member GET with a read rate class', () => {
    expect(contextRuleRoutes).toHaveLength(1);
    const [route] = contextRuleRoutes;
    expect(route!.method).toBe('GET');
    expect(route!.principals).toEqual(['session']);
    expect(route!.minRole).toBe('member');
    expect(route!.idempotency).toBe('never');
    expect(ROUTES).toContain(route);
  });

  it('lists a repository\'s rules, and the rules in force for an item (its own over the repository\'s), by path', async () => {
    const w = await world();
    await w.rule('repo', 'pin', 'package.json');
    await w.rule('repo', 'exclude', 'secret/**');
    await w.rule('item', 'exclude', 'package.json');
    const repoRes = await get(`?repo_id=${w.repoId}`, w);
    expect(repoRes.status).toBe(200);
    const repoBody = contextRuleResponseSchema.parse(await repoRes.json());
    expect(repoBody.data.map((r) => [r.scope, r.kind, r.path, r.repo_id, r.work_item_id])).toEqual([
      ['repo', 'pin', 'package.json', w.repoId, null],
      ['repo', 'exclude', 'secret/**', w.repoId, null],
    ]);
    const itemBody = contextRuleResponseSchema.parse(await (await get(`?work_item_id=${w.itemId}`, w)).json());
    expect(itemBody.data.map((r) => [r.scope, r.kind, r.path])).toEqual([
      ['item', 'exclude', 'package.json'],
      ['repo', 'exclude', 'secret/**'],
    ]);
  });

  it('a repository or item with no rules, and one that does not exist, answer an empty list (never null)', async () => {
    const w = await world();
    for (const q of [`?repo_id=${w.repoId}`, `?work_item_id=${w.itemId}`, `?repo_id=${randomUUID()}`, `?work_item_id=${randomUUID()}`]) {
      const res = await get(q, w);
      expect(res.status, q).toBe(200);
      expect(await res.json()).toEqual({ data: [] });
    }
  });

  it('RLS on the read path: an account-B session reads nothing of account A, by repository or by item', async () => {
    const a = await world();
    const b = await world();
    await a.rule('repo', 'exclude', 'a-secret');
    await a.rule('item', 'pin', 'a-item.md');
    expect(await (await get(`?repo_id=${a.repoId}`, b)).json()).toEqual({ data: [] });
    expect(await (await get(`?work_item_id=${a.itemId}`, b)).json()).toEqual({ data: [] });
    expect((await (await get(`?work_item_id=${a.itemId}`, a)).json() as { data: unknown[] }).data).toHaveLength(2);
  });

  it('wants exactly one of repo_id and work_item_id, both uuids, and nothing else', async () => {
    const w = await world();
    for (const q of ['', `?repo_id=${w.repoId}&work_item_id=${w.itemId}`, '?repo_id=nope', '?work_item_id=1', `?repo_id=${w.repoId}&extra=1`]) {
      expect((await get(q, w)).status, q).toBe(422);
    }
  });

  it('needs a session', async () => {
    const w = await world();
    expect((await get(`?repo_id=${w.repoId}`)).status).toBe(401);
  });
});
