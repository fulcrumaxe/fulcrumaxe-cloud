import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { completeInstall, type InstallOutcome } from '../src/installCallback.js';
import type { AppKind } from '../src/appCredentials.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { pagedListing, strictGithubFetch } from './helpers/strictGithub.js';

/**
 * D#2 H17a against real Postgres: the recording transaction, the unique
 * index and the column-scoped platform_ops INSERT (migration 0655). GitHub
 * is faked to confirm every installation, so what is under test is the
 * database side.
 */
const INSTALLER = 5150;

describe('completeInstall (D#2 H17a)', () => {
  let adminPool: Pool;
  let platformOpsPool: Pool;
  let admin: PoolClient;
  let nextGh = 8_000_000;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    platformOpsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await platformOpsPool.end();
    await adminPool.end();
  });

  async function seed(role: string, paused = false) {
    const accountId = randomUUID();
    const userId = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [
      accountId,
      `cus_${accountId}`,
    ]);
    // status is derived from marker columns: a manual pause makes it 'paused'.
    if (paused) await admin.query(`UPDATE accounts SET owner_paused_at = now() WHERE id = $1`, [accountId]);
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }

  const fetchAll = strictGithubFetch((async (url: string | URL | Request) =>
    String(url).includes('/login/oauth/')
      ? Response.json({ access_token: 'ghu_x' })
      : String(url) === 'https://api.github.com/user'
        ? Response.json({ id: INSTALLER })
        : pagedListing('installations', [{ id: nextGh, app_id: 7 }], String(url))) as unknown as typeof fetch);

  async function run(who: { accountId: string; userId: string }, kind: AppKind, ghId = nextGh): Promise<InstallOutcome> {
    nextGh = ghId;
    // H17e: the delivery has already recorded this user as the installer.
    await admin.query(
      `INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [ghId, kind, INSTALLER],
    );
    return completeInstall(
      {
        platformOpsPool,
        recheck: async () => true,
        appCredentials: () => ({ appId: '7', privateKeyPem: '', webhookSecret: '' }),
        env: {
          GITHUB_APP_TEAM_CLIENT_ID: 'i',
          GITHUB_APP_TEAM_CLIENT_SECRET: 's',
          GITHUB_APP_TEAM_READONLY_CLIENT_ID: 'i',
          GITHUB_APP_TEAM_READONLY_CLIENT_SECRET: 's',
          GITHUB_APP_SITEKIT_CLIENT_ID: 'i',
          GITHUB_APP_SITEKIT_CLIENT_SECRET: 's',
        },
        fetchImpl: fetchAll,
      },
      { kind, ...who, installationId: String(ghId), code: 'c0de' },
    );
  }

  const rows = async (ghId: number) =>
    (await admin.query<{ account_id: string; app_kind: string }>(
      `SELECT account_id, app_kind FROM installations WHERE gh_installation_id = $1 ORDER BY app_kind`,
      [ghId],
    )).rows;
  const audits = async (accountId: string) =>
    (await admin.query<{ actor: string; payload: { gh_installation_id: number; app_kind: string; user_id: string; installer_gh_user_id: number; path: string } }>(
      `SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'github.installation_recorded'`,
      [accountId],
    )).rows;

  it('records the row and its audit row together; a repeat by the same account adds neither', async () => {
    const who = await seed('admin');
    const gh = ++nextGh;
    expect(await run(who, 'team', gh)).toBe('ok');
    expect(await rows(gh)).toEqual([{ account_id: who.accountId, app_kind: 'team' }]);
    const a = await audits(who.accountId);
    expect(a).toHaveLength(1);
    expect(a[0]!.actor).toBe('system:github_install');
    expect(a[0]!.payload).toMatchObject({ gh_installation_id: gh, app_kind: 'team', user_id: who.userId, installer_gh_user_id: INSTALLER, path: 'callback' });

    expect(await run(who, 'team', gh)).toBe('ok');
    expect(await rows(gh)).toHaveLength(1);
    expect(await audits(who.accountId)).toHaveLength(1);
  });

  it('a second account claiming the same installation and kind is refused and the first row is unchanged', async () => {
    const first = await seed('owner');
    const second = await seed('owner');
    const gh = ++nextGh;
    expect(await run(first, 'team', gh)).toBe('ok');
    expect(await run(second, 'team', gh)).toBe('claimed');
    expect(await rows(gh)).toEqual([{ account_id: first.accountId, app_kind: 'team' }]);
    expect(await audits(second.accountId)).toHaveLength(0);
  });

  it('the same GitHub installation id may exist once per App kind', async () => {
    const who = await seed('owner');
    const gh = ++nextGh;
    expect(await run(who, 'team_readonly', gh)).toBe('ok');
    expect(await run(who, 'sitekit', gh)).toBe('ok');
    expect((await rows(gh)).map((r) => r.app_kind)).toEqual(['sitekit', 'team_readonly']);
  });

  it('a plain member records nothing', async () => {
    const who = await seed('member');
    const gh = ++nextGh;
    expect(await run(who, 'team_readonly', gh)).toBe('failed');
    expect(await rows(gh)).toEqual([]);
  });

  it('a user who is not in the account records nothing', async () => {
    const acct = await seed('owner');
    const stranger = await seed('owner');
    const gh = ++nextGh;
    expect(await run({ accountId: acct.accountId, userId: stranger.userId }, 'team', gh)).toBe('failed');
    expect(await rows(gh)).toEqual([]);
  });

  it('the write App needs an active account (a paused one is refused); the read-only App and sitekit do not', async () => {
    const who = await seed('owner', true);
    const gh = ++nextGh;
    expect(await run(who, 'team', gh)).toBe('pay_first');
    expect(await rows(gh)).toEqual([]);
    expect(await audits(who.accountId)).toHaveLength(0);
    expect(await run(who, 'team_readonly', gh)).toBe('ok');
    expect(await run(who, 'sitekit', gh)).toBe('ok');
  });

  it('migration 0655: platform_ops can insert only the three columns (42501 for any other), only for its tenant, and cannot update or delete', async () => {
    const who = await seed('owner');
    const other = await seed('owner');
    const gh = ++nextGh;
    const asOps = async (accountId: string, sql: string, params: unknown[]) => {
      const c = await platformOpsPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.account_id', $1, true)`, [accountId]);
        await c.query(sql, params);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    };
    const ins = `INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, 'sitekit')`;
    await expect(asOps(other.accountId, ins, [who.accountId, gh])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(
      asOps(who.accountId, `INSERT INTO installations (account_id, gh_installation_id, app_kind, created_at) VALUES ($1, $2, 'sitekit', now())`, [who.accountId, gh]),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await asOps(who.accountId, ins, [who.accountId, gh]);
    await expect(asOps(who.accountId, ins, [who.accountId, gh])).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    await expect(
      asOps(who.accountId, `INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES (gen_random_uuid(), $1, $2, 'team')`, [who.accountId, gh + 1]),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(asOps(who.accountId, `UPDATE installations SET app_kind = 'team' WHERE gh_installation_id = $1`, [gh])).rejects.toMatchObject({
      code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
    });
    await expect(asOps(who.accountId, `DELETE FROM installations WHERE gh_installation_id = $1`, [gh])).rejects.toMatchObject({
      code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
    });
  });
});
