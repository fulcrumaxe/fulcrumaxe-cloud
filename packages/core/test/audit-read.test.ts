import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { listAuditLog } from '../src/audit/read.js';

/** D#31 API-7b criterion 1 and 3: `listAuditLog` against a real Postgres cluster under `withTenant`/RLS. */
describe('audit/read (D#31 API-7b)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  async function insertAudit(refs: SeedRefs, action: string, createdAt: string, id: string = randomUUID()): Promise<string> {
    await admin.query(
      `INSERT INTO audit_log (id, account_id, actor, action, payload, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
      [id, refs.accountId, refs.userId, action, JSON.stringify({ n: action }), createdAt],
    );
    return id;
  }

  it('returns the five documented fields, newest first, and pages by (created_at, id) with no duplicate or skip across a created_at tie', async () => {
    const refs = await seedAccount(admin, randomUUID());
    // seedAccount also writes one 'seed' audit row at now(); all rows below are dated in the future,
    // so that row is the oldest and lands last, on page three.
    // Two rows share a timestamp (to the microsecond) so the id tie-break is what keeps paging exact.
    const tie = '2030-03-01T10:00:00.123456Z';
    const lo = await insertAudit(refs, 'a.tie-lo', tie, '00000000-0000-4000-8000-000000000001');
    const hi = await insertAudit(refs, 'a.tie-hi', tie, '00000000-0000-4000-8000-000000000002');
    const oldest = await insertAudit(refs, 'a.oldest', '2030-03-01T09:00:00Z');
    const newest = await insertAudit(refs, 'a.newest', '2030-03-01T11:00:00Z');

    const ctx = { pool: appUserPool, principal: refs };
    const first = await listAuditLog(ctx, { limit: 2 });
    expect(first.data.map((r) => r.id)).toEqual([newest, hi]);
    expect(Object.keys(first.data[0]!).sort()).toEqual(['action', 'actor', 'created_at', 'id', 'payload']);
    expect(first.data[0]).toMatchObject({ action: 'a.newest', actor: refs.userId, payload: { n: 'a.newest' }, created_at: '2030-03-01T11:00:00.000Z' });
    expect(first.nextCursor).toEqual({ createdAt: '2030-03-01T10:00:00.123456Z', id: hi });

    const second = await listAuditLog(ctx, { limit: 2, cursor: first.nextCursor! });
    expect(second.data.map((r) => r.id)).toEqual([lo, oldest]);
    const third = await listAuditLog(ctx, { limit: 2, cursor: second.nextCursor! });
    expect(third.data.map((r) => r.action)).toEqual(['seed']);
    expect(third.nextCursor).toBeNull();
  });

  it('defaults to 50 rows and clamps limit to 200', async () => {
    const refs = await seedAccount(admin, randomUUID());
    await admin.query(
      `INSERT INTO audit_log (account_id, actor, action, created_at)
       SELECT $1, $2, 'bulk', timestamptz '2026-01-01T00:00:00Z' + n * interval '1 second' FROM generate_series(1, 210) AS n`,
      [refs.accountId, refs.userId],
    );
    const ctx = { pool: appUserPool, principal: refs };
    expect((await listAuditLog(ctx)).data).toHaveLength(50);
    const big = await listAuditLog(ctx, { limit: 100000 });
    expect(big.data).toHaveLength(200);
    expect(big.nextCursor).not.toBeNull();
  });

  it('reports no next page when a limit-200 read exactly exhausts the rows', async () => {
    const refs = await seedAccount(admin, randomUUID());
    // seedAccount wrote one row; 199 more make exactly 200.
    await admin.query(
      `INSERT INTO audit_log (account_id, actor, action, created_at)
       SELECT $1, $2, 'bulk', timestamptz '2026-02-01T00:00:00Z' + n * interval '1 second' FROM generate_series(1, 199) AS n`,
      [refs.accountId, refs.userId],
    );
    const res = await listAuditLog({ pool: appUserPool, principal: refs }, { limit: 200 });
    expect(res.data).toHaveLength(200);
    expect(res.nextCursor).toBeNull();
  });

  it("never returns another account's rows", async () => {
    const mineId = await insertAudit(refsA, 'tenant.a', '2026-04-01T00:00:00Z');
    const theirsId = await insertAudit(refsB, 'tenant.b', '2026-04-02T00:00:00Z');
    const a = await listAuditLog({ pool: appUserPool, principal: refsA }, { limit: 200 });
    const b = await listAuditLog({ pool: appUserPool, principal: refsB }, { limit: 200 });
    expect(a.data.map((r) => r.id)).toContain(mineId);
    expect(a.data.map((r) => r.id)).not.toContain(theirsId);
    expect(b.data.map((r) => r.id)).toContain(theirsId);
    expect(b.data.map((r) => r.id)).not.toContain(mineId);
  });
});
