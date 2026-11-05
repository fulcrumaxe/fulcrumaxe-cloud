import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { contextRuleDeps, contextRuleResponseSchema, missingResolver } from '../src/routes/context-rules.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);
const HEAD = 'a'.repeat(40);

/** D#600 CX-9b: a pin whose path is not in the default branch's tree is listed with `missing_at`; every way the tree cannot be had lists it without one. */
describe('GET /api/v1/context-rules: missing_at (D#600 CX-9b)', { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const reads: string[] = [];
  let tree: { truncated: boolean; entries: Array<{ path: string; type: 'blob' | 'tree' }> } | null = { truncated: false, entries: [] };
  let head: string | null = HEAD;
  const saved = contextRuleDeps.openTree;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = FX_SESSION_SECRET;
    contextRuleDeps.openTree = async () => ({
      headSha: async () => (reads.push('head'), head),
      tree: async () => (reads.push('tree'), tree),
    });
  });
  afterEach(() => {
    reads.length = 0;
    missingResolver.clear();
    tree = { truncated: false, entries: [] };
    head = HEAD;
  });
  afterAll(async () => {
    contextRuleDeps.openTree = saved;
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function get(query: string, identity: { userId: string; accountId: string }): Promise<Response> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession({ userId: identity.userId, accountId: identity.accountId })}` });
    return handleApiRequest(new Request(`http://localhost/api/v1/context-rules${query}`, { headers }), appUserPool, platformOpsPool, ROUTES);
  }
  const list = async (q: string, w: { userId: string; accountId: string }) => contextRuleResponseSchema.parse(await (await get(q, w)).json()).data;

  async function world(connected = true) {
    const m = await seedAccountWithMember(admin, { role: 'member' });
    const repoId = randomUUID();
    const itemId = randomUUID();
    if (connected) {
      const inst = randomUUID();
      await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [inst, m.accountId, Math.floor(Math.random() * 1e9)]);
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, installation_id, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', $4, 'acme', 'widgets')`, [repoId, m.accountId, Math.floor(Math.random() * 1e9), inst]);
    } else {
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team')`, [repoId, m.accountId, Math.floor(Math.random() * 1e9)]);
    }
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance) VALUES ($1, $2, $3, 'feature', 'running', 'internal')`, [itemId, m.accountId, repoId]);
    const rule = async (scope: 'repo' | 'item', kind: 'pin' | 'exclude', path: string) => {
      await admin.query(`INSERT INTO context_rules (account_id, scope, repo_id, work_item_id, kind, path, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [m.accountId, scope, scope === 'repo' ? repoId : null, scope === 'item' ? itemId : null, kind, path, m.userId]);
    };
    return { ...m, repoId, itemId, rule };
  }
  const missing = (rows: Array<{ path: string; missing_at?: string }>) => rows.filter((r) => r.missing_at !== undefined).map((r) => [r.path, r.missing_at]);

  it('labels a pin whose path is not a file at the head, for a repository and for an item (repo and item pins both)', async () => {
    tree = { truncated: false, entries: [{ path: 'src/kept.ts', type: 'blob' }, { path: 'docs', type: 'tree' }] };
    const w = await world();
    await w.rule('repo', 'pin', 'src/kept.ts');
    await w.rule('repo', 'pin', 'src/gone.ts');
    await w.rule('repo', 'pin', 'docs'); // a folder is not a file a pin can name
    await w.rule('item', 'pin', 'item/gone.md');
    await w.rule('repo', 'exclude', 'old/gone.md'); // beside pins, an exclude on a path that is not there is still never labelled
    expect(missing(await list(`?repo_id=${w.repoId}`, w))).toEqual([['docs', HEAD], ['src/gone.ts', HEAD]]);
    expect(missing(await list(`?work_item_id=${w.itemId}`, w))).toEqual([['docs', HEAD], ['item/gone.md', HEAD], ['src/gone.ts', HEAD]]);
  });

  it('never labels an exclude (a glob or an exact path), and reads nothing when the list holds no pin', async () => {
    const w = await world();
    await w.rule('repo', 'exclude', 'secrets/**');
    await w.rule('repo', 'exclude', 'not/there.txt');
    expect(missing(await list(`?repo_id=${w.repoId}`, w))).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('says nothing for a truncated tree, an unreadable tree, no head, a repository with no installation, and a throwing reader', async () => {
    const w = await world();
    await w.rule('repo', 'pin', 'src/gone.ts');
    const none = async () => expect(missing(await list(`?repo_id=${w.repoId}`, w))).toEqual([]);
    tree = { truncated: true, entries: [] };
    await none();
    missingResolver.clear();
    tree = null;
    await none();
    missingResolver.clear();
    head = null;
    await none();
    missingResolver.clear();
    contextRuleDeps.openTree = async () => Promise.reject(new Error('no read scope'));
    await none();
    contextRuleDeps.openTree = null;
    missingResolver.clear();
    await none();
    const bare = await world(false);
    await bare.rule('repo', 'pin', 'x.ts');
    expect(missing(await list(`?repo_id=${bare.repoId}`, bare))).toEqual([]);
    contextRuleDeps.openTree = async () => ({ headSha: async () => (reads.push('head'), head), tree: async () => (reads.push('tree'), tree) });
  });

  it('a second view inside the head window reads nothing more; the labels come from the cache', async () => {
    const w = await world();
    await w.rule('repo', 'pin', 'src/gone.ts');
    expect(missing(await list(`?repo_id=${w.repoId}`, w))).toEqual([['src/gone.ts', HEAD]]);
    expect(reads).toEqual(['head', 'tree']);
    expect(missing(await list(`?work_item_id=${w.itemId}`, w))).toEqual([['src/gone.ts', HEAD]]);
    expect(reads).toEqual(['head', 'tree']);
  });

  it("another account's repository answers an empty list, with no label and no read", async () => {
    const a = await world();
    const b = await world();
    await a.rule('repo', 'pin', 'src/gone.ts');
    expect(await list(`?repo_id=${a.repoId}`, b)).toEqual([]);
    expect(reads).toEqual([]);
  });
});
