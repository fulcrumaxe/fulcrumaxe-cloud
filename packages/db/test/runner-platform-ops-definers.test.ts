import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount } from './helpers/seed.js';
import { fakeKey, insertRunner, sha256Hex } from './helpers/runnerFixtures.js';

/** 0724: the six statements runner identity used to run as platform_ops are now definers, and platform_ops can no longer write the tables directly. */
const nonce = (): string => randomBytes(24).toString('base64url');

interface Acct {
  accountId: string;
  owner: string;
  admin: string;
  member: string;
  repoId: string;
}

describe('runner platform_ops definers (0724)', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  async function account(): Promise<Acct> {
    const refs = await seedAccount(admin, randomUUID());
    const people: Record<string, string> = {};
    // seedAccount already made refs.userId a member; check its role rather than assume it.
    const seeded = (await admin.query<{ role: string }>('SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2', [refs.accountId, refs.userId])).rows[0]?.role;
    if (seeded !== 'owner') await admin.query(`UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2`, [refs.accountId, refs.userId]);
    people.owner = refs.userId;
    for (const role of ['admin', 'member'] as const) {
      const id = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
      await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [refs.accountId, id, role]);
      people[role] = id;
    }
    return { accountId: refs.accountId, owner: people.owner!, admin: people.admin!, member: people.member!, repoId: refs.repoId };
  }
  const code = async (a: Acct): Promise<string> => {
    const sha = sha256Hex();
    await admin.query(`INSERT INTO runner_registration_codes (account_id, registered_by, code_sha256, expires_at, credential_mode) VALUES ($1, $2, $3, now() + interval '10 minutes', 'api_key')`, [a.accountId, a.admin, sha]);
    return sha;
  };
  const fail = async (act: () => Promise<unknown>): Promise<{ code?: string; message?: string }> => {
    try {
      await act();
    } catch (error) {
      return error as { code?: string; message?: string };
    }
    throw new Error('the call was accepted');
  };
  /** Runs `sql` on a fresh platform_ops connection (a direct login, as the web tier's identity code has). */
  const asOps = (sql: string, params: unknown[] = []) => opsPool.query(sql, params);
  const noContext = (sql: string, params: unknown[] = []) => appPool.query(sql, params);
  /** A tenant session for the account, with the acting user when there is one. */
  const inSession = <T>(accountId: string, user: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> => (user ? withTenant(appPool, accountId, user, fn) : withTenant(appPool, accountId, fn));

  describe('a direct platform_ops session', () => {
    it('can no longer insert, update or delete a row of any of the three tables, and a refusal changes nothing', async () => {
      const a = await account();
      const runner = await insertRunner(admin, a.accountId, a.admin);
      const sha = await code(a);
      await admin.query(`INSERT INTO runner_request_nonces (account_id, runner_id, nonce) VALUES ($1, $2, $3)`, [a.accountId, runner, nonce()]);
      const key = fakeKey();
      const attempts: Array<[string, string, unknown[]]> = [
        ['runners insert', `INSERT INTO runners (account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3::jsonb, $4, 'api_key')`, [a.accountId, a.admin, JSON.stringify(key.jwk), key.jkt]],
        ['runners update', `UPDATE runners SET protocol_version = 2 WHERE id = $1`, [runner]],
        ['runners revoke', `UPDATE runners SET revoked_at = now() WHERE id = $1`, [runner]],
        ['runners delete', `DELETE FROM runners WHERE id = $1`, [runner]],
        ['codes insert', `INSERT INTO runner_registration_codes (account_id, registered_by, code_sha256, expires_at, credential_mode) VALUES ($1, $2, $3, now() + interval '1 minute', 'api_key')`, [a.accountId, a.admin, sha256Hex()]],
        ['codes update', `UPDATE runner_registration_codes SET used_at = now() WHERE code_sha256 = $1`, [sha]],
        ['codes delete', `DELETE FROM runner_registration_codes WHERE code_sha256 = $1`, [sha]],
        ['nonce insert', `INSERT INTO runner_request_nonces (account_id, runner_id, nonce) VALUES ($1, $2, $3)`, [a.accountId, runner, nonce()]],
        ['nonce prune', `DELETE FROM runner_request_nonces WHERE runner_id = $1`, [runner]],
      ];
      const before = JSON.stringify([
        (await admin.query('SELECT * FROM runners WHERE account_id = $1', [a.accountId])).rows,
        (await admin.query('SELECT * FROM runner_registration_codes WHERE account_id = $1', [a.accountId])).rows,
        (await admin.query('SELECT * FROM runner_request_nonces WHERE account_id = $1', [a.accountId])).rows,
      ]);
      for (const [label, sql, params] of attempts) {
        const error = await fail(() => asOps(sql, params));
        expect(error.code, `${label}: ${error.message}`).toBe('42501');
      }
      const after = JSON.stringify([
        (await admin.query('SELECT * FROM runners WHERE account_id = $1', [a.accountId])).rows,
        (await admin.query('SELECT * FROM runner_registration_codes WHERE account_id = $1', [a.accountId])).rows,
        (await admin.query('SELECT * FROM runner_request_nonces WHERE account_id = $1', [a.accountId])).rows,
      ]);
      expect(after).toBe(before);
    });

    it('is refused by every new function, which would otherwise be a way around the guard', async () => {
      const a = await account();
      const calls: Array<[string, unknown[]]> = [
        ['SELECT * FROM runner_lookup_by_jkt($1)', [fakeKey().jkt]],
        ['SELECT runner_jkt_registered($1)', [fakeKey().jkt]],
        ['SELECT runner_code_account($1)', [sha256Hex()]],
        ['SELECT runner_nonce_record($1, $2, 180)', [randomUUID(), nonce()]],
        ['SELECT runner_registration_code_create($1, $2, $3::uuid[], 10)', [sha256Hex(), 'api_key', []]],
        ["SELECT runner_hello_record(1, '1.0.0', 'container')", []],
      ];
      for (const [sql, params] of calls) {
        const error = await fail(() => asOps(sql, params));
        expect(error.code, `${sql}: ${error.message}`).toBe('42501');
      }
      // Even with a tenant context set, a platform_ops login is refused.
      const client = await opsPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [a.accountId, a.admin]);
        const error = await fail(() => client.query('SELECT runner_registration_code_create($1, $2, $3::uuid[], 10)', [sha256Hex(), 'api_key', []]));
        expect(error.code).toBe('42501');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it('still triggers the demotion revoke and the account cascade, which run inside other triggers', async () => {
      const a = await account();
      const runner = await insertRunner(admin, a.accountId, a.admin);
      // The member change is issued from the platform_ops login; 0712's trigger revokes the runner from inside it.
      await asOps(`DELETE FROM account_members WHERE account_id = $1 AND user_id = $2`, [a.accountId, a.admin]);
      expect((await admin.query('SELECT revoked_at, revoked_reason FROM runners WHERE id = $1', [runner])).rows[0]).toMatchObject({ revoked_reason: 'member_demoted' });
      const b = await account();
      const runnerB = await insertRunner(admin, b.accountId, b.admin);
      await admin.query(`INSERT INTO runner_request_nonces (account_id, runner_id, nonce) VALUES ($1, $2, $3)`, [b.accountId, runnerB, nonce()]);
      await admin.query(`DELETE FROM runners WHERE id = $1`, [runnerB]);
      expect((await admin.query('SELECT 1 FROM runner_request_nonces WHERE runner_id = $1', [runnerB])).rowCount).toBe(0);
    });
  });

  describe('the guard cannot be switched off by the login it restricts (CWE-284)', () => {
    /** Runs `sql` as a direct platform_ops login inside a transaction that is always rolled back, so a statement that wrongly succeeds cannot leave damage for the next test. */
    async function asOpsRolledBack(sql: string): Promise<string | undefined> {
      const client = await opsPool.connect();
      try {
        await client.query('BEGIN');
        try {
          await client.query(sql);
          return undefined;
        } catch (error) {
          return (error as { code?: string }).code ?? 'no code';
        }
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
    const GUARD = 'runner_tables_platform_ops_guard';
    const TABLES = ['runners', 'runner_registration_codes', 'runner_request_nonces'];

    it('is owned by neither platform_ops nor a role platform_ops belongs to, and so are the functions behind every guard trigger on the runner tables', async () => {
      const { rows } = await admin.query<{ tbl: string; trg: string; fn: string; owner: string; ops_is_member: boolean }>(
        `SELECT c.relname AS tbl, t.tgname AS trg, p.proname AS fn, p.proowner::regrole::text AS owner,
                pg_has_role('platform_ops', p.proowner, 'MEMBER') AS ops_is_member
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE NOT t.tgisinternal AND c.relname = ANY($1)`,
        [TABLES],
      );
      expect(rows.map((r) => r.tbl).sort()).toEqual([...TABLES].sort()); // one guard trigger on each table
      for (const row of rows) {
        expect(row.ops_is_member, `${row.fn} on ${row.tbl}`).toBe(false);
        expect(row.owner, `${row.fn} on ${row.tbl}`).not.toBe('platform_ops');
      }
    });

    it('cannot be dropped, altered, replaced or disabled by a platform_ops login, and the triggers survive', async () => {
      const attempts = [
        `DROP FUNCTION ${GUARD}() CASCADE`,
        `DROP FUNCTION ${GUARD}()`,
        `ALTER FUNCTION ${GUARD}() RENAME TO guard_gone`,
        `ALTER FUNCTION ${GUARD}() OWNER TO platform_ops`,
        `ALTER FUNCTION ${GUARD}() SET search_path = public`,
        `CREATE OR REPLACE FUNCTION ${GUARD}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
        'DROP TRIGGER runners_platform_ops_guard ON runners',
        'ALTER TABLE runners DISABLE TRIGGER runners_platform_ops_guard',
        ...TABLES.map((t) => `ALTER TABLE ${t} DISABLE TRIGGER ALL`),
        ...TABLES.map((t) => `ALTER TABLE ${t} DISABLE TRIGGER USER`),
        `SET session_replication_role = replica`,
      ];
      for (const sql of attempts) expect(await asOpsRolledBack(sql), sql).toBe('42501');
      const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname LIKE '%\\_platform\\_ops\\_guard' AND c.relname = ANY($1) AND t.tgenabled = 'O'`, [TABLES]);
      expect(rows[0]!.n).toBe(3);
    });

    it('holds no TRUNCATE on the runner tables, which the row triggers would not see, and a TRUNCATE is refused', async () => {
      const { rows } = await admin.query<{ relname: string; can: boolean }>(
        `SELECT c.relname, has_table_privilege('platform_ops', c.oid, 'TRUNCATE') AS can FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1)`,
        [TABLES],
      );
      expect(rows).toHaveLength(3);
      expect(rows.filter((r) => r.can)).toEqual([]);
      for (const t of TABLES) expect(await asOpsRolledBack(`TRUNCATE ${t} CASCADE`), t).toBe('42501');
    });

    it('still refuses the direct write afterwards, and a revoked runner stays revoked', async () => {
      const a = await account();
      const runner = await insertRunner(admin, a.accountId, a.admin);
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [runner]);
      for (const sql of [`DROP FUNCTION ${GUARD}() CASCADE`, 'ALTER TABLE runners DISABLE TRIGGER ALL']) await asOpsRolledBack(sql);
      expect((await fail(() => asOps('UPDATE runners SET revoked_at = NULL WHERE id = $1', [runner]))).code).toBe('42501');
      expect((await admin.query('SELECT revoked_at FROM runners WHERE id = $1', [runner])).rows[0]!.revoked_at).not.toBeNull();
    });
  });

  describe('the grants', () => {
    it('give EXECUTE to app_user and the owner, and to nobody else', async () => {
      const { rows } = await admin.query<{ proname: string; grantees: string[]; owner: string; secdef: boolean; config: string[] | null }>(
        `SELECT p.proname,
                COALESCE((SELECT array_agg(s.g ORDER BY s.g)
                            FROM (SELECT DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END AS g
                                    FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x WHERE x.privilege_type = 'EXECUTE') s), '{}') AS grantees,
                p.proowner::regrole::text AS owner, p.prosecdef AS secdef, p.proconfig AS config
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('runner_lookup_by_jkt','runner_jkt_registered','runner_code_account','runner_nonce_record','runner_registration_code_create','runner_hello_record')`,
      );
      expect(rows.map((r) => r.proname).sort()).toEqual(['runner_code_account', 'runner_hello_record', 'runner_jkt_registered', 'runner_lookup_by_jkt', 'runner_nonce_record', 'runner_registration_code_create']);
      for (const row of rows) {
        expect(row.owner, row.proname).toBe('platform_ops');
        expect(row.secdef, row.proname).toBe(true);
        expect(row.grantees, row.proname).toEqual(['app_user', 'platform_ops']);
        expect(row.config, row.proname).toContain('search_path=pg_catalog, public, pg_temp');
      }
    });
  });

  describe('runner_lookup_by_jkt, runner_jkt_registered, runner_code_account', () => {
    it('finds an active runner by its exact key, not a revoked one, and says whether any runner holds the key', async () => {
      const a = await account();
      const key = fakeKey();
      const id = await insertRunner(admin, a.accountId, a.admin, { jwk: key.jwk, jkt: key.jkt });
      const found = (await noContext('SELECT * FROM runner_lookup_by_jkt($1)', [key.jkt])).rows;
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ id, account_id: a.accountId, registered_by: a.admin, credential_mode: 'subscription', jkt: key.jkt, public_key_jwk: key.jwk, key_rotated_at: null });
      expect(Object.keys(found[0]!).sort()).toEqual(['account_id', 'created_at', 'credential_mode', 'id', 'jkt', 'key_rotated_at', 'public_key_jwk', 'registered_by']);
      expect((await noContext('SELECT runner_jkt_registered($1) AS t', [key.jkt])).rows[0]!.t).toBe(true);
      await admin.query(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [id]);
      expect((await noContext('SELECT * FROM runner_lookup_by_jkt($1)', [key.jkt])).rowCount).toBe(0);
      expect((await noContext('SELECT runner_jkt_registered($1) AS t', [key.jkt])).rows[0]!.t).toBe(true);
      expect((await noContext('SELECT runner_jkt_registered($1) AS t', [fakeKey().jkt])).rows[0]!.t).toBe(false);
      expect((await noContext('SELECT * FROM runner_lookup_by_jkt($1)', [fakeKey().jkt])).rowCount).toBe(0);
    });

    it('takes one exact, well-formed key or hash: anything else is refused, so nothing can be enumerated', async () => {
      for (const jkt of ['', 'x', '%', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`]) {
        expect((await fail(() => noContext('SELECT * FROM runner_lookup_by_jkt($1)', [jkt]))).code, jkt).toBe('22023');
        expect((await fail(() => noContext('SELECT runner_jkt_registered($1)', [jkt]))).code, jkt).toBe('22023');
      }
      expect((await fail(() => noContext('SELECT * FROM runner_lookup_by_jkt(NULL)'))).code).toBe('22023');
      for (const hash of ['', 'x', sha256Hex().toUpperCase(), sha256Hex().slice(1), '%']) expect((await fail(() => noContext('SELECT runner_code_account($1)', [hash]))).code, hash).toBe('22023');
    });

    it("returns a code's account, or null for an unknown code", async () => {
      const a = await account();
      const sha = await code(a);
      expect((await noContext('SELECT runner_code_account($1) AS a', [sha])).rows[0]!.a).toBe(a.accountId);
      expect((await noContext('SELECT runner_code_account($1) AS a', [sha256Hex()])).rows[0]!.a).toBeNull();
    });
  });

  describe('runner_nonce_record', () => {
    const record = (runner: string, n: string, secs = 180) => appPool.query<{ fresh: boolean }>('SELECT runner_nonce_record($1, $2, $3) AS fresh', [runner, n, secs]);

    it("records a nonce once under the runner's own account, and a repeat is not fresh", async () => {
      const a = await account();
      const id = await insertRunner(admin, a.accountId, a.admin);
      const n = nonce();
      expect((await record(id, n)).rows[0]!.fresh).toBe(true);
      expect((await record(id, n)).rows[0]!.fresh).toBe(false);
      expect((await admin.query('SELECT account_id FROM runner_request_nonces WHERE runner_id = $1 AND nonce = $2', [id, n])).rows).toEqual([{ account_id: a.accountId }]);
    });

    it('prunes only rows older than the retention it was given, and never keeps less than 180 seconds', async () => {
      const a = await account();
      const id = await insertRunner(admin, a.accountId, a.admin);
      const [oldNonce, youngNonce, edgeNonce] = [nonce(), nonce(), nonce()];
      for (const [n, age] of [[oldNonce, 181], [youngNonce, 60], [edgeNonce, 179]] as const) {
        await admin.query(`INSERT INTO runner_request_nonces (account_id, runner_id, nonce, seen_at) VALUES ($1, $2, $3, now() - make_interval(secs => $4))`, [a.accountId, id, n, age]);
      }
      expect((await record(id, nonce())).rows[0]!.fresh).toBe(true);
      const left = (await admin.query<{ nonce: string }>('SELECT nonce FROM runner_request_nonces WHERE runner_id = $1', [id])).rows.map((r) => r.nonce);
      expect(left).toContain(youngNonce);
      expect(left).toContain(edgeNonce);
      expect(left).not.toContain(oldNonce);
      // 120 s (the old retention), 179 s and a negative or null value are all refused before anything is pruned.
      for (const secs of [0, 120, 179, -1, 3601]) expect((await fail(() => record(id, nonce(), secs))).code, String(secs)).toBe('22023');
      expect((await fail(() => appPool.query('SELECT runner_nonce_record($1, $2, NULL)', [id, nonce()]))).code).toBe('22023');
      expect((await admin.query('SELECT 1 FROM runner_request_nonces WHERE runner_id = $1 AND nonce = $2', [id, edgeNonce])).rowCount).toBe(1);
    });

    it('refuses a revoked or unknown runner and a malformed nonce, and records nothing', async () => {
      const a = await account();
      const id = await insertRunner(admin, a.accountId, a.admin);
      await admin.query(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [id]);
      expect((await fail(() => record(id, nonce()))).code).toBe('P0002');
      expect((await fail(() => record(randomUUID(), nonce()))).code).toBe('P0002');
      const live = await insertRunner(admin, a.accountId, a.admin);
      for (const bad of ['', 'short', 'a'.repeat(65), 'has space and more chars', 'a'.repeat(15) + '!']) expect((await fail(() => record(live, bad))).code, bad).toBe('22023');
      expect((await admin.query('SELECT 1 FROM runner_request_nonces WHERE account_id = $1', [a.accountId])).rowCount).toBe(0);
    });
  });

  describe('runner_registration_code_create', () => {
    const create = (a: Acct, userId: string | null, over: { sha?: string; mode?: string; repos?: string[] | null; ttl?: number } = {}) =>
      inSession(a.accountId, userId, async (c) =>
        (await c.query<{ at: Date }>('SELECT runner_registration_code_create($1, $2, $3::uuid[], $4) AS at', [over.sha ?? sha256Hex(), over.mode ?? 'api_key', over.repos === null ? null : over.repos ?? [], over.ttl ?? 10])).rows[0]!.at,
      );

    it('lets an owner or admin write a code for the session account, registered by the session user, with only the hash stored', async () => {
      const a = await account();
      for (const user of [a.owner, a.admin]) {
        const sha = sha256Hex();
        const at = await create(a, user, { sha, mode: 'subscription', repos: [a.repoId, a.repoId], ttl: 10 });
        expect(Math.abs(at.getTime() - Date.now() - 600_000)).toBeLessThan(20_000);
        expect((await admin.query('SELECT * FROM runner_registration_codes WHERE code_sha256 = $1', [sha])).rows[0]).toMatchObject({ account_id: a.accountId, registered_by: user, credential_mode: 'subscription', allowed_repo_ids: [a.repoId], used_at: null });
      }
    });

    it("refuses a member, no user and another account's owner, each with no row written", async () => {
      const a = await account();
      const b = await account();
      const count = async (): Promise<number> => (await admin.query('SELECT count(*)::int AS n FROM runner_registration_codes WHERE account_id = ANY($1)', [[a.accountId, b.accountId]])).rows[0]!.n;
      const before = await count();
      expect((await fail(() => create(a, a.member))).code).toBe('42501');
      expect((await fail(() => create(a, null))).code).toBe('42501');
      expect((await fail(() => create(a, b.owner))).code).toBe('42501');
      expect(await count()).toBe(before);
    });

    it("refuses a repo of another account, and a malformed argument, with no row written", async () => {
      const a = await account();
      const b = await account();
      const before = (await admin.query('SELECT count(*)::int AS n FROM runner_registration_codes')).rows[0]!.n;
      expect((await fail(() => create(a, a.admin, { repos: [b.repoId] }))).code).toBe('P0002');
      expect((await fail(() => create(a, a.admin, { repos: [randomUUID()] }))).code).toBe('P0002');
      for (const over of [{ sha: 'x' }, { sha: sha256Hex().toUpperCase() }, { mode: 'token' }, { ttl: 0 }, { ttl: 61 }, { repos: null }, { repos: Array.from({ length: 101 }, () => randomUUID()) }]) {
        expect((await fail(() => create(a, a.admin, over))).code, JSON.stringify(over)).toBe('22023');
      }
      expect((await fail(() => withTenant(appPool, a.accountId, a.admin, (c) => c.query('SELECT runner_registration_code_create($1, $2, ARRAY[NULL]::uuid[], 10)', [sha256Hex(), 'api_key'])))).code).toBe('22023');
      expect((await admin.query('SELECT count(*)::int AS n FROM runner_registration_codes')).rows[0]!.n).toBe(before);
    });
  });

  describe('runner_hello_record', () => {
    const hello = (accountId: string, runnerId: string | null, args: [number, string, string] = [3, '1.2.3', 'microvm']) =>
      withTenant(appPool, accountId, async (c) => {
        if (runnerId) await c.query(`SELECT set_config('app.runner_id', $1, true)`, [runnerId]);
        return (await c.query<{ ok: boolean }>('SELECT runner_hello_record($1, $2, $3) AS ok', args)).rows[0]!.ok;
      });

    it('records the versions of the runner the session names, and touches nothing else', async () => {
      const a = await account();
      const other = await insertRunner(admin, a.accountId, a.admin);
      const id = await insertRunner(admin, a.accountId, a.admin);
      const otherBefore = JSON.stringify((await admin.query('SELECT * FROM runners WHERE id = $1', [other])).rows[0]);
      expect(await hello(a.accountId, id)).toBe(true);
      expect((await admin.query('SELECT protocol_version, binary_version, isolation, last_seen_at FROM runners WHERE id = $1', [id])).rows[0]).toMatchObject({ protocol_version: 3, binary_version: '1.2.3', isolation: 'microvm' });
      expect(JSON.stringify((await admin.query('SELECT * FROM runners WHERE id = $1', [other])).rows[0])).toBe(otherBefore);
    });

    it("is refused with no runner in the session, and writes nothing for a revoked runner or another account's runner", async () => {
      const a = await account();
      const b = await account();
      const id = await insertRunner(admin, a.accountId, a.admin);
      const foreign = await insertRunner(admin, b.accountId, b.admin);
      expect((await fail(() => hello(a.accountId, null))).code).toBe('42501');
      expect((await fail(() => withTenant(appPool, a.accountId, async (c) => { await c.query(`SELECT set_config('app.runner_id', 'nope', true)`); return c.query(`SELECT runner_hello_record(1, '1', 'container')`); }))).code).toBe('42501');
      expect(await hello(a.accountId, foreign)).toBe(false);
      expect((await admin.query('SELECT protocol_version FROM runners WHERE id = $1', [foreign])).rows[0]!.protocol_version).toBeNull();
      await admin.query(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [id]);
      expect(await hello(a.accountId, id)).toBe(false);
      expect((await admin.query('SELECT protocol_version FROM runners WHERE id = $1', [id])).rows[0]!.protocol_version).toBeNull();
    });

    it('refuses a malformed argument, an isolation tier of none, and a value outside int4', async () => {
      const a = await account();
      const id = await insertRunner(admin, a.accountId, a.admin);
      for (const args of [[0, '1', 'container'], [-1, '1', 'container'], [1, '', 'container'], [1, 'a b', 'container'], [1, 'x'.repeat(65), 'container'], [1, '1', 'none'], [1, '1', 'Container']] as Array<[number, string, string]>) {
        expect((await fail(() => hello(a.accountId, id, args))).code, JSON.stringify(args)).toBe('22023');
      }
      expect((await fail(() => hello(a.accountId, id, [2_147_483_648, '1', 'container']))).code).toBe('22003');
      expect((await admin.query('SELECT protocol_version FROM runners WHERE id = $1', [id])).rows[0]!.protocol_version).toBeNull();
    });
  });
});
