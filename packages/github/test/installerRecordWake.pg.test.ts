import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { recordInstallationLifecycle } from '../src/installerRecord.js';

/**
 * The webhook claim binding wakes the discovery drain: a `created` delivery that completes a pending claim queues the
 * installation's discovery and hands the queued runs to `onDiscoveryQueued`. Real Postgres; GitHub is not involved.
 */
const INSTALLER = 7101;

describe('installer record wake hook', () => {
  let adminPool: Pool;
  let platformOpsPool: Pool;
  let appUserPool: Pool;
  let admin: PoolClient;

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

  it('a created delivery that binds a pending claim calls the hook with the queued runs, and a replay does not call it again', async () => {
    const accountId = randomUUID();
    const userId = randomUUID();
    const gh = 9_300_001;
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [accountId, userId]);
    await admin.query(
      `INSERT INTO installation_pending_claims (gh_installation_id, app_kind, gh_user_id, account_id, user_id, expires_at) VALUES ($1, 'team', $2, $3, $4, now() + interval '5 minutes')`,
      [gh, INSTALLER, accountId, userId],
    );
    // The repo sync is the one step that creates the repository to queue; stand in for it with one attached team repo.
    const ghRepoId = 880_001;
    const syncRepos = vi.fn(async (installationId: string) => {
      await admin.query(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', 'wake')`, [accountId, installationId, ghRepoId]);
      return { status: 'ok' };
    });
    const onDiscoveryQueued = vi.fn(async () => undefined);
    const deps = {
      platformOpsPool,
      appUserPool,
      appCredentials: () => ({ appId: '7', privateKeyPem: '', webhookSecret: '' }),
      recheck: vi.fn(async () => true),
      syncRepos,
      onDiscoveryQueued,
    };
    const payload = { action: 'created', installation: { id: gh }, sender: { id: INSTALLER } };

    await recordInstallationLifecycle(deps, 'team', payload);

    const stored = (await admin.query<{ id: string; repo_id: string }>(`SELECT id, repo_id FROM discovery_runs WHERE account_id = $1`, [accountId])).rows;
    expect(stored).toHaveLength(1);
    expect(onDiscoveryQueued).toHaveBeenCalledTimes(1);
    expect(onDiscoveryQueued).toHaveBeenCalledWith(accountId, [{ id: stored[0]!.id, repoId: stored[0]!.repo_id }]);

    // A replay finds the run already queued under the same reference: nothing new, so no wake.
    onDiscoveryQueued.mockClear();
    await recordInstallationLifecycle(deps, 'team', payload);
    expect(onDiscoveryQueued).not.toHaveBeenCalled();
  });
});
