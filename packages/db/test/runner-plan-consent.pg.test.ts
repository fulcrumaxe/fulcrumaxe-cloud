import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGUE, CATALOGUE_VERSION } from '@fx/decisions';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * [pg] D#6 R2b-4a (migration 0767, C31 section 2): the consent record and its definer, the shared auto-approval check, and the
 * claim's write. Everything is exercised through the real logins (app_user, the run writer, platform_ops) and the real definers.
 */
const CONSENT_ROLE = 'runner_consent_definer';
const APPROVE_ROLE = 'runner_auto_approve_definer';

const CONSENT_PRIVILEGES = [
  ...['id', 'account_id', 'registered_by', 'allowed_repo_ids', 'revoked_at'].map((c) => `column runners.${c} SELECT`),
  ...['account_id', 'user_id'].map((c) => `column account_members.${c} SELECT`),
  ...['account_id', 'runner_id', 'granted', 'version', 'created_at'].map((c) => `column runner_plan_consents.${c} SELECT`),
  ...['account_id', 'runner_id', 'granted', 'version', 'changed_by'].map((c) => `column runner_plan_consents.${c} INSERT`),
  ...['account_id', 'actor', 'action', 'payload', 'created_at'].map((c) => `column audit_log.${c} INSERT`),
  'column accounts.id SELECT',
  'column accounts.deleted_at SELECT',
  'schema public USAGE',
].sort();

const APPROVE_PRIVILEGES = [
  ...['id', 'account_id', 'work_item_id', 'dispatch_repo_id', 'status', 'runtime', 'execution_mode', 'approved_by', 'runner_id', 'claimable_after'].map((c) => `column agent_runs.${c} SELECT`),
  'column agent_runs.approved_by UPDATE',
  'column agent_runs.updated_at UPDATE',
  ...['id', 'account_id', 'registered_by', 'credential_mode', 'allowed_repo_ids', 'revoked_at'].map((c) => `column runners.${c} SELECT`),
  ...['account_id', 'user_id'].map((c) => `column account_members.${c} SELECT`),
  ...['account_id', 'runner_id', 'granted', 'version'].map((c) => `column runner_plan_consents.${c} SELECT`),
  ...['account_id', 'repo_id', 'decision_type', 'disposition', 'version'].map((c) => `column decision_settings.${c} SELECT`),
  ...['account_id', 'actor', 'action', 'payload', 'created_at'].map((c) => `column audit_log.${c} INSERT`),
  'column accounts.id SELECT',
  'column accounts.deleted_at SELECT',
  'schema public USAGE',
].sort();

describe('migration 0767: runner plan consent [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writerPool: Pool;
  let opsPool: Pool;
  let A: SeedRefs;
  let adminUser: string;
  let member: string;
  let registrant: string;
  let runner: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, writerPool, opsPool]) await p.end();
  });

  async function user(role: 'admin' | 'member' | null): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    if (role) await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [A.accountId, id, role]);
    return id;
  }
  beforeEach(async () => {
    A = await seedAccount(admin, randomUUID());
    adminUser = await user('admin');
    member = await user('member');
    registrant = await user('member');
    runner = await insertRunner(admin, A.accountId, registrant, { credentialMode: 'subscription' });
    await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1', [runner, [A.repoId]]);
  });

  const asUser = <T>(who: string, fn: (c: PoolClient) => Promise<T>, accountId = A.accountId): Promise<T> => withTenant(appPool, accountId, who, fn);
  const setConsent = (who: string, id: string, granted: boolean) =>
    asUser(who, async (c) => (await c.query('SELECT * FROM runner_plan_consent_set($1, $2)', [id, granted])).rows[0] as { changed: boolean; consent_version: number; changed_at: Date | null });
  const consents = async (id = runner) => (await admin.query('SELECT granted, version, changed_by FROM runner_plan_consents WHERE runner_id = $1 ORDER BY version', [id])).rows;
  const audit = async (action: string) => (await admin.query('SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2 ORDER BY created_at', [A.accountId, action])).rows;
  /** The check the claim and the read model share, called as the run writer. */
  const approvable = (runnerId = runner, repoId = A.repoId) => withTenant(writerPool, A.accountId, async (c) => (await c.query('SELECT runner_plan_auto_approvable($1, $2) AS ok', [runnerId, repoId])).rows[0].ok as boolean);
  const dial = (disposition: string, repoId = A.repoId) =>
    admin.query(
      `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by)
       VALUES ($1, $2, 'runner_run_on_member_plan', $3, (SELECT COALESCE(max(version), 0) + 1 FROM decision_settings WHERE repo_id = $2 AND decision_type = 'runner_run_on_member_plan'), $4)`,
      [A.accountId, repoId, disposition, A.userId],
    );
  async function pendingRun(o: { status?: string; mode?: string; approvedBy?: string | null; claimableAfter?: Date | null } = {}): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, work_item_id, approved_by, claimable_after)
       VALUES ($1, $2, 'executor', 'runner', $3, $4, $5, $6, $7, $8)`,
      [id, A.accountId, o.status ?? 'pending', o.mode ?? 'runner_local', A.repoId, A.workItemId, o.approvedBy ?? null, o.claimableAfter ?? null],
    );
    return id;
  }
  const approve = (runId: string, runnerId = runner, now = new Date()) =>
    withTenant(writerPool, A.accountId, async (c) => (await c.query('SELECT agent_run_runner_auto_approve($1, $2, $3, $4) AS ok', [runId, runnerId, now, CATALOGUE_VERSION])).rows[0].ok as boolean);
  const approvedBy = async (runId: string) => (await admin.query('SELECT approved_by FROM agent_runs WHERE id = $1', [runId])).rows[0].approved_by as string | null;

  describe('the roles and the table', () => {
    it.each([
      [CONSENT_ROLE, ['runner_plan_consent_set(uuid,boolean)'], CONSENT_PRIVILEGES, []],
      [APPROVE_ROLE, ['runner_plan_auto_approvable(uuid,uuid)', 'agent_run_runner_auto_approve(uuid,uuid,timestamp with time zone,integer)'], APPROVE_PRIVILEGES, ['receipt_writer_invoker']],
    ])('%s is NOLOGIN and unprivileged, memberless, owns exactly its functions, holds exactly its column grants and cannot create', async (role, owned, privileges, memberOf) => {
      const attrs = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [role]);
      expect(attrs.rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole`, [role])).rowCount, 'members').toBe(0);
      const memberships = await admin.query<{ r: string }>(`SELECT pg_get_userbyid(roleid) AS r FROM pg_auth_members WHERE member = $1::regrole`, [role]);
      expect(memberships.rows.map((r) => r.r)).toEqual(memberOf);
      const fns = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole`, [role]);
      expect(fns.rows.map((r) => r.sig).sort()).toEqual([...owned].sort());
      expect((await admin.query(`SELECT 1 FROM pg_class WHERE relowner = $1::regrole UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner = $1::regrole`, [role])).rowCount).toBe(0);
      expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [role])).rows[0].ok).toBe(false);
      const held = await admin.query<{ x: string }>(
        `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
         SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
           FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'`,
        [role],
      );
      expect(held.rows.map((r) => r.x).sort()).toEqual(privileges);
    });

    it('the definers are SECURITY DEFINER with a pinned search_path, EXECUTE only for the logins that call each, and no grant option', async () => {
      const want: Record<string, string[]> = {
        'runner_plan_consent_set(uuid,boolean)': ['app_user'],
        'runner_plan_auto_approvable(uuid,uuid)': ['agent_run_writer', 'app_user'],
        'agent_run_runner_auto_approve(uuid,uuid,timestamp with time zone,integer)': ['agent_run_writer'],
      };
      for (const [sig, grantees] of Object.entries(want)) {
        const { rows } = await admin.query<{ prosecdef: boolean; proconfig: string[] | null; grantees: string[]; grantable: boolean }>(
          `SELECT p.prosecdef, p.proconfig,
                  coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '{}') AS grantees,
                  coalesce((SELECT bool_or(a.is_grantable) FROM aclexplode(p.proacl) a), false) AS grantable
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [sig],
        );
        expect(rows[0]!.prosecdef, sig).toBe(true);
        expect(rows[0]!.proconfig, sig).toEqual(['search_path=pg_catalog, public, pg_temp']);
        expect([...rows[0]!.grantees].sort(), sig).toEqual(grantees);
        expect(rows[0]!.grantable, sig).toBe(false);
        for (const who of ['platform_ops', 'partner_user']) expect((await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [who, sig])).rows[0].ok, `${who} ${sig}`).toBe(false);
      }
    });

    it('the direct grantees of INSERT on decision_receipts are still exactly {receipt_writer}: the receipt goes through the existing definer', async () => {
      const { rows } = await admin.query<{ g: string }>(`SELECT pg_get_userbyid(a.grantee) AS g FROM pg_class c, aclexplode(c.relacl) a WHERE c.relname = 'decision_receipts' AND a.privilege_type = 'INSERT' AND a.grantee <> c.relowner`);
      expect(rows.map((r) => r.g)).toEqual(['receipt_writer']);
      expect((await admin.query(`SELECT has_table_privilege($1, 'decision_receipts', 'INSERT') AS ok`, [APPROVE_ROLE])).rows[0].ok).toBe(false);
    });

    it('runner_plan_consents is row-secured and forced, and app_user holds SELECT and nothing else; platform_ops holds nothing and has no policy', async () => {
      const t = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'runner_plan_consents'::regclass`);
      expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const grants = async (who: string) =>
        (await admin.query<{ p: string }>(`SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege($1, 'runner_plan_consents', p)`, [who])).rows.map((r) => r.p);
      expect(await grants('app_user')).toEqual(['SELECT']);
      expect(await grants('platform_ops')).toEqual([]);
      expect(await grants('agent_run_writer')).toEqual([]);
      const pol = await admin.query<{ roles: string[] }>(`SELECT roles::text[] AS roles FROM pg_policies WHERE tablename = 'runner_plan_consents'`);
      expect(pol.rows.flatMap((r) => r.roles).sort()).toEqual(['app_user', 'runner_auto_approve_definer', 'runner_consent_definer', 'runner_consent_definer']);
    });
  });

  describe('runner_plan_consent_set (C31 acceptance 1)', () => {
    it('refuses 42501 for an owner and for an admin who did not register the runner, for another member, and for a platform_ops login', async () => {
      for (const who of [A.userId, adminUser, member]) await expect(setConsent(who, runner, true), who).rejects.toMatchObject({ code: '42501' });
      expect(await consents()).toEqual([]);
      await expect(withTenant(opsPool, A.accountId, registrant, (c) => c.query('SELECT * FROM runner_plan_consent_set($1, true)', [runner]))).rejects.toThrow();
      expect(await consents()).toEqual([]);
    });

    it('refuses a caller who is not a member of the account, and an unknown or revoked runner is P0002', async () => {
      const stranger = await user(null);
      await expect(setConsent(stranger, runner, true)).rejects.toMatchObject({ code: '42501' });
      await expect(setConsent(registrant, randomUUID(), true)).rejects.toMatchObject({ code: 'P0002' });
      const revoked = await insertRunner(admin, A.accountId, registrant);
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [revoked]);
      await expect(setConsent(registrant, revoked, true)).rejects.toMatchObject({ code: 'P0002' });
      // an owner who is not the registrant meets the missing runner first, not a permission answer about a runner that is gone
      await expect(setConsent(A.userId, revoked, true)).rejects.toMatchObject({ code: 'P0002' });
    });

    it('as the registrant writes version n+1 with changed_by = the caller and one audit row naming the runner, the state and the repo list', async () => {
      expect(await setConsent(registrant, runner, true)).toMatchObject({ changed: true, consent_version: 1 });
      expect(await setConsent(registrant, runner, false)).toMatchObject({ changed: true, consent_version: 2 });
      expect(await setConsent(registrant, runner, true)).toMatchObject({ changed: true, consent_version: 3 });
      expect(await consents()).toEqual([
        { granted: true, version: 1, changed_by: registrant },
        { granted: false, version: 2, changed_by: registrant },
        { granted: true, version: 3, changed_by: registrant },
      ]);
      const rows = await audit('runner.plan_consent_changed');
      expect(rows).toHaveLength(3);
      expect(rows[2]).toEqual({ actor: registrant, payload: { runner_id: runner, granted: true, version: 3, repo_ids: [A.repoId] } });
    });

    it('a write that changes nothing writes nothing: withdrawing what was never on, granting what is on', async () => {
      expect(await setConsent(registrant, runner, false)).toMatchObject({ changed: false, consent_version: 0 });
      expect(await setConsent(registrant, runner, true)).toMatchObject({ changed: true, consent_version: 1 });
      expect(await setConsent(registrant, runner, true)).toMatchObject({ changed: false, consent_version: 1 });
      expect(await consents()).toHaveLength(1);
      expect(await audit('runner.plan_consent_changed')).toHaveLength(1);
    });

    it('is append-only for app_user: no UPDATE, DELETE or INSERT, and the registrant sees only their own account\'s rows', async () => {
      await setConsent(registrant, runner, true);
      for (const sql of ['UPDATE runner_plan_consents SET granted = false', 'DELETE FROM runner_plan_consents', `INSERT INTO runner_plan_consents (account_id, runner_id, granted, version, changed_by) VALUES ('${A.accountId}', '${runner}', true, 9, '${registrant}')`]) {
        await expect(asUser(registrant, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
      }
      const other = await seedAccount(admin, randomUUID());
      expect((await asUser(other.userId, (c) => c.query('SELECT 1 FROM runner_plan_consents'), other.accountId)).rowCount).toBe(0);
      expect((await asUser(registrant, (c) => c.query('SELECT 1 FROM runner_plan_consents'))).rowCount).toBe(1);
      await expect(opsPool.query('SELECT 1 FROM runner_plan_consents')).rejects.toMatchObject({ code: '42501' });
    });

    it('a re-registered runner has a new id and starts with consent off (C31 acceptance 6)', async () => {
      await setConsent(registrant, runner, true);
      expect(await approvable()).toBe(true);
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [runner]);
      const again = await insertRunner(admin, A.accountId, registrant, { credentialMode: 'subscription' });
      await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1', [again, [A.repoId]]);
      expect(await approvable(runner)).toBe(false);
      expect(await approvable(again)).toBe(false);
    });
  });

  describe('runner_plan_auto_approvable: the conditions of C31 section 2.2, one at a time', () => {
    it('is false with no consent, true once granted, false again when withdrawn', async () => {
      expect(await approvable()).toBe(false);
      await setConsent(registrant, runner, true);
      expect(await approvable()).toBe(true);
      await setConsent(registrant, runner, false);
      expect(await approvable()).toBe(false);
    });

    it('needs a live subscription runner that lists the repo', async () => {
      await setConsent(registrant, runner, true);
      expect(await approvable(runner, randomUUID())).toBe(false);
      await admin.query(`UPDATE runners SET credential_mode = 'api_key' WHERE id = $1`, [runner]);
      expect(await approvable()).toBe(false);
      await admin.query(`UPDATE runners SET credential_mode = 'subscription', allowed_repo_ids = '{}' WHERE id = $1`, [runner]);
      expect(await approvable()).toBe(false);
      await admin.query(`UPDATE runners SET allowed_repo_ids = $2::uuid[], revoked_at = now() WHERE id = $1`, [runner, [A.repoId]]);
      expect(await approvable()).toBe(false);
    });

    it('needs the registrant to still be a member of the account', async () => {
      await setConsent(registrant, runner, true);
      expect(await approvable()).toBe(true);
      await admin.query('DELETE FROM account_members WHERE user_id = $1 AND account_id = $2', [registrant, A.accountId]);
      // Removing a member also revokes their runners (0712's trigger); put the runner back so this checks the membership condition alone.
      await admin.query('UPDATE runners SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1', [runner]);
      expect(await approvable()).toBe(false);
    });

    it('follows the repo dial: no row is announce (the catalogue default), announce and act approve, ask does not, and the newest version decides', async () => {
      await setConsent(registrant, runner, true);
      // The SQL default is a constant; this pins it to the catalogue so the two cannot drift.
      expect(CATALOGUE.find((e) => e.id === 'runner_run_on_member_plan')?.defaultDisposition).toBe('announce');
      expect(await approvable()).toBe(true);
      await dial('ask');
      expect(await approvable()).toBe(false);
      await dial('act');
      expect(await approvable()).toBe(true);
      await dial('announce');
      expect(await approvable()).toBe(true);
      await dial('ask');
      expect(await approvable()).toBe(false);
    });

    it('reads the dial of the run\'s repo only', async () => {
      await setConsent(registrant, runner, true);
      const other = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 2, 'team')`, [other, A.accountId, A.installationId]);
      await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1', [runner, [A.repoId, other]]);
      await dial('ask', other);
      expect(await approvable(runner, A.repoId)).toBe(true);
      expect(await approvable(runner, other)).toBe(false);
    });

    it('refuses a platform_ops login, and answers false outside any account context', async () => {
      await expect(withTenant(opsPool, A.accountId, (c) => c.query('SELECT runner_plan_auto_approvable($1, $2)', [runner, A.repoId]))).rejects.toThrow();
      const { rows } = await writerPool.query('SELECT runner_plan_auto_approvable($1, $2) AS ok', [runner, A.repoId]);
      expect(rows[0].ok).toBe(false);
    });
  });

  describe('agent_run_runner_auto_approve: the claim\'s write', () => {
    beforeEach(async () => {
      await setConsent(registrant, runner, true);
    });

    it('approves a pending run for the registrant and writes one audit row and one class 2 receipt', async () => {
      await dial('act');
      const run = await pendingRun();
      expect(await approve(run)).toBe(true);
      expect(await approvedBy(run)).toBe(registrant);
      expect(await audit('runner.run_auto_approved')).toEqual([{ actor: registrant, payload: { run_id: run, runner_id: runner, consent_version: 1, dial_version: 1, disposition: 'act' } }]);
      const receipts = await admin.query('SELECT class, decision_type, chosen, rejected_alternative, dial_version, actor, catalogue_version, work_item_id FROM decision_receipts WHERE run_id = $1', [run]);
      expect(receipts.rows).toEqual([
        { class: 'human_over_the_loop', decision_type: 'runner_run_on_member_plan', chosen: 'act', rejected_alternative: 'ask', dial_version: 1, actor: 'policy', catalogue_version: CATALOGUE_VERSION, work_item_id: A.workItemId },
      ]);
    });

    it('with no dial row it approves under the default, and the receipt has no dial version', async () => {
      const run = await pendingRun();
      expect(await approve(run)).toBe(true);
      const receipts = await admin.query('SELECT chosen, dial_version FROM decision_receipts WHERE run_id = $1', [run]);
      expect(receipts.rows).toEqual([{ chosen: 'announce', dial_version: null }]);
      expect((await audit('runner.run_auto_approved'))[0]!.payload).toMatchObject({ dial_version: null, disposition: 'announce' });
    });

    it('writes nothing when any condition fails: dial ask, no consent, other state of the run, an approver already there, a future claimable_after', async () => {
      const cases: Array<[string, () => Promise<string>]> = [
        ['not pending', () => pendingRun({ status: 'running' })],
        ['not runner_local', () => pendingRun({ mode: 'sandbox' })],
        ['already approved by someone', () => pendingRun({ approvedBy: member })],
        ['claimable later', () => pendingRun({ claimableAfter: new Date(Date.now() + 3600_000) })],
      ];
      for (const [label, make] of cases) {
        const run = await make();
        expect(await approve(run), label).toBe(false);
        expect(await approvedBy(run), label).toBe(label === 'already approved by someone' ? member : null);
      }
      const ask = await pendingRun();
      await dial('ask');
      expect(await approve(ask)).toBe(false);
      await dial('announce');
      await setConsent(registrant, runner, false);
      expect(await approve(ask)).toBe(false);
      expect(await approve(randomUUID())).toBe(false);
      expect(await approvedBy(ask)).toBeNull();
      expect(await audit('runner.run_auto_approved')).toEqual([]);
      expect((await admin.query('SELECT 1 FROM decision_receipts WHERE account_id = $1 AND decision_type = $2', [A.accountId, 'runner_run_on_member_plan'])).rowCount).toBe(0);
    });

    it('a claimable_after in the past, or exactly now, no longer holds the run back', async () => {
      const now = new Date();
      expect(await approve(await pendingRun({ claimableAfter: new Date(now.getTime() - 1000) }), runner, now)).toBe(true);
      expect(await approve(await pendingRun({ claimableAfter: now }), runner, now)).toBe(true);
    });

    it('approves a run once: a second call finds an approver and writes nothing more', async () => {
      const run = await pendingRun();
      expect(await approve(run)).toBe(true);
      expect(await approve(run)).toBe(false);
      expect(await audit('runner.run_auto_approved')).toHaveLength(1);
      expect((await admin.query('SELECT 1 FROM decision_receipts WHERE run_id = $1', [run])).rowCount).toBe(1);
    });

    it('is callable by the run writer alone: app_user and platform_ops cannot run it', async () => {
      const run = await pendingRun();
      await expect(asUser(registrant, (c) => c.query('SELECT agent_run_runner_auto_approve($1, $2, now(), 1)', [run, runner]))).rejects.toMatchObject({ code: '42501' });
      await expect(withTenant(opsPool, A.accountId, (c) => c.query('SELECT agent_run_runner_auto_approve($1, $2, now(), 1)', [run, runner]))).rejects.toThrow();
      expect(await approvedBy(run)).toBeNull();
    });

    it('is held to the caller\'s account: a run of another account is not approved from this context', async () => {
      const other = await seedAccount(admin, randomUUID());
      const theirs = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id) VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local', $3)`, [theirs, other.accountId, other.repoId]);
      expect(await approve(theirs)).toBe(false);
      expect(await approvedBy(theirs)).toBeNull();
    });

    it('rolls back whole with the caller\'s transaction: no approval, audit row or receipt is left behind', async () => {
      const run = await pendingRun();
      await expect(
        withTenant(writerPool, A.accountId, async (c) => {
          expect((await c.query('SELECT agent_run_runner_auto_approve($1, $2, now(), $3) AS ok', [run, runner, CATALOGUE_VERSION])).rows[0].ok).toBe(true);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await approvedBy(run)).toBeNull();
      expect(await audit('runner.run_auto_approved')).toEqual([]);
      expect((await admin.query('SELECT 1 FROM decision_receipts WHERE run_id = $1', [run])).rowCount).toBe(0);
    });
  });
});
