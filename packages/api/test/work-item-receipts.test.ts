import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { activityResponseSchema } from '../src/routes/work-item-activity.js';
import { seedAccountWithMember } from './helpers/seed.js';

/** D#7 DW-R5: the activity answer lists an item's class 2 and class 3 receipts as closed values only, and carries nothing for an item with none. Real Postgres, RLS on. */
describe('GET /api/v1/work-items/{id}/activity: receipts (D#7 DW-R5)', { timeout: 60_000 }, () => {
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
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });

  type Fixture = Awaited<ReturnType<typeof seed>>;
  async function seed() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, settings) VALUES ($1, $2, $3, 'team', 'acme', 'docs', '{}'::jsonb)`, [repoId, owner.accountId, Math.floor(Math.random() * 1e9)]);
    const itemId = await item(owner.accountId, repoId, 42);
    return { owner, repoId, itemId };
  }
  async function item(accountId: string, repoId: string, n: number): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress', $4)`, [id, accountId, repoId, n]);
    return id;
  }
  async function receipt(f: Fixture, over: Partial<{ item: string; account: string; type: string; cls: string; chosen: string | null; rejected: string | null; actor: string | null; at: string }> = {}) {
    await admin.query(
      `INSERT INTO decision_receipts (account_id, work_item_id, decision_type, class, chosen, rejected_alternative, actor, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [over.account ?? f.owner.accountId, over.item ?? f.itemId, over.type ?? 'start_work_small', over.cls ?? 'human_over_the_loop',
        over.chosen === undefined ? 'start' : over.chosen, over.rejected === undefined ? 'hold' : over.rejected, over.actor === undefined ? 'policy' : over.actor, over.at ?? '2026-10-20T10:00:00Z'],
    );
  }
  async function activity(f: Fixture): Promise<{ body: Record<string, unknown>; raw: string }> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(f.owner)}` });
    const res = await handleApiRequest(new Request(`http://localhost/api/v1/work-items/${f.itemId}/activity`, { headers }), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(activityResponseSchema.parse(body)).toEqual(body);
    return { body, raw };
  }

  it('lists class 2 and class 3 receipts and a reversal, newest first, with only closed values; other items and accounts are absent', async () => {
    const f = await seed();
    await receipt(f, { at: '2026-10-20T10:00:00Z', chosen: 'start', rejected: 'hold' });
    await receipt(f, { at: '2026-10-21T10:00:00Z', type: 'start_parent_item', cls: 'human_in_the_loop', chosen: 'start', rejected: 'hold', actor: f.owner.userId });
    await receipt(f, { at: '2026-10-22T10:00:00Z', type: 'test_strategy_choice', chosen: 'unit', rejected: 'e2e' });
    await receipt(f, { at: '2026-10-23T10:00:00Z', type: 'reversal_recorded', cls: 'human_in_the_loop', chosen: 'undo', rejected: 'keep', actor: f.owner.userId });
    // Not this item's: a sibling item in the same account, and another account's item.
    await receipt(f, { item: await item(f.owner.accountId, f.repoId, 43), type: 'start_work_bug' });
    const other = await seed();
    await receipt(other, { type: 'start_work_doc' });

    const { body, raw } = await activity(f);
    const list = body.receipts as Array<Record<string, unknown>>;
    expect(list.map((r) => r.label)).toEqual([
      'Undoing an earlier decision', 'How to test a change', 'Starting a new feature, project or critical item', 'Starting a small piece of work',
    ]);
    expect(list.map((r) => r.class)).toEqual([3, 2, 3, 2]);
    expect(list[0]).toEqual({ id: expect.any(String), label: 'Undoing an earlier decision', class: 3, at: '2026-10-23T10:00:00.000Z', by: 'person', chosen: 'undo', rejected: 'keep' });
    expect(list.map((r) => r.by)).toEqual(['person', 'policy', 'person', 'policy']);
    expect(Object.keys(list[3]!).sort()).toEqual(['at', 'by', 'chosen', 'class', 'id', 'label', 'rejected']);
    expect('receipts_total' in body).toBe(false);
    // No user id and no other item's or account's receipt.
    expect(raw).not.toContain(f.owner.userId);
    expect(raw).not.toMatch(/bug fix|documentation change/);
  });

  it('an item with no class 2 or 3 receipt has no receipts key, and a class 1 receipt never appears', async () => {
    const f = await seed();
    expect('receipts' in (await activity(f)).body).toBe(false);
    await receipt(f, { cls: 'automated_with_monitoring', type: 'dependency_patch_bump' });
    const { body, raw } = await activity(f);
    expect('receipts' in body).toBe(false);
    expect(raw).not.toContain('Patch-level');
  });

  it('no free text reaches the answer: a value that is not a plain id is replaced by a fixed word', async () => {
    const f = await seed();
    // Built at runtime so no secret-shaped literal sits in the source.
    const hostile = '<img src=x onerror=alert(1)>' + ['sk', 'ant', 'api03'].join('-') + '-' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(30);
    expect(hostile.length).toBeGreaterThanOrEqual(600);
    await receipt(f, { type: hostile, chosen: hostile, rejected: hostile, actor: hostile });
    await receipt(f, { at: '2026-10-21T10:00:00Z', type: 'start_work_small', chosen: null, rejected: 'Has Spaces' });
    const { body, raw } = await activity(f);
    const [newer, hostileRow] = body.receipts as Array<Record<string, unknown>>;
    expect(newer).toMatchObject({ chosen: '(not shown)', rejected: '(not shown)' });
    expect(hostileRow).toMatchObject({ label: 'A decision', chosen: '(not shown)', rejected: '(not shown)', by: 'person' });
    for (const bit of ['<img', 'onerror', 'sk-ant', 'A1b2C3d4E5f6']) expect(raw).not.toContain(bit);
  });

  it('returns the newest 50 and the full count when more exist', async () => {
    const f = await seed();
    for (let i = 0; i < 53; i++) await receipt(f, { at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), chosen: `option-${i}` });
    const { body } = await activity(f);
    const list = body.receipts as Array<{ chosen: string }>;
    expect(list).toHaveLength(50);
    expect(list[0]!.chosen).toBe('option-52');
    expect(list[49]!.chosen).toBe('option-3');
    expect(body.receipts_total).toBe(53);
  });
});
