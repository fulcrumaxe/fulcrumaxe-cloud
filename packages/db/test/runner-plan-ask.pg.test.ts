import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { raiseAsk } from '../src/decisionAsks.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * [pg] D#7 DW-R7 (migration 0982): `runner_plan_asks` and its one writer, `runner_plan_ask_record`, owned by `runner_plan_ask_definer`. The threat is a login
 * naming a plan holder it does not own, or an ask the run is not waiting on: the holder is read from the runner's registrant, the table has no direct writer,
 * and a runner, run or ask of another account is never visible to the call.
 */
const ROLE = 'runner_plan_ask_definer';
const LOGIN = 'fx_runner_plan_ask_db_test';
const FENCED = '<<UNTRUSTED EXTERNAL CONTENT>>\nx\n<<END UNTRUSTED>>';
const OPTIONS = [{ id: 'approve', label: 'Yes' }, { id: 'decline', label: 'No' }];
const PRIVILEGES = [
  'column accounts.id SELECT', 'column accounts.deleted_at SELECT',
  ...['id', 'account_id', 'dispatch_repo_id', 'status', 'runtime', 'approved_by', 'runner_id'].map((c) => `column agent_runs.${c} SELECT`),
  ...['id', 'account_id', 'registered_by', 'credential_mode', 'allowed_repo_ids', 'revoked_at'].map((c) => `column runners.${c} SELECT`),
  ...['account_id', 'user_id', 'role'].map((c) => `column account_members.${c} SELECT`),
  ...['account_id', 'repo_id', 'decision_type', 'disposition', 'version'].map((c) => `column decision_settings.${c} SELECT`),
  // state and answered_option (and runner_plan_asks.ask_id) are 0987's: runner_plan_declined reads whether the ask was answered with anything but "approve".
  ...['id', 'account_id', 'run_id', 'decision_type', 'state', 'answered_option'].map((c) => `column decision_asks.${c} SELECT`),
  ...['account_id', 'run_id', 'ask_id'].map((c) => `column runner_plan_asks.${c} SELECT`),
  ...['account_id', 'run_id', 'ask_id', 'runner_id', 'plan_holder'].map((c) => `column runner_plan_asks.${c} INSERT`),
  'schema public USAGE',
].sort();

describe('migration 0982: the member-plan ask record [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let writerPool: Pool;
  let receiptPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let holder: string;
  let runner: string;
  let run: string;
  let ask: string;

  async function user(accountId: string, role: 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, id, role]);
    return id;
  }
  async function seedRun(t: SeedRefs, registrant: string): Promise<{ runner: string; run: string }> {
    const r = await insertRunner(admin, t.accountId, registrant, { credentialMode: 'subscription' });
    await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1', [r, [t.repoId]]);
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, work_item_id) VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local', $3, $4)`, [id, t.accountId, t.repoId, t.workItemId]);
    await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, 'runner_run_on_member_plan', 'ask', 1, $3)`, [t.accountId, t.repoId, t.userId]);
    return { runner: r, run: id };
  }
  const raise = (t: SeedRefs, runId: string, type = 'runner_run_on_member_plan'): Promise<string> =>
    withTenant(receiptPool, t.accountId, (c) => raiseAsk(c, { class: 'human_over_the_loop', decisionType: type, workItemId: t.workItemId, runId, options: OPTIONS, proposed: 'approve', rationale: FENCED, quotedInputs: [{ trust: 'untrusted', storedBody: FENCED }] }));
  const record = (t: SeedRefs, a: string, r: string, rn: string, pool: Pool = appPool) => withTenant(pool, t.accountId, (c) => c.query('SELECT runner_plan_ask_record($1, $2, $3) AS ok', [a, r, rn]));
  const rows = async (accountId: string) => (await admin.query('SELECT * FROM runner_plan_asks WHERE account_id = $1', [accountId])).rows;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end(), writerPool.end(), receiptPool.end()]);
  });
  beforeEach(async () => {
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    holder = await user(A.accountId, 'admin');
    ({ runner, run } = await seedRun(A, holder));
    ask = await raise(A, run);
  });

  it('the role is a no-login role with exactly the column grants of the migration, owning exactly its two functions (0987 adds runner_plan_declined)', async () => {
    const r = (await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE])).rows[0];
    expect(r).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    const held = await admin.query<{ x: string }>(
      `SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type AS x FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a WHERE a.grantee = $1::regrole
        UNION ALL SELECT 'table ' || c.relname || ' ' || a.privilege_type FROM pg_class c, aclexplode(c.relacl) a WHERE a.grantee = $1::regrole
        UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.grantee = $1::regrole AND n.nspname = 'public'`, [ROLE]);
    expect(held.rows.map((x) => x.x).sort()).toEqual(PRIVILEGES);
    const owned = await admin.query<{ proname: string }>(`SELECT proname FROM pg_proc WHERE proowner = $1::regrole`, [ROLE]);
    expect(owned.rows.map((x) => x.proname).sort()).toEqual(['runner_plan_ask_record', 'runner_plan_declined']);
    expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rows).toEqual([]);
  });

  it('EXECUTE is held by app_user and the owner only: not PUBLIC, not platform_ops, not the partner login', async () => {
    const f = 'public.runner_plan_ask_record(uuid,uuid,uuid)';
    const can = async (role: string) => (await admin.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, f])).rows[0]!.ok;
    expect(await can('app_user')).toBe(true);
    for (const role of ['platform_ops', 'partner_user', 'public']) expect(await can(role), role).toBe(false);
    await expect(record(A, ask, run, runner, opsPool)).rejects.toThrow(/permission denied|platform_ops/);
  });

  it('writes the holder from the runner\'s registrant, once; a repeat writes nothing and says false', async () => {
    expect((await record(A, ask, run, runner)).rows[0]!.ok).toBe(true);
    expect(await rows(A.accountId)).toEqual([expect.objectContaining({ run_id: run, ask_id: ask, runner_id: runner, plan_holder: holder })]);
    expect((await record(A, ask, run, runner)).rows[0]!.ok).toBe(false);
    expect(await rows(A.accountId)).toHaveLength(1);
  });

  it('a deleted holder leaves the ask and its record, with no holder named (the Needs you list then shows a former team member and no one can answer)', async () => {
    const T = await seedAccount(admin, randomUUID());
    const gone = await user(T.accountId, 'admin');
    const s = await seedRun(T, gone);
    const a = await raise(T, s.run);
    expect((await record(T, a, s.run, s.runner)).rows[0]!.ok).toBe(true);
    await admin.query('DELETE FROM runners WHERE id = $1', [s.runner]);
    await admin.query('DELETE FROM users WHERE id = $1', [gone]);
    expect((await admin.query('SELECT plan_holder FROM runner_plan_asks WHERE ask_id = $1', [a])).rows).toEqual([{ plan_holder: null }]);
    expect((await admin.query('SELECT 1 FROM decision_asks WHERE id = $1', [a])).rowCount).toBe(1);
  });

  it('nobody else can write the table: not app_user, not the run writer, not platform_ops; so a holder cannot be named by the caller', async () => {
    const other = await user(A.accountId, 'admin');
    const insert = (pool: Pool) => withTenant(pool, A.accountId, (c) => c.query('INSERT INTO runner_plan_asks (account_id, run_id, ask_id, runner_id, plan_holder) VALUES ($1, $2, $3, $4, $5)', [A.accountId, run, ask, runner, other]));
    for (const pool of [appPool, writerPool, opsPool]) await expect(insert(pool)).rejects.toThrow(/permission denied/);
    await expect(withTenant(appPool, A.accountId, (c) => c.query('UPDATE runner_plan_asks SET plan_holder = $1', [other]))).rejects.toThrow(/permission denied/);
    await expect(withTenant(appPool, A.accountId, (c) => c.query('DELETE FROM runner_plan_asks'))).rejects.toThrow(/permission denied/);
    expect(await rows(A.accountId)).toEqual([]);
  });

  it('is tenant-bound: another account\'s runner, run or ask is not found, and app_user reads only its own rows', async () => {
    const theirs = await seedRun(B, await user(B.accountId, 'admin'));
    const theirAsk = await raise(B, theirs.run);
    await expect(record(A, ask, run, theirs.runner)).rejects.toThrow(/no_plan_holder/);
    await expect(record(A, ask, theirs.run, runner)).rejects.toThrow(/run_not_waiting/);
    await expect(record(A, theirAsk, run, runner)).rejects.toThrow(/no_such_ask/);
    await record(B, theirAsk, theirs.run, theirs.runner);
    await record(A, ask, run, runner);
    const seen = await withTenant(appPool, A.accountId, (c) => c.query('SELECT account_id FROM runner_plan_asks'));
    expect(seen.rows).toEqual([{ account_id: A.accountId }]);
    expect(await withTenant(appPool, B.accountId, (c) => c.query('SELECT 1 FROM runner_plan_asks WHERE run_id = $1', [run]))).toMatchObject({ rowCount: 0 });
  });

  it.each([
    ['a decision of another kind', async () => raise(A, run, 'test_strategy_choice'), /no_such_ask/],
    ['a revoked runner', async () => { await admin.query(`UPDATE runners SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1`, [runner]); return ask; }, /no_plan_holder/],
    ['an api-key runner', async () => { await admin.query(`UPDATE runners SET credential_mode = 'api_key' WHERE id = $1`, [runner]); return ask; }, /no_plan_holder/],
    ['a registrant who is only a member', async () => { await admin.query(`UPDATE account_members SET role = 'member' WHERE user_id = $1`, [holder]); return ask; }, /no_plan_holder/],
    ['a repo the runner does not list', async () => { await admin.query(`UPDATE runners SET allowed_repo_ids = '{}'`); return ask; }, /no_plan_holder/],
    ['a run that is no longer pending', async () => { await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [run]); return ask; }, /run_not_waiting/],
    ['a run already approved', async () => { await admin.query(`UPDATE agent_runs SET approved_by = $2 WHERE id = $1`, [run, holder]); return ask; }, /run_not_waiting/],
    ['a dial that is not ask', async () => { await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, 'runner_run_on_member_plan', 'act', 2, $3)`, [A.accountId, A.repoId, A.userId]); return ask; }, /dial_not_ask/],
  ])('refuses %s and writes nothing', async (_name, arrange, message) => {
    const target = await arrange();
    await expect(record(A, target, run, runner)).rejects.toThrow(message);
    expect(await rows(A.accountId)).toEqual([]);
  });
});
