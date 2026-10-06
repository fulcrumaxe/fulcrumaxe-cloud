import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { bindClaim, completeInstall, type InstallOutcome } from '../src/installCallback.js';
import { recordInstallationLifecycle } from '../src/installerRecord.js';
import type { AppKind } from '../src/appCredentials.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { pagedListing, strictGithubFetch } from './helpers/strictGithub.js';
import { captureReports } from './helpers/captureReports.js';

/**
 * D#2 H17e against real Postgres: the installer rule (C57). GitHub is faked;
 * `recheck` is a spy so call order against the database is observable.
 */
const INSTALLER = 7001; // GitHub user id of whoever installed the App
const OTHER = 7002; // an org admin / read-only collaborator who did not

describe('installer rule (D#2 H17e)', () => {
  let adminPool: Pool;
  let platformOpsPool: Pool;
  let appUserPool: Pool;
  let admin: PoolClient;
  let nextGh = 9_100_000;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    platformOpsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await appUserPool.end();
    await platformOpsPool.end();
    await adminPool.end();
  });

  async function seed(role = 'owner') {
    const accountId = randomUUID();
    const userId = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }

  const env = {
    GITHUB_APP_TEAM_CLIENT_ID: 'i',
    GITHUB_APP_TEAM_CLIENT_SECRET: 's',
    GITHUB_APP_TEAM_READONLY_CLIENT_ID: 'i',
    GITHUB_APP_TEAM_READONLY_CLIENT_SECRET: 's',
  };
  const appCredentials = () => ({ appId: '7', privateKeyPem: '', webhookSecret: '' });

  function harness(active = true) {
    const order: string[] = [];
    const recheck = vi.fn(async (input: { ghInstallationId: number }) => {
      const r = await admin.query('SELECT 1 FROM installations WHERE gh_installation_id = $1', [input.ghInstallationId]);
      order.push(`recheck(rows=${r.rowCount})`);
      return active;
    });
    return { order, recheck };
  }

  const githubAs = (ghUser: number, ghId: number) =>
    strictGithubFetch((async (url: string | URL | Request) =>
      String(url).includes('/login/oauth/')
        ? Response.json({ access_token: 'ghu_x' })
        : String(url) === 'https://api.github.com/user'
          ? Response.json({ id: ghUser })
          : pagedListing('installations', [{ id: ghId, app_id: 7 }], String(url))) as unknown as typeof fetch);

  function callback(
    who: { accountId: string; userId: string },
    ghUser: number,
    ghId: number,
    recheck: ReturnType<typeof harness>['recheck'],
    kind: AppKind = 'team',
  ): Promise<InstallOutcome> {
    return completeInstall(
      { platformOpsPool, appCredentials, env, fetchImpl: githubAs(ghUser, ghId), recheck },
      { kind, ...who, installationId: String(ghId), code: 'c0de' },
    );
  }

  const created = (ghId: number, sender: number, action = 'created') => ({ action, installation: { id: ghId }, sender: { id: sender } });
  const deliver = (recheck: ReturnType<typeof harness>['recheck'], kind: AppKind, payload: unknown) =>
    recordInstallationLifecycle({ platformOpsPool, appUserPool, appCredentials, recheck }, kind, payload);

  const bound = async (ghId: number) =>
    (await admin.query<{ account_id: string }>(`SELECT account_id FROM installations WHERE gh_installation_id = $1`, [ghId])).rows;
  const audits = async (accountId: string) =>
    (await admin.query<{ payload: { path: string; installer_gh_user_id: number } }>(
      `SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'github.installation_recorded'`,
      [accountId],
    )).rows;
  const pendingCount = async (ghId: number) =>
    Number((await admin.query(`SELECT count(*) AS n FROM installation_pending_claims WHERE gh_installation_id = $1`, [ghId])).rows[0].n);

  it('R1: created records the installer once; a replay from a different sender changes nothing; flags follow deleted/suspend/unsuspend', async () => {
    const h = harness();
    const gh = ++nextGh;
    await deliver(h.recheck, 'team_readonly', created(gh, INSTALLER));
    const row = () => admin.query(`SELECT * FROM installation_installers WHERE gh_installation_id = $1`, [gh]);
    await deliver(h.recheck, 'team_readonly', created(gh, OTHER));
    // Asserted right after the other sender's replay, so a code-level overwrite is not masked by the next one.
    expect(Number((await row()).rows[0].installer_gh_user_id)).toBe(INSTALLER);
    await deliver(h.recheck, 'team_readonly', created(gh, INSTALLER));
    expect((await row()).rows).toHaveLength(1);
    expect(Number((await row()).rows[0].installer_gh_user_id)).toBe(INSTALLER);
    expect((await row()).rows[0].app_kind).toBe('team_readonly');

    await deliver(h.recheck, 'team_readonly', created(gh, INSTALLER, 'suspend'));
    expect((await row()).rows[0].suspended_at).not.toBeNull();
    await deliver(h.recheck, 'team_readonly', created(gh, INSTALLER, 'unsuspend'));
    expect((await row()).rows[0].suspended_at).toBeNull();
    await deliver(h.recheck, 'team_readonly', created(gh, INSTALLER, 'deleted'));
    expect((await row()).rows[0].deleted_at).not.toBeNull();
    // Only this kind's row is touched, and R1 alone never creates a work item or an installations row.
    await deliver(h.recheck, 'team', created(gh, INSTALLER, 'deleted'));
    expect(await bound(gh)).toEqual([]);
  });

  it('CWE-362: a delivery racing a callback\'s pending insert still ends with exactly one binding', async () => {
    const h = harness();
    const gh = ++nextGh;
    const who = await seed();
    let reached!: () => void;
    const atInsert = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // A pool whose connections hold the pending-claim insert until told to go.
    const slowPool = {
      connect: async () => {
        const c = await platformOpsPool.connect();
        const query = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
        (c as unknown as { query: unknown }).query = async (...a: unknown[]) => {
          if (typeof a[0] === 'string' && a[0].includes('INSERT INTO installation_pending_claims')) {
            reached();
            await gate;
          }
          return query(...a);
        };
        return c;
      },
    } as unknown as Pool;

    const cb = completeInstall(
      { platformOpsPool: slowPool, appCredentials, env, fetchImpl: githubAs(INSTALLER, gh), recheck: h.recheck },
      { kind: 'team', ...who, installationId: String(gh), code: 'c0de' },
    );
    await atInsert; // the callback has read "no installer" and is about to insert its pending claim
    const delivery = deliver(h.recheck, 'team', created(gh, INSTALLER));
    await new Promise((r) => setTimeout(r, 300)); // without the lock the delivery finishes here, seeing no claim
    release();
    expect(await cb).toBe('pending');
    await delivery;
    expect(await bound(gh)).toEqual([{ account_id: who.accountId }]);
    expect(await audits(who.accountId)).toHaveLength(1);
    expect(await pendingCount(gh)).toBe(0);
  });

  it('a new claim announces itself once (installation.changed, installed), by the callback and by the delivery; a repeat adds nothing', async () => {
    const h = harness();
    const who = await seed();
    const evs = async () =>
      (await admin.query(`SELECT payload FROM domain_events WHERE account_id = $1 AND type = 'installation.changed' ORDER BY seq`, [who.accountId])).rows.map((r) => r.payload);
    const gh = ++nextGh;
    await deliver(h.recheck, 'team_readonly', created(gh, INSTALLER));
    expect(await callback(who, INSTALLER, gh, h.recheck, 'team_readonly')).toBe('ok');
    expect(await evs()).toEqual([{ kind: 'team_readonly', state: 'installed' }]);
    expect(await callback(who, INSTALLER, gh, h.recheck, 'team_readonly')).toBe('ok');
    expect(await evs()).toHaveLength(1);
    // the delivery-completes-a-pending-claim path
    const gh2 = ++nextGh;
    await admin.query(
      `INSERT INTO installation_pending_claims (gh_installation_id, app_kind, gh_user_id, account_id, user_id, expires_at) VALUES ($1, 'team_readonly', $2, $3, $4, now() + interval '5 minutes')`,
      [gh2, INSTALLER, who.accountId, who.userId],
    );
    await deliver(h.recheck, 'team_readonly', created(gh2, INSTALLER));
    expect(await evs()).toHaveLength(2);
  });

  it('malformed or unrelated deliveries record nothing', async () => {
    const h = harness();
    const gh = ++nextGh;
    for (const payload of [
      null,
      { action: 'created', installation: { id: gh } },
      { action: 'created', installation: { id: `${gh}` }, sender: { id: INSTALLER } },
      { action: 'created', installation: { id: gh }, sender: { id: 0 } },
      { action: 'new_permissions_accepted', installation: { id: gh }, sender: { id: INSTALLER } },
    ]) {
      await deliver(h.recheck, 'team', payload);
    }
    expect((await admin.query(`SELECT 1 FROM installation_installers WHERE gh_installation_id = $1`, [gh])).rowCount).toBe(0);
  });

  it('R2: a non-installer cannot claim, even an org admin who has the installation in /user/installations', async () => {
    const h = harness();
    const gh = ++nextGh;
    const orgAdmin = await seed('admin');
    await deliver(h.recheck, 'team', created(gh, INSTALLER));
    expect(await callback(orgAdmin, OTHER, gh, h.recheck)).toBe('not_installer');
    expect(await bound(gh)).toEqual([]);
    expect(h.recheck).not.toHaveBeenCalled();
    expect(await audits(orgAdmin.accountId)).toHaveLength(0);
    expect(await pendingCount(gh)).toBe(0);
  });

  it('R2/R4: the installer binds after the recheck, which runs before the insert; the audit names the path', async () => {
    const h = harness();
    const gh = ++nextGh;
    const who = await seed();
    await deliver(h.recheck, 'team', created(gh, INSTALLER));
    expect(await callback(who, INSTALLER, gh, h.recheck)).toBe('ok');
    expect(h.order).toEqual(['recheck(rows=0)']);
    expect(await bound(gh)).toEqual([{ account_id: who.accountId }]);
    expect((await audits(who.accountId))[0]!.payload).toMatchObject({ path: 'callback', installer_gh_user_id: INSTALLER });
  });

  it('R3: callback first leaves one pending row, then the delivery binds it once with path webhook', async () => {
    const h = harness();
    const gh = ++nextGh;
    const who = await seed();
    expect(await callback(who, INSTALLER, gh, h.recheck)).toBe('pending');
    expect(await callback(who, INSTALLER, gh, h.recheck)).toBe('pending');
    expect(await pendingCount(gh)).toBe(1);
    expect(await bound(gh)).toEqual([]);

    await deliver(h.recheck, 'team', created(gh, INSTALLER));
    expect(await bound(gh)).toEqual([{ account_id: who.accountId }]);
    const a = await audits(who.accountId);
    expect(a).toHaveLength(1);
    expect(a[0]!.payload.path).toBe('webhook');
    expect(await pendingCount(gh)).toBe(0);
    await deliver(h.recheck, 'team', created(gh, INSTALLER)); // replay
    expect(await audits(who.accountId)).toHaveLength(1);
  });

  it('H1b: a pending claim whose bind throws is reported as a coded class, binds nothing and keeps the claim for the next callback', async () => {
    const h = harness();
    const gh = ++nextGh;
    const who = await seed();
    expect(await callback(who, INSTALLER, gh, h.recheck)).toBe('pending');

    const reports = captureReports();
    const exploding = vi.fn(async () => {
      throw Object.assign(new Error('recheck failed for ghs_FAKE_h1b_installer_token at https://api.github.com/app/installations/1'), { code: 'ECONNRESET' });
    });
    await deliver(exploding, 'team', created(gh, INSTALLER));

    expect(await bound(gh)).toEqual([]);
    expect(await pendingCount(gh)).toBe(1);
    expect(reports.classes).toEqual([{ service: 'test', route: '/', stage: 'github.bind_pending_claim', code: 'ECONNRESET' }]);
    expect(reports.everything()).not.toMatch(/ghs_FAKE_h1b_installer_token|api\.github\.com/);
  });

  it('H1b: an App whose credentials cannot be read fails the bind and is reported by stage only', async () => {
    const h = harness();
    const gh = ++nextGh;
    const who = await seed();
    const reports = captureReports();
    const outcome = await bindClaim(
      {
        platformOpsPool,
        appCredentials: () => {
          throw new Error('GITHUB_APP_TEAM_PRIVATE_KEY missing: -----BEGIN FAKE h1b KEY-----');
        },
        recheck: h.recheck,
      },
      { kind: 'team', accountId: who.accountId, userId: who.userId, ghInstallationId: gh, installerGhUserId: INSTALLER, path: 'callback' },
    );
    expect(outcome).toBe('failed');
    expect(reports.classes).toEqual([{ service: 'test', route: '/', stage: 'github.install.credentials', code: 'other' }]);
    expect(reports.everything()).not.toMatch(/PRIVATE_KEY|FAKE h1b KEY/);
  });

  it('R3: a pending claim by someone who is not the installer never binds, and cannot displace the installer\'s own', async () => {
    const h = harness();
    const gh = ++nextGh;
    const squatter = await seed();
    const real = await seed();
    expect(await callback(real, INSTALLER, gh, h.recheck)).toBe('pending');
    expect(await callback(squatter, OTHER, gh, h.recheck)).toBe('pending');
    await deliver(h.recheck, 'team', created(gh, INSTALLER));
    expect(await bound(gh)).toEqual([{ account_id: real.accountId }]);
    expect(await audits(squatter.accountId)).toHaveLength(0);
  });

  it('R3: an expired pending claim is inert when the delivery arrives', async () => {
    const h = harness();
    const gh = ++nextGh;
    const who = await seed();
    expect(await callback(who, INSTALLER, gh, h.recheck)).toBe('pending');
    await admin.query(`UPDATE installation_pending_claims SET expires_at = now() - interval '1 second' WHERE gh_installation_id = $1`, [gh]);
    await deliver(h.recheck, 'team', created(gh, INSTALLER));
    expect(await bound(gh)).toEqual([]);
    expect(h.recheck).not.toHaveBeenCalled();
  });

  it('R4: a failed recheck (removed, other App, suspended) binds nothing, on the callback path and the webhook path', async () => {
    const dead = harness(false);
    const gh = ++nextGh;
    const who = await seed();
    await deliver(dead.recheck, 'team', created(gh, INSTALLER));
    expect(await callback(who, INSTALLER, gh, dead.recheck)).toBe('inactive');
    expect(await bound(gh)).toEqual([]);
    expect(await audits(who.accountId)).toHaveLength(0);

    const gh2 = ++nextGh;
    expect(await callback(who, INSTALLER, gh2, dead.recheck)).toBe('pending');
    await deliver(dead.recheck, 'team', created(gh2, INSTALLER));
    expect(dead.recheck).toHaveBeenCalledTimes(2);
    expect(await bound(gh2)).toEqual([]);
    expect(await audits(who.accountId)).toHaveLength(0);
  });

  it('a recorded deletion or suspension refuses the callback before any GitHub recheck', async () => {
    const h = harness();
    const who = await seed();
    for (const action of ['deleted', 'suspend']) {
      const gh = ++nextGh;
      await deliver(h.recheck, 'team', created(gh, INSTALLER));
      await deliver(h.recheck, 'team', created(gh, INSTALLER, action));
      expect(await callback(who, INSTALLER, gh, h.recheck)).toBe('inactive');
      expect(await bound(gh)).toEqual([]);
    }
    expect(h.recheck).not.toHaveBeenCalled();
  });

  it('two tenants of the same installer cannot both bind one installation', async () => {
    const h = harness();
    const gh = ++nextGh;
    const a = await seed();
    const b = await seed();
    await deliver(h.recheck, 'team', created(gh, INSTALLER));
    expect(await callback(a, INSTALLER, gh, h.recheck)).toBe('ok');
    expect(await callback(b, INSTALLER, gh, h.recheck)).toBe('claimed');
    expect(await bound(gh)).toEqual([{ account_id: a.accountId }]);
    expect(await audits(b.accountId)).toHaveLength(0);
  });

  it('a plain member cannot leave a pending claim', async () => {
    const h = harness();
    const gh = ++nextGh;
    expect(await callback(await seed('member'), INSTALLER, gh, h.recheck)).toBe('failed');
    expect(await pendingCount(gh)).toBe(0);
  });

  it('the rule applies to team_readonly too', async () => {
    const h = harness();
    const gh = ++nextGh;
    const who = await seed();
    await deliver(h.recheck, 'team_readonly', created(gh, INSTALLER));
    expect(await callback(who, OTHER, gh, h.recheck, 'team_readonly')).toBe('not_installer');
    expect(await callback(who, INSTALLER, gh, h.recheck, 'team_readonly')).toBe('ok');
  });

  it('no token, code or id reaches a log line on the webhook path', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    }
    const h = harness(false);
    const gh = ++nextGh;
    const who = await seed();
    await callback(who, INSTALLER, gh, h.recheck);
    await deliver(h.recheck, 'team', created(gh, INSTALLER));
    vi.restoreAllMocks();
    expect(lines).toEqual([]);
  });

  it('migration 0667: app_user has no access, and platform_ops can neither change the installer nor delete an installer row', async () => {
    const gh = ++nextGh;
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team', $2)`, [gh, INSTALLER]);
    for (const table of ['installation_installers', 'installation_pending_claims']) {
      await expect(appUserPool.query(`SELECT 1 FROM ${table}`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    }
    await expect(platformOpsPool.query(`UPDATE installation_installers SET installer_gh_user_id = 1 WHERE gh_installation_id = $1`, [gh])).rejects.toMatchObject({
      code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
    });
    await expect(platformOpsPool.query(`DELETE FROM installation_installers WHERE gh_installation_id = $1`, [gh])).rejects.toMatchObject({
      code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
    });
  });
});
