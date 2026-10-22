import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import {
  AskSettingError,
  appendAskSettingVersion,
  listAskSettingHistory,
  listCurrentAskSettings,
  writeAskSetting,
  type WriteAskSettingInput,
} from '../src/decisionAskSettings.js';
import { raiseAsk } from '../src/decisionAsks.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#7 DP12a-1: decision_ask_settings (0812) and its writer. Append-only versions, owner or admin only, an audit row naming both values,
 * and a raise that takes its policy from the customer's settings.
 */
const INVOKER_LOGIN = 'fx_ask_settings_invoker_test';
const ACTION = 'decision_ask_setting.changed';

describe('decision_ask_settings (0812)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let invokerPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;
  let memberId: string;
  let adminUserId: string;

  const input = (over: Partial<WriteAskSettingInput> = {}): WriteAskSettingInput => ({
    accountId: refs.accountId,
    repoId: null,
    decisionType: '*',
    answerWindowMinutes: null,
    timeoutOutcome: null,
    notify: null,
    ...over,
  });
  const asOwner = { get pool() { return appUserPool; }, get principal() { return refs.userId; } };
  const write = (over: Partial<WriteAskSettingInput> = {}) => writeAskSetting(asOwner, input(over));
  const auditRows = async (accountId = refs.accountId) =>
    (await admin.query<{ actor: string; payload: Record<string, unknown> }>(
      `SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2 ORDER BY created_at`,
      [accountId, ACTION],
    )).rows;
  const rowCount = async (accountId = refs.accountId) =>
    Number((await admin.query(`SELECT count(*) AS n FROM decision_ask_settings WHERE account_id = $1`, [accountId])).rows[0].n);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN
          CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = '';
    invokerPool = createPool(u.toString());
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
    other = await seedAccount(admin, randomUUID());
    memberId = randomUUID();
    adminUserId = randomUUID();
    for (const [id, role] of [[memberId, 'member'], [adminUserId, 'admin']] as const) {
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [refs.accountId, id, role]);
    }
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await invokerPool.end();
  });

  describe('shape, grants and RLS', () => {
    it('is a tenant table with forced RLS and no violation in the inventory', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
      const { rows } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.decision_ask_settings'::regclass`);
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('app_user holds SELECT and INSERT and neither UPDATE nor DELETE; no other app role writes it', async () => {
      const privs = async (role: string) =>
        (await admin.query<{ p: string; ok: boolean }>(
          `SELECT p, has_table_privilege($1, 'public.decision_ask_settings', p) AS ok FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`,
          [role],
        )).rows.filter((r) => r.ok).map((r) => r.p);
      expect(await privs('app_user')).toEqual(['SELECT', 'INSERT']);
      for (const role of ['platform_ops', 'partner_user', 'agent_run_writer', 'receipt_writer_invoker']) {
        expect(await privs(role)).not.toContain('UPDATE');
        expect(await privs(role)).not.toContain('DELETE');
        expect(await privs(role)).not.toContain('INSERT');
      }
    });

    it('an UPDATE or DELETE from the app role is refused, even by an owner', async () => {
      await write({ answerWindowMinutes: 45 });
      for (const sql of [`UPDATE decision_ask_settings SET notify = 'none'`, `DELETE FROM decision_ask_settings`]) {
        await expect(withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(sql))).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      }
    });
  });

  describe('who may write (C8)', () => {
    it('an owner and an admin can write; a plain member cannot, and nothing is left behind', async () => {
      const before = { rows: await rowCount(), audit: (await auditRows()).length };
      await expect(
        writeAskSetting({ pool: appUserPool, principal: memberId }, input({ answerWindowMinutes: 60 })),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect({ rows: await rowCount(), audit: (await auditRows()).length }).toEqual(before);

      await writeAskSetting({ pool: appUserPool, principal: adminUserId }, input({ decisionType: 'test_strategy_choice', notify: 'none' }));
      expect((await auditRows()).length).toBe(before.audit + 1);
    });

    it('a member cannot name an admin as changed_by: the session user must be the writer', async () => {
      const before = await rowCount();
      await expect(
        withTenant(appUserPool, refs.accountId, memberId, (c) =>
          c.query(
            `INSERT INTO decision_ask_settings (account_id, repo_id, decision_type, notify, version, changed_by)
             VALUES ($1, NULL, 'nonbreaking_refactor_approach', 'none', 1, $2)`,
            [refs.accountId, adminUserId],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowCount()).toBe(before);
    });

    it('cannot write into another account, and cannot read it', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, (c) =>
          c.query(
            `INSERT INTO decision_ask_settings (account_id, repo_id, decision_type, notify, version, changed_by)
             VALUES ($1, NULL, '*', 'none', 1, $2)`,
            [other.accountId, refs.userId],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      await writeAskSetting({ pool: appUserPool, principal: other.userId }, input({ accountId: other.accountId, answerWindowMinutes: 999 }));
      const seen = await withTenant(appUserPool, refs.accountId, refs.userId, (c) => listCurrentAskSettings(c));
      expect(seen.every((r) => r.accountId === refs.accountId)).toBe(true);
      expect(seen.some((r) => r.answerWindowMinutes === 999)).toBe(false);
    });
  });

  describe('append-only versions, the audit row and the undo path', () => {
    it('versions forward per key; the audit row names the actor and both the previous and the new values', async () => {
      const key = { repoId: refs.repoId, decisionType: 'nonbreaking_refactor_approach' };
      const v1 = await write({ ...key, answerWindowMinutes: 30, timeoutOutcome: 'proceed_recommended', notify: 'email' });
      const v2 = await write({ ...key, answerWindowMinutes: 90, timeoutOutcome: 'stop_and_flag', notify: 'none' });
      expect([v1.version, v2.version]).toEqual([1, 2]);
      expect(v2).toMatchObject({ changedBy: refs.userId, accountId: refs.accountId, repoId: refs.repoId });

      const audits = (await auditRows()).filter((a) => a.payload.decision_type === 'nonbreaking_refactor_approach');
      expect(audits).toHaveLength(2);
      expect(audits[0]).toMatchObject({ actor: refs.userId });
      expect(audits[0]!.payload).toMatchObject({
        actor: refs.userId,
        repo_id: refs.repoId,
        version: 1,
        previous: { answer_window_minutes: null, timeout_outcome: null, notify: null },
        new: { answer_window_minutes: 30, timeout_outcome: 'proceed_recommended', notify: 'email' },
      });
      expect(audits[1]!.payload).toMatchObject({
        version: 2,
        previous: { answer_window_minutes: 30, timeout_outcome: 'proceed_recommended', notify: 'email' },
        new: { answer_window_minutes: 90, timeout_outcome: 'stop_and_flag', notify: 'none' },
      });
    });

    it('current state is the highest version per key; the history keeps every version', async () => {
      const key = { repoId: refs.repoId, decisionType: 'test_strategy_choice' };
      await write({ ...key, answerWindowMinutes: 20 });
      await write({ ...key, answerWindowMinutes: 25 });
      const current = await withTenant(appUserPool, refs.accountId, refs.userId, (c) => listCurrentAskSettings(c));
      const mine = current.filter((r) => r.repoId === refs.repoId && r.decisionType === 'test_strategy_choice');
      expect(mine).toHaveLength(1);
      expect(mine[0]!.answerWindowMinutes).toBe(25);
      const history = await withTenant(appUserPool, refs.accountId, refs.userId, (c) => listAskSettingHistory(c, refs.repoId, 'test_strategy_choice'));
      expect(history.map((h) => h.answerWindowMinutes)).toEqual([20, 25]);
    });

    it('undo: writing every value as null removes an override as a new version, and the earlier versions stay', async () => {
      const key = { repoId: null, decisionType: 'publish_release_artifact' };
      await write({ ...key, answerWindowMinutes: 600, notify: 'none' });
      const cleared = await write({ ...key });
      expect(cleared).toMatchObject({ version: 2, answerWindowMinutes: null, timeoutOutcome: null, notify: null });
      const history = await withTenant(appUserPool, refs.accountId, refs.userId, (c) => listAskSettingHistory(c, null, 'publish_release_artifact'));
      expect(history.map((h) => h.version)).toEqual([1, 2]);
      expect(history[0]!.answerWindowMinutes).toBe(600);
      const audits = (await auditRows()).filter((a) => a.payload.decision_type === 'publish_release_artifact');
      expect(audits.at(-1)!.payload).toMatchObject({ previous: { answer_window_minutes: 600, notify: 'none' }, new: { answer_window_minutes: null, notify: null } });
    });

    it('the account-wide key (NULL repo) versions like any other, per decision type', async () => {
      const a = await write({ decisionType: 'external_paid_api_call', notify: 'none' });
      const b = await write({ decisionType: 'external_paid_api_call', notify: 'email' });
      const c = await write({ decisionType: 'publish_deprecation_notice', notify: 'none' });
      expect([a.version, b.version, c.version]).toEqual([1, 2, 1]);
    });

    it('two transactions taking the same version: the loser fails on the UNIQUE key once the winner commits', async () => {
      const insert = (c: PoolClient) =>
        c.query(
          `INSERT INTO decision_ask_settings (account_id, repo_id, decision_type, notify, version, changed_by)
           VALUES ($1, $2, 'external_paid_api_call', 'none', 1, $3)`,
          [refs.accountId, refs.repoId, refs.userId],
        );
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let inserted!: () => void;
      const winnerIn = new Promise<void>((r) => { inserted = r; });
      const winner = withTenant(appUserPool, refs.accountId, refs.userId, async (c) => { await insert(c); inserted(); await gate; });
      await winnerIn;
      // The loser's rejection arrives the moment the winner commits, on another socket, and can beat the winner's own acknowledgement.
      // Observe the loser from the moment it exists: with no handler attached yet, that early rejection is an unhandled rejection.
      const loserOutcome = withTenant(appUserPool, refs.accountId, refs.userId, insert).then(
        () => 'won' as const,
        (e: unknown) => e,
      );
      setTimeout(release, 150);
      await expect(winner).resolves.toBeUndefined();
      expect(await loserOutcome).toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });

    it('two writers racing for the first version of an account-wide key (repo NULL): exactly one wins, the loser gets ask_setting_version_conflict', async () => {
      // A NULL repo_id is distinct in the table's UNIQUE, so only the partial unique index stops this. Writer A holds its insert
      // uncommitted; writer B has read the same "no previous version" and inserts the same version, so it must wait and then lose.
      const key = { repoId: null, decisionType: 'start_after_reclassify' };
      let releaseA!: () => void;
      const gate = new Promise<void>((resolve) => { releaseA = resolve; });
      let aInserted!: () => void;
      const aReady = new Promise<void>((resolve) => { aInserted = resolve; });
      const a = withTenant(appUserPool, refs.accountId, refs.userId, async (c) => {
        const v = await appendAskSettingVersion(c, { ...input({ ...key, answerWindowMinutes: 20 }), changedBy: refs.userId });
        aInserted();
        await gate;
        return v;
      });
      await aReady;
      const b = write({ ...key, answerWindowMinutes: 40 });
      const bOutcome = b.then(() => 'won' as const, (e: unknown) => e);
      await new Promise((r) => setTimeout(r, 300));
      releaseA();
      const first = await a;
      expect(first.version).toBe(1);
      expect(await bOutcome).toMatchObject({ code: 'ask_setting_version_conflict' });
      const history = await withTenant(appUserPool, refs.accountId, refs.userId, (c) => listAskSettingHistory(c, null, 'start_after_reclassify'));
      expect(history.map((h) => [h.version, h.answerWindowMinutes])).toEqual([[1, 20]]);
      const audits = (await auditRows()).filter((r) => r.payload.decision_type === 'start_after_reclassify' && r.payload.repo_id === null);
      expect(audits).toHaveLength(1);
    });

    it('the writer maps a lost version race to ask_setting_version_conflict, and passes other errors through', async () => {
      const failing = (err: object) =>
        ({ query: async (sql: string) => { if (sql.includes('INSERT')) throw Object.assign(new Error((err as { message?: string }).message ?? 'x'), err); return { rows: [] }; } }) as unknown as PoolClient;
      const run = (err: object) => appendAskSettingVersion(failing(err), { ...input(), changedBy: refs.userId });
      await expect(run({ code: '23505' })).rejects.toMatchObject({ code: 'ask_setting_version_conflict' });
      await expect(run({ code: '23514', message: 'decision_ask_settings.version must be 2 (the next version for this key), got 1' })).rejects.toMatchObject({ code: 'ask_setting_version_conflict' });
      await expect(run({ code: '23514', message: 'new row violates check constraint' })).rejects.toMatchObject({ code: '23514' });
    });

    it('the database refuses a skipped or reused version, for a repo key and for the account key', async () => {
      for (const repoId of [refs.repoId, null]) {
        for (const version of [7, 1]) {
          const first = await write({ repoId, decisionType: 'nonbreaking_refactor_approach', notify: 'email' }).catch(() => null);
          expect(first === null || first.version >= 1).toBe(true);
          await expect(
            withTenant(appUserPool, refs.accountId, refs.userId, (c) =>
              c.query(
                `INSERT INTO decision_ask_settings (account_id, repo_id, decision_type, notify, version, changed_by)
                 VALUES ($1, $2, 'nonbreaking_refactor_approach', 'none', $3, $4)`,
                [refs.accountId, repoId, version, refs.userId],
              ),
            ),
          ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
        }
      }
    });

    it('a repo that has settings history cannot be hard-deleted (NO ACTION), by anyone', async () => {
      await write({ repoId: refs.repoId, decisionType: '*', answerWindowMinutes: 77 });
      await expect(withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(`DELETE FROM repos WHERE id = $1`, [refs.repoId]))).rejects.toMatchObject({
        code: PG_ERROR.FOREIGN_KEY_VIOLATION,
      });
    });
  });

  describe('bounds and validation', () => {
    it.each([
      ['a window under 15 minutes', { answer_window_minutes: 14 }],
      ['a window over 14 days', { answer_window_minutes: 20161 }],
      ['an unknown outcome', { timeout_outcome: 'deny' }],
      ['an unknown notify value', { notify: 'sms' }],
    ])('the database refuses %s', async (_name, col) => {
      const [name, value] = Object.entries(col)[0]!;
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, (c) =>
          c.query(
            `INSERT INTO decision_ask_settings (account_id, repo_id, decision_type, ${name}, version, changed_by)
             VALUES ($1, NULL, 'bounds_probe', $2, 1, $3)`,
            [refs.accountId, value, refs.userId],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it.each([
      ['the bounds 15 and 20160', 15], ['', 20160],
    ])('the database accepts %s', async (_n, minutes) => {
      const t = await seedAccount(admin, randomUUID());
      const row = await writeAskSetting({ pool: appUserPool, principal: t.userId }, input({ accountId: t.accountId, answerWindowMinutes: minutes }));
      expect(row.answerWindowMinutes).toBe(minutes);
    });

    it.each([
      ['', 'made_up_type', 'ask_setting_unknown_decision_type'],
      ['', 'dependency_patch_bump', 'ask_setting_class1_never_asks'],
      ['', 'Bearer ghp_x', 'ask_setting_unknown_decision_type'],
    ])('the writer refuses %s %s with %s before any write', async (_n, decisionType, code) => {
      const before = { rows: await rowCount(), audit: (await auditRows()).length };
      await expect(write({ decisionType, notify: 'none' })).rejects.toMatchObject({ code });
      expect({ rows: await rowCount(), audit: (await auditRows()).length }).toEqual(before);
    });

    it.each([
      [{ answerWindowMinutes: 14 }, 'ask_setting_window_out_of_range'],
      [{ answerWindowMinutes: 20161 }, 'ask_setting_window_out_of_range'],
      [{ answerWindowMinutes: 60.5 }, 'ask_setting_window_out_of_range'],
      [{ timeoutOutcome: 'deny' as never }, 'ask_setting_outcome_invalid'],
      [{ notify: 'sms' as never }, 'ask_setting_notify_invalid'],
      [{ repoId: 'not-a-uuid' }, 'ask_setting_repo_invalid'],
    ])('the writer refuses %j with %s', async (over, code) => {
      await expect(write(over as Partial<WriteAskSettingInput>)).rejects.toBeInstanceOf(AskSettingError);
      await expect(write(over as Partial<WriteAskSettingInput>)).rejects.toMatchObject({ code });
    });

    it('only the clamped choices can be stored for a type: proceed_recommended is refused on a stop-only entry', async () => {
      for (const decisionType of ['publish_release_artifact', 'external_paid_api_call', 'publish_deprecation_notice', 'runner_run_on_member_plan']) {
        await expect(write({ decisionType, timeoutOutcome: 'proceed_recommended' })).rejects.toMatchObject({ code: 'ask_setting_outcome_not_allowed' });
      }
      for (const decisionType of ['nonbreaking_refactor_approach', 'test_strategy_choice']) {
        await expect(write({ decisionType, timeoutOutcome: 'proceed_recommended' })).resolves.toMatchObject({ timeoutOutcome: 'proceed_recommended' });
      }
    });
  });

  describe('the audit allowlist', () => {
    it('audit_write accepts the new action and still refuses an unlisted one', async () => {
      await withTenant(appUserPool, refs.accountId, refs.userId, async (c) => {
        await c.query(`SELECT audit_write($1, '{}'::jsonb)`, [ACTION]);
      });
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(`SELECT audit_write('decision_ask_setting.deleted', '{}'::jsonb)`)),
      ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });

    it('the entries the replaced function carried are still allowed', async () => {
      for (const action of ['decision_dial_changed', 'run_limits.changed', 'role_settings.mode_changed', 'model_connection.connect']) {
        await withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(`SELECT audit_write($1, '{}'::jsonb)`, [action]));
      }
    });
  });

  describe('a raise takes its policy from the settings', () => {
    const OPTIONS = [{ id: 'apply', label: 'Apply' }, { id: 'skip', label: 'Skip' }];
    const raise = (tenant: SeedRefs, over: Record<string, unknown> = {}) =>
      withTenant(invokerPool, tenant.accountId, (c) =>
        raiseAsk(c, {
          class: 'human_over_the_loop',
          decisionType: 'test_strategy_choice',
          workItemId: tenant.workItemId,
          options: OPTIONS,
          proposed: 'apply',
          rationale: 'because',
          quotedInputs: [{ trust: 'trusted', storedBody: 'ok' }],
          ...over,
        }),
      );
    const stored = async (id: string) => {
      const row = (await admin.query(`SELECT * FROM decision_asks WHERE id = $1`, [id])).rows[0];
      return { minutes: Math.round((row.answer_due_at - row.raised_at) / 60000), outcome: row.timeout_outcome as string };
    };
    let t: SeedRefs;
    const asT = (over: Partial<WriteAskSettingInput>) => writeAskSetting({ pool: appUserPool, principal: t.userId }, input({ accountId: t.accountId, ...over }));

    beforeAll(async () => {
      t = await seedAccount(admin, randomUUID());
    });

    it('with no settings the policy is the preset default: 24 hours, and Cautious stops while Balanced goes ahead', async () => {
      expect(await stored(await raise(t))).toEqual({ minutes: 1440, outcome: 'stop_and_flag' });
      expect(await stored(await raise(t, { preset: 'balanced' }))).toEqual({ minutes: 1440, outcome: 'proceed_recommended' });
    });

    it('a stop-only entry stays stop_and_flag even for Autonomous', async () => {
      const id = await raise(t, { preset: 'autonomous', class: 'human_in_the_loop', decisionType: 'publish_release_artifact' });
      expect((await stored(id)).outcome).toBe('stop_and_flag');
    });

    it('account settings, then repo settings, change the frozen terms of the next ask', async () => {
      await asT({ decisionType: '*', answerWindowMinutes: 120 });
      expect((await stored(await raise(t))).minutes).toBe(120);
      await asT({ decisionType: 'test_strategy_choice', answerWindowMinutes: 45, timeoutOutcome: 'proceed_recommended' });
      expect(await stored(await raise(t))).toEqual({ minutes: 45, outcome: 'proceed_recommended' });
      await asT({ repoId: t.repoId, decisionType: '*', answerWindowMinutes: 30 });
      expect((await stored(await raise(t))).minutes).toBe(30);
    });

    it('an ask already waiting keeps its terms when settings change later (frozen at raise)', async () => {
      const id = await raise(t);
      const before = await stored(id);
      await asT({ repoId: t.repoId, decisionType: 'test_strategy_choice', answerWindowMinutes: 5000, timeoutOutcome: 'stop_and_flag' });
      expect(await stored(id)).toEqual(before);
      expect(await stored(await raise(t))).toEqual({ minutes: 5000, outcome: 'stop_and_flag' });
    });

    it('removing the override (all null) returns the next ask to the level below', async () => {
      await asT({ repoId: t.repoId, decisionType: 'test_strategy_choice' });
      expect((await stored(await raise(t))).minutes).toBe(30);
    });

    it("another account's settings never apply: each account sees only its own", async () => {
      // `other` wrote 999 earlier in this file; this account's 120/45/30/5000 never reach it, and its 999 never reached this one.
      expect((await stored(await raise(other))).minutes).toBe(999);
      expect((await stored(await raise(t))).minutes).not.toBe(999);
    });

    it('an explicit policy still wins and is still checked', async () => {
      const id = await raise(t, { policy: { answerWindowMinutes: 15, onTimeout: 'stop_and_flag' } });
      expect((await stored(id)).minutes).toBe(15);
      await expect(raise(t, { decisionType: 'publish_deprecation_notice', policy: { answerWindowMinutes: 60, onTimeout: 'proceed_recommended' } })).rejects.toMatchObject({
        code: 'ask_proceed_not_allowed',
      });
    });
  });
});
