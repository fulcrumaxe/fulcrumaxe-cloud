import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { clearEngineHalt, EngineHaltForbidden, EngineHaltRepoNotFound, haltPending, isEngineHalted, lockEngineHaltForSession, readEngineHalts, setEngineHalt } from '../src/engineHalt.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { findRlsViolations } from '../src/rlsInventory.js';

/**
 * Engine bridge EB-11a, migration 1031: the engine halt marker, who can write it, and the triggers that refuse a decide or a start-like command under it.
 *
 * The trigger FUNCTIONS are the real ones. The race and kind tests attach them to probe tables of this file, so they do not depend on the columns the
 * command and decision tables (1029, 1030) carry; a separate test pins that the real tables hold the triggers.
 */
describe('engine halt (1031)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  const CMD = 'eh_probe_commands';
  const DEC = 'eh_probe_decisions';

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    for (const [table, fn, extra] of [
      [CMD, 'engine_commands_refuse_halted', ', kind text NOT NULL, halt_epoch_at_issue integer NOT NULL DEFAULT 0'],
      [DEC, 'engine_decisions_refuse_halted', ''],
    ] as const) {
      await admin.query(`CREATE TABLE ${table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, repo_id uuid NOT NULL${extra})`);
      await admin.query(`CREATE TRIGGER ${table}_halt BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    }
  });
  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS ${CMD}, ${DEC}`);
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end()]);
  });

  /** A repo of account `acct`, fresh (no marker row yet), plus a member of the given role. */
  async function repo(acct: SeedRefs = a): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`, [
      acct.accountId,
      Math.floor(Math.random() * 1e12),
    ]);
    return rows[0]!.id;
  }
  async function member(acct: SeedRefs, role: 'owner' | 'admin' | 'member'): Promise<string> {
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [acct.accountId, userId, role]);
    return userId;
  }
  const asOwner = <T>(fn: (c: PoolClient) => Promise<T>, acct: SeedRefs = a) => withTenant(appUserPool, acct.accountId, acct.userId, fn);
  const insertCmd = (repoId: string, kind: string, acct: SeedRefs = a) => admin.query(`INSERT INTO ${CMD} (account_id, repo_id, kind) VALUES ($1, $2, $3)`, [acct.accountId, repoId, kind]);
  const insertDec = (repoId: string, acct: SeedRefs = a) => admin.query(`INSERT INTO ${DEC} (account_id, repo_id) VALUES ($1, $2)`, [acct.accountId, repoId]);
  const control = async (repoId: string) =>
    (await admin.query(`SELECT halted_at IS NOT NULL AS halted, halt_action_id IS NOT NULL AS has_action, halt_epoch, cleared_at IS NOT NULL AS was_cleared FROM engine_repo_controls WHERE repo_id = $1`, [repoId])).rows[0];

  describe('set and clear', () => {
    it('a halt sets the marker and counts the epoch; a repeat changes nothing; a clear keeps the epoch; the next halt is epoch 2', async () => {
      const r = await repo();
      expect(await asOwner((c) => readEngineHalts(c, [r]))).toEqual(new Map([[r, { halt_epoch: 0, halted: false }]]));
      expect(await asOwner((c) => setEngineHalt(c, r))).toEqual({ halt_epoch: 1, newly_halted: true });
      expect(await control(r)).toMatchObject({ halted: true, has_action: true, halt_epoch: 1, was_cleared: false });
      expect(await asOwner((c) => setEngineHalt(c, r))).toEqual({ halt_epoch: 1, newly_halted: false });
      expect(await asOwner((c) => readEngineHalts(c, [r]))).toEqual(new Map([[r, { halt_epoch: 1, halted: true }]]));

      expect(await asOwner((c) => clearEngineHalt(c, r))).toEqual({ halt_epoch: 1, newly_cleared: true });
      expect(await control(r)).toMatchObject({ halted: false, has_action: false, halt_epoch: 1, was_cleared: true });
      expect(await asOwner((c) => clearEngineHalt(c, r))).toEqual({ halt_epoch: 1, newly_cleared: false });
      expect(await asOwner((c) => setEngineHalt(c, r))).toEqual({ halt_epoch: 2, newly_halted: true });
    });

    it('an admin may halt and clear; a plain member may do neither (42501 as EngineHaltForbidden)', async () => {
      const r = await repo();
      const adminId = await member(a, 'admin');
      const memberId = await member(a, 'member');
      expect(await withTenant(appUserPool, a.accountId, adminId, (c) => setEngineHalt(c, r))).toMatchObject({ newly_halted: true });
      await expect(withTenant(appUserPool, a.accountId, memberId, (c) => clearEngineHalt(c, r))).rejects.toBeInstanceOf(EngineHaltForbidden);
      expect((await control(r))!.halted).toBe(true);
      await expect(withTenant(appUserPool, a.accountId, memberId, (c) => setEngineHalt(c, r))).rejects.toBeInstanceOf(EngineHaltForbidden);
      expect(await withTenant(appUserPool, a.accountId, adminId, (c) => clearEngineHalt(c, r))).toMatchObject({ newly_cleared: true });
    });

    it('a session with no user, a user who is not a member of the account, or another account\'s owner is refused', async () => {
      const r = await repo();
      await expect(withTenant(appUserPool, a.accountId, (c) => setEngineHalt(c, r))).rejects.toBeInstanceOf(EngineHaltForbidden);
      const stranger = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [stranger, `${stranger}@example.test`]);
      await expect(withTenant(appUserPool, a.accountId, stranger, (c) => setEngineHalt(c, r))).rejects.toBeInstanceOf(EngineHaltForbidden);
      // b's owner naming a's account in the session is not a member of it.
      await expect(withTenant(appUserPool, a.accountId, b.userId, (c) => clearEngineHalt(c, r))).rejects.toBeInstanceOf(EngineHaltForbidden);
      expect(await control(r)).toBeUndefined();
    });

    it('a repo of another account, or one that does not exist, answers not-found and creates no marker', async () => {
      const theirs = await repo(b);
      await expect(asOwner((c) => setEngineHalt(c, theirs))).rejects.toBeInstanceOf(EngineHaltRepoNotFound);
      await expect(asOwner((c) => clearEngineHalt(c, theirs))).rejects.toBeInstanceOf(EngineHaltRepoNotFound);
      await expect(asOwner((c) => setEngineHalt(c, randomUUID()))).rejects.toBeInstanceOf(EngineHaltRepoNotFound);
      expect(await control(theirs)).toBeUndefined();
    });

    it('the marker pair is all or nothing, and the epoch cannot go negative', async () => {
      const r = await repo();
      await asOwner((c) => setEngineHalt(c, r));
      await expect(admin.query(`UPDATE engine_repo_controls SET halted_at = NULL WHERE repo_id = $1`, [r])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE engine_repo_controls SET halt_epoch = -1 WHERE repo_id = $1`, [r])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('only a person writes the marker', () => {
    it('app_user holds SELECT only on the table: no INSERT, UPDATE or DELETE, even as the account\'s owner', async () => {
      const r = await repo();
      await asOwner((c) => setEngineHalt(c, r));
      const attempts = [
        `UPDATE engine_repo_controls SET halted_at = NULL, halt_action_id = NULL WHERE repo_id = $1`,
        `UPDATE engine_repo_controls SET halt_epoch = 99 WHERE repo_id = $1`,
        `DELETE FROM engine_repo_controls WHERE repo_id = $1`,
      ];
      for (const sql of attempts) {
        await expect(asOwner((c) => c.query(sql, [r])), sql).rejects.toMatchObject({ code: '42501' });
      }
      await expect(asOwner((c) => c.query(`INSERT INTO engine_repo_controls (account_id, repo_id) VALUES ($1, $2)`, [a.accountId, randomUUID()]))).rejects.toMatchObject({ code: '42501' });
      expect((await control(r))!.halted).toBe(true);
    });

    it('EXECUTE on set and clear is app_user\'s alone: the runner write login, platform_ops and PUBLIC have none', async () => {
      const { rows } = await admin.query<{ proname: string; grantee: string }>(
        `SELECT p.proname, pg_get_userbyid(x.grantee) AS grantee
           FROM pg_proc p, aclexplode(p.proacl) x
          WHERE p.proname IN ('engine_halt_set', 'engine_halt_clear', 'engine_halt_assert_person') AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner`,
      );
      const by = (n: string) => rows.filter((r) => r.proname === n).map((r) => r.grantee).sort();
      expect(by('engine_halt_set')).toEqual(['app_user']);
      expect(by('engine_halt_clear')).toEqual(['app_user']);
      expect(by('engine_halt_assert_person')).toEqual([]);
      for (const fn of ['engine_halt_set(uuid)', 'engine_halt_clear(uuid)']) {
        for (const role of ['agent_run_writer', 'platform_ops']) {
          const { rows: r } = await admin.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [role, fn]);
          expect(r[0]!.ok, `${role} ${fn}`).toBe(false);
        }
      }
    });

    it('platform_ops is refused whatever tenant and user it names; the run writer login (which inherits app_user) is refused unless the session names a verified owner or admin (42501)', async () => {
      const r = await repo();
      await asOwner((c) => setEngineHalt(c, r));
      const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
      const writer = createPool(process.env.DATABASE_URL_RUN_WRITER!);
      try {
        for (const sql of ['SELECT * FROM engine_halt_clear($1::uuid)', 'SELECT * FROM engine_halt_set($1::uuid)']) {
          // The owner's own ids are set as the session settings, as a stolen identity would: platform_ops still has no EXECUTE.
          await expect(withTenant(ops, a.accountId, a.userId, (c) => c.query(sql, [r])), `ops ${sql}`).rejects.toMatchObject({ code: '42501' });
          // The worker's tenant session carries no person: the definer refuses it.
          await expect(withTenant(writer, a.accountId, (c) => c.query(sql, [r])), `writer ${sql}`).rejects.toMatchObject({ code: '42501' });
          // A person who is not an owner or admin, on the same login: refused.
          const plain = await member(a, 'member');
          await expect(withTenant(writer, a.accountId, plain, (c) => c.query(sql, [r])), `writer member ${sql}`).rejects.toMatchObject({ code: '42501' });
        }
      } finally {
        await Promise.all([ops.end(), writer.end()]);
      }
      expect((await control(r))!.halted).toBe(true);
    });

    it('a runner session is refused even when it names a verified owner: app.runner_id set, or a login that is a member of agent_run_writer (42501)', async () => {
      const r = await repo();
      await asOwner((c) => setEngineHalt(c, r));
      const writer = createPool(process.env.DATABASE_URL_RUN_WRITER!);
      const withRunner = (pool: Pool, sql: string) =>
        withTenant(pool, a.accountId, a.userId, async (c) => {
          await c.query(`SELECT set_config('app.runner_id', $1, true)`, [randomUUID()]);
          return c.query(sql, [r]);
        });
      try {
        for (const sql of ['SELECT * FROM engine_halt_clear($1::uuid)', 'SELECT * FROM engine_halt_set($1::uuid)']) {
          // The API's own login with the owner's identity, but a runner named in the session: refused.
          await expect(withRunner(appUserPool, sql), `runner_id ${sql}`).rejects.toMatchObject({ code: '42501' });
          // The run writer's login with a verified owner's user id and no runner id: refused by the role, not by a missing person.
          await expect(withTenant(writer, a.accountId, a.userId, (c) => c.query(sql, [r])), `writer owner ${sql}`).rejects.toMatchObject({ code: '42501' });
          await expect(withRunner(writer, sql), `writer runner_id owner ${sql}`).rejects.toMatchObject({ code: '42501' });
        }
      } finally {
        await writer.end();
      }
      expect((await control(r))!.halted).toBe(true);
      // The same owner on the API's login, with no runner named, still works.
      expect(await asOwner((c) => clearEngineHalt(c, r))).toMatchObject({ newly_cleared: true });
    });

    it('a login that is a member of platform_ops is refused by role membership, whatever its name', async () => {
      const r = await repo();
      const alias = `eh_ops_alias_${Math.floor(Math.random() * 1e9)}`;
      const url = new URL(process.env.DATABASE_URL_PLATFORM_OPS!);
      const password = randomUUID();
      await admin.query(`CREATE ROLE ${alias} LOGIN PASSWORD '${password}'`);
      let pool: Pool | undefined;
      try {
        await admin.query(`GRANT platform_ops TO ${alias}`);
        await admin.query(`GRANT app_user TO ${alias}`);
        url.username = alias;
        url.password = password;
        pool = createPool(url.toString());
        await expect(withTenant(pool, a.accountId, a.userId, (c) => setEngineHalt(c, r))).rejects.toBeInstanceOf(EngineHaltForbidden);
        expect(await control(r)).toBeUndefined();
      } finally {
        await pool?.end();
        await admin.query(`DROP OWNED BY ${alias}`);
        await admin.query(`DROP ROLE ${alias}`);
      }
    });

    it('the functions are owned by a NOLOGIN role nothing can become, with a pinned search_path', async () => {
      const { rows } = await admin.query(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig FROM pg_proc p
          WHERE p.proname IN ('engine_halt_lock', 'engine_halt_epoch', 'engine_halt_set', 'engine_halt_clear', 'engine_halt_assert_person') ORDER BY 1`,
      );
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row, row.proname).toMatchObject({ owner: 'engine_halt_definer', prosecdef: true });
        expect(row.proconfig, row.proname).toEqual(['search_path=pg_catalog, public, pg_temp']);
      }
      const role = (await admin.query(`SELECT rolcanlogin, rolsuper, rolbypassrls, (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships FROM pg_roles r WHERE rolname = 'engine_halt_definer'`)).rows[0];
      expect(role).toMatchObject({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, memberships: 0 });
    });

    it('one account cannot read another\'s marker, and the table is under forced row security', async () => {
      const mine = await repo();
      await asOwner((c) => setEngineHalt(c, mine));
      const seen = await withTenant(appUserPool, b.accountId, b.userId, (c) => c.query(`SELECT repo_id FROM engine_repo_controls WHERE repo_id = $1`, [mine]));
      expect(seen.rows).toEqual([]);
      expect(await findRlsViolations(admin)).not.toContain('engine_repo_controls');
    });
  });

  describe('the refusal', () => {
    const REFUSED = ['start_day', 'resume_loop', 'request_spawn', 'set_dial'];
    const ALLOWED = ['pause_loop', 'answer_ask', 'stop_agent'];

    it('while halted, each of the four start-like commands raises HX409 engine_halted, and each of the three quieting ones is stored', async () => {
      const r = await repo();
      await asOwner((c) => setEngineHalt(c, r));
      for (const kind of REFUSED) {
        const err = await insertCmd(r, kind).then(() => null, (e: unknown) => e);
        expect(isEngineHalted(err), kind).toBe(true);
      }
      for (const kind of ALLOWED) await expect(insertCmd(r, kind), kind).resolves.toBeDefined();
      expect((await admin.query(`SELECT count(*)::int AS n FROM ${CMD} WHERE repo_id = $1`, [r])).rows[0].n).toBe(ALLOWED.length);
    });

    it('every decide raises HX409 while halted, and nothing is stored', async () => {
      const r = await repo();
      await asOwner((c) => setEngineHalt(c, r));
      expect(isEngineHalted(await insertDec(r).then(() => null, (e: unknown) => e))).toBe(true);
      expect((await admin.query(`SELECT count(*)::int AS n FROM ${DEC} WHERE repo_id = $1`, [r])).rows[0].n).toBe(0);
    });

    it('after a clear, every kind is accepted again; another repo of the account was never affected', async () => {
      const r = await repo();
      const other = await repo();
      await asOwner((c) => setEngineHalt(c, r));
      await expect(insertCmd(other, 'start_day')).resolves.toBeDefined();
      await expect(insertDec(other)).resolves.toBeDefined();
      await asOwner((c) => clearEngineHalt(c, r));
      for (const kind of [...REFUSED, ...ALLOWED]) await expect(insertCmd(r, kind), kind).resolves.toBeDefined();
      await expect(insertDec(r)).resolves.toBeDefined();
    });

    it('the helper names both ids: account a asking about b\'s halted repo is not answered with the halt (the FK refuses it, so nothing leaks)', async () => {
      const theirs = await repo(b);
      await withTenant(appUserPool, b.accountId, b.userId, (c) => setEngineHalt(c, theirs));
      await expect(admin.query(`SELECT engine_halt_lock($1, $2) AS h`, [a.accountId, theirs])).rejects.toMatchObject({ code: '23503' });
      expect((await control(theirs))!.halted).toBe(true);
    });
  });

  describe('a command is stamped with the epoch read under the lock, not the one the caller read earlier', () => {
    it('a halt and a clear that commit between the route\'s read and its insert still give the command the current epoch', async () => {
      const r = await repo();
      const reader = await adminPool.connect(); // the route's connection: reads the epoch, then inserts later
      try {
        const staleRead = (await reader.query(`SELECT coalesce((SELECT halt_epoch FROM engine_repo_controls WHERE repo_id = $1), 0) AS e`, [r])).rows[0].e as number;
        expect(staleRead).toBe(0);
        // Another connection halts and clears: the epoch is now 1 and nothing is halted.
        await asOwner(async (c) => { await setEngineHalt(c, r); await clearEngineHalt(c, r); });
        expect((await control(r))!.halt_epoch).toBe(1);
        await reader.query(`INSERT INTO ${CMD} (account_id, repo_id, kind, halt_epoch_at_issue) VALUES ($1, $2, 'pause_loop', $3)`, [a.accountId, r, staleRead]);
        const { rows } = await admin.query(`SELECT halt_epoch_at_issue AS e FROM ${CMD} WHERE repo_id = $1`, [r]);
        expect(rows.map((x) => x.e)).toEqual([1]);
      } finally {
        reader.release();
      }
    });

    it("a command inserted by a tenant session as app_user (the commands route's real path) is stamped with the current epoch", async () => {
      const r = await repo();
      const runnerId = (
        await admin.query<{ id: string }>(
          `INSERT INTO runners (account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, '{"kty":"OKP","crv":"Ed25519","x":"x"}', $3, 'api_key') RETURNING id`,
          [a.accountId, a.userId, Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43)],
        )
      ).rows[0]!.id;
      await asOwner(async (c) => { await setEngineHalt(c, r); await clearEngineHalt(c, r); await setEngineHalt(c, r); await clearEngineHalt(c, r); });
      expect((await control(r))!.halt_epoch).toBe(2);
      // The route's own read is stale (0); the trigger's helper runs as app_user under the tenant and must replace it.
      await asOwner((c) =>
        c.query(
          `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, expires_at, halt_epoch_at_issue)
           VALUES ($1, $2, $3, 1, 'pause_loop', '{}'::jsonb, $4, now() + interval '5 minutes', 0)`,
          [a.accountId, runnerId, r, a.userId],
        ),
      );
      const { rows } = await admin.query(`SELECT halt_epoch_at_issue AS e FROM engine_commands WHERE repo_id = $1`, [r]);
      expect(rows.map((x) => x.e)).toEqual([2]);
    });

    describe('1034: a tenant session gets the exact epoch, whatever it passes; no tenant keeps the higher stamp', () => {
      async function runner(): Promise<string> {
        return (
          await admin.query<{ id: string }>(
            `INSERT INTO runners (account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, '{"kty":"OKP","crv":"Ed25519","x":"x"}', $3, 'api_key') RETURNING id`,
            [a.accountId, a.userId, Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43)],
          )
        ).rows[0]!.id;
      }
      const insertReal = (c: PoolClient, runnerId: string, repoId: string, stamp: number, seq: number, issuer: string = a.userId) =>
        c.query(
          `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, expires_at, halt_epoch_at_issue)
           VALUES ($1, $2, $3, $4, 'pause_loop', '{}'::jsonb, $5, now() + interval '5 minutes', $6)`,
          [a.accountId, runnerId, repoId, seq, issuer, stamp],
        );
      const stored = async (repoId: string) => (await admin.query(`SELECT halt_epoch_at_issue AS e FROM engine_commands WHERE repo_id = $1 ORDER BY command_seq`, [repoId])).rows.map((x) => x.e);

      it('an owner session that stamps current + 5 and one that stamps low both store the current epoch', async () => {
        const r = await repo();
        const runnerId = await runner();
        await asOwner(async (c) => { await setEngineHalt(c, r); await clearEngineHalt(c, r); await setEngineHalt(c, r); await clearEngineHalt(c, r); });
        const current = (await control(r))!.halt_epoch as number;
        expect(current).toBe(2);
        await asOwner((c) => insertReal(c, runnerId, r, current + 5, 1));
        await asOwner((c) => insertReal(c, runnerId, r, 0, 2));
        expect(await stored(r)).toEqual([current, current]);
      });

      it('an admin session is held to the same rule as the owner', async () => {
        const r = await repo();
        const runnerId = await runner();
        const adminId = await member(a, 'admin');
        await asOwner((c) => setEngineHalt(c, r));
        await asOwner((c) => clearEngineHalt(c, r));
        await withTenant(appUserPool, a.accountId, adminId, (c) => insertReal(c, runnerId, r, 9, 1, adminId));
        expect(await stored(r)).toEqual([1]);
      });

      it('the owner connection with no tenant (the fixture path) keeps the higher stamp, and is still raised when it stamps low', async () => {
        const r = await repo();
        await asOwner(async (c) => { await setEngineHalt(c, r); await clearEngineHalt(c, r); });
        await insertCmd(r, 'pause_loop');
        await admin.query(`INSERT INTO ${CMD} (account_id, repo_id, kind, halt_epoch_at_issue) VALUES ($1, $2, 'pause_loop', 7)`, [a.accountId, r]);
        expect((await admin.query(`SELECT halt_epoch_at_issue AS e FROM ${CMD} WHERE repo_id = $1 ORDER BY halt_epoch_at_issue`, [r])).rows.map((x) => x.e)).toEqual([1, 7]);
      });
    });

    it('every kind is stamped, the allowed ones included, and a command with no marker row yet is stamped 0', async () => {
      const r = await repo();
      for (const kind of ['pause_loop', 'start_day']) await insertCmd(r, kind);
      expect((await admin.query(`SELECT halt_epoch_at_issue AS e FROM ${CMD} WHERE repo_id = $1`, [r])).rows.map((x) => x.e)).toEqual([0, 0]);
    });
  });

  describe('a decide or command racing a halt (0750\'s lock order)', () => {
    const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

    /** Opens a transaction on its own connection (the writer's) and inserts one decision; the caller commits. */
    async function openInsert(repoId: string): Promise<{ client: PoolClient; done: Promise<unknown> }> {
      const client = await adminPool.connect();
      await client.query('BEGIN');
      return { client, done: client.query(`INSERT INTO ${DEC} (account_id, repo_id) VALUES ($1, $2)`, [a.accountId, repoId]) };
    }

    for (const fresh of [true, false]) {
      it(`a decide in flight when the halt arrives commits first and the halt then lists it (${fresh ? 'no marker row yet' : 'marker row exists'})`, async () => {
        const r = await repo();
        if (!fresh) await asOwner(async (c) => { await setEngineHalt(c, r); await clearEngineHalt(c, r); });
        const writer = await openInsert(r);
        await writer.done; // inserted, not committed: it holds the share lock
        let haltReturned = false;
        const halt = asOwner((c) => setEngineHalt(c, r)).then((x) => { haltReturned = true; return x; });
        await settle();
        expect(haltReturned, 'the halt waits for the in-flight decide').toBe(false);
        await writer.client.query('COMMIT');
        writer.client.release();
        const result = await halt;
        expect(result.newly_halted).toBe(true);
        // The halt's list sees the decide; nothing lands after the halt.
        expect((await admin.query(`SELECT count(*)::int AS n FROM ${DEC} WHERE repo_id = $1`, [r])).rows[0].n).toBe(1);
        expect(isEngineHalted(await insertDec(r).then(() => null, (e: unknown) => e))).toBe(true);
      });

      it(`a decide that starts after the halt began waits for it and is refused (${fresh ? 'no marker row yet' : 'marker row exists'})`, async () => {
        const r = await repo();
        if (!fresh) await asOwner(async (c) => { await setEngineHalt(c, r); await clearEngineHalt(c, r); });
        let release!: () => void;
        const hold = new Promise<void>((res) => { release = res; });
        let marked!: () => void;
        const inHalt = new Promise<void>((res) => { marked = res; });
        const halt = asOwner(async (c) => {
          const out = await setEngineHalt(c, r);
          marked();
          await hold; // the halt's transaction stays open: halted, not committed
          return out;
        });
        await inHalt;
        const writer = await openInsert(r);
        let settled = false;
        const outcome = writer.done.then(() => 'inserted', (e: unknown) => (isEngineHalted(e) ? 'halted' : `other: ${(e as Error).message}`)).then((x) => { settled = true; return x; });
        await settle();
        expect(settled, 'the decide waits for the halt to finish').toBe(false);
        release();
        await halt;
        expect(await outcome).toBe('halted');
        await writer.client.query('ROLLBACK');
        writer.client.release();
        expect((await admin.query(`SELECT count(*)::int AS n FROM ${DEC} WHERE repo_id = $1`, [r])).rows[0].n).toBe(0);
      });
    }
  });

  describe('engine_halt_lock and engine_halt_epoch take the account from the session', () => {
    it("a session of one account cannot lock, read or create a marker for another account's repo (42501), on the API login and on the run writer", async () => {
      const theirs = await repo(b);
      const writer = createPool(process.env.DATABASE_URL_RUN_WRITER!);
      try {
        await expect(asOwner((c) => c.query(`SELECT engine_halt_lock($1, $2)`, [b.accountId, theirs]))).rejects.toMatchObject({ code: '42501' });
        await expect(withTenant(writer, a.accountId, (c) => c.query(`SELECT engine_halt_lock($1, $2)`, [b.accountId, theirs]))).rejects.toMatchObject({ code: '42501' });
        // The epoch helper holds the same account rule: another account's repo is refused, and the run writer's session is no exception.
        await expect(asOwner((c) => c.query(`SELECT engine_halt_epoch($1, $2)`, [b.accountId, theirs]))).rejects.toMatchObject({ code: '42501' });
        await expect(withTenant(writer, a.accountId, (c) => c.query(`SELECT engine_halt_epoch($1, $2)`, [b.accountId, theirs]))).rejects.toMatchObject({ code: '42501' });
        // Naming its own account with their repo is the FK's refusal, as before: still no marker, no answer.
        await expect(asOwner((c) => c.query(`SELECT engine_halt_lock($1, $2)`, [a.accountId, theirs]))).rejects.toMatchObject({ code: '23503' });
      } finally {
        await writer.end();
      }
      expect(await control(theirs)).toBeUndefined();
      expect(await withTenant(appUserPool, b.accountId, b.userId, (c) => setEngineHalt(c, theirs))).toMatchObject({ newly_halted: true });
    });

    it('an app_user session with no tenant is refused; its own account is answered; the migration owner with no tenant (a fixture) is answered', async () => {
      const mine = await repo();
      await expect(appUserPool.query(`SELECT engine_halt_lock($1, $2)`, [a.accountId, mine])).rejects.toMatchObject({ code: '42501' });
      await expect(appUserPool.query(`SELECT engine_halt_epoch($1, $2)`, [a.accountId, mine])).rejects.toMatchObject({ code: '42501' });
      const writerNoTenant = createPool(process.env.DATABASE_URL_RUN_WRITER!);
      try {
        await expect(writerNoTenant.query(`SELECT engine_halt_epoch($1, $2)`, [a.accountId, mine])).rejects.toMatchObject({ code: '42501' });
      } finally {
        await writerNoTenant.end();
      }
      expect((await admin.query(`SELECT engine_halt_epoch($1, $2) AS e`, [a.accountId, mine])).rows[0].e).toBe(0);
      expect(await asOwner((c) => lockEngineHaltForSession(c, mine))).toBe(false);
      expect((await admin.query(`SELECT engine_halt_lock($1, $2) AS h`, [a.accountId, mine])).rows[0].h).toBe(false);
      await asOwner((c) => setEngineHalt(c, mine));
      expect(await asOwner((c) => lockEngineHaltForSession(c, mine))).toBe(true);
    });
  });

  describe('a decide that answers without inserting (a replayed act, an approved ask) still loses to a halt', () => {
    const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
    // The route's shape: read the halt through the lock, then answer from a stored receipt. Neither case inserts, so the trigger never fires.
    const RECEIPTS = [
      { name: 'a replayed act receipt', answer: 'act' },
      { name: 'an ask a person approved', answer: 'act' },
    ] as const;

    for (const receipt of RECEIPTS) {
      it(`order 1, ${receipt.name}: the decide holds the share lock, the halt waits for it and commits after`, async () => {
        const r = await repo();
        const writer = createPool(process.env.DATABASE_URL_RUN_WRITER!);
        try {
          let release!: () => void;
          const hold = new Promise<void>((res) => { release = res; });
          let locked!: () => void;
          const inDecide = new Promise<void>((res) => { locked = res; });
          const decide = withTenant(writer, a.accountId, async (c) => {
            const halted = await lockEngineHaltForSession(c, r);
            locked();
            await hold; // answering from the stored receipt: no insert
            return halted ? 'halted' : receipt.answer;
          });
          await inDecide;
          let haltReturned = false;
          const halt = asOwner((c) => setEngineHalt(c, r)).then((x) => { haltReturned = true; return x; });
          await settle();
          expect(haltReturned, 'the halt waits for the decide in flight').toBe(false);
          release();
          expect(await decide).toBe(receipt.answer);
          expect((await halt).newly_halted).toBe(true);
          expect(await withTenant(writer, a.accountId, (c) => lockEngineHaltForSession(c, r))).toBe(true);
        } finally {
          await writer.end();
        }
      });

      it(`order 2, ${receipt.name}: the halt holds the row, the replaying decide blocks and then answers halted`, async () => {
        const r = await repo();
        const writer = createPool(process.env.DATABASE_URL_RUN_WRITER!);
        try {
          let release!: () => void;
          const hold = new Promise<void>((res) => { release = res; });
          let marked!: () => void;
          const inHalt = new Promise<void>((res) => { marked = res; });
          const halt = asOwner(async (c) => {
            const out = await setEngineHalt(c, r);
            marked();
            await hold; // halted, not committed
            return out;
          });
          await inHalt;
          let settled = false;
          const decide = withTenant(writer, a.accountId, async (c) => ((await lockEngineHaltForSession(c, r)) ? 'halted' : receipt.answer)).then((x) => { settled = true; return x; });
          await settle();
          expect(settled, 'the replay waits for the halt to finish').toBe(false);
          release();
          await halt;
          expect(await decide).toBe('halted');
        } finally {
          await writer.end();
        }
      });
    }
  });

  describe('the real tables', () => {
    it('engine_commands and engine_decisions each hold the refusing trigger, and the trigger functions are the migration owner\'s invoker functions', async () => {
      const { rows } = await admin.query<{ tbl: string; fn: string; owner: string; secdef: boolean }>(
        `SELECT t.tgrelid::regclass::text AS tbl, p.proname AS fn, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef
           FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE NOT t.tgisinternal AND t.tgrelid IN ('public.engine_commands'::regclass, 'public.engine_decisions'::regclass) AND p.proname LIKE 'engine\\_%\\_refuse\\_halted'`,
      );
      expect(rows.map((r) => `${r.tbl}:${r.fn}`).sort()).toEqual(['engine_commands:engine_commands_refuse_halted', 'engine_decisions:engine_decisions_refuse_halted']);
      const tableOwner = (await admin.query(`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'public.agent_runs'::regclass`)).rows[0].o;
      for (const r of rows) expect(r, r.fn).toMatchObject({ owner: tableOwner, secdef: false });
    });

    it('the lock and epoch helpers are callable by app_user, the run writer and the migration owner, and by nobody else', async () => {
      const tableOwner = (await admin.query(`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'public.agent_runs'::regclass`)).rows[0].o;
      for (const fn of ['engine_halt_lock', 'engine_halt_epoch']) {
        const { rows } = await admin.query<{ g: string }>(
          `SELECT pg_get_userbyid(x.grantee) AS g FROM pg_proc p, aclexplode(p.proacl) x WHERE p.proname = $1 AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner`,
          [fn],
        );
        expect(rows.map((r) => r.g).sort(), fn).toEqual(['agent_run_writer', 'app_user', tableOwner].sort());
      }
    });
  });

  describe('haltPending (the repo list\'s halt_pending, derived on read)', () => {
    it('is true while halted until a halt_applied event at or above the epoch arrives; never for a repo that is not halted', () => {
      expect(haltPending({ halted: true, halt_epoch: 3 }, null)).toBe(true);
      expect(haltPending({ halted: true, halt_epoch: 3 }, 2)).toBe(true);
      expect(haltPending({ halted: true, halt_epoch: 3 }, 3)).toBe(false);
      expect(haltPending({ halted: true, halt_epoch: 3 }, 4)).toBe(false);
      expect(haltPending({ halted: false, halt_epoch: 3 }, null)).toBe(false);
      expect(haltPending({ halted: false, halt_epoch: 0 }, 0)).toBe(false);
    });

    it('a second halt is pending again even though the first epoch was applied', () => {
      expect(haltPending({ halted: true, halt_epoch: 2 }, 1)).toBe(true);
    });
  });
});
