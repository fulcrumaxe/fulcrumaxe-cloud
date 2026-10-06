import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';

/**
 * DP3a-1 (D#7 DP-C3c): the receipt_writer / receipt_writer_invoker role
 * split. The INSERT on decision_receipts belongs to receipt_writer alone,
 * and receipt_writer has no members, so the definer is the only way in.
 */
describe('receipt_writer roles and grants (0663)', () => {
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

  const ATTRS = `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
                   FROM pg_roles WHERE rolname = $1`;

  /** Direct INSERT grantees on the table, minus its owner and superusers. */
  async function directInsertGrantees(): Promise<string[]> {
    const { rows } = await admin.query<{ grantee: string }>(
      `SELECT DISTINCT r.rolname AS grantee
         FROM pg_class c, aclexplode(c.relacl) a
         JOIN pg_roles r ON r.oid = a.grantee
        WHERE c.oid = 'public.decision_receipts'::regclass
          AND a.privilege_type = 'INSERT'
          AND a.grantee <> c.relowner
          AND NOT r.rolsuper
        ORDER BY 1`,
    );
    return rows.map((r) => r.grantee);
  }

  it.each(['receipt_writer', 'receipt_writer_invoker'])('%s is NOLOGIN with every privileged attribute off', async (role) => {
    const { rows } = await admin.query(ATTRS, [role]);
    expect(rows).toEqual([
      {
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    ]);
  });

  it('the direct grantees of INSERT on decision_receipts are exactly {receipt_writer}', async () => {
    expect(await directInsertGrantees()).toEqual(['receipt_writer']);
  });

  it.each(['app_user', 'platform_ops', 'partner_user', 'agent_run_writer', 'receipt_writer_invoker'])(
    '%s has no INSERT on decision_receipts',
    async (role) => {
      const { rows } = await admin.query<{ ok: boolean }>(
        `SELECT has_table_privilege($1, 'public.decision_receipts', 'INSERT') AS ok`,
        [role],
      );
      expect(rows[0]!.ok).toBe(false);
    },
  );

  it('non-vacuity: granting INSERT to another role makes the grantee check go red', async () => {
    const scratch = `fx_scratch_${randomUUID().slice(0, 8)}`;
    await admin.query(`CREATE ROLE ${scratch} NOLOGIN`);
    try {
      await admin.query(`GRANT INSERT ON decision_receipts TO ${scratch}`);
      const grantees = await directInsertGrantees();
      expect(grantees).toContain(scratch);
      expect(grantees).not.toEqual(['receipt_writer']);
    } finally {
      await admin.query(`REVOKE ALL ON decision_receipts FROM ${scratch}`);
      await admin.query(`DROP ROLE ${scratch}`);
    }
    expect(await directInsertGrantees()).toEqual(['receipt_writer']);
  });

  it('receipt_writer has no member', async () => {
    const { rows } = await admin.query(
      `SELECT member::regrole::text AS member FROM pg_auth_members WHERE roleid = 'receipt_writer'::regrole`,
    );
    expect(rows).toEqual([]);
  });

  it('no role is a member of both agent_run_writer and receipt_writer_invoker', async () => {
    const { rows } = await admin.query(
      `SELECT a.member::regrole::text AS member
         FROM pg_auth_members a
         JOIN pg_auth_members b ON b.member = a.member
        WHERE a.roleid = 'agent_run_writer'::regrole AND b.roleid = 'receipt_writer_invoker'::regrole`,
    );
    expect(rows).toEqual([]);
  });

  it('receipt_writer_invoker holds no table privilege at all', async () => {
    const { rows } = await admin.query(
      `SELECT c.relname FROM pg_class c, aclexplode(c.relacl) a
        WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'receipt_writer_invoker'::regrole::oid`,
    );
    expect(rows).toEqual([]);
  });
});
