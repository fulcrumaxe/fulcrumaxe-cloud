import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#68 OPS-G0: support_grants_created_at_guard has no role exemption. Before
 * 0656 a member of platform_ops (and a superuser migration role, for which
 * pg_has_role is always true) could forward-date created_at and so defeat the
 * 60-minute CHECK, or move created_at later on an existing grant.
 */
describe('support_grants created_at guard applies to every role', () => {
  let adminPool: Pool;
  let platformOpsPool: Pool;
  let refs: SeedRefs;

  const FORWARD_INSERT = `INSERT INTO support_grants (account_id, grantee_kind, granted_by_user_id, created_at, expires_at)
     VALUES ($1, 'platform', $2, now() + interval '10 years', now() + interval '10 years 30 minutes')`;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    const seed = await adminPool.connect();
    try {
      refs = await seedAccount(seed, randomUUID());
    } finally {
      seed.release();
    }
  });

  afterAll(async () => {
    await adminPool.end();
    await platformOpsPool.end();
  });

  async function grantCount(): Promise<number> {
    const { rows } = await adminPool.query(
      'SELECT count(*)::int AS n FROM support_grants WHERE account_id = $1',
      [refs.accountId],
    );
    return rows[0].n;
  }

  async function insertGrant(pool: Pool): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO support_grants (account_id, grantee_kind, granted_by_user_id, expires_at)
       VALUES ($1, 'platform', $2, now() + interval '10 minutes') RETURNING id`,
      [refs.accountId, refs.userId],
    );
    return rows[0].id;
  }

  it('platform_ops: a forward-dated INSERT fails the 60-minute CHECK and writes no row', async () => {
    const before = await grantCount();
    await expect(
      platformOpsPool.query(FORWARD_INSERT, [refs.accountId, refs.userId]),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    expect(await grantCount()).toBe(before);
  });

  it('platform_ops: an explicit back-dated created_at is overwritten with server time', async () => {
    const { rows } = await platformOpsPool.query(
      `INSERT INTO support_grants (account_id, grantee_kind, granted_by_user_id, created_at, expires_at)
       VALUES ($1, 'platform', $2, now() - interval '30 minutes', now() + interval '20 minutes')
       RETURNING id`,
      [refs.accountId, refs.userId],
    );
    const { rows: stored } = await adminPool.query(
      `SELECT extract(epoch from (now() - created_at)) AS age_seconds
       FROM support_grants WHERE id = $1`,
      [rows[0].id],
    );
    expect(Math.abs(Number(stored[0].age_seconds))).toBeLessThan(5);
  });

  it('platform_ops: UPDATE cannot move created_at', async () => {
    const id = await insertGrant(platformOpsPool);
    await expect(
      platformOpsPool.query(
        `UPDATE support_grants SET created_at = now() + interval '10 years' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/support_grants: created_at is immutable/);
  });

  it('migration role: a forward-dated INSERT fails and writes no row', async () => {
    const before = await grantCount();
    await expect(adminPool.query(FORWARD_INSERT, [refs.accountId, refs.userId])).rejects.toMatchObject({
      code: PG_ERROR.CHECK_VIOLATION,
    });
    expect(await grantCount()).toBe(before);
  });

  it('migration role: UPDATE cannot move created_at', async () => {
    const id = await insertGrant(adminPool);
    await expect(
      adminPool.query(
        `UPDATE support_grants SET created_at = now() + interval '10 years' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/support_grants: created_at is immutable/);
  });

  it('the guard function body names no role test', async () => {
    const { rows } = await adminPool.query<{ def: string }>(
      `SELECT pg_get_functiondef('support_grants_created_at_guard'::regproc) AS def`,
    );
    expect(rows[0].def).not.toMatch(/pg_has_role/);
    expect(rows[0].def).not.toMatch(/platform_ops/);
  });
});
