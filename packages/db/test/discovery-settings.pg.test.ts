import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import {
  DISCOVERY_DEFAULT_FREQUENCY,
  appendDiscoveryVersion,
  effectiveDiscoveryFrequency,
  getCurrentDiscoverySetting,
  listDiscoverySettingHistory,
  writeDiscoverySetting,
  type DiscoveryFrequency,
} from '../src/discoverySettings.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#483 S5-g1: discovery_settings (0849) and its writer. Append-only versions per repo, owner or admin only, an audit row naming both
 * values, no row meaning daily, and the same value written twice writing nothing.
 */
const ACTION = 'discovery_setting.changed';

describe('discovery_settings (0849)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;
  let memberId: string;
  let adminUserId: string;

  const write = (frequency: DiscoveryFrequency, repoId = refs.repoId) =>
    writeDiscoverySetting({ pool: appUserPool, principal: refs.userId }, { accountId: refs.accountId, repoId, frequency });
  const auditRows = async (accountId = refs.accountId) =>
    (await admin.query<{ actor: string; payload: Record<string, unknown> }>(
      `SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2 ORDER BY created_at, id`,
      [accountId, ACTION],
    )).rows;
  const rowCount = async (accountId = refs.accountId) =>
    Number((await admin.query(`SELECT count(*) AS n FROM discovery_settings WHERE account_id = $1`, [accountId])).rows[0].n);
  const newRepo = async (accountId: string): Promise<string> =>
    (await admin.query<{ id: string }>(
      `INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`,
      [accountId, Math.floor(Math.random() * 1e9)],
    )).rows[0]!.id;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
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
  });

  describe('shape, grants and RLS', () => {
    it('is a tenant table with forced RLS and no violation in the inventory', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
      const { rows } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.discovery_settings'::regclass`);
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('app_user holds SELECT and INSERT and neither UPDATE nor DELETE; no other app role writes it', async () => {
      const privs = async (role: string) =>
        (await admin.query<{ p: string; ok: boolean }>(
          `SELECT p, has_table_privilege($1, 'public.discovery_settings', p) AS ok FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`,
          [role],
        )).rows.filter((r) => r.ok).map((r) => r.p);
      expect(await privs('app_user')).toEqual(['SELECT', 'INSERT']);
      for (const role of ['platform_ops', 'partner_user', 'agent_run_writer', 'receipt_writer_invoker']) {
        expect(await privs(role), role).toEqual([]);
      }
    });

    it('an UPDATE or DELETE from the app role is refused, even by an owner', async () => {
      await write('weekly');
      for (const sql of [`UPDATE discovery_settings SET frequency = 'off'`, `DELETE FROM discovery_settings`]) {
        await expect(withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(sql))).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      }
    });

    it('the database refuses a frequency outside daily, weekly and off', async () => {
      const repo = await newRepo(refs.accountId);
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, (c) =>
          c.query(`INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, 'hourly', 1, $3)`, [refs.accountId, repo, refs.userId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('created_at is the database clock whatever the INSERT says', async () => {
      const repo = await newRepo(refs.accountId);
      const row = await withTenant(appUserPool, refs.accountId, refs.userId, async (c) =>
        (await c.query<{ created_at: Date }>(
          `INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by, created_at) VALUES ($1, $2, 'off', 1, $3, '2001-01-01') RETURNING created_at`,
          [refs.accountId, repo, refs.userId],
        )).rows[0]!,
      );
      expect(row.created_at.getFullYear()).toBeGreaterThan(2020);
    });
  });

  describe('who may write', () => {
    it('an owner and an admin can write; a plain member cannot, and nothing is left behind', async () => {
      const repo = await newRepo(refs.accountId);
      const before = { rows: await rowCount(), audit: (await auditRows()).length };
      await expect(
        writeDiscoverySetting({ pool: appUserPool, principal: memberId }, { accountId: refs.accountId, repoId: repo, frequency: 'off' }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect({ rows: await rowCount(), audit: (await auditRows()).length }).toEqual(before);

      await writeDiscoverySetting({ pool: appUserPool, principal: adminUserId }, { accountId: refs.accountId, repoId: repo, frequency: 'off' });
      expect((await auditRows()).length).toBe(before.audit + 1);
    });

    it('a member cannot name an admin as changed_by: the session user must be the writer', async () => {
      const repo = await newRepo(refs.accountId);
      const before = await rowCount();
      await expect(
        withTenant(appUserPool, refs.accountId, memberId, (c) =>
          c.query(`INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, 'off', 1, $3)`, [refs.accountId, repo, adminUserId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowCount()).toBe(before);
    });

    it('cannot write into another account, and cannot read it', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, (c) =>
          c.query(`INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, 'off', 1, $3)`, [other.accountId, other.repoId, refs.userId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      await writeDiscoverySetting({ pool: appUserPool, principal: other.userId }, { accountId: other.accountId, repoId: other.repoId, frequency: 'off' });
      const seen = await withTenant(appUserPool, refs.accountId, refs.userId, (c) => getCurrentDiscoverySetting(c, other.repoId));
      expect(seen).toBeNull();
    });
  });

  describe('append-only versions, the audit row and the undo path', () => {
    it('no row means daily; the first change is version 1 and the audit row names the actor and both values', async () => {
      const repo = await newRepo(refs.accountId);
      const none = await withTenant(appUserPool, refs.accountId, refs.userId, (c) => getCurrentDiscoverySetting(c, repo));
      expect(none).toBeNull();
      expect(effectiveDiscoveryFrequency(none)).toBe(DISCOVERY_DEFAULT_FREQUENCY);
      expect(DISCOVERY_DEFAULT_FREQUENCY).toBe('daily');

      const v1 = await write('weekly', repo);
      const v2 = await write('off', repo);
      expect([v1!.version, v2!.version]).toEqual([1, 2]);
      expect(v2).toMatchObject({ changedBy: refs.userId, accountId: refs.accountId, repoId: repo, frequency: 'off' });
      const audits = (await auditRows()).filter((a) => a.payload.repo_id === repo);
      expect(audits).toHaveLength(2);
      expect(audits[0]).toMatchObject({ actor: refs.userId });
      expect(audits[0]!.payload).toMatchObject({ actor: refs.userId, version: 1, previous: 'daily', new: 'weekly' });
      expect(audits[1]!.payload).toMatchObject({ version: 2, previous: 'weekly', new: 'off' });
    });

    it('setting the value already in force writes nothing: the default included', async () => {
      const repo = await newRepo(refs.accountId);
      const before = { rows: await rowCount(), audit: (await auditRows()).length };
      expect(await write('daily', repo)).toBeNull();
      await write('off', repo);
      expect(await write('off', repo)).toBeNull();
      expect({ rows: await rowCount(), audit: (await auditRows()).length }).toEqual({ rows: before.rows + 1, audit: before.audit + 1 });
    });

    it('undo: choosing the earlier value appends a version, and every earlier version stays', async () => {
      const repo = await newRepo(refs.accountId);
      await write('off', repo);
      const back = await write('daily', repo);
      expect(back).toMatchObject({ version: 2, frequency: 'daily' });
      const history = await withTenant(appUserPool, refs.accountId, refs.userId, (c) => listDiscoverySettingHistory(c, repo));
      expect(history.map((h) => [h.version, h.frequency])).toEqual([[2, 'daily'], [1, 'off']]);
      expect(effectiveDiscoveryFrequency(history[0]!)).toBe('daily');
    });

    it('versions are per repo: a second repo starts at 1', async () => {
      const a = await newRepo(refs.accountId);
      const b = await newRepo(refs.accountId);
      await write('weekly', a);
      await write('off', a);
      expect((await write('weekly', b))!.version).toBe(1);
    });

    it('the database refuses a skipped or reused version', async () => {
      const repo = await newRepo(refs.accountId);
      await write('weekly', repo);
      for (const version of [7, 1]) {
        await expect(
          withTenant(appUserPool, refs.accountId, refs.userId, (c) =>
            c.query(`INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, 'off', $3, $4)`, [refs.accountId, repo, version, refs.userId]),
          ),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
    });

    it('two writers racing for one version: exactly one wins, the loser gets discovery_version_conflict and leaves no audit row', async () => {
      const repo = await newRepo(refs.accountId);
      let releaseA!: () => void;
      const gate = new Promise<void>((resolve) => { releaseA = resolve; });
      let aInserted!: () => void;
      const aReady = new Promise<void>((resolve) => { aInserted = resolve; });
      const a = withTenant(appUserPool, refs.accountId, refs.userId, async (c) => {
        const v = await appendDiscoveryVersion(c, { accountId: refs.accountId, repoId: repo, frequency: 'weekly', changedBy: refs.userId });
        aInserted();
        await gate;
        return v;
      });
      await aReady;
      const bOutcome = write('off', repo).then(() => 'won' as const, (e: unknown) => e);
      await new Promise((r) => setTimeout(r, 300));
      releaseA();
      expect((await a)!.version).toBe(1);
      expect(await bOutcome).toMatchObject({ code: 'discovery_version_conflict' });
      const history = await withTenant(appUserPool, refs.accountId, refs.userId, (c) => listDiscoverySettingHistory(c, repo));
      expect(history.map((h) => [h.version, h.frequency])).toEqual([[1, 'weekly']]);
      expect((await auditRows()).filter((r) => r.payload.repo_id === repo)).toHaveLength(1);
    });

    it('the writer maps a lost version race to discovery_version_conflict, and passes other errors through', async () => {
      const failing = (err: object) =>
        ({ query: async (sql: string) => { if (sql.includes('INSERT')) throw Object.assign(new Error((err as { message?: string }).message ?? 'x'), err); return { rows: [] }; } }) as unknown as PoolClient;
      const run = (err: object) => appendDiscoveryVersion(failing(err), { accountId: refs.accountId, repoId: refs.repoId, frequency: 'off', changedBy: refs.userId });
      await expect(run({ code: '23505' })).rejects.toMatchObject({ code: 'discovery_version_conflict' });
      await expect(run({ code: '23514', message: 'discovery_settings.version must be 2 (the next version for this repo), got 1' })).rejects.toMatchObject({ code: 'discovery_version_conflict' });
      await expect(run({ code: '23514', message: 'new row violates check constraint' })).rejects.toMatchObject({ code: '23514' });
    });

    it('a repo that has settings history cannot be hard-deleted (NO ACTION), by anyone', async () => {
      const repo = await newRepo(refs.accountId);
      await write('off', repo);
      await expect(withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(`DELETE FROM repos WHERE id = $1`, [repo]))).rejects.toMatchObject({
        code: PG_ERROR.FOREIGN_KEY_VIOLATION,
      });
    });
  });

  describe('validation', () => {
    it('a bad frequency or a bad repo id is refused before anything is written', async () => {
      const before = { rows: await rowCount(), audit: (await auditRows()).length };
      await expect(write('hourly' as DiscoveryFrequency)).rejects.toMatchObject({ code: 'discovery_frequency_invalid' });
      await expect(write('off', 'not-a-uuid')).rejects.toMatchObject({ code: 'discovery_repo_invalid' });
      expect({ rows: await rowCount(), audit: (await auditRows()).length }).toEqual(before);
    });

    it('a stored value the code does not know fails closed to off', () => {
      expect(effectiveDiscoveryFrequency({ frequency: 'monthly' } as never)).toBe('off');
    });
  });

  it('audit_write still refuses an action that is not on its list (the widened list is still a list)', async () => {
    await expect(
      withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(`SELECT audit_write('discovery_setting.deleted', '{}'::jsonb)`)),
    ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
  });
});
