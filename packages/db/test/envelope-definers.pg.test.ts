import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#483 S5-e1: 0865. The one setter of work_items.envelope_id, the one writer of envelope_run_charges and the one writer of envelope_pause_asks,
 * and what app_user can no longer do to the three. The #301 review found app_user could insert a charge or a "raised" memory directly (hiding a
 * real charge, suppressing an ask) and that nothing stopped an INSERT of a work item that already named an envelope.
 */
describe('envelope definers (0865)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let memberId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    memberId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberId, `${memberId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [a.accountId, memberId]);
    await admin.query(`UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2`, [a.accountId, a.userId]);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end()]);
  });

  /** As a logged-in person of an account (the session shape every approval route runs in). */
  const asPerson = <T>(refs: SeedRefs, userId: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
    userId === null ? withTenant(appUserPool, refs.accountId, fn) : withTenant(appUserPool, refs.accountId, userId, fn);

  async function envelope(refs: SeedRefs, scope: 'item' | 'batch' | 'weekly_autostart' = 'item', repoId: string | null = refs.repoId): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, repo_id, scope, amount_usd, version, created_by) VALUES ($1, $2, $3, $4, 10, 1, $5)`, [id, refs.accountId, repoId, scope, refs.userId]);
    return id;
  }
  async function item(refs: SeedRefs, over: { stage?: string; envelope?: string | null } = {}): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, title, stage, envelope_id) VALUES ($1, $2, $3, 'issue', 'internal', 'T', $4, $5)`, [id, refs.accountId, refs.repoId, over.stage ?? 'triaged', over.envelope ?? null]);
    return id;
  }
  async function run(refs: SeedRefs, workItemId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'project-manager', 'local', 'pending')`, [id, refs.accountId, workItemId]);
    return id;
  }
  const setEnv = (refs: SeedRefs, userId: string | null, workItem: string, env: string) =>
    asPerson(refs, userId, async (c) => (await c.query<{ set: boolean }>('SELECT work_item_set_envelope($1::uuid, $2::uuid) AS set', [workItem, env])).rows[0]!.set);
  const itemEnvelope = async (id: string) => (await admin.query<{ envelope_id: string | null }>('SELECT envelope_id FROM work_items WHERE id = $1', [id])).rows[0]!.envelope_id;

  describe('grants and the shape of the role', () => {
    it('app_user holds SELECT and nothing else on the two tables it used to write', async () => {
      for (const table of ['envelope_run_charges', 'envelope_pause_asks']) {
        const { rows } = await admin.query<{ p: string; ok: boolean }>(
          `SELECT p, has_table_privilege('app_user', $1, p) AS ok FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`,
          [`public.${table}`],
        );
        expect(Object.fromEntries(rows.map((r) => [r.p, r.ok])), table).toEqual({ SELECT: true, INSERT: false, UPDATE: false, DELETE: false });
      }
    });

    it('app_user can set neither column nor row: an INSERT or UPDATE naming an envelope fails on privilege', async () => {
      const env = await envelope(a);
      const stray = await item(a);
      await expect(asPerson(a, a.userId, (c) => c.query(`UPDATE work_items SET envelope_id = $2 WHERE id = $1`, [stray, env]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        asPerson(a, a.userId, (c) =>
          c.query(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title, envelope_id) VALUES ($1, $2, 'issue', 'internal', 'T', $3)`, [a.accountId, a.repoId, env]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await itemEnvelope(stray)).toBeNull();
      // An INSERT that names no envelope is untouched (the approve path creates its work item this way).
      await expect(asPerson(a, a.userId, (c) => c.query(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'T')`, [a.accountId, a.repoId]))).resolves.toBeDefined();
    });

    it('app_user cannot insert a charge or an ask memory directly, with or without a real run and ask', async () => {
      const env = await envelope(a);
      const wi = await item(a, { envelope: env });
      const r = await run(a, wi);
      await expect(asPerson(a, a.userId, (c) => c.query(`INSERT INTO envelope_run_charges (account_id, run_id, envelope_id, usd) VALUES ($1, $2, $3, 0.0001)`, [a.accountId, r, env]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        asPerson(a, a.userId, (c) => c.query(`INSERT INTO envelope_pause_asks (account_id, work_item_id, envelope_id, envelope_version, ask_id) VALUES ($1, $2, $3, 1, $4)`, [a.accountId, wi, env, randomUUID()])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(Number((await admin.query('SELECT count(*) n FROM envelope_run_charges WHERE run_id = $1', [r])).rows[0].n)).toBe(0);
    });

    it('the three functions are owned by envelope_definer, pinned, and executable by app_user alone', async () => {
      const { rows } = await admin.query<{ name: string; owner: string; secdef: boolean; config: string[]; grantees: string[] }>(
        `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS config,
                COALESCE((SELECT array_agg(DISTINCT pg_get_userbyid(g.grantee)::text) FROM aclexplode(p.proacl) g WHERE g.grantee <> p.proowner), '{}') AS grantees
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('work_item_set_envelope', 'envelope_charge_record', 'envelope_pause_ask_record') ORDER BY p.proname`,
      );
      expect(rows.map((r) => r.name)).toEqual(['envelope_charge_record', 'envelope_pause_ask_record', 'work_item_set_envelope']);
      for (const r of rows) {
        expect(r, r.name).toMatchObject({ owner: 'envelope_definer', secdef: true, config: ['search_path=pg_catalog, public, pg_temp'], grantees: ['app_user'] });
      }
      const { rows: po } = await admin.query<{ ok: boolean }>(
        `SELECT bool_or(has_function_privilege('platform_ops', p.oid, 'EXECUTE')) AS ok FROM pg_proc p WHERE p.proname IN ('work_item_set_envelope', 'envelope_charge_record', 'envelope_pause_ask_record')`,
      );
      expect(po[0]!.ok).toBe(false);
    });

    it('the role is NOLOGIN and unprivileged, and the RLS inventory has no violation', async () => {
      const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'envelope_definer'`);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect(await findRlsViolations(admin)).toEqual([]);
    });
  });

  describe('work_item_set_envelope', () => {
    it('an owner sets it once at approval; the same call again changes nothing', async () => {
      const env = await envelope(a);
      const wi = await item(a);
      expect(await setEnv(a, a.userId, wi, env)).toBe(true);
      expect(await itemEnvelope(wi)).toBe(env);
      expect(await setEnv(a, a.userId, wi, env)).toBe(false);
      expect(await itemEnvelope(wi)).toBe(env);
    });

    it('a member, a session with no person, and an unknown caller are all refused (42501); the item is unchanged', async () => {
      const env = await envelope(a);
      const wi = await item(a);
      await expect(setEnv(a, memberId, wi, env)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(setEnv(a, null, wi, env)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(setEnv(a, randomUUID(), wi, env)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await itemEnvelope(wi)).toBeNull();
    });

    it('is refused for an item that has started: past triaged, or with any run', async () => {
      const env = await envelope(a);
      const moved = await item(a, { stage: 'discussing' });
      const ran = await item(a);
      await run(a, ran);
      for (const wi of [moved, ran]) {
        await expect(setEnv(a, a.userId, wi, env), wi).rejects.toMatchObject({ code: '55000', message: 'work_started' });
        expect(await itemEnvelope(wi)).toBeNull();
      }
    });

    it('is set once: a different envelope is refused, and so is the weekly auto-start scope, another repo, and an item envelope already taken', async () => {
      const env = await envelope(a);
      const other = await envelope(a);
      const wi = await item(a);
      await setEnv(a, a.userId, wi, env);
      await expect(setEnv(a, a.userId, wi, other)).rejects.toMatchObject({ code: '55000', message: 'envelope_already_set' });
      expect(await itemEnvelope(wi)).toBe(env);

      const fresh = await item(a);
      await expect(setEnv(a, a.userId, fresh, await envelope(a, 'weekly_autostart'))).rejects.toMatchObject({ code: '55000', message: 'envelope_scope' });
      const otherRepo = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, NULL, $3, 'team')`, [otherRepo, a.accountId, Math.floor(Math.random() * 1e9) + 7]);
      await expect(setEnv(a, a.userId, fresh, await envelope(a, 'item', otherRepo))).rejects.toMatchObject({ code: '55000', message: 'envelope_repo_mismatch' });
      await expect(setEnv(a, a.userId, fresh, env)).rejects.toMatchObject({ code: '55000', message: 'envelope_taken' });
      expect(await itemEnvelope(fresh)).toBeNull();
    });

    it('a batch envelope may be drawn on by many items', async () => {
      const env = await envelope(a, 'batch');
      const one = await item(a);
      const two = await item(a);
      expect(await setEnv(a, a.userId, one, env)).toBe(true);
      expect(await setEnv(a, a.userId, two, env)).toBe(true);
    });

    it('RLS: another account\'s item or envelope is not found, and nothing changes', async () => {
      const theirEnv = await envelope(b);
      const theirItem = await item(b);
      const myEnv = await envelope(a);
      const myItem = await item(a);
      await expect(setEnv(a, a.userId, theirItem, myEnv)).rejects.toMatchObject({ code: 'P0002' });
      await expect(setEnv(a, a.userId, myItem, theirEnv)).rejects.toMatchObject({ code: 'P0002' });
      expect(await itemEnvelope(theirItem)).toBeNull();
      expect(await itemEnvelope(myItem)).toBeNull();
    });

    it('a rolled-back approval leaves no envelope on the item', async () => {
      const env = await envelope(a);
      const wi = await item(a);
      await expect(
        asPerson(a, a.userId, async (c) => {
          await c.query('SELECT work_item_set_envelope($1::uuid, $2::uuid)', [wi, env]);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await itemEnvelope(wi)).toBeNull();
    });
  });

  describe('envelope_charge_record', () => {
    const charge = (refs: SeedRefs, runId: string, env: string, usd: number) =>
      asPerson(refs, null, async (c) => (await c.query<{ r: boolean }>('SELECT envelope_charge_record($1::uuid, $2::uuid, $3::numeric) AS r', [runId, env, usd])).rows[0]!.r);
    const stored = async (runId: string) => (await admin.query<{ usd: string }>('SELECT usd::text FROM envelope_run_charges WHERE run_id = $1', [runId])).rows.map((r) => Number(r.usd));

    it('records the charge of a run whose item draws on that envelope, once', async () => {
      const env = await envelope(a);
      const wi = await item(a, { envelope: env });
      const r = await run(a, wi);
      expect(await charge(a, r, env, 0.8)).toBe(true);
      expect(await stored(r)).toEqual([0.8]);
      expect(await charge(a, r, env, 0.8)).toBe(false);
      expect(await stored(r)).toEqual([0.8]);
    });

    it('a charge only goes up: a smaller figure written first can never hide the real one', async () => {
      const env = await envelope(a);
      const wi = await item(a, { envelope: env });
      const r = await run(a, wi);
      await charge(a, r, env, 0.0001);
      expect(await charge(a, r, env, 0.8)).toBe(true);
      expect(await stored(r)).toEqual([0.8]);
      expect(await charge(a, r, env, 0.3)).toBe(false);
      expect(await stored(r)).toEqual([0.8]);
    });

    it('refuses a run whose item draws on another envelope or none, a missing run, another account\'s run, and a nonsense figure', async () => {
      const env = await envelope(a);
      const wi = await item(a, { envelope: env });
      const r = await run(a, wi);
      const bare = await item(a);
      const bareRun = await run(a, bare);
      await expect(charge(a, r, await envelope(a), 1)).rejects.toMatchObject({ code: '55000', message: 'envelope_mismatch' });
      await expect(charge(a, bareRun, env, 1)).rejects.toMatchObject({ code: '55000', message: 'envelope_mismatch' });
      await expect(charge(a, randomUUID(), env, 1)).rejects.toMatchObject({ code: 'P0002' });
      const theirItem = await item(b, { envelope: await envelope(b) });
      const theirRun = await run(b, theirItem);
      await expect(charge(a, theirRun, env, 1)).rejects.toMatchObject({ code: 'P0002' });
      for (const usd of [0, -1, 100_000_000]) await expect(charge(a, r, env, usd), String(usd)).rejects.toMatchObject({ code: '22023' });
      expect(await stored(r)).toEqual([]);
      expect(await stored(bareRun)).toEqual([]);
    });
  });

  describe('envelope_pause_ask_record', () => {
    async function askFor(refs: SeedRefs, workItemId: string, type = 'spend_past_envelope'): Promise<string> {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO decision_asks (id, account_id, work_item_id, decision_type, options, proposed, rationale, input_trust_classes, raised_at, answer_due_at, timeout_outcome)
         VALUES ($1, $2, $3, $4, '[{"id":"a","label":"A"},{"id":"b","label":"B"}]', 'a', 'r', '[]', now(), now() + interval '1 day', 'stop_and_flag')`,
        [id, refs.accountId, workItemId, type],
      );
      return id;
    }
    const record = (refs: SeedRefs, wi: string, env: string, version: number, askId: string) =>
      asPerson(refs, null, async (c) => (await c.query<{ r: boolean }>('SELECT envelope_pause_ask_record($1::uuid, $2::uuid, $3::integer, $4::uuid) AS r', [wi, env, version, askId])).rows[0]!.r);

    it('records the memory beside a real spend_past_envelope ask, once per item and version', async () => {
      const env = await envelope(a);
      const wi = await item(a, { envelope: env });
      const ask = await askFor(a, wi);
      expect(await record(a, wi, env, 1, ask)).toBe(true);
      expect(await record(a, wi, env, 1, ask)).toBe(false);
      expect(Number((await admin.query('SELECT count(*) n FROM envelope_pause_asks WHERE work_item_id = $1', [wi])).rows[0].n)).toBe(1);
    });

    it('refuses a memory with no ask, an ask of another type or item, an unknown version, and another envelope', async () => {
      const env = await envelope(a);
      const wi = await item(a, { envelope: env });
      const other = await item(a, { envelope: env });
      await expect(record(a, wi, env, 1, randomUUID())).rejects.toMatchObject({ code: '55000', message: 'no_such_ask' });
      await expect(record(a, wi, env, 1, await askFor(a, wi, 'start_parent_item'))).rejects.toMatchObject({ code: '55000', message: 'no_such_ask' });
      await expect(record(a, wi, env, 1, await askFor(a, other))).rejects.toMatchObject({ code: '55000', message: 'no_such_ask' });
      const ask = await askFor(a, wi);
      await expect(record(a, wi, env, 2, ask)).rejects.toMatchObject({ code: 'P0002' });
      await expect(record(a, wi, await envelope(a), 1, ask)).rejects.toMatchObject({ code: '55000', message: 'envelope_mismatch' });
      expect(Number((await admin.query('SELECT count(*) n FROM envelope_pause_asks WHERE work_item_id = $1', [wi])).rows[0].n)).toBe(0);
    });

    it('RLS: another account\'s item is not found', async () => {
      const theirEnv = await envelope(b);
      const theirItem = await item(b, { envelope: theirEnv });
      const ask = await askFor(b, theirItem);
      await expect(record(a, theirItem, theirEnv, 1, ask)).rejects.toMatchObject({ code: 'P0002' });
    });
  });
});
