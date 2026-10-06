import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** D#31 API-7b (C29): audit_log_read() on real Postgres, migration 0653. */
describe('audit_log_read (migration 0653)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function insertAudit(refs: SeedRefs, action: string, createdAt: string, id: string = randomUUID()): Promise<string> {
    await admin.query(
      `INSERT INTO audit_log (id, account_id, actor, action, payload, created_at) VALUES ($1, $2, $3, $4, '{}'::jsonb, $5::timestamptz)`,
      [id, refs.accountId, refs.userId, action, createdAt],
    );
    return id;
  }

  type Row = { id: string; action: string; created_at_cursor: string };
  const read = (refs: SeedRefs, args: [number | null, string | null, string | null] = [50, null, null]) =>
    withTenant(appUserPool, refs.accountId, refs.userId, async (c) => {
      const { rows } = await c.query('SELECT * FROM audit_log_read($1::int, $2::text, $3::uuid)', args);
      return rows as Row[];
    });

  it('returns only the session account rows (A/B isolation)', async () => {
    await insertAudit(refsA, 'iso.a', '2031-01-01T00:00:00Z');
    await insertAudit(refsB, 'iso.b', '2031-01-01T00:00:01Z');
    const a = await read(refsA);
    const b = await read(refsB);
    expect(a.some((r) => r.action === 'iso.a')).toBe(true);
    expect(a.some((r) => r.action === 'iso.b')).toBe(false);
    expect(b.some((r) => r.action === 'iso.b')).toBe(true);
    expect(b.some((r) => r.action === 'iso.a')).toBe(false);
  });

  it('returns zero rows, without error, when app.account_id is unset or empty', async () => {
    const client = await appUserPool.connect();
    try {
      const unset = await client.query('SELECT * FROM audit_log_read(50, NULL, NULL)');
      expect(unset.rows).toEqual([]);
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.account_id', '', true)`);
      const empty = await client.query('SELECT * FROM audit_log_read(50, NULL, NULL)');
      await client.query('ROLLBACK');
      expect(empty.rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('returns zero rows for a suspended (soft-deleted) account', async () => {
    const refs = await seedAccount(admin, randomUUID());
    expect((await read(refs)).length).toBeGreaterThan(0);
    await platformOpsPool.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [refs.accountId]);
    expect(await read(refs)).toEqual([]);
  });

  it('keyset pages over tied created_at with no skip or duplicate', async () => {
    const refs = await seedAccount(admin, randomUUID());
    const tie = '2032-05-05T05:05:05.123456Z';
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];
    for (const id of ids) await insertAudit(refs, 'tie', tie, id);
    const seen: string[] = [];
    let args: [number, string | null, string | null] = [2, null, null];
    for (let i = 0; i < 5; i++) {
      const rows = await read(refs, args);
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.id));
      const last = rows[rows.length - 1]!;
      args = [2, last.created_at_cursor, last.id];
    }
    expect(seen.slice(0, 3)).toEqual([...ids].reverse());
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(4); // three ties plus the seed row
  });

  it('clamps p_limit to 200 and raises values below 1', async () => {
    const refs = await seedAccount(admin, randomUUID());
    await admin.query(
      `INSERT INTO audit_log (account_id, actor, action, payload, created_at)
       SELECT $1, $2, 'bulk', '{}'::jsonb, '2033-01-01'::timestamptz + g * interval '1 second' FROM generate_series(1, 210) g`,
      [refs.accountId, refs.userId],
    );
    expect(await read(refs, [100000, null, null])).toHaveLength(200);
    expect(await read(refs, [0, null, null])).toHaveLength(1);
  });

  it('is INVOKER, STABLE, search_path pinned, executable by app_user only', async () => {
    const { rows } = await admin.query<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
      app: boolean;
      ops: boolean;
      pub: boolean;
    }>(
      `SELECT prosecdef, provolatile, proconfig,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
              has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
              COALESCE((SELECT bool_or(a.grantee = 0) FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                         WHERE a.privilege_type = 'EXECUTE'), false) AS pub
         FROM pg_proc p WHERE p.oid = 'audit_log_read(int,text,uuid)'::regprocedure`,
    );
    const r = rows[0]!;
    expect(r.prosecdef).toBe(false);
    expect(r.provolatile).toBe('s');
    expect(r.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    expect(r.app).toBe(true);
    expect(r.pub).toBe(false);
    expect(r.ops).toBe(false);
  });
});
