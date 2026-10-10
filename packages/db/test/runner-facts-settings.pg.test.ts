import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const FACTS_ROLE = 'runner_facts_definer';
const SETTINGS_ROLE = 'runner_settings_definer';
const FACTS_FN = 'runner_facts_record(text,text,integer,integer,text)';
const SETTINGS_FN = 'runner_settings_apply(uuid,text,text,text[],integer)';
const BEL = String.fromCharCode(7);
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_v, i) => from + i);
/** Names the reviewer listed (CWE-176) plus the rest of Default_Ignorable_Code_Point: each must be refused as the only content and inside an otherwise good name. */
const IGNORABLE: number[] = [0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, ...range(0x180b, 0x180f), ...range(0x200b, 0x200f), ...range(0x202a, 0x202e), ...range(0x2060, 0x206f), 0x3164, ...range(0xfe00, 0xfe0f), 0xfeff, 0xffa0, ...range(0xfff0, 0xfff8), 0x1bca0, 0x1d173, 0xe0001, 0xe0020, 0xe0100, 0xe0fff];
/** Names that render as nothing without being empty. */
const BLANK_NAMES: string[] = [cp(0xa0), cp(0x3000), cp(0x2800), cp(0x3164), cp(0xa0, 0x3000, 0x2800), cp(0x2003, 0x200b, 0x20), cp(0x2800, 0x3164, 0x2060), cp(0x0a, 0x20)];

/** D#605 FL-1: runner_facts and runner_settings, their two definers, and the privilege line around them. */
describe('migration 0783: runner_facts, runner_settings, runner_facts_record and runner_settings_apply', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs; // account A: its seeded user is the owner
  let b: SeedRefs;
  let runner: string; // registered by the owner of A
  let adminUser: string;
  let registrant: string; // a plain member who registered `memberRunner`
  let otherMember: string; // a plain member who registered nothing
  let memberRunner: string;

  const addMember = async (accountId: string, role: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, id, role]);
    return id;
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    runner = await insertRunner(admin, a.accountId, a.userId);
    adminUser = await addMember(a.accountId, 'admin');
    registrant = await addMember(a.accountId, 'member');
    otherMember = await addMember(a.accountId, 'member');
    memberRunner = await insertRunner(admin, a.accountId, registrant);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  const facts = (id = runner) => admin.query(`SELECT os, arch, mem_gb_bucket, cpus, sandbox_engine FROM runner_facts WHERE runner_id = $1`, [id]).then((r) => r.rows[0] ?? null);
  const settings = (id = runner) =>
    admin.query(`SELECT name, labels, rank, paused_at IS NOT NULL AS paused, paused_by, draining, drained_by, updated_by FROM runner_settings WHERE runner_id = $1`, [id]).then((r) => r.rows[0] ?? null);
  /** The facts definer, as the web tier's login in a runner's session context (what the runner middleware sets). */
  const record = (args: [string, string, number, number, string], o: { runnerId?: string | null; accountId?: string } = {}): Promise<unknown> =>
    withTenant(appPool, o.accountId ?? a.accountId, async (client) => {
      if (o.runnerId !== null) await client.query(`SELECT set_config('app.runner_id', $1, true)`, [o.runnerId ?? runner]);
      await client.query('SELECT runner_facts_record($1, $2, $3::int, $4::int, $5)', args);
    });
  /** The settings definer, as a signed-in member of account A (or of `accountId`). */
  const apply = (user: string, id: string, action: string, o: { name?: string | null; labels?: string[] | null; rank?: number | null; accountId?: string } = {}): Promise<unknown> =>
    withTenant(appPool, o.accountId ?? a.accountId, user, (client) =>
      client.query('SELECT runner_settings_apply($1::uuid, $2, $3, $4::text[], $5::int)', [id, action, o.name ?? null, o.labels ?? null, o.rank ?? null]),
    );
  const OK_FACTS: [string, string, number, number, string] = ['linux', 'x64', 16, 8, 'os_sandbox'];

  describe('CHECK constraints (criterion 1)', () => {
    const insertFacts = (over: Record<string, unknown>) => {
      const row = { os: 'linux', arch: 'x64', mem_gb_bucket: 16, cpus: 8, sandbox_engine: 'os_sandbox', ...over };
      return insertRunner(admin, a.accountId, a.userId).then((id) =>
        admin.query(`INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, a.accountId, row.os, row.arch, row.mem_gb_bucket, row.cpus, row.sandbox_engine]),
      );
    };
    it.each([
      ['os windows', { os: 'windows' }],
      ['arch arm', { arch: 'arm' }],
      ['memory 12', { mem_gb_bucket: 12 }],
      ['memory 256', { mem_gb_bucket: 256 }],
      ['0 cpus', { cpus: 0 }],
      ['257 cpus', { cpus: 257 }],
      ['engine docker', { sandbox_engine: 'docker' }],
    ])('refuses %s', async (_n, over) => {
      await expect(insertFacts(over)).rejects.toMatchObject({ code: '23514' });
    });
    it('accepts every value of every enum and the cpu edges', async () => {
      for (const over of [{ os: 'macos' }, { arch: 'arm64' }, { sandbox_engine: 'microvm' }, { cpus: 1 }, { cpus: 256 }, ...[4, 8, 16, 32, 64, 128].map((m) => ({ mem_gb_bucket: m }))]) {
        await insertFacts(over);
      }
    });

    const insertSettings = async (cols: string, values: unknown[]) => {
      const id = await insertRunner(admin, a.accountId, a.userId);
      return admin.query(`INSERT INTO runner_settings (runner_id, account_id, ${cols}) VALUES ($1, $2, ${values.map((_v, i) => `$${i + 3}`).join(', ')})`, [id, a.accountId, ...values]);
    };
    const sixteen = Array.from({ length: 16 }, (_v, i) => `l${i}`);
    it.each([
      ['a 17th label', 'labels', [[...sixteen, 'l16']]],
      ['an uppercase label', 'labels', [['GPU!']]],
      ['a label with punctuation', 'labels', [['gpu!']]],
      ['a label starting with a hyphen', 'labels', [['-gpu']]],
      ['a 33-character label', 'labels', [['a'.repeat(33)]],],
      ['an empty label', 'labels', [['']]],
      ['a null label', 'labels', [['a', null]]],
      ['a duplicate label', 'labels', [['gpu', 'gpu']]],
      ['a label holding a comma', 'labels', [['a,b']]],
      ['a name holding BEL', 'name', [`ab${BEL}`]],
      ['a name holding a newline', 'name', ['a\nb']],
      ['a name holding a bidi override', 'name', ['a‮b']],
      ['an empty name', 'name', ['']],
      ['a blank name', 'name', ['   ']],
      ['a 65-character name', 'name', ['n'.repeat(65)]],
      ['rank -1', 'rank', [-1]],
      ['rank 1001', 'rank', [1001]],
    ] as Array<[string, string, unknown[]]>)('refuses %s', async (_n, col, values) => {
      await expect(insertSettings(col, values)).rejects.toMatchObject({ code: '23514' });
    });
    it('refuses an ignorable or invisible-only name by CHECK (CWE-176)', async () => {
      for (const code of IGNORABLE) await expect(insertSettings('name', [`ab${cp(code)}cd`]), code.toString(16)).rejects.toMatchObject({ code: '23514' });
      for (const name of BLANK_NAMES) await expect(insertSettings('name', [name]), JSON.stringify(name)).rejects.toMatchObject({ code: '23514' });
    });
    it('accepts a name that has a visible character, whatever else it holds that is allowed', async () => {
      for (const name of [`a${cp(0xa0)}b`, cp(0x3000, 0x6841, 0x9762), 'Desktop \u{1f600}', `${cp(0x2800)}x`]) await insertSettings('name', [name]);
    });
    it('accepts 16 labels, a 64-character name, a name with spaces and unicode, and the rank edges', async () => {
      await insertSettings('labels', [sixteen]);
      await insertSettings('labels', [['a'.repeat(32), '0-x']]);
      await insertSettings('name', ['n'.repeat(64)]);
      await insertSettings('name', ['Büro Desktop (2nd floor)']);
      await insertSettings('rank', [0]);
      await insertSettings('rank', [1000]);
    });
    it('refuses a paused_by without a paused_at', async () => {
      await expect(insertSettings('paused_by', [a.userId])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('privileges (criterion 3)', () => {
    it('both roles are NOLOGIN and unprivileged, have no member, are members of nothing, and own exactly their one function', async () => {
      for (const [role, fn] of [[FACTS_ROLE, FACTS_FN], [SETTINGS_ROLE, SETTINGS_FN]]) {
        const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [role]);
        expect(rows[0], role).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
        expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [role])).rowCount, role).toBe(0);
        const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole`, [role]);
        expect(owned.rows.map((r) => r.sig), role).toEqual([fn]);
        expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [role])).rows[0].ok, role).toBe(false);
      }
    });

    it('platform_ops holds NO privilege on either table, any column of it, or either function; runners is unchanged', async () => {
      for (const table of ['runner_facts', 'runner_settings']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          expect((await admin.query(`SELECT has_table_privilege('platform_ops', $1, $2) AS ok`, [table, privilege])).rows[0].ok, `${table} ${privilege}`).toBe(false);
        }
        expect((await admin.query(`SELECT has_any_column_privilege('platform_ops', $1, 'SELECT, INSERT, UPDATE, REFERENCES') AS ok`, [table])).rows[0].ok, table).toBe(false);
      }
      for (const fn of [FACTS_FN, SETTINGS_FN, 'runner_labels_valid(text[])']) {
        expect((await admin.query(`SELECT has_function_privilege('platform_ops', $1::regprocedure, 'EXECUTE') AS ok`, [fn])).rows[0].ok, fn).toBe(false);
      }
      expect((await admin.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'runners' AND column_name IN ('name', 'labels', 'rank', 'paused_at', 'draining', 'os', 'arch', 'cpus')`)).rowCount).toBe(0);
    });

    it('app_user, partner_user and agent_run_writer cannot write either table; app_user reads them under the tenant policy only', async () => {
      for (const table of ['runner_facts', 'runner_settings']) {
        for (const who of ['app_user', 'partner_user', 'agent_run_writer']) {
          expect((await admin.query(`SELECT has_any_column_privilege($1, $2, 'INSERT, UPDATE') AS ok`, [who, table])).rows[0].ok, `${who} ${table}`).toBe(false);
          expect((await admin.query(`SELECT has_table_privilege($1, $2, 'DELETE, TRUNCATE') AS ok`, [who, table])).rows[0].ok, `${who} ${table}`).toBe(false);
        }
        expect((await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [table])).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      }
    });

    it('each function is SECURITY DEFINER with a pinned search_path and EXECUTE for app_user alone', async () => {
      for (const fn of [FACTS_FN, SETTINGS_FN]) {
        const { rows } = await admin.query(
          `SELECT p.prosecdef, p.proconfig,
                  coalesce((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner), '{}') AS grantees
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [fn],
        );
        expect(rows[0], fn).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['app_user'] });
      }
    });

    it('a direct platform_ops login reads and calls nothing', async () => {
      const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
      try {
        for (const table of ['runner_facts', 'runner_settings']) await expect(ops.query(`SELECT 1 FROM ${table}`), table).rejects.toMatchObject({ code: '42501' });
        await expect(ops.query(`SELECT runner_facts_record('linux', 'x64', 16, 8, 'os_sandbox')`)).rejects.toMatchObject({ code: '42501' });
        await expect(ops.query(`SELECT runner_settings_apply(gen_random_uuid(), 'pause', NULL, NULL, NULL)`)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await ops.end();
      }
    });
  });

  describe('tenant isolation (criterion 2)', () => {
    it('account B sees none of account A rows, and changes none of them', async () => {
      await record(OK_FACTS);
      await apply(a.userId, runner, 'rename', { name: 'Desktop' });
      for (const table of ['runner_facts', 'runner_settings']) {
        const own = await withTenant(appPool, a.accountId, (c) => c.query(`SELECT runner_id FROM ${table} WHERE runner_id = $1`, [runner]));
        expect(own.rowCount, table).toBe(1);
        const foreign = await withTenant(appPool, b.accountId, (c) => c.query(`SELECT runner_id FROM ${table} WHERE runner_id = $1`, [runner]));
        expect(foreign.rowCount, table).toBe(0);
        const upd = await withTenant(appPool, b.accountId, (c) => c.query(`SELECT 1 FROM ${table} WHERE account_id = $1`, [a.accountId]));
        expect(upd.rowCount, table).toBe(0);
        await expect(withTenant(appPool, b.accountId, (c) => c.query(`UPDATE ${table} SET account_id = account_id WHERE runner_id = $1`, [runner])), table).rejects.toMatchObject({ code: '42501' });
      }
      // The definers, called from account B's session about A's runner, find no such runner and write nothing.
      await expect(apply(b.userId, runner, 'rename', { name: 'Stolen', accountId: b.accountId })).rejects.toMatchObject({ code: 'P0002' });
      await expect(record(['macos', 'arm64', 4, 2, 'microvm'], { accountId: b.accountId })).rejects.toMatchObject({ code: '42501' });
      expect(await settings()).toMatchObject({ name: 'Desktop' });
      expect(await facts()).toEqual({ os: 'linux', arch: 'x64', mem_gb_bucket: 16, cpus: 8, sandbox_engine: 'os_sandbox' });
    });

    it('a suspended account reads none of its rows', async () => {
      const c = await seedAccount(admin, randomUUID());
      const r = await insertRunner(admin, c.accountId, c.userId);
      await admin.query(`INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, 'linux', 'x64', 8, 4, 'os_sandbox')`, [r, c.accountId]);
      await admin.query(`INSERT INTO runner_settings (runner_id, account_id) VALUES ($1, $2)`, [r, c.accountId]);
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [c.accountId]);
      for (const table of ['runner_facts', 'runner_settings']) {
        expect((await withTenant(appPool, c.accountId, (cl) => cl.query(`SELECT 1 FROM ${table}`))).rowCount, table).toBe(0);
      }
    });

    it('the rows follow their runner when it is deleted', async () => {
      const r = await insertRunner(admin, a.accountId, a.userId);
      await admin.query(`INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, 'linux', 'x64', 8, 4, 'os_sandbox')`, [r, a.accountId]);
      await admin.query(`INSERT INTO runner_settings (runner_id, account_id) VALUES ($1, $2)`, [r, a.accountId]);
      await admin.query('DELETE FROM runners WHERE id = $1', [r]);
      expect((await admin.query('SELECT 1 FROM runner_facts WHERE runner_id = $1', [r])).rowCount).toBe(0);
      expect((await admin.query('SELECT 1 FROM runner_settings WHERE runner_id = $1', [r])).rowCount).toBe(0);
    });
  });

  describe('runner_facts_record (criterion 4)', () => {
    it('stores the facts, replaces them on a later hello, and every enum value is accepted', async () => {
      const r = await insertRunner(admin, a.accountId, a.userId);
      await record(['macos', 'arm64', 128, 256, 'microvm'], { runnerId: r });
      expect(await facts(r)).toEqual({ os: 'macos', arch: 'arm64', mem_gb_bucket: 128, cpus: 256, sandbox_engine: 'microvm' });
      await record(['linux', 'x64', 4, 1, 'os_sandbox'], { runnerId: r });
      expect(await facts(r)).toEqual({ os: 'linux', arch: 'x64', mem_gb_bucket: 4, cpus: 1, sandbox_engine: 'os_sandbox' });
    });

    it('raises insufficient_privilege and writes nothing without app.runner_id, with a malformed one, or for an unknown one', async () => {
      const before = (await admin.query('SELECT count(*)::int AS n FROM runner_facts')).rows[0].n;
      await expect(record(OK_FACTS, { runnerId: null })).rejects.toMatchObject({ code: '42501' });
      await expect(record(OK_FACTS, { runnerId: 'not-a-uuid' })).rejects.toMatchObject({ code: '42501' });
      await expect(record(OK_FACTS, { runnerId: randomUUID() })).rejects.toMatchObject({ code: '42501' });
      expect((await admin.query('SELECT count(*)::int AS n FROM runner_facts')).rows[0].n).toBe(before);
    });

    it('raises insufficient_privilege for a revoked runner and leaves its row as it was, then works again when it is live', async () => {
      const r = await insertRunner(admin, a.accountId, a.userId);
      await record(OK_FACTS, { runnerId: r });
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [r]);
      await expect(record(['macos', 'arm64', 4, 2, 'microvm'], { runnerId: r })).rejects.toMatchObject({ code: '42501' });
      expect(await facts(r)).toEqual({ os: 'linux', arch: 'x64', mem_gb_bucket: 16, cpus: 8, sandbox_engine: 'os_sandbox' });
      const never = await insertRunner(admin, a.accountId, a.userId);
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [never]);
      await expect(record(OK_FACTS, { runnerId: never })).rejects.toMatchObject({ code: '42501' });
      expect(await facts(never)).toBeNull();
    });

    it('refuses a value outside its enum or range (22023) and writes nothing', async () => {
      const r = await insertRunner(admin, a.accountId, a.userId);
      for (const bad of [['windows', 'x64', 16, 8, 'os_sandbox'], ['linux', 'arm', 16, 8, 'os_sandbox'], ['linux', 'x64', 12, 8, 'os_sandbox'], ['linux', 'x64', 16, 0, 'os_sandbox'], ['linux', 'x64', 16, 257, 'os_sandbox'], ['linux', 'x64', 16, 8, 'docker']] as Array<[string, string, number, number, string]>) {
        await expect(record(bad, { runnerId: r }), bad.join()).rejects.toMatchObject({ code: '22023' });
      }
      expect(await facts(r)).toBeNull();
    });

    it("touches only the runner the session names: not another runner, not another account's runner", async () => {
      const other = await insertRunner(admin, a.accountId, a.userId);
      await record(OK_FACTS, { runnerId: runner });
      expect(await facts(other)).toBeNull();
      await expect(record(OK_FACTS, { runnerId: runner, accountId: b.accountId })).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('runner_settings_apply', () => {
    it('renames, sets labels and rank, and an unset runner starts from no name, no labels, rank 0, not paused', async () => {
      const r = await insertRunner(admin, a.accountId, a.userId);
      expect(await settings(r)).toBeNull();
      await apply(a.userId, r, 'rename', { name: 'Home server' });
      expect(await settings(r)).toMatchObject({ name: 'Home server', labels: [], rank: 0, paused: false, draining: false, updated_by: a.userId });
      await apply(adminUser, r, 'labels', { labels: ['gpu', 'macos'] });
      await apply(adminUser, r, 'rank', { rank: 7 });
      expect(await settings(r)).toMatchObject({ name: 'Home server', labels: ['gpu', 'macos'], rank: 7, updated_by: adminUser });
      await apply(adminUser, r, 'labels', { labels: [] });
      expect((await settings(r)).labels).toEqual([]);
    });

    it('refuses what the CHECK refuses, as 22023, before writing anything', async () => {
      const r = await insertRunner(admin, a.accountId, a.userId);
      for (const name of [null, '', '   ', 'n'.repeat(65), `ab${BEL}`, 'a\nb', 'a‮b', 'a​b']) {
        await expect(apply(a.userId, r, 'rename', { name }), String(name)).rejects.toMatchObject({ code: '22023' });
      }
      for (const labels of [null, ['GPU!'], ['gpu', 'gpu'], Array.from({ length: 17 }, (_v, i) => `l${i}`), ['a,b'], ['']]) {
        await expect(apply(a.userId, r, 'labels', { labels }), JSON.stringify(labels)).rejects.toMatchObject({ code: '22023' });
      }
      for (const rank of [null, -1, 1001]) await expect(apply(a.userId, r, 'rank', { rank }), String(rank)).rejects.toMatchObject({ code: '22023' });
      await expect(apply(a.userId, r, 'launch')).rejects.toMatchObject({ code: '22023' });
      expect(await settings(r)).toBeNull();
    });

    it('refuses every ignorable character and every invisible-only name through the definer (22023), writing nothing (CWE-176)', async () => {
      const r = await insertRunner(admin, a.accountId, a.userId);
      for (const code of IGNORABLE) await expect(apply(a.userId, r, 'rename', { name: `ab${cp(code)}cd` }), code.toString(16)).rejects.toMatchObject({ code: '22023' });
      for (const name of BLANK_NAMES) await expect(apply(a.userId, r, 'rename', { name }), JSON.stringify(name)).rejects.toMatchObject({ code: '22023' });
      await expect(apply(a.userId, r, 'rename', { name: 'n'.repeat(65) })).rejects.toMatchObject({ code: '22023' });
      expect(await settings(r)).toBeNull();
      await apply(a.userId, r, 'rename', { name: `Büro${cp(0xa0)}2` });
      expect((await settings(r)).name).toBe(`Büro${cp(0xa0)}2`);
    });

    it('a registrant cannot take over an admin pause and then undo it (CWE-863): the reviewer sequence', async () => {
      const r = await insertRunner(admin, a.accountId, registrant);
      await apply(adminUser, r, 'pause');
      await expect(apply(registrant, r, 'pause')).rejects.toMatchObject({ code: '42501' });
      await expect(apply(registrant, r, 'resume')).rejects.toMatchObject({ code: '42501' });
      expect(await settings(r)).toMatchObject({ paused: true, paused_by: adminUser });
      // The registrant may still pause their own runner when nobody else has, and the admin may overwrite it.
      await apply(adminUser, r, 'resume');
      await apply(registrant, r, 'pause');
      await apply(a.userId, r, 'pause');
      expect(await settings(r)).toMatchObject({ paused: true, paused_by: a.userId });
      await expect(apply(registrant, r, 'resume')).rejects.toMatchObject({ code: '42501' });
    });

    it('drained_by follows the same rule as paused_by: a registrant cannot take over or cancel an admin drain', async () => {
      const r = await insertRunner(admin, a.accountId, registrant);
      await apply(adminUser, r, 'drain');
      expect(await settings(r)).toMatchObject({ draining: true, drained_by: adminUser });
      await expect(apply(registrant, r, 'drain')).rejects.toMatchObject({ code: '42501' });
      await expect(apply(registrant, r, 'resume')).rejects.toMatchObject({ code: '42501' });
      expect(await settings(r)).toMatchObject({ draining: true, drained_by: adminUser });
      // An admin drain after the registrant's own overwrites it; the registrant cancels only their own.
      await apply(adminUser, r, 'resume');
      await apply(registrant, r, 'drain');
      expect(await settings(r)).toMatchObject({ draining: true, drained_by: registrant });
      await apply(registrant, r, 'resume');
      expect(await settings(r)).toMatchObject({ draining: false, drained_by: null });
      await apply(registrant, r, 'drain');
      await apply(a.userId, r, 'drain');
      expect(await settings(r)).toMatchObject({ drained_by: a.userId });
      await apply(a.userId, r, 'resume');
      expect(await settings(r)).toMatchObject({ draining: false, drained_by: null, paused: false });
    });

    it('a registrant resume is refused while either the pause or the drain belongs to someone else', async () => {
      const r = await insertRunner(admin, a.accountId, registrant);
      await apply(registrant, r, 'pause');
      await apply(adminUser, r, 'drain');
      await expect(apply(registrant, r, 'resume')).rejects.toMatchObject({ code: '42501' });
      expect(await settings(r)).toMatchObject({ paused: true, paused_by: registrant, draining: true, drained_by: adminUser });
    });

    it('C-605-1: every settings write for a revoked runner raises 55000 and changes 0 rows', async () => {
      const r = await insertRunner(admin, a.accountId, registrant);
      await apply(a.userId, r, 'rename', { name: 'Before' });
      const snapshot = async () => (await admin.query('SELECT * FROM runner_settings WHERE runner_id = $1', [r])).rows[0];
      const before = await snapshot();
      await admin.query("UPDATE runners SET revoked_at = now(), revoked_reason = 'member_demoted' WHERE id = $1", [r]);
      for (const user of [a.userId, adminUser, registrant]) {
        for (const action of ['rename', 'labels', 'rank', 'pause', 'drain', 'resume']) {
          await expect(apply(user, r, action, { name: 'After', labels: ['x'], rank: 5 }), `${user} ${action}`).rejects.toMatchObject({ code: '55000' });
        }
      }
      expect(await snapshot()).toEqual(before);
    });

    it('re-derives the caller: a plain member who did not register the runner can do nothing to it', async () => {
      for (const action of ['rename', 'pause', 'drain', 'resume', 'labels', 'rank']) {
        await expect(apply(otherMember, memberRunner, action, { name: 'x', labels: ['x'], rank: 1 }), action).rejects.toMatchObject({ code: '42501' });
      }
      expect(await settings(memberRunner)).toBeNull();
    });

    it('lets the registrant rename, pause and drain their runner, but not set labels or rank', async () => {
      await apply(registrant, memberRunner, 'rename', { name: 'Laptop' });
      await apply(registrant, memberRunner, 'pause');
      await apply(registrant, memberRunner, 'drain');
      expect(await settings(memberRunner)).toMatchObject({ name: 'Laptop', paused: true, paused_by: registrant, draining: true });
      await expect(apply(registrant, memberRunner, 'labels', { labels: ['gpu'] })).rejects.toMatchObject({ code: '42501' });
      await expect(apply(registrant, memberRunner, 'rank', { rank: 3 })).rejects.toMatchObject({ code: '42501' });
      expect(await settings(memberRunner)).toMatchObject({ labels: [], rank: 0 });
    });

    it('resume: the registrant undoes their own pause (and the drain); an owner pause is theirs only until an admin or owner resumes it', async () => {
      await apply(registrant, memberRunner, 'resume');
      expect(await settings(memberRunner)).toMatchObject({ paused: false, paused_by: null, draining: false });
      await apply(adminUser, memberRunner, 'pause');
      expect(await settings(memberRunner)).toMatchObject({ paused: true, paused_by: adminUser });
      await expect(apply(registrant, memberRunner, 'resume')).rejects.toMatchObject({ code: '42501' });
      expect(await settings(memberRunner)).toMatchObject({ paused: true, paused_by: adminUser });
      await apply(a.userId, memberRunner, 'resume');
      expect(await settings(memberRunner)).toMatchObject({ paused: false, paused_by: null });
    });

    it('an admin pause after a registrant pause overwrites paused_by, and a repeated pause keeps the first paused_at', async () => {
      await apply(registrant, memberRunner, 'pause');
      const first = (await admin.query('SELECT paused_at FROM runner_settings WHERE runner_id = $1', [memberRunner])).rows[0].paused_at;
      await apply(a.userId, memberRunner, 'pause');
      const second = (await admin.query('SELECT paused_at, paused_by FROM runner_settings WHERE runner_id = $1', [memberRunner])).rows[0];
      expect(second.paused_by).toBe(a.userId);
      expect(second.paused_at).toEqual(first);
      await apply(a.userId, memberRunner, 'resume');
    });

    it('a registrant who is no longer a member has no control (models the owner/admin path of a registrant-less runner; the real removal revokes the runner, tested below); a resume with no pause is allowed', async () => {
      const leaver = await addMember(a.accountId, 'member');
      const r = await insertRunner(admin, a.accountId, leaver);
      await apply(leaver, r, 'resume');
      await apply(leaver, r, 'pause');
      await admin.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [a.accountId, leaver]);
      // Removing the member really revokes their runners (0712/0720, C-605-1); un-revoking here only isolates the membership check of the definer.
      await admin.query('UPDATE runners SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1', [r]);
      await expect(apply(leaver, r, 'resume')).rejects.toMatchObject({ code: '42501' });
      await expect(apply(leaver, r, 'rename', { name: 'mine' })).rejects.toMatchObject({ code: '42501' });
      // The owner still controls it.
      await apply(a.userId, r, 'resume');
      expect(await settings(r)).toMatchObject({ paused: false });
    });

    it('removing the registrant from the account revokes their runner (0712), after which the definer answers 55000 to everyone', async () => {
      const leaver = await addMember(a.accountId, 'member');
      const r = await insertRunner(admin, a.accountId, leaver);
      await apply(leaver, r, 'pause');
      await admin.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [a.accountId, leaver]);
      expect((await admin.query('SELECT revoked_at IS NOT NULL AS revoked FROM runners WHERE id = $1', [r])).rows[0].revoked).toBe(true);
      await expect(apply(a.userId, r, 'resume')).rejects.toMatchObject({ code: '55000' });
      await expect(apply(leaver, r, 'resume')).rejects.toMatchObject({ code: '42501' });
    });

    it('refuses a revoked runner (55000), an unknown runner (P0002) and an unsigned-in caller (42501), and a user of another account', async () => {
      const r = await insertRunner(admin, a.accountId, a.userId);
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [r]);
      await expect(apply(a.userId, r, 'pause')).rejects.toMatchObject({ code: '55000' });
      await expect(apply(a.userId, randomUUID(), 'pause')).rejects.toMatchObject({ code: 'P0002' });
      await expect(apply(b.userId, runner, 'pause')).rejects.toMatchObject({ code: '42501' });
      await expect(withTenant(appPool, a.accountId, (c) => c.query(`SELECT runner_settings_apply($1::uuid, 'pause', NULL, NULL, NULL)`, [runner]))).rejects.toMatchObject({ code: '42501' });
      expect(await settings(r)).toBeNull();
    });

    it('the state read back is derived from the row: paused and draining are set and cleared independently of the clock', async () => {
      const r = await insertRunner(admin, a.accountId, a.userId);
      await apply(a.userId, r, 'drain');
      expect(await settings(r)).toMatchObject({ paused: false, draining: true });
      await apply(a.userId, r, 'resume');
      expect(await settings(r)).toMatchObject({ paused: false, draining: false });
    });
  });
});
