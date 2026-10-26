import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { activityResponseSchema } from '../src/routes/work-item-activity.js';
import { seedAccountWithMember } from './helpers/seed.js';

/** D#7 start gate (c): the activity answer carries the start decision in fixed sentences, and carries nothing for an item that never went through the gate. */
describe('GET /api/v1/work-items/{id}/activity: start_decision (D#7 start gate c)', { timeout: 60_000 }, () => {
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

  async function seed() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, settings) VALUES ($1, $2, $3, 'team', 'acme', 'docs', '{}'::jsonb)`, [repoId, owner.accountId, Math.floor(Math.random() * 1e9)]);
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress', 42)`, [itemId, owner.accountId, repoId]);
    return { owner, itemId };
  }
  async function activity(f: Awaited<ReturnType<typeof seed>>): Promise<Record<string, unknown>> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(f.owner)}` });
    const res = await handleApiRequest(new Request(`http://localhost/api/v1/work-items/${f.itemId}/activity`, { headers }), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(activityResponseSchema.parse(body)).toEqual(body);
    return body;
  }

  it('an item that never went through the gate has no start_decision key at all', async () => {
    expect('start_decision' in (await activity(await seed()))).toBe(false);
  });

  it('a start under the dial reads as automatic; a person\'s start is named; the date is the decision\'s', async () => {
    const f = await seed();
    await admin.query(
      `INSERT INTO start_gate (account_id, work_item_id, decision_type, preset, dial_version, outcome, receipt_id, decided_by, decided_at)
       VALUES ($1, $2, 'start_work_small', 'balanced', 0, 'started', $3, 'policy', '2026-10-20T14:05:00Z')`,
      [f.owner.accountId, f.itemId, randomUUID()],
    );
    expect((await activity(f)).start_decision).toEqual({
      state: 'started', by: 'dial', name: null, at: '2026-10-20T14:05:00.000Z', sentence: 'Started automatically under your Balanced setting. No one had to answer.',
    });
    const g = await seed();
    await admin.query(`UPDATE users SET name = 'Ada Lovelace' WHERE id = $1`, [g.owner.userId]);
    await admin.query(
      `INSERT INTO start_gate (account_id, work_item_id, decision_type, preset, dial_version, outcome, receipt_id, decided_by, decided_at)
       VALUES ($1, $2, 'start_parent_item', 'cautious', 0, 'started', $3, $4, '2026-10-21T09:00:00Z')`,
      [g.owner.accountId, g.itemId, randomUUID(), g.owner.userId],
    );
    expect((await activity(g)).start_decision).toMatchObject({ state: 'started', by: 'person', name: 'Ada Lovelace', sentence: 'Started by Ada Lovelace.' });
  });
});
