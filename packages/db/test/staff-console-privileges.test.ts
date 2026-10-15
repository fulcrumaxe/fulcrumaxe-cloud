import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#68 OPS-C1 (migration 0801): the staff tables, the two ops roles and what each may reach. The tests run as the migration owner
 * and `SET LOCAL ROLE` into the role under test inside a transaction that is always rolled back. SET ROLE applies the same
 * privilege and row-security checks a login as that role would face; what it cannot show is a real connection as ops_console
 * (that login has no password until an owner sets one), so the role's LOGIN attribute is checked in the catalog instead.
 */
describe('staff console roles, tables and functions (OPS-C1)', () => {
  let pool: Pool;
  let admin: PoolClient;

  const run = async <T>(role: string | null, fn: (c: PoolClient) => Promise<T>, staffId?: string): Promise<T> => {
    await admin.query('BEGIN');
    try {
      if (role) await admin.query(`SET LOCAL ROLE ${role}`);
      if (staffId !== undefined) await admin.query(`SELECT set_config('app.staff_id', $1, true)`, [staffId]);
      return await fn(admin);
    } finally {
      await admin.query('ROLLBACK');
    }
  };
  const denied = (role: string, sql: string) =>
    expect(run(role, (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    admin = await pool.connect();
  });
  afterAll(async () => {
    admin.release();
    await pool.end();
  });

  it('C1-1: ops_console logs in and is no member of platform_ops or app_user; neither role is privileged', async () => {
    const { rows } = await admin.query(`
      SELECT rolname, rolcanlogin, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
             pg_has_role(rolname, 'platform_ops', 'MEMBER') AS in_platform_ops,
             pg_has_role(rolname, 'app_user', 'MEMBER') AS in_app_user
      FROM pg_roles WHERE rolname IN ('ops_console', 'ops_owner') ORDER BY rolname`);
    expect(rows).toEqual([
      expect.objectContaining({ rolname: 'ops_console', rolcanlogin: true }),
      expect.objectContaining({ rolname: 'ops_owner', rolcanlogin: false }),
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ in_platform_ops: false, in_app_user: false, rolbypassrls: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false });
    }
  });

  it('C1-2: ops_console cannot INSERT, UPDATE or DELETE on the guarded tables', async () => {
    const tables: Record<string, string> = {
      accounts: 'id',
      support_grants: 'id',
      support_access_log: 'id',
      staff_audit_log: 'id',
      audit_log: 'id',
      platform_staff: 'id',
      staff_webauthn_credentials: 'id',
    };
    for (const [t, col] of Object.entries(tables)) {
      await denied('ops_console', `INSERT INTO ${t} DEFAULT VALUES`);
      await denied('ops_console', `UPDATE ${t} SET ${col} = ${col}`);
      await denied('ops_console', `DELETE FROM ${t}`);
    }
  });

  it('C1-3: ops_console cannot SELECT the listed tables, and holds no table, column or sequence privilege anywhere', async () => {
    for (const t of ['accounts', 'agent_runs', 'run_events', 'ledger', 'model_connections', 'audit_log', 'platform_staff', 'staff_enrollment_tokens']) {
      await denied('ops_console', `SELECT * FROM ${t}`);
    }
    // Catalog view: no grant row for the grantee on any base table, column or schema-level routine table.
    const tableGrants = await admin.query(
      `SELECT g.table_name, g.privilege_type FROM information_schema.role_table_grants g
        JOIN information_schema.tables t USING (table_schema, table_name)
       WHERE g.grantee = 'ops_console' AND t.table_type = 'BASE TABLE'`,
    );
    expect(tableGrants.rows).toEqual([]);
    const columnGrants = await admin.query(`SELECT table_name, column_name FROM information_schema.role_column_grants WHERE grantee = 'ops_console'`);
    expect(columnGrants.rows).toEqual([]);
    // Effective privilege (catches a grant to PUBLIC or through a role): every base table, every column, every sequence.
    const tables = await admin.query<{ relname: string; any_col: boolean; table_priv: boolean }>(`
      SELECT c.relname,
             has_any_column_privilege('ops_console', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES') AS any_col,
             has_table_privilege('ops_console', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS table_priv
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')`);
    expect(tables.rows.length).toBeGreaterThan(50);
    expect(tables.rows.filter((r) => r.any_col || r.table_priv)).toEqual([]);
    const seqs = await admin.query<{ relname: string }>(`
      SELECT s.relname FROM (SELECT c.oid, c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S' OFFSET 0) s
       WHERE has_sequence_privilege('ops_console', s.oid, 'USAGE, SELECT, UPDATE')`);
    expect(seqs.rows).toEqual([]);
  });

  it('C1-4: ops_owner cannot read model-key columns, run payloads or run envelopes', async () => {
    await denied('ops_owner', 'SELECT key_ciphertext FROM model_connections');
    await denied('ops_owner', 'SELECT wrapped_dek FROM model_connections');
    await denied('ops_owner', 'SELECT key_fingerprint FROM model_connections');
    await denied('ops_owner', 'SELECT payload FROM run_events');
    await denied('ops_owner', 'SELECT envelope FROM agent_runs');
  });

  it('C1-5: ops_current_staff raises unless app.staff_id names an active staff member', async () => {
    const ids: string[] = [];
    try {
      for (const active_ of [true, false]) {
        const id = randomUUID();
        await admin.query(`INSERT INTO platform_staff (id, email, display_name, active) VALUES ($1, $2, 'T', $3)`, [id, `${id}@example.test`, active_]);
        ids.push(id);
      }
      const [okId, offId] = ids as [string, string];
      const call = (staffId: string | undefined) => run('ops_console', (c) => c.query<{ s: string }>('SELECT ops_current_staff() AS s'), staffId);
      await expect(call(undefined)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(call('')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(call('not-a-uuid')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(call(randomUUID())).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(call(offId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await call(okId)).rows[0]!.s).toBe(okId);
      // app_user holds no EXECUTE on it.
      await expect(run('app_user', (c) => c.query('SELECT ops_current_staff()'), okId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    } finally {
      await admin.query(`DELETE FROM platform_staff WHERE id = ANY($1::uuid[])`, [ids]);
    }
  });

  it('C1-6: audit_write_staff writes one audit_log row with actor staff:<uuid>; ops_console and app_user cannot call it', async () => {
    const staff = randomUUID();
    const acct = randomUUID();
    await admin.query(`INSERT INTO platform_staff (id, email, display_name) VALUES ($1, $2, 'T')`, [staff, `${staff}@example.test`]);
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [acct, `cus_test_${acct}`]);
    try {
      const sql = `SELECT audit_write_staff($1::uuid, $2::uuid, 'ops.test_action', $3::jsonb) AS id`;
      await expect(run('ops_console', (c) => c.query(sql, [acct, staff, '{}']), staff)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(run('app_user', (c) => c.query(sql, [acct, staff, '{}']), staff)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      const rows = await run(
        'ops_owner',
        async (c) => {
          const { rows: r } = await c.query<{ id: string }>(sql, [acct, staff, JSON.stringify({ actor: 'someone-else', note: 'x' })]);
          // ops_owner has no SELECT on audit_log: read the row back as the migration owner inside the same transaction.
          await c.query('RESET ROLE');
          return (await c.query(`SELECT actor, action, account_id, payload FROM audit_log WHERE id = $1`, [r[0]!.id])).rows;
        },
        staff,
      );
      expect(rows).toEqual([{ actor: `staff:${staff}`, action: 'ops.test_action', account_id: acct, payload: { actor: `staff:${staff}`, note: 'x' } }]);

      // Another person's id, a missing account, a bad action name and a non-object payload are all refused.
      const other = randomUUID();
      await expect(run('ops_owner', (c) => c.query(sql, [acct, other, '{}']), staff)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(run('ops_owner', (c) => c.query(sql, [null, staff, '{}']), staff)).rejects.toMatchObject({ code: '22023' });
      await expect(run('ops_owner', (c) => c.query(`SELECT audit_write_staff($1::uuid, $2::uuid, 'Bad Action', NULL)`, [acct, staff]), staff)).rejects.toMatchObject({ code: '22023' });
      await expect(run('ops_owner', (c) => c.query(`SELECT audit_write_staff($1::uuid, $2::uuid, 'ops.x', '[]'::jsonb)`, [acct, staff]), staff)).rejects.toMatchObject({ code: '22023' });
    } finally {
      await admin.query(`DELETE FROM audit_log WHERE account_id = $1`, [acct]);
      await admin.query(`DELETE FROM accounts WHERE id = $1`, [acct]);
      await admin.query(`DELETE FROM platform_staff WHERE id = $1`, [staff]);
    }
  });

  it('C1-6: ops_owner can write only staff-stamped audit_log rows', async () => {
    const acct = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [acct, `cus_test_${acct}`]);
    try {
      await expect(
        run('ops_owner', (c) => c.query(`INSERT INTO audit_log (account_id, actor, action) VALUES ($1, 'system:billing', 'x')`, [acct])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    } finally {
      await admin.query(`DELETE FROM accounts WHERE id = $1`, [acct]);
    }
  });

  it('C1-7: staff_audit_log is append-only for every role, and its reason is required', async () => {
    const staff = randomUUID();
    await admin.query(`INSERT INTO platform_staff (id, email, display_name) VALUES ($1, $2, 'T')`, [staff, `${staff}@example.test`]);
    try {
      const { rows: roles } = await admin.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE NOT rolsuper`);
      const holders = await admin.query<{ r: string }>(
        `SELECT r.rolname AS r FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%' AND (has_table_privilege(r.oid, 'staff_audit_log', 'UPDATE')
           OR has_table_privilege(r.oid, 'staff_audit_log', 'DELETE') OR has_table_privilege(r.oid, 'staff_audit_log', 'TRUNCATE')
           OR has_any_column_privilege(r.oid, 'staff_audit_log', 'UPDATE'))`,
      );
      expect(roles.length).toBeGreaterThan(3);
      expect(holders.rows).toEqual([]);
      await denied('ops_owner', `UPDATE staff_audit_log SET reason = 'x'`);
      await denied('ops_owner', `DELETE FROM staff_audit_log`);

      // The insert works as ops_owner, and the table refuses an empty reason.
      const insert = `INSERT INTO staff_audit_log (staff_id, action, reason) VALUES ($1, 'ops.test', $2)`;
      await run('ops_owner', async (c) => expect((await c.query(insert, [staff, 'because'])).rowCount).toBe(1));
      await expect(run('ops_owner', (c) => c.query(insert, [staff, '  ']))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(run('ops_owner', (c) => c.query(`INSERT INTO staff_audit_log (staff_id, action) VALUES ($1, 'ops.test')`, [staff]))).rejects.toMatchObject({ code: '23502' });
    } finally {
      await admin.query(`DELETE FROM platform_staff WHERE id = $1`, [staff]);
    }
  });

  it('login functions: read a passkey for an active staff member only, and the counter only goes up', async () => {
    const [on, off] = [randomUUID(), randomUUID()];
    const credOn = Buffer.from('credential-on');
    const credOff = Buffer.from('credential-off');
    await admin.query(`INSERT INTO platform_staff (id, email, display_name, active) VALUES ($1, $2, 'On', true), ($3, $4, 'Off', false)`, [on, `${on}@example.test`, off, `${off}@example.test`]);
    await admin.query(
      `INSERT INTO staff_webauthn_credentials (staff_id, credential_id, public_key, sign_count) VALUES ($1, $2, $3, 5), ($4, $5, $3, 5)`,
      [on, credOn, Buffer.from('pk'), off, credOff],
    );
    try {
      const read = (cred: Buffer) => run('ops_console', async (c) => (await c.query(`SELECT * FROM ops_login_credential($1)`, [cred])).rows);
      expect(await read(credOn)).toEqual([{ staff_id: on, public_key: Buffer.from('pk'), sign_count: '5' }]);
      expect(await read(credOff)).toEqual([]);
      expect(await read(Buffer.from('unknown'))).toEqual([]);

      const bump = (cred: Buffer, n: number) =>
        run('ops_console', async (c) => {
          const { rows } = await c.query<{ ok: boolean }>(`SELECT ops_login_bump_sign_count($1, $2) AS ok`, [cred, n]);
          await c.query('RESET ROLE');
          const after = await c.query<{ sign_count: string }>(`SELECT sign_count FROM staff_webauthn_credentials WHERE credential_id = $1`, [cred]);
          return [rows[0]!.ok, after.rows[0]!.sign_count] as const;
        });
      expect(await bump(credOn, 6)).toEqual([true, '6']);
      expect(await bump(credOn, 5)).toEqual([false, '5']); // not higher than the stored 5: unchanged
      expect(await bump(credOn, 4)).toEqual([false, '5']);
      expect(await bump(credOff, 9)).toEqual([false, '5']); // inactive staff member
      // app_user may call neither.
      await expect(run('app_user', (c) => c.query(`SELECT * FROM ops_login_credential($1)`, [credOn]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(run('app_user', (c) => c.query(`SELECT ops_login_bump_sign_count($1, 9)`, [credOn]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    } finally {
      await admin.query(`DELETE FROM platform_staff WHERE id = ANY($1::uuid[])`, [[on, off]]);
    }
  });

  it('C1-9: every new table has row security forced, and no runtime login holds anything on it', async () => {
    const names = ['platform_staff', 'staff_webauthn_credentials', 'staff_enrollment_tokens', 'staff_audit_log'];
    const { rows } = await admin.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY relname`, [names]);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    for (const role of ['app_user', 'platform_ops', 'partner_user', 'ops_console']) {
      for (const t of names) {
        const { rows: p } = await admin.query(`SELECT has_any_column_privilege($1, $2, 'SELECT, INSERT, UPDATE, REFERENCES') OR has_table_privilege($1, $2, 'DELETE, TRUNCATE, TRIGGER') AS held`, [role, t]);
        expect(p[0]!.held, `${role} on ${t}`).toBe(false);
      }
    }
  });
});
