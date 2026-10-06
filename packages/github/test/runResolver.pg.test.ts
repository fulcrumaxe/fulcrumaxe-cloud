import { randomUUID, generateKeyPairSync } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { createRunResolver } from '../src/runResolver.js';
import { decideProxyRequest, type ProxyDecisionDeps } from '../src/proxyDecision.js';
import { InstallationTokenCache, type AccessTokenRequester } from '../src/installationToken.js';
import { ensureGhProxyTestLogin } from './helpers/ghProxyLogin.js';
import { captureReports } from './helpers/captureReports.js';
import { seedAccountWithRepo, seedAgentRun, setRepoGithubNames, type SeedRefs } from './helpers/seed.js';

/**
 * D#2 H13c (correction C27), H13c-4: `createRunResolver`'s real-Postgres
 * behavior -- one allow fixture, and one fixture for every deny case
 * H13c-4 names: no row, two rows, a terminal run, a NULL
 * `dispatch_repo_id`, a deleted repo, a missing installation, a missing
 * name, and a DB error.
 *
 * Also covers H13c-5's own requirement -- "a new handler-level test with
 * the real resolver over a pg fixture reaches the mint spy exactly once
 * for the allow fixture" -- via `decideProxyRequest` directly (the exact
 * function `ghProxyHandler` calls; the route/host/OIDC layer above it is
 * already covered with no database in apps/web's own handler.test.ts, so
 * a second Next.js-level test would exercise nothing new).
 */
describe('createRunResolver (D#2 H13c, C27)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool; // the gh-proxy's narrow login since 0696
  let ghProxyUrl: string;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    ghProxyUrl = await ensureGhProxyTestLogin(process.env.GITHUB_DATABASE_URL!);
    platformOpsPool = createPool(ghProxyUrl);
    admin = await adminPool.connect();
    refs = await seedAccountWithRepo(admin, 5252);
    await setRepoGithubNames(admin, refs.repoId, 'acme-corp', 'widgets');
  });

  afterAll(async () => {
    admin.release();
    await platformOpsPool.end();
    await adminPool.end();
  });

  it('allow: role/product/installationId/owner/repo, for a pending or running non-terminal run', async () => {
    const resolver = createRunResolver(platformOpsPool);
    const sandboxName = `sbx-allow-${randomUUID()}`;
    await seedAgentRun(admin, refs.accountId, { sandboxName, role: 'executor', status: 'running', dispatchRepoId: refs.repoId });

    const result = await resolver(sandboxName);
    expect(result).toEqual({
      role: 'executor',
      product: 'team',
      installationId: refs.ghInstallationId,
      appKind: 'team',
      owner: 'acme-corp',
      repo: 'widgets',
    });
  });

  it('allow: also resolves a "paused" run (non-terminal, per RUN_STATUS_TRANSITIONS)', async () => {
    const resolver = createRunResolver(platformOpsPool);
    const sandboxName = `sbx-paused-${randomUUID()}`;
    await seedAgentRun(admin, refs.accountId, { sandboxName, status: 'paused', dispatchRepoId: refs.repoId });

    const result = await resolver(sandboxName);
    expect(result).not.toBeNull();
  });

  it('deny: no row for this sandbox_name', async () => {
    const resolver = createRunResolver(platformOpsPool);
    expect(await resolver(`sbx-no-such-run-${randomUUID()}`)).toBeNull();
  });

  it('deny: two LIVE rows share the same sandbox_name (ambiguous match)', async () => {
    const resolver = createRunResolver(platformOpsPool);
    const sandboxName = `sbx-dup-${randomUUID()}`;
    await seedAgentRun(admin, refs.accountId, { sandboxName, status: 'running', dispatchRepoId: refs.repoId });
    await seedAgentRun(admin, refs.accountId, { sandboxName, status: 'paused', dispatchRepoId: refs.repoId });
    expect(await resolver(sandboxName)).toBeNull();
  });

  it('allow (executor fix round): the first run on the PR ended, the second is live on the same name -> the second resolves', async () => {
    const resolver = createRunResolver(platformOpsPool);
    // Executor runs on one PR reuse one name on purpose (resume finds the sandbox by it).
    const sandboxName = `ex-fixround-${randomUUID()}`;
    await seedAgentRun(admin, refs.accountId, { sandboxName, role: 'executor', status: 'succeeded', dispatchRepoId: refs.repoId });
    expect(await resolver(sandboxName)).toBeNull(); // between rounds nothing is live
    await seedAgentRun(admin, refs.accountId, { sandboxName, role: 'executor', status: 'running', dispatchRepoId: refs.repoId });
    expect(await resolver(sandboxName)).toEqual({
      role: 'executor',
      product: 'team',
      installationId: refs.ghInstallationId,
      appKind: 'team',
      owner: 'acme-corp',
      repo: 'widgets',
    });
  });

  it('allow: one live run resolves although several ended runs share its name', async () => {
    const resolver = createRunResolver(platformOpsPool);
    const sandboxName = `ex-manyrounds-${randomUUID()}`;
    for (const status of ['failed', 'cancelled', 'timed_out']) {
      await seedAgentRun(admin, refs.accountId, { sandboxName, status, dispatchRepoId: refs.repoId });
    }
    await seedAgentRun(admin, refs.accountId, { sandboxName, status: 'pending', dispatchRepoId: refs.repoId });
    expect(await resolver(sandboxName)).not.toBeNull();
  });

  it('deny: only ended runs share the name', async () => {
    const resolver = createRunResolver(platformOpsPool);
    const sandboxName = `ex-allended-${randomUUID()}`;
    await seedAgentRun(admin, refs.accountId, { sandboxName, status: 'succeeded', dispatchRepoId: refs.repoId });
    await seedAgentRun(admin, refs.accountId, { sandboxName, status: 'failed', dispatchRepoId: refs.repoId });
    expect(await resolver(sandboxName)).toBeNull();
  });

  it.each(['succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled', 'refused_spend'])(
    'deny: a terminal run (status=%s)',
    async (status) => {
      const resolver = createRunResolver(platformOpsPool);
      const sandboxName = `sbx-terminal-${status}-${randomUUID()}`;
      await seedAgentRun(admin, refs.accountId, { sandboxName, status, dispatchRepoId: refs.repoId });
      expect(await resolver(sandboxName)).toBeNull();
    },
  );

  it('deny: NULL dispatch_repo_id (never dispatched, or a pre-migration row)', async () => {
    const resolver = createRunResolver(platformOpsPool);
    const sandboxName = `sbx-nulldispatch-${randomUUID()}`;
    await seedAgentRun(admin, refs.accountId, { sandboxName, dispatchRepoId: null });
    expect(await resolver(sandboxName)).toBeNull();
  });

  it('deny: a deleted repo (dispatch_repo_id names a row that no longer exists -- no FK, see 0605)', async () => {
    const resolver = createRunResolver(platformOpsPool);
    const doomedRepoId = randomUUID();
    await admin.query(
      `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name)
       VALUES ($1, $2, $3, 9998, 'team', 'acme-corp', 'doomed')`,
      [doomedRepoId, refs.accountId, refs.installationId],
    );
    const sandboxName = `sbx-deletedrepo-${randomUUID()}`;
    await seedAgentRun(admin, refs.accountId, { sandboxName, dispatchRepoId: doomedRepoId });
    await admin.query(`DELETE FROM repos WHERE id = $1`, [doomedRepoId]);

    expect(await resolver(sandboxName)).toBeNull();
  });

  it('deny: repo has no installation (installation_id IS NULL)', async () => {
    const resolver = createRunResolver(platformOpsPool);
    const unlinkedRepoId = randomUUID();
    await admin.query(
      `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name)
       VALUES ($1, $2, NULL, 9997, 'team', 'acme-corp', 'unlinked')`,
      [unlinkedRepoId, refs.accountId],
    );
    const sandboxName = `sbx-noinstallation-${randomUUID()}`;
    await seedAgentRun(admin, refs.accountId, { sandboxName, dispatchRepoId: unlinkedRepoId });

    expect(await resolver(sandboxName)).toBeNull();
  });

  it('deny: repo has an installation but no stored owner/name', async () => {
    const resolver = createRunResolver(platformOpsPool);
    const namelessRepoId = randomUUID();
    await admin.query(
      `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product)
       VALUES ($1, $2, $3, 9996, 'team')`,
      [namelessRepoId, refs.accountId, refs.installationId],
    );
    const sandboxName = `sbx-noname-${randomUUID()}`;
    await seedAgentRun(admin, refs.accountId, { sandboxName, dispatchRepoId: namelessRepoId });

    expect(await resolver(sandboxName)).toBeNull();
  });

  describe('M1 (fix round 1, security review NEEDS-FIX, D#2 C27, CWE-639): a duplicated gh_installation_id must deny', () => {
    it('two DIFFERENT accounts share one gh_installation_id -- BOTH resolve to null', async () => {
      // Migration 0655 makes (gh_installation_id, app_kind) unique, but the
      // resolver looks up by gh_installation_id alone, so two accounts can
      // still collide across app kinds: the shape this guard must deny.
      const sharedGhInstallationId = 700_000 + Math.floor(Math.random() * 90_000);
      const acctA = await seedAccountWithRepo(admin, sharedGhInstallationId);
      const acctB = await seedAccountWithRepo(admin, sharedGhInstallationId, 'team_readonly');
      await setRepoGithubNames(admin, acctA.repoId, 'acct-a', 'repo-a');
      await setRepoGithubNames(admin, acctB.repoId, 'acct-b', 'repo-b');

      const resolver = createRunResolver(platformOpsPool);

      const sandboxA = `sbx-dupgh-a-${randomUUID()}`;
      await seedAgentRun(admin, acctA.accountId, { sandboxName: sandboxA, dispatchRepoId: acctA.repoId });
      const sandboxB = `sbx-dupgh-b-${randomUUID()}`;
      await seedAgentRun(admin, acctB.accountId, { sandboxName: sandboxB, dispatchRepoId: acctB.repoId });

      // Each account's own account_id-scoped join lands on ITS OWN
      // installations row correctly -- the guard has to deny anyway,
      // because gh_installation_id (the value that actually reaches
      // GitHub) is ambiguous across the whole table, not just within one
      // account's join.
      expect(await resolver(sandboxA)).toBeNull();
      expect(await resolver(sandboxB)).toBeNull();
    });
  });

  describe('M2 (fix round 1, security review NEEDS-FIX, D#2 C27, CWE-639): forged cross-tenant rows must still deny', () => {
    it('a run whose dispatch_repo_id points at ANOTHER account\'s repo', async () => {
      const victim = await seedAccountWithRepo(admin, 800_000 + Math.floor(Math.random() * 90_000));
      await setRepoGithubNames(admin, victim.repoId, 'victim-corp', 'victim-repo');

      const attackerAccountId = randomUUID();
      await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [
        attackerAccountId,
        `cus_test_${attackerAccountId}`,
      ]);

      const sandboxName = `sbx-forged-dispatch-${randomUUID()}`;
      const runId = randomUUID();
      // 0605's agent_runs_dispatch_repo_same_tenant trigger normally
      // refuses a cross-account dispatch_repo_id at INSERT time --
      // disabling it (as the reviewer did) forges exactly the row shape
      // the query's OWN `r.account_id = ar.account_id` join guard is the
      // only thing standing between and a cross-tenant resolve.
      await admin.query('SET session_replication_role = replica');
      try {
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, role, runtime, status, sandbox_name, dispatch_repo_id)
           VALUES ($1, $2, 'executor', 'production', 'running', $3, $4)`,
          [runId, attackerAccountId, sandboxName, victim.repoId],
        );
      } finally {
        await admin.query('SET session_replication_role = DEFAULT');
      }

      const resolver = createRunResolver(platformOpsPool);
      expect(await resolver(sandboxName)).toBeNull();
    });

    it('a repo whose installation_id points at ANOTHER account\'s installation', async () => {
      const other = await seedAccountWithRepo(admin, 800_100 + Math.floor(Math.random() * 90_000));

      const victimAccountId = randomUUID();
      await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [
        victimAccountId,
        `cus_test_${victimAccountId}`,
      ]);

      const forgedRepoId = randomUUID();
      // repos' own composite FK to installations (account_id, id) normally
      // refuses a cross-account installation_id -- disabling it forges
      // exactly the row shape the query's OWN `i.account_id = r.account_id`
      // join guard is the only thing standing between and a cross-tenant
      // resolve.
      await admin.query('SET session_replication_role = replica');
      try {
        await admin.query(
          `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name)
           VALUES ($1, $2, $3, 9995, 'team', 'victim-corp', 'crossed-repo')`,
          [forgedRepoId, victimAccountId, other.installationId],
        );
      } finally {
        await admin.query('SET session_replication_role = DEFAULT');
      }

      const sandboxName = `sbx-forged-installation-${randomUUID()}`;
      await seedAgentRun(admin, victimAccountId, { sandboxName, dispatchRepoId: forgedRepoId });

      const resolver = createRunResolver(platformOpsPool);
      expect(await resolver(sandboxName)).toBeNull();
    });
  });

  it('deny: any DB error (e.g. the pool is unusable)', async () => {
    const deadPool = createPool(ghProxyUrl);
    await deadPool.end();
    const resolver = createRunResolver(deadPool);
    const reports = captureReports();
    expect(await resolver(`sbx-doesnt-matter-${randomUUID()}`)).toBeNull();
    // The failure is reported as one coded class (it used to be a console.error carrying the error object).
    expect(reports.classes).toEqual([{ service: 'test', route: '/', stage: 'github.run_resolve', code: 'other' }]);
  });

  it('H1b: a database error is reported by its SQLSTATE only, never its text', async () => {
    const reports = captureReports();
    const failing = {
      query: async () => {
        throw Object.assign(new Error('password authentication failed for user "ghproxy" FAKE-h1b-db-password'), { code: '28P01' });
      },
    } as unknown as Pool;
    expect(await createRunResolver(failing)(`sbx-${randomUUID()}`)).toBeNull();
    expect(reports.classes).toEqual([{ service: 'test', route: '/', stage: 'github.run_resolve', code: '28P01' }]);
    expect(reports.everything()).not.toMatch(/FAKE-h1b-db-password|ghproxy/);
  });

  describe('H13c-5: decideProxyRequest end to end with the real resolver, real fixture data', () => {
    let privateKeyPem: string;

    beforeAll(() => {
      privateKeyPem = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey as unknown as string;
    });

    it('allow fixture: reaches the mint spy exactly once, scoped to the resolved repo', async () => {
      const sandboxName = `sbx-e2e-allow-${randomUUID()}`;
      await seedAgentRun(admin, refs.accountId, { sandboxName, role: 'executor', status: 'running', dispatchRepoId: refs.repoId });

      const mintSpy: AccessTokenRequester = vi.fn(async () => ({
        token: 'ghs_test',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }));
      const deps: ProxyDecisionDeps = {
        resolveSandboxRun: createRunResolver(platformOpsPool),
        appCredentials: () => ({ appId: 'app-1', privateKeyPem, webhookSecret: 'unused-in-these-tests' }),
        tokenCache: new InstallationTokenCache(),
        accessTokenRequester: mintSpy,
      };

      const result = await decideProxyRequest(
        {
          method: 'GET',
          path: '/repos/acme-corp/widgets/issues/5',
          query: {},
          rawBody: new Uint8Array(0),
          sandboxName,
          contentEncoding: null,
        },
        deps,
      );

      expect(result).toMatchObject({ allow: true, upstreamHost: 'api.github.com', installationToken: 'ghs_test' });
      expect(mintSpy).toHaveBeenCalledTimes(1);
      expect(mintSpy).toHaveBeenCalledWith(expect.objectContaining({ repositories: ['widgets'] }));
    });

    // H13e: the kind comes from the installations row (platform_ops can read
    // app_kind since 0650), and a non-team row never reaches the mint.
    it.each(['team_readonly', 'sitekit'] as const)('deny fixture: a %s installation resolves its kind and mints nothing', async (kind) => {
      const other = await seedAccountWithRepo(admin, kind === 'sitekit' ? 5254 : 5253);
      await admin.query('UPDATE installations SET app_kind = $1 WHERE id = $2', [kind, other.installationId]);
      await setRepoGithubNames(admin, other.repoId, 'acme-other', 'gadgets');
      const sandboxName = `sbx-e2e-${kind}-${randomUUID()}`;
      await seedAgentRun(admin, other.accountId, { sandboxName, role: 'executor', status: 'running', dispatchRepoId: other.repoId });

      const resolver = createRunResolver(platformOpsPool);
      expect(await resolver(sandboxName)).toMatchObject({ appKind: kind });

      const mintSpy: AccessTokenRequester = vi.fn();
      const result = await decideProxyRequest(
        {
          method: 'GET',
          path: '/repos/acme-other/gadgets/issues/5',
          query: {},
          rawBody: new Uint8Array(0),
          sandboxName,
          contentEncoding: null,
        },
        {
          resolveSandboxRun: resolver,
          appCredentials: () => ({ appId: 'app-1', privateKeyPem, webhookSecret: 'unused-in-these-tests' }),
          tokenCache: new InstallationTokenCache(),
          accessTokenRequester: mintSpy,
        },
      );
      expect(result).toMatchObject({ allow: false, status: 403, reason: 'installation_not_writable' });
      expect(mintSpy).not.toHaveBeenCalled();
    });

    it('deny fixture: an unresolvable sandbox_name -- default proxy path, real resolver, no mint call', async () => {
      const mintSpy: AccessTokenRequester = vi.fn();
      const deps: ProxyDecisionDeps = {
        resolveSandboxRun: createRunResolver(platformOpsPool),
        appCredentials: () => ({ appId: 'app-1', privateKeyPem, webhookSecret: 'unused-in-these-tests' }),
        tokenCache: new InstallationTokenCache(),
        accessTokenRequester: mintSpy,
      };

      const result = await decideProxyRequest(
        {
          method: 'GET',
          path: '/repos/acme-corp/widgets/issues/5',
          query: {},
          rawBody: new Uint8Array(0),
          sandboxName: `sbx-e2e-unknown-${randomUUID()}`,
          contentEncoding: null,
        },
        deps,
      );

      expect(result).toMatchObject({ allow: false, status: 403, reason: 'sandbox_not_resolved' });
      expect(mintSpy).not.toHaveBeenCalled();
    });
  });
});
