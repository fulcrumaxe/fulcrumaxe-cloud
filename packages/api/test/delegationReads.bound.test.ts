import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, delegationToken, get, openPools, seedFixture, type DelegationFixture, type Pools } from './helpers/delegationFixture.js';

/** D#597 CC-4b criterion 1: a delegation token with `read` reads its bound repo's data on each of the seven routes (real Postgres, real dispatcher). */
describe('delegation token reads its bound repo', () => {
  let p: Pools;
  let f: DelegationFixture;
  let token: string;

  beforeAll(async () => {
    p = await openPools();
    f = await seedFixture(p.admin);
    token = await delegationToken(p.app, f.owner, f.a.repoId);
  });
  afterAll(() => closePools(p));

  it('GET /work-items lists the bound repo and nothing else, with or without the repo_id filter', async () => {
    for (const q of ['', `?repo_id=${f.a.repoId}`, `?repo_id=${f.a.repoId.toUpperCase()}`]) {
      const r = await get(p, token, `/work-items${q}`);
      expect(r.status, q).toBe(200);
      expect(r.body.data.map((i: { id: string }) => i.id), q).toEqual([f.a.itemId]);
    }
  });

  it('GET /work-items/{id}', async () => {
    const r = await get(p, token, `/work-items/${f.a.itemId}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(f.a.itemId);
  });

  it('GET /runs lists the bound repo runs and not the other repo or a run with no work item', async () => {
    const r = await get(p, token, '/runs');
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: { id: string }) => x.id)).toEqual([f.a.runId]);
    const byItem = await get(p, token, `/runs?work_item_id=${f.a.itemId}`);
    expect(byItem.status).toBe(200);
    expect(byItem.body.data.map((x: { id: string }) => x.id)).toEqual([f.a.runId]);
  });

  it('GET /runs/{id}', async () => {
    const r = await get(p, token, `/runs/${f.a.runId}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(f.a.runId);
  });

  it('GET /runs/{id}/events (JSON mode)', async () => {
    const r = await get(p, token, `/runs/${f.a.runId}/events`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
  });

  it('GET /repos/{id}/plan', async () => {
    const r = await get(p, token, `/repos/${f.a.repoId}/plan`);
    expect(r.status).toBe(200);
    expect(r.body.milestones).toEqual([]);
  });

  it('GET /work-items/{id}/receipts returns the item\'s receipt', async () => {
    const r = await get(p, token, `/work-items/${f.a.itemId}/receipts`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.receipts).toHaveLength(1);
  });

  it('a session still reads everything in the account, unbound', async () => {
    const r = await get(p, f.owner, '/work-items');
    expect(r.body.data.map((i: { id: string }) => i.id).sort()).toEqual([f.a.itemId, f.b.itemId].sort());
    expect((await get(p, f.owner, `/runs/${f.b.runId}`)).status).toBe(200);
  });

  it('a token without `read` is refused with 403 on a route it could otherwise read', async () => {
    const t = await delegationToken(p.app, f.owner, f.a.repoId, ['corrections:write']);
    expect((await get(p, t, `/work-items/${f.a.itemId}`)).status).toBe(403);
  });
});
