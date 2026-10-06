import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { findRlsViolations } from '../src/rlsInventory.js';

/**
 * DP11a-1 (D#7 DP-C5 criterion 2): decision_asks is written only through the
 * definer. app_user reads it under the tenant policy and holds no write
 * privilege; the one direct INSERT grantee is receipt_writer, which has no
 * members.
 */
describe('decision_asks grants (0666)', () => {
  let adminPool: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  /** Direct grantees of a privilege on the table, minus its owner and superusers. */
  async function grantees(privilege: string): Promise<string[]> {
    const { rows } = await admin.query<{ grantee: string }>(
      `SELECT DISTINCT r.rolname AS grantee
         FROM pg_class c, aclexplode(c.relacl) a
         JOIN pg_roles r ON r.oid = a.grantee
        WHERE c.oid = 'public.decision_asks'::regclass
          AND a.privilege_type = $1
          AND a.grantee <> c.relowner
          AND NOT r.rolsuper
        ORDER BY 1`,
      [privilege],
    );
    return rows.map((r) => r.grantee);
  }

  it('the direct grantees of INSERT are exactly {receipt_writer}', async () => {
    expect(await grantees('INSERT')).toEqual(['receipt_writer']);
  });

  it.each(['UPDATE', 'DELETE'])('nobody but the owner holds %s', async (privilege) => {
    expect(await grantees(privilege)).toEqual([]);
  });

  it.each(['app_user', 'platform_ops', 'partner_user', 'agent_run_writer', 'receipt_writer_invoker'])(
    '%s has no INSERT, UPDATE or DELETE on decision_asks',
    async (role) => {
      const { rows } = await admin.query<{ p: string; ok: boolean }>(
        `SELECT p, has_table_privilege($1, 'public.decision_asks', p) AS ok FROM unnest(ARRAY['INSERT','UPDATE','DELETE']) p`,
        [role],
      );
      expect(rows.filter((r) => r.ok)).toEqual([]);
    },
  );

  it('the definer is owned by receipt_writer and executable by receipt_writer_invoker only', async () => {
    const { rows } = await admin.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
              (SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS grantees
         FROM pg_proc p WHERE p.proname = 'decision_ask_raise'`,
    );
    expect(rows).toEqual([
      {
        owner: 'receipt_writer',
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, public, pg_temp'],
        grantees: ['receipt_writer_invoker'],
      },
    ]);
  });

  it('takes no parameter named like actor, user or account', async () => {
    const { rows } = await admin.query<{ name: string }>(
      `SELECT unnest(proargnames) AS name FROM pg_proc WHERE proname = 'decision_ask_raise'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.name).not.toMatch(/actor|user|account/i);
  });

  it('findRlsViolations returns []', async () => {
    expect(await findRlsViolations(admin)).toEqual([]);
  });

  it('non-vacuity: granting INSERT to app_user makes the grantee check go red', async () => {
    const scratch = `fx_scratch_${randomUUID().slice(0, 8)}`;
    await admin.query(`CREATE ROLE ${scratch} NOLOGIN`);
    try {
      await admin.query(`GRANT INSERT ON decision_asks TO ${scratch}`);
      await admin.query(`GRANT INSERT ON decision_asks TO app_user`);
      const mutated = await grantees('INSERT');
      expect(mutated).toContain('app_user');
      expect(mutated).toContain(scratch);
      expect(mutated).not.toEqual(['receipt_writer']);
    } finally {
      await admin.query(`REVOKE ALL ON decision_asks FROM ${scratch}`);
      await admin.query(`REVOKE INSERT ON decision_asks FROM app_user`);
      await admin.query(`DROP ROLE ${scratch}`);
    }
    expect(await grantees('INSERT')).toEqual(['receipt_writer']);
  });
});
