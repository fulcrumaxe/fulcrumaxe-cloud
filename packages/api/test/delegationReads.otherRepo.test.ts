import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, delegationToken, get, type Body, openPools, seedFixture, type DelegationFixture, type Pools } from './helpers/delegationFixture.js';

/**
 * D#597 CC-4b criterion 2: on every route, an id or filter of another repo answers 404 with the same body as an unknown id, and a
 * list never holds another repo's row. Also the paging rule: the repo is in the query, so pages and cursors never count another repo.
 */
describe('delegation token cannot read another repo', () => {
  let p: Pools;
  let f: DelegationFixture;
  let token: string;

  beforeAll(async () => {
    p = await openPools();
    f = await seedFixture(p.admin);
    token = await delegationToken(p.app, f.owner, f.a.repoId);
  });
  afterAll(() => closePools(p));

  /** [route with another repo's id, the same route with an id nothing has]. */
  const cases = (): [string, string][] => {
    const none = randomUUID();
    return [
      [`/work-items/${f.b.itemId}`, `/work-items/${none}`],
      [`/runs/${f.b.runId}`, `/runs/${none}`],
      [`/runs/${f.orphanRunId}`, `/runs/${none}`],
      [`/runs/${f.b.runId}/events`, `/runs/${none}/events`],
      [`/repos/${f.b.repoId}/plan`, `/repos/${none}/plan`],
      [`/work-items/${f.b.itemId}/receipts`, `/work-items/${none}/receipts`],
      [`/work-items?repo_id=${f.b.repoId}`, `/work-items?repo_id=${none}`],
      [`/runs?work_item_id=${f.b.itemId}`, `/runs?work_item_id=${none}`],
    ];
  };

  it('answers 404 with the very body an unknown id gets', async () => {
    for (const [other, unknown] of cases()) {
      const o = await get(p, token, other);
      const u = await get(p, token, unknown);
      expect(o.status, other).toBe(404);
      expect(u.status, unknown).toBe(404);
      // request ids differ per call; the error envelope must not
      const strip = (b: Body) => ({ code: b.error.code, message: b.error.message });
      expect(strip(o.body), other).toEqual(strip(u.body));
    }
  });

  it('a malformed id answers 404 like an unknown one, not 500', async () => {
    for (const path of ['/work-items/not-a-uuid', '/runs/not-a-uuid', '/runs/not-a-uuid/events', '/work-items/not-a-uuid/receipts', '/repos/not-a-uuid/plan']) {
      expect((await get(p, token, path)).status, path).toBe(404);
    }
  });

  it('lists hold no row of the other repo, and the other repo is not reachable by its own filter', async () => {
    const items = await get(p, token, '/work-items');
    expect(items.raw).not.toContain(f.b.itemId);
    const runs = await get(p, token, '/runs');
    expect(runs.raw).not.toContain(f.b.runId);
    expect(runs.raw).not.toContain(f.orphanRunId);
  });

  it('paging is bound in the query: limit=1 pages through the bound repo only, and the next cursor is null when it holds one row', async () => {
    // a second item and run in repo A, so a page boundary exists inside the bound repo while repo B interleaves in time
    const itemId = randomUUID();
    const runId = randomUUID();
    await p.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress', 7001)`, [itemId, f.owner.accountId, f.a.repoId]);
    await p.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'build', 'local', 'running')`, [runId, f.owner.accountId, itemId]);
    for (const [path, ids] of [['/work-items', [f.a.itemId, itemId]], ['/runs', [f.a.runId, runId]]] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 5; i++) {
        const r: { status: number; body: Body } = await get(p, token, `${path}?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect(r.status).toBe(200);
        expect(r.body.data.length, path).toBe(1);
        seen.push(r.body.data[0]!.id);
        cursor = r.body.next_cursor;
        if (cursor === null) break;
      }
      expect(seen.sort(), path).toEqual([...ids].sort());
      expect(cursor, path).toBeNull();
    }
  });
});
