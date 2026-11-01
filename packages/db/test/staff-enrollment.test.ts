import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { findOpsInventoryViolations } from '../src/opsInventory.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#68 OPS-C2 (migration 0802): the two definer functions that enroll a staff passkey. As in the OPS-C1 tests, each case runs as the
 * migration owner and `SET LOCAL ROLE`s into the role under test inside a transaction (the functions' own transaction semantics hold
 * either way: a failing statement inside the function rolls back with it).
 */
describe('staff enrollment functions (OPS-C2)', () => {
  let pool: Pool;
  let admin: PoolClient;
  const staffIds: string[] = [];

  const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

  const run = async <T>(role: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    await admin.query('BEGIN');
    try {
      await admin.query(`SET LOCAL ROLE ${role}`);
      return await fn(admin);
    } finally {
      await admin.query('ROLLBACK');
    }
  };

  /** A staff row and a token for it. `minutes` is relative to now (negative: already expired). */
  const seed = async (opts: { active?: boolean; minutes?: number; used?: boolean } = {}) => {
    const staff = randomUUID();
    const token = randomUUID();
    await admin.query(`INSERT INTO platform_staff (id, email, display_name, active) VALUES ($1, $2, 'Test Person', $3)`, [staff, `${staff}@example.test`, opts.active ?? true]);
    await admin.query(
      `INSERT INTO staff_enrollment_tokens (staff_id, token_hash, expires_at, used_at) VALUES ($1, $2, now() + make_interval(mins => $3), $4)`,
      [staff, hashOf(token), opts.minutes ?? 15, opts.used ? new Date() : null],
    );
    staffIds.push(staff);
    return { staff, token, email: `${staff}@example.test` };
  };

  const lookup = (token: string) => run('ops_console', async (c) => (await c.query(`SELECT * FROM ops_enroll_lookup($1)`, [hashOf(token)])).rows);
  const complete = (token: string, cred: Buffer) =>
    `SELECT ops_enroll_complete('${hashOf(token)}', '\\x${cred.toString('hex')}'::bytea, '\\x70'::bytea, 0) AS staff_id`;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    admin = await pool.connect();
  });
  afterAll(async () => {
    await admin.query(`DELETE FROM platform_staff WHERE id = ANY($1::uuid[])`, [staffIds]);
    admin.release();
    await pool.end();
  });

  it('lookup returns the staff member for a live token, and nothing for an unknown, used, expired or inactive one', async () => {
    const live = await seed();
    expect(await lookup(live.token)).toEqual([{ staff_id: live.staff, email: live.email, display_name: 'Test Person' }]);
    expect(await lookup(randomUUID())).toEqual([]);
    expect(await lookup((await seed({ used: true })).token)).toEqual([]);
    expect(await lookup((await seed({ minutes: -1 })).token)).toEqual([]);
    expect(await lookup((await seed({ active: false })).token)).toEqual([]);
  });

  it('complete spends the token and stores one passkey; a second use of the same token is refused', async () => {
    const { staff, token } = await seed();
    const cred = Buffer.from(`cred-${randomUUID()}`);
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE ops_console');
      expect((await admin.query(complete(token, cred))).rows).toEqual([{ staff_id: staff }]);
      await admin.query('RESET ROLE');
      const row = await admin.query(`SELECT c.sign_count, t.used_at IS NOT NULL AS spent FROM staff_webauthn_credentials c, staff_enrollment_tokens t WHERE c.credential_id = $1 AND t.token_hash = $2`, [cred, hashOf(token)]);
      expect(row.rows).toEqual([{ sign_count: '0', spent: true }]);
    } finally {
      await admin.query('ROLLBACK');
    }
    // Committed use, then a replay: the second call raises and stores nothing.
    await admin.query(complete(token, cred));
    await expect(admin.query('SET ROLE ops_console').then(() => admin.query(complete(token, Buffer.from('other'))))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await admin.query('RESET ROLE');
    const count = await admin.query(`SELECT count(*)::int AS n FROM staff_webauthn_credentials WHERE staff_id = $1`, [staff]);
    expect(count.rows[0].n).toBe(1);
  });

  it('complete refuses an expired token, an inactive staff member and an unknown token, and stores nothing', async () => {
    for (const s of [await seed({ minutes: -1 }), await seed({ active: false })]) {
      await expect(run('ops_console', (c) => c.query(complete(s.token, Buffer.from(`c-${s.staff}`))))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const n = await admin.query(`SELECT count(*)::int AS n FROM staff_webauthn_credentials WHERE staff_id = $1`, [s.staff]);
      expect(n.rows[0].n).toBe(0);
    }
    await expect(run('ops_console', (c) => c.query(complete(randomUUID(), Buffer.from('x'))))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('a duplicate credential id fails as a unique violation and leaves the token unspent', async () => {
    const first = await seed();
    const second = await seed();
    const cred = Buffer.from(`dup-${randomUUID()}`);
    await admin.query(complete(first.token, cred));
    await expect(run('ops_console', (c) => c.query(complete(second.token, cred)))).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    const spent = await admin.query(`SELECT used_at FROM staff_enrollment_tokens WHERE token_hash = $1`, [hashOf(second.token)]);
    expect(spent.rows).toEqual([{ used_at: null }]);
  });

  it('only ops_console may execute them, and ops_console still reads no table', async () => {
    const { token } = await seed();
    for (const role of ['app_user', 'platform_ops', 'partner_user']) {
      await expect(run(role, (c) => c.query(`SELECT * FROM ops_enroll_lookup($1)`, [hashOf(token)]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(run(role, (c) => c.query(complete(token, Buffer.from('z'))))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    }
    for (const sql of ['SELECT * FROM staff_enrollment_tokens', 'SELECT * FROM staff_webauthn_credentials', 'SELECT email FROM platform_staff']) {
      await expect(run('ops_console', (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    }
  });

  it('ops_challenge_consume spends a challenge once, sweeps expired rows, and only ops_console may call it', async () => {
    const consume = async (hash: string, role = 'ops_console') => {
      await admin.query(`SET ROLE ${role}`);
      try {
        return (await admin.query(`SELECT ops_challenge_consume($1, now() + interval '5 minutes') AS ok`, [hash])).rows[0].ok as boolean;
      } finally {
        await admin.query('RESET ROLE');
      }
    };
    const h = hashOf(randomUUID());
    expect(await consume(h)).toBe(true);
    expect(await consume(h)).toBe(false);
    await admin.query(`INSERT INTO staff_used_challenges VALUES ('stale', now() - interval '1 minute')`);
    expect(await consume(hashOf(randomUUID()))).toBe(true);
    expect((await admin.query(`SELECT 1 FROM staff_used_challenges WHERE challenge_hash = 'stale'`)).rowCount).toBe(0);
    await expect(consume(hashOf('x'), 'app_user')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(run('ops_console', (c) => c.query('SELECT * FROM staff_used_challenges'))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  describe('ops_auth_rate_take (R-68-C2-6)', () => {
    const take = async (key: string, bucket: string, max: number, window: string, record?: boolean, role = 'ops_console') => {
      await admin.query(`SET ROLE ${role}`);
      try {
        const args = record === undefined ? [key, bucket, max, window] : [key, bucket, max, window, record];
        const sql = record === undefined ? `SELECT ops_auth_rate_take($1, $2, $3, $4::interval) AS ok` : `SELECT ops_auth_rate_take($1, $2, $3, $4::interval, $5) AS ok`;
        return (await admin.query(sql, args)).rows[0].ok as boolean;
      } finally {
        await admin.query('RESET ROLE');
      }
    };
    const keys: string[] = [];
    const key = () => {
      const k = hashOf(randomUUID());
      keys.push(k);
      return k;
    };
    afterAll(async () => {
      await admin.query(`DELETE FROM staff_auth_rate WHERE key_hash = ANY($1::text[])`, [keys]);
    });

    it('allows max takes inside the window, then refuses without recording; buckets and keys are separate', async () => {
      const k = key();
      for (let i = 0; i < 3; i++) expect(await take(k, 'b', 3, '5 minutes'), `take ${i + 1}`).toBe(true);
      expect(await take(k, 'b', 3, '5 minutes')).toBe(false);
      expect(await take(k, 'b', 3, '5 minutes')).toBe(false);
      expect((await admin.query(`SELECT count(*)::int AS n FROM staff_auth_rate WHERE key_hash = $1`, [k])).rows[0].n).toBe(3);
      expect(await take(k, 'other', 3, '5 minutes')).toBe(true);
      expect(await take(key(), 'b', 3, '5 minutes')).toBe(true);
    });

    it('record = false only asks: it records nothing, and answers false once the bucket is full', async () => {
      const k = key();
      expect(await take(k, 'b', 1, '5 minutes', false)).toBe(true);
      expect(await take(k, 'b', 1, '5 minutes', false)).toBe(true);
      expect((await admin.query(`SELECT count(*)::int AS n FROM staff_auth_rate WHERE key_hash = $1`, [k])).rows[0].n).toBe(0);
      expect(await take(k, 'b', 1, '5 minutes', true)).toBe(true);
      expect(await take(k, 'b', 1, '5 minutes', false)).toBe(false);
    });

    it('counts only rows inside the window, and sweeps rows older than the longest window (8 hours) in the same call', async () => {
      const k = key();
      await take(k, 'b', 2, '5 minutes');
      await take(k, 'b', 2, '5 minutes');
      expect(await take(k, 'b', 2, '5 minutes')).toBe(false);
      await admin.query(`UPDATE staff_auth_rate SET at = now() - interval '6 minutes' WHERE key_hash = $1`, [k]);
      expect(await take(k, 'b', 2, '5 minutes')).toBe(true);
      // A longer window still sees the old rows.
      expect(await take(k, 'b', 2, '15 minutes')).toBe(false);
      await admin.query(`INSERT INTO staff_auth_rate (key_hash, bucket, at) VALUES ('stale-rate-row', 'b', now() - interval '9 hours')`);
      await take(key(), 'b', 1, '1 minute');
      expect((await admin.query(`SELECT 1 FROM staff_auth_rate WHERE key_hash = 'stale-rate-row'`)).rowCount).toBe(0);
    });

    it('refuses a max below 1 and a window that is not positive or is longer than 8 hours', async () => {
      const k = key();
      for (const [max, window] of [[0, '1 minute'], [-1, '1 minute'], [1, '0 seconds'], [1, '-1 minute'], [1, '8 hours 1 second']] as const) {
        await expect(take(k, 'b', max, window), `${max} ${window}`).rejects.toMatchObject({ code: '22023' });
      }
      expect(await take(k, 'b', 1, '8 hours')).toBe(true);
    });

    it('only ops_console may call it, and ops_console reads and writes the table only through it', async () => {
      for (const role of ['app_user', 'platform_ops', 'partner_user']) {
        await expect(take(key(), 'b', 1, '1 minute', true, role)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      for (const sql of ['SELECT * FROM staff_auth_rate', `INSERT INTO staff_auth_rate (key_hash, bucket) VALUES ('x', 'y')`, 'DELETE FROM staff_auth_rate']) {
        await expect(run('ops_console', (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });
  });

  it('the audit writers accept only the session\'s own staff member: a mismatched staff_id or actor, or none at all, is refused', async () => {
    const mine = await seed();
    const other = await seed();
    const acct = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [acct, `cus_test_${acct}`]);
    const asOwner = async (staffId: string | undefined, sql: string, params: unknown[]) => {
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL ROLE ops_owner');
        if (staffId !== undefined) await admin.query(`SELECT set_config('app.staff_id', $1, true)`, [staffId]);
        return await admin.query(sql, params);
      } finally {
        await admin.query('ROLLBACK');
      }
    };
    try {
      const staffRow = `INSERT INTO staff_audit_log (staff_id, action, reason) VALUES ($1, 'ops.test', 'because')`;
      expect((await asOwner(mine.staff, staffRow, [mine.staff])).rowCount).toBe(1);
      await expect(asOwner(mine.staff, staffRow, [other.staff])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asOwner(undefined, staffRow, [mine.staff])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const auditRow = `INSERT INTO audit_log (account_id, actor, action) VALUES ($1, $2, 'ops.test')`;
      expect((await asOwner(mine.staff, auditRow, [acct, `staff:${mine.staff}`])).rowCount).toBe(1);
      await expect(asOwner(mine.staff, auditRow, [acct, `staff:${other.staff}`])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asOwner(mine.staff, auditRow, [acct, 'system:billing'])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asOwner(undefined, auditRow, [acct, `staff:${mine.staff}`])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    } finally {
      await admin.query(`DELETE FROM accounts WHERE id = $1`, [acct]);
    }
  });

  it('ops_console can execute exactly the eight allowed SECURITY DEFINER functions in public, and no other', async () => {
    const { rows } = await admin.query<{ sig: string }>(`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND has_function_privilege('ops_console', p.oid, 'EXECUTE')
       ORDER BY 1`);
    expect(rows.map((r) => r.sig)).toEqual([
      'capacity_settings_write(p_key text, p_value integer)',
      'ops_auth_rate_take(p_key_hash text, p_bucket text, p_max integer, p_window interval, p_record boolean)',
      'ops_challenge_consume(p_hash text, p_expires_at timestamp with time zone)',
      'ops_current_staff()',
      'ops_enroll_complete(p_token_hash text, p_credential_id bytea, p_public_key bytea, p_sign_count bigint)',
      'ops_enroll_lookup(p_token_hash text)',
      'ops_login_bump_sign_count(p_credential_id bytea, p_sign_count bigint)',
      'ops_login_credential(p_credential_id bytea)',
    ]);
  });

  it('keeps the ops inventory clean and the new tables forced', async () => {
    expect(await findOpsInventoryViolations(admin)).toEqual([]);
    const { rows } = await admin.query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('staff_enrollment_tokens', 'staff_webauthn_credentials', 'staff_used_challenges', 'staff_auth_rate') AND relrowsecurity AND relforcerowsecurity`);
    expect(rows).toHaveLength(4);
  });
});
