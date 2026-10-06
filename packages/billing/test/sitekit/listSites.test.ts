import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/spend';
import { createPool as createBillingPool } from '../../src/pg.js';
import { listSites } from '../../src/sitekit/listSites.js';
import { seedAccountWithMember, type SeededTenant } from '../helpers/seed.js';

describe('D#31 listSites (real Postgres)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let seq = 0;

  beforeAll(async () => {
    adminPool = createBillingPool(process.env.BILLING_DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.BILLING_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  const ctx = (t: SeededTenant) => ({ accountId: t.accountId, userId: t.userId });
  /** Each site gets its own minute so the newest-first order is known. */
  async function site(t: SeededTenant, minute: number, extra: { repoId?: string | null; domain?: string } = {}): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO sites (id, account_id, repo_id, domain, created_at) VALUES ($1, $2::uuid, $3, $4, $5)`, [
      id, t.accountId, extra.repoId ?? null, extra.domain ?? null, new Date(Date.UTC(2026, 8, 1, 10, minute)),
    ]);
    return id;
  }
  async function repo(t: SeededTenant, owner: string | null, name: string | null): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2::uuid, $3, 'team', $4, $5)`, [
      id, t.accountId, 880_000 + ++seq, owner, name,
    ]);
    return id;
  }

  it("pages exactly the caller's sites newest first across a page boundary, and never shows another account's, even by a crafted cursor", async () => {
    const a = await seedAccountWithMember(admin, 'member');
    const b = await seedAccountWithMember(admin, 'owner');
    const [a1, a2, a3] = [await site(a, 1), await site(a, 2), await site(a, 3)];
    await site(b, 0);
    const b6 = await site(b, 6);

    const first = await listSites(appPool, ctx(a), { limit: 2 });
    expect(first.data.map((s) => s.id)).toEqual([a3, a2]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listSites(appPool, ctx(a), { limit: 2, cursor: first.nextCursor! });
    expect(second.data.map((s) => s.id)).toEqual([a1]);
    expect(second.nextCursor).toBeNull();

    // A cursor that encodes one of B's rows only moves a position in A's own list.
    const bRow = (await admin.query<{ c: string }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS c FROM sites WHERE id = $1`, [b6],
    )).rows[0]!;
    const crafted = await listSites(appPool, ctx(a), { limit: 10, cursor: { createdAt: bRow.c, id: b6 } });
    expect(crafted.data.map((s) => s.id)).toEqual([a3, a2, a1]);
    const all = await listSites(appPool, ctx(a), { limit: 100 });
    expect(all.data.map((s) => s.id)).toEqual([a3, a2, a1]);
  });

  it('maps billing (none, or a paid site with an active sync) and the repo full name (only when both parts exist)', async () => {
    const t = await seedAccountWithMember(admin, 'member');
    const bare = await site(t, 1);
    const noOwner = await site(t, 2, { repoId: await repo(t, null, 'widgets') });
    const noName = await site(t, 3, { repoId: await repo(t, 'acme', null) });
    const named = await site(t, 4, { repoId: await repo(t, 'acme', 'widgets'), domain: 'acme.example' });
    await admin.query(
      `INSERT INTO sitekit_entitlements (account_id, site_id, setup_paid_at, setup_payment_intent_id, sync_subscription_id, sync_status, sync_current_period_end, sync_cancel_at_period_end)
       VALUES ($1, $2::uuid, $3, 'pi_' || $2::uuid::text, 'sub_' || $2::uuid::text, 'active', $4, true)`,
      [t.accountId, named, new Date('2026-09-30T10:00:00Z'), new Date('2026-10-30T10:00:00Z')],
    );

    const byId = new Map((await listSites(appPool, ctx(t), { limit: 10 })).data.map((s) => [s.id, s]));
    expect(byId.get(bare)).toEqual({
      id: bare, domain: null, status: 'draft', repo_full_name: null, created_at: '2026-09-01T10:01:00.000Z',
      billing: { setup_paid: false, sync_status: null, sync_current_period_end: null, sync_cancel_at_period_end: false },
    });
    expect(byId.get(noOwner)!.repo_full_name).toBeNull();
    expect(byId.get(noName)!.repo_full_name).toBeNull();
    expect(byId.get(named)).toMatchObject({
      domain: 'acme.example',
      repo_full_name: 'acme/widgets',
      billing: { setup_paid: true, sync_status: 'active', sync_current_period_end: '2026-10-30T10:00:00.000Z', sync_cancel_at_period_end: true },
    });
  });
});
