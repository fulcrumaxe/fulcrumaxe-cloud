import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import {
  PLAN_WRITEBACK_DEFAULT_AUTO_MERGE,
  appendPlanWritebackVersion,
  getCurrentPlanWritebackSetting,
  readPlanWritebackAutoMerge,
  writePlanWritebackAutoMerge,
} from '../src/planWritebackSettings.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#598 P5c-a: plan_writeback_settings (0967) and its writer, against real Postgres with the real app role (RLS as production runs it).
 * Append-only versions per repo, owner or admin only, an audit row naming both values, no row meaning off.
 */
const ACTION = 'plan_writeback_setting.changed';

describe('plan_writeback_settings (0967)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;
  let memberId: string;
  let adminUserId: string;

  const write = (autoMerge: boolean, repoId = refs.repoId) =>
    writePlanWritebackAutoMerge({ pool: appUserPool, principal: refs.userId }, { accountId: refs.accountId, repoId, autoMerge });
  const auditRows = async (accountId = refs.accountId) =>
    (await admin.query<{ actor: string; payload: Record<string, unknown> }>(
      `SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2 ORDER BY created_at, id`,
      [accountId, ACTION],
    )).rows;
  const rowCount = async (accountId = refs.accountId) =>
    Number((await admin.query(`SELECT count(*) AS n FROM plan_writeback_settings WHERE account_id = $1`, [accountId])).rows[0].n);
  const newRepo = async (accountId: string): Promise<string> =>
    (await admin.query<{ id: string }>(
      `INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`,
      [accountId, Math.floor(Math.random() * 1e9)],
    )).rows[0]!.id;
  const rawInsert = (as: string, accountId: string, repoId: string, changedBy: string, version = 1) =>
    withTenant(appUserPool, accountId, as, (c) =>
      c.query(`INSERT INTO plan_writeback_settings (account_id, repo_id, auto_merge, version, changed_by) VALUES ($1, $2, true, $3, $4)`, [accountId, repoId, version, changedBy]),
    );

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
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
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });

  describe('shape, grants and RLS (P5c-a-1)', () => {
    it('is a tenant table with forced RLS and no violation in the inventory', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
      const { rows } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.plan_writeback_settings'::regclass`);
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('app_user holds SELECT and INSERT and neither UPDATE nor DELETE; no other app role holds anything', async () => {
      const privs = async (role: string) =>
        (await admin.query<{ p: string; ok: boolean }>(
          `SELECT p, has_table_privilege($1, 'public.plan_writeback_settings', p) AS ok FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`,
          [role],
        )).rows.filter((r) => r.ok).map((r) => r.p);
      expect(await privs('app_user')).toEqual(['SELECT', 'INSERT']);
      for (const role of ['platform_ops', 'partner_user', 'agent_run_writer', 'receipt_writer_invoker']) {
        expect(await privs(role), role).toEqual([]);
      }
    });

    it('an UPDATE or DELETE from the app role is refused, even by an owner', async () => {
      await write(true);
      for (const sql of [`UPDATE plan_writeback_settings SET auto_merge = false`, `DELETE FROM plan_writeback_settings`]) {
        await expect(withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('created_at is the database clock whatever the INSERT says', async () => {
      const repo = await newRepo(refs.accountId);
      const row = await withTenant(appUserPool, refs.accountId, refs.userId, async (c) =>
        (await c.query<{ created_at: Date }>(
          `INSERT INTO plan_writeback_settings (account_id, repo_id, auto_merge, version, changed_by, created_at) VALUES ($1, $2, true, 1, $3, '2001-01-01') RETURNING created_at`,
          [refs.accountId, repo, refs.userId],
        )).rows[0]!,
      );
      expect(row.created_at.getFullYear()).toBeGreaterThan(2020);
    });
  });

  describe('who may write (P5c-a-1)', () => {
    it('an owner and an admin can write; a plain member cannot, and nothing is left behind', async () => {
      const repo = await newRepo(refs.accountId);
      const before = { rows: await rowCount(), audit: (await auditRows()).length };
      await expect(
        writePlanWritebackAutoMerge({ pool: appUserPool, principal: memberId }, { accountId: refs.accountId, repoId: repo, autoMerge: true }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect({ rows: await rowCount(), audit: (await auditRows()).length }).toEqual(before);

      await writePlanWritebackAutoMerge({ pool: appUserPool, principal: adminUserId }, { accountId: refs.accountId, repoId: repo, autoMerge: true });
      expect((await auditRows()).length).toBe(before.audit + 1);
    });

    it('a member cannot name an admin as changed_by: the session user must be the writer', async () => {
      const repo = await newRepo(refs.accountId);
      const before = await rowCount();
      await expect(rawInsert(memberId, refs.accountId, repo, adminUserId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowCount()).toBe(before);
    });

    it('a userless session is refused: with no app.user_id the policy has no writer to match', async () => {
      const repo = await newRepo(refs.accountId);
      const before = await rowCount();
      const c = await appUserPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.account_id', $1, true)`, [refs.accountId]);
        await expect(
          c.query(`INSERT INTO plan_writeback_settings (account_id, repo_id, auto_merge, version, changed_by) VALUES ($1, $2, true, 1, $3)`, [refs.accountId, repo, refs.userId]),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
      expect(await rowCount()).toBe(before);
    });

    it('a platform_ops login writes nothing', async () => {
      const repo = await newRepo(refs.accountId);
      const before = await rowCount();
      await expect(
        platformOpsPool.query(`INSERT INTO plan_writeback_settings (account_id, repo_id, auto_merge, version, changed_by) VALUES ($1, $2, true, 1, $3)`, [refs.accountId, repo, refs.userId]),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowCount()).toBe(before);
    });

    it('a user who is admin in two accounts cannot write for account B from a session on account A', async () => {
      const both = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [both, `${both}@example.test`]);
      for (const accountId of [refs.accountId, other.accountId]) {
        await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [accountId, both]);
      }
      const otherRepo = await newRepo(other.accountId);
      const before = await rowCount(other.accountId);
      // The owner/admin check alone would pass (the user IS an admin of B); only the session-account clause refuses this.
      await expect(
        withTenant(appUserPool, refs.accountId, both, (c) =>
          c.query(`INSERT INTO plan_writeback_settings (account_id, repo_id, auto_merge, version, changed_by) VALUES ($1, $2, true, 1, $3)`, [other.accountId, otherRepo, both]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowCount(other.accountId)).toBe(before);
      // The same user on a session for B writes there, so the refusal above is the session clause and not the user.
      await writePlanWritebackAutoMerge({ pool: appUserPool, principal: both }, { accountId: other.accountId, repoId: otherRepo, autoMerge: true });
      expect(await rowCount(other.accountId)).toBe(before + 1);
    });

    it('the insert policy names the session account itself, not only the membership check', async () => {
      // Behaviour cannot tell the two apart: account_members is itself tenant-isolated, so the membership EXISTS in the policy
      // already fails for any other account. The session-account clause is the second, independent gate; pin that it is present.
      const { rows } = await admin.query<{ with_check: string }>(
        `SELECT with_check FROM pg_policies WHERE tablename = 'plan_writeback_settings' AND policyname = 'owner_or_admin_insert'`,
      );
      expect(rows).toHaveLength(1);
      const clause = rows[0]!.with_check.replace(/\s+/g, ' ');
      expect(clause).toContain("(account_id = (NULLIF(current_setting('app.account_id'::text, true), ''::text))::uuid)");
      expect(clause).toContain("(changed_by = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)");
    });

    it('the reader filters by the account itself: a client RLS does not bind still answers false for another account', async () => {
      const repo = await newRepo(other.accountId);
      await writePlanWritebackAutoMerge({ pool: appUserPool, principal: other.userId }, { accountId: other.accountId, repoId: repo, autoMerge: true });
      // `admin` is the migration owner: not bound by the policies, so only the query's own account filter separates the accounts.
      expect(await readPlanWritebackAutoMerge(admin, other.accountId, repo)).toBe(true);
      expect(await readPlanWritebackAutoMerge(admin, refs.accountId, repo)).toBe(false);
    });

    it('cannot write into another account, and cannot read it', async () => {
      const otherRepo = await newRepo(other.accountId);
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, (c) =>
          c.query(`INSERT INTO plan_writeback_settings (account_id, repo_id, auto_merge, version, changed_by) VALUES ($1, $2, true, 1, $3)`, [other.accountId, otherRepo, refs.userId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await writePlanWritebackAutoMerge({ pool: appUserPool, principal: other.userId }, { accountId: other.accountId, repoId: other.repoId, autoMerge: true });
      expect(await withTenant(appUserPool, refs.accountId, refs.userId, (c) => getCurrentPlanWritebackSetting(c, other.repoId))).toBeNull();
      // The reader names the account too: another account's repo answers false from this session.
      expect(await withTenant(appUserPool, refs.accountId, refs.userId, (c) => readPlanWritebackAutoMerge(c, other.accountId, other.repoId))).toBe(false);
    });
  });

  describe('append-only versions, the audit row and the undo path (P5c-a-1)', () => {
    it('no row means off; the first change is version 1 and the audit row names the actor and both values', async () => {
      const repo = await newRepo(refs.accountId);
      expect(await withTenant(appUserPool, refs.accountId, refs.userId, (c) => getCurrentPlanWritebackSetting(c, repo))).toBeNull();
      expect(await withTenant(appUserPool, refs.accountId, refs.userId, (c) => readPlanWritebackAutoMerge(c, refs.accountId, repo))).toBe(false);
      expect(PLAN_WRITEBACK_DEFAULT_AUTO_MERGE).toBe(false);

      const v1 = await write(true, repo);
      const v2 = await write(false, repo);
      expect([v1!.version, v2!.version]).toEqual([1, 2]);
      expect(v2).toMatchObject({ changedBy: refs.userId, accountId: refs.accountId, repoId: repo, autoMerge: false });
      const audits = (await auditRows()).filter((a) => a.payload.repo_id === repo);
      expect(audits).toHaveLength(2);
      expect(audits[0]).toMatchObject({ actor: refs.userId });
      expect(audits[0]!.payload).toMatchObject({ actor: refs.userId, version: 1, previous: false, new: true });
      expect(audits[1]!.payload).toMatchObject({ version: 2, previous: true, new: false });
    });

    it('the reader answers the current version only, and true only for a stored true', async () => {
      const repo = await newRepo(refs.accountId);
      const read = () => withTenant(appUserPool, refs.accountId, refs.userId, (c) => readPlanWritebackAutoMerge(c, refs.accountId, repo));
      await write(true, repo);
      expect(await read()).toBe(true);
      await write(false, repo);
      expect(await read()).toBe(false);
    });

    it('setting the value already in force writes nothing: the default included', async () => {
      const repo = await newRepo(refs.accountId);
      const before = { rows: await rowCount(), audit: (await auditRows()).length };
      expect(await write(false, repo)).toBeNull();
      await write(true, repo);
      expect(await write(true, repo)).toBeNull();
      expect({ rows: await rowCount(), audit: (await auditRows()).length }).toEqual({ rows: before.rows + 1, audit: before.audit + 1 });
    });

    it('undo: choosing the earlier value appends a version, and every earlier version stays', async () => {
      const repo = await newRepo(refs.accountId);
      await write(true, repo);
      expect(await write(false, repo)).toMatchObject({ version: 2, autoMerge: false });
      const { rows } = await admin.query(`SELECT version, auto_merge FROM plan_writeback_settings WHERE repo_id = $1 ORDER BY version`, [repo]);
      expect(rows).toEqual([{ version: 1, auto_merge: true }, { version: 2, auto_merge: false }]);
    });

    it('versions are per repo: a second repo starts at 1', async () => {
      const a = await newRepo(refs.accountId);
      const b = await newRepo(refs.accountId);
      await write(true, a);
      await write(false, a);
      expect((await write(true, b))!.version).toBe(1);
    });

    it('the database refuses a skipped or reused version', async () => {
      const repo = await newRepo(refs.accountId);
      await write(true, repo);
      for (const version of [7, 1]) {
        await expect(rawInsert(refs.userId, refs.accountId, repo, refs.userId, version)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
    });

    it('two writers racing for one version: exactly one wins, the loser gets plan_writeback_version_conflict and leaves no audit row', async () => {
      const repo = await newRepo(refs.accountId);
      let releaseA!: () => void;
      const gate = new Promise<void>((resolve) => { releaseA = resolve; });
      let aInserted!: () => void;
      const aReady = new Promise<void>((resolve) => { aInserted = resolve; });
      const a = withTenant(appUserPool, refs.accountId, refs.userId, async (c) => {
        const v = await appendPlanWritebackVersion(c, { accountId: refs.accountId, repoId: repo, autoMerge: true, changedBy: refs.userId });
        aInserted();
        await gate;
        return v;
      });
      await aReady;
      const bOutcome = write(true, repo).then(() => 'won' as const, (e: unknown) => e);
      await new Promise((r) => setTimeout(r, 300));
      releaseA();
      expect((await a)!.version).toBe(1);
      expect(await bOutcome).toMatchObject({ code: 'plan_writeback_version_conflict' });
      expect(await rowCount()).toBeGreaterThan(0);
      expect((await auditRows()).filter((r) => r.payload.repo_id === repo)).toHaveLength(1);
    });

    it('the writer maps a lost version race to plan_writeback_version_conflict, and passes other errors through', async () => {
      const failing = (err: object) =>
        ({ query: async (sql: string) => { if (sql.includes('INSERT')) throw Object.assign(new Error((err as { message?: string }).message ?? 'x'), err); return { rows: [] }; } }) as unknown as PoolClient;
      const run = (err: object) => appendPlanWritebackVersion(failing(err), { accountId: refs.accountId, repoId: refs.repoId, autoMerge: true, changedBy: refs.userId });
      await expect(run({ code: '23505' })).rejects.toMatchObject({ code: 'plan_writeback_version_conflict' });
      await expect(run({ code: '23514', message: 'plan_writeback_settings.version must be 2 (the next version for this repo), got 1' })).rejects.toMatchObject({ code: 'plan_writeback_version_conflict' });
      await expect(run({ code: '23514', message: 'new row violates check constraint' })).rejects.toMatchObject({ code: '23514' });
    });

    it('a repo that has settings history cannot be hard-deleted (NO ACTION), by anyone', async () => {
      const repo = await newRepo(refs.accountId);
      await write(true, repo);
      await expect(withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(`DELETE FROM repos WHERE id = $1`, [repo]))).rejects.toMatchObject({
        code: PG_ERROR.FOREIGN_KEY_VIOLATION,
      });
    });
  });

  describe('validation', () => {
    it('a bad value or a bad repo id is refused before anything is written', async () => {
      const before = { rows: await rowCount(), audit: (await auditRows()).length };
      await expect(write('yes' as unknown as boolean)).rejects.toMatchObject({ code: 'plan_writeback_value_invalid' });
      await expect(write(true, 'not-a-uuid')).rejects.toMatchObject({ code: 'plan_writeback_repo_invalid' });
      expect({ rows: await rowCount(), audit: (await auditRows()).length }).toEqual(before);
    });
  });

  it('audit_write still refuses an action that is not on its list (the widened list is still a list)', async () => {
    await expect(
      withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(`SELECT audit_write('plan_writeback_setting.deleted', '{}'::jsonb)`)),
    ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
  });
});
