import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { nextGhInstallationId } from '@fx/db/test/helpers/seed.js';
import { createTeamInstallationOwnership } from '@fx/core/src/tenancy/installationOwnership.js';
import { createPublishInstallationOwnership } from '../src/publishInstallationOwnership.js';
import { ensureGhProxyTestLogin } from './helpers/ghProxyLogin.js';
import { captureReports } from './helpers/captureReports.js';

/**
 * PUSH-OWNER-SANDBOX-DEFINER: the sandbox path's installation-ownership answer, through the production adapter on the narrow gh-proxy login against the
 * real function (migration 0908) and real rows. The function's own catalog, grants and role cases are in packages/db/test/plane-publish-installation-owned.pg.test.ts.
 * What cannot be faked: that GitHub names the installation of the repository's real owner (the table here is the test's).
 */
describe('createPublishInstallationOwnership on the narrow login', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let proxyPool: Pool;
  let opsPool: Pool;
  let ghProxyUrl: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    ghProxyUrl = await ensureGhProxyTestLogin(process.env.GITHUB_DATABASE_URL!);
    proxyPool = createPool(ghProxyUrl);
    opsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await proxyPool.end();
    await opsPool.end();
    await adminPool.end();
  });

  async function account(): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [id, `cus_test_${id}`]);
    return id;
  }
  async function installation(accountId: string, o: { installer?: 'live' | 'deleted' | 'suspended' | 'none'; kind?: 'team' | 'team_readonly' } = {}): Promise<number> {
    const gh = Number(nextGhInstallationId());
    const kind = o.kind ?? 'team';
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [randomUUID(), accountId, gh, kind]);
    const installer = o.installer ?? 'live';
    if (installer !== 'none') {
      await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id, deleted_at, suspended_at) VALUES ($1, $2, 1, $3, $4)`, [
        gh, kind, installer === 'deleted' ? new Date() : null, installer === 'suspended' ? new Date() : null,
      ]);
    }
    return gh;
  }
  async function publishRun(accountId: string, o: { role?: string; status?: string } = {}): Promise<string> {
    const name = `pp-${randomUUID()}`;
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, sandbox_name) VALUES ($1, $2, $3, 'production', $4, $5)`, [
      randomUUID(), accountId, o.role ?? 'plane_publish', o.status ?? 'running', name,
    ]);
    return name;
  }
  const owns = createPublishInstallationOwnership;

  it("accepts the run's own installation AND any other live team installation of the same account", async () => {
    const a = await account();
    const own = await installation(a);
    const other = await installation(a);
    const name = await publishRun(a);
    expect(await owns(proxyPool)(name, own)).toBe(true);
    expect(await owns(proxyPool)(name, other)).toBe(true);
  });

  it("refuses another account's installation, live or not, and an id no installation carries", async () => {
    const a = await account();
    const b = await account();
    await installation(a);
    const theirs = await installation(b);
    const name = await publishRun(a);
    expect(await owns(proxyPool)(name, theirs)).toBe(false);
    expect(await owns(proxyPool)(name, Number(nextGhInstallationId()))).toBe(false);
  });

  it.each(['deleted', 'suspended', 'none'] as const)('refuses an installation of the same account whose installer record is %s', async (installer) => {
    const a = await account();
    const gh = await installation(a, { installer });
    expect(await owns(proxyPool)(await publishRun(a), gh)).toBe(false);
  });

  it('refuses an installation of another App kind', async () => {
    const a = await account();
    const gh = await installation(a, { kind: 'team_readonly' });
    expect(await owns(proxyPool)(await publishRun(a), gh)).toBe(false);
  });

  it('refuses with no run to name the account: an unknown name, an ended run, a run of another role, two live runs under one name', async () => {
    const a = await account();
    const gh = await installation(a);
    expect(await owns(proxyPool)(`pp-${randomUUID()}`, gh)).toBe(false);
    expect(await owns(proxyPool)(await publishRun(a, { status: 'failed' }), gh)).toBe(false);
    expect(await owns(proxyPool)(await publishRun(a, { role: 'executor' }), gh)).toBe(false);
    const dup = await publishRun(a);
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, sandbox_name) VALUES ($1, $2, 'plane_publish', 'production', 'running', $3)`, [randomUUID(), a, dup]);
    expect(await owns(proxyPool)(dup, gh)).toBe(false);
  });

  it('refuses malformed input without asking the database', async () => {
    const a = await account();
    const gh = await installation(a);
    const name = await publishRun(a);
    for (const id of [0, -1, 1.5, Number.NaN, 2 ** 53]) expect(await owns(proxyPool)(name, id)).toBe(false);
    expect(await owns(proxyPool)('', gh)).toBe(false);
    expect(await owns(proxyPool)(undefined as unknown as string, gh)).toBe(false);
  });

  it('an account that loses its installation (the undo path) stops owning it at once, and a restored record owns it again', async () => {
    const a = await account();
    const gh = await installation(a);
    const name = await publishRun(a);
    expect(await owns(proxyPool)(name, gh)).toBe(true);
    await admin.query(`UPDATE installation_installers SET suspended_at = now() WHERE gh_installation_id = $1 AND app_kind = 'team'`, [gh]);
    expect(await owns(proxyPool)(name, gh)).toBe(false);
    await admin.query(`UPDATE installation_installers SET suspended_at = NULL WHERE gh_installation_id = $1 AND app_kind = 'team'`, [gh]);
    expect(await owns(proxyPool)(name, gh)).toBe(true);
    await admin.query(`DELETE FROM installations WHERE gh_installation_id = $1 AND app_kind = 'team'`, [gh]);
    expect(await owns(proxyPool)(name, gh)).toBe(false);
  });

  it('is the same rule as the shared reader the runner path uses, over one fixture matrix', async () => {
    const a = await account();
    const b = await account();
    const ids: number[] = [];
    for (const installer of ['live', 'deleted', 'suspended', 'none'] as const) {
      ids.push(await installation(a, { installer }));
      ids.push(await installation(b, { installer }));
    }
    ids.push(await installation(a, { kind: 'team_readonly' }), Number(nextGhInstallationId()));
    const name = await publishRun(a);
    const shared = createTeamInstallationOwnership(opsPool);
    for (const id of ids) expect(await owns(proxyPool)(name, id), `installation ${id}`).toBe(await shared(a, id));
    expect(ids.filter((id) => id > 0)).toHaveLength(ids.length);
    // The matrix is not vacuous: both answers occur.
    const answers = await Promise.all(ids.map((id) => shared(a, id)));
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });

  it('a database error is reported by class only and thrown, never answered as owned', async () => {
    const dead = createPool(ghProxyUrl);
    await dead.end();
    const reports = captureReports();
    await expect(owns(dead)(`pp-${randomUUID()}`, 5)).rejects.toBeTruthy();
    expect(reports.classes).toEqual([{ service: 'test', route: '/', stage: 'github.plane_publish_installation_owned', code: 'other' }]);
  });
});
