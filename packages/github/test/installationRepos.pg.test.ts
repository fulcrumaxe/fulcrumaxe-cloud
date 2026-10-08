import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import {
  InstallationTokenCache,
  completeInstall,
  handleGithubWebhookEventForApp,
  recordInstallationLifecycle,
  syncInstallationRepos,
  syncClaimedInstallation,
  type GithubWebhookDbDeps,
  type GithubWebhookPayload,
  type SyncDeps,
} from '../src/index.js';
import { captureReports } from './helpers/captureReports.js';

/**
 * D#2 H17b-2 against real Postgres: the installation_repositories case, the
 * post-commit failure-tolerant sync wiring, and the suspended/deleted stop.
 */
describe('repo sync wiring (D#2 H17b-2)', () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let admin: PoolClient;
  let pem: string;
  let nextGh = 8_300_000;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    pem = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
      .privateKey as unknown as string;
  });
  afterAll(async () => {
    admin.release();
    await appUserPool.end();
    await platformOpsPool.end();
    await adminPool.end();
  });

  async function account(): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [id, `cus_${id}`]);
    return id;
  }
  async function install(accountId: string, kind = 'team') {
    const id = randomUUID();
    const gh = nextGh++;
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [id, accountId, gh, kind]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, $2, 1)`, [gh, kind]);
    return { id, gh };
  }
  async function repo(accountId: string, installationId: string | null, ghRepoId: number) {
    await admin.query(
      `INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', $4)`,
      [accountId, installationId, ghRepoId, `r${ghRepoId}`],
    );
  }
  const attached = async (accountId: string) =>
    (await admin.query(`SELECT gh_repo_id::int AS id, installation_id FROM repos WHERE account_id = $1 ORDER BY gh_repo_id`, [accountId])).rows;

  const deps = (extra: Partial<GithubWebhookDbDeps> = {}): GithubWebhookDbDeps => ({ appUserPool, platformOpsPool, ...extra });
  const event = (ghInstallation: number, action: 'added' | 'removed', ids: number[]): GithubWebhookPayload => ({
    action,
    installation: { id: ghInstallation },
    [action === 'added' ? 'repositories_added' : 'repositories_removed']: ids.map((id) => ({ id })),
  }) as GithubWebhookPayload;
  const deliver = (d: GithubWebhookDbDeps, payload: GithubWebhookPayload, kind: 'team' | 'team_readonly' = 'team') =>
    handleGithubWebhookEventForApp(d, 'installation_repositories', payload, randomUUID(), kind);

  it('removed detaches only that installation\'s rows for the listed repos; never deletes, never touches another installation or account', async () => {
    const a = await account();
    const b = await account();
    const one = await install(a);
    const two = await install(a);
    const other = await install(b);
    await repo(a, one.id, 1);
    await repo(a, one.id, 2);
    await repo(a, two.id, 3);
    await repo(b, other.id, 1);
    await repo(b, other.id, 3);

    const out = await deliver(deps(), event(one.gh, 'removed', [1, 3]));
    expect(out).toMatchObject({ handled: true, result: { applied: 'repos_detached', count: 1, syncRequested: false } });
    expect(await attached(a)).toEqual([{ id: 1, installation_id: null }, { id: 2, installation_id: one.id }, { id: 3, installation_id: two.id }]);
    expect(await attached(b)).toEqual([{ id: 1, installation_id: other.id }, { id: 3, installation_id: other.id }]);
  });

  it('the tenant comes from the verified installation only: an unknown installation, a site-kit delivery or a kind mismatch changes nothing', async () => {
    const a = await account();
    const ro = await install(a, 'team_readonly');
    const team = await install(a);
    await repo(a, ro.id, 5);
    await repo(a, team.id, 6);
    expect(await deliver(deps(), event(9_999_999, 'removed', [5, 6]))).toEqual({ handled: false, reason: 'unknown_tenant' });
    // the site-kit App stays inert; a delivery naming an installation of another kind is refused either way round
    const sitekitDelivery = handleGithubWebhookEventForApp(deps(), 'installation_repositories', event(team.gh, 'removed', [6]), randomUUID(), 'sitekit');
    expect(await sitekitDelivery).toEqual({ handled: false, reason: 'inert_app_kind' });
    expect(await deliver(deps({ warn: () => {} }), event(team.gh, 'removed', [6]), 'team_readonly')).toEqual({ handled: false, reason: 'app_kind_mismatch' });
    expect(await deliver(deps({ warn: () => {} }), event(ro.gh, 'removed', [5]))).toEqual({ handled: false, reason: 'app_kind_mismatch' });
    expect(await attached(a)).toEqual([{ id: 5, installation_id: ro.id }, { id: 6, installation_id: team.id }]);
  });

  describe('the read-only App: installation_repositories is the one delivery it may act on', () => {
    it('removed detaches only that read-only installation\'s listed repos; never deletes, never touches another installation or account', async () => {
      const a = await account();
      const b = await account();
      const ro = await install(a, 'team_readonly');
      const team = await install(a);
      const otherRo = await install(b, 'team_readonly');
      await repo(a, ro.id, 1);
      await repo(a, ro.id, 2);
      await repo(a, team.id, 3);
      await repo(b, otherRo.id, 1);
      const out = await deliver(deps(), event(ro.gh, 'removed', [1, 3]), 'team_readonly');
      expect(out).toMatchObject({ handled: true, result: { applied: 'repos_detached', count: 1, syncRequested: false } });
      expect(await attached(a)).toEqual([{ id: 1, installation_id: null }, { id: 2, installation_id: ro.id }, { id: 3, installation_id: team.id }]);
      expect(await attached(b)).toEqual([{ id: 1, installation_id: otherRo.id }]);
    });

    it('added asks for the post-commit repo sync of that installation, and removed alone does not', async () => {
      const a = await account();
      const ro = await install(a, 'team_readonly');
      const syncRepos = vi.fn(async () => ({}));
      expect(await deliver(deps({ syncRepos }), event(ro.gh, 'added', [11]), 'team_readonly')).toMatchObject({
        handled: true,
        result: { applied: 'repos_detached', syncRequested: true },
      });
      expect(syncRepos).toHaveBeenCalledWith(ro.id);
      await deliver(deps({ syncRepos }), event(ro.gh, 'removed', [11]), 'team_readonly');
      expect(syncRepos).toHaveBeenCalledTimes(1);
    });

    it('any other action of that event, and every other event from the read-only App, changes nothing', async () => {
      const a = await account();
      const ro = await install(a, 'team_readonly');
      await repo(a, ro.id, 1);
      const syncRepos = vi.fn(async () => ({}));
      const odd = { action: 'other', installation: { id: ro.gh }, repositories_removed: [{ id: 1 }], repositories_added: [{ id: 2 }] } as unknown as GithubWebhookPayload;
      expect(await deliver(deps({ syncRepos }), odd, 'team_readonly')).toMatchObject({ handled: true, result: { applied: 'skipped' } });
      for (const name of ['installation', 'issues', 'pull_request', 'push'] as const) {
        const payload = { action: 'removed', installation: { id: ro.gh }, repositories_removed: [{ id: 1 }] } as unknown as GithubWebhookPayload;
        const result = await handleGithubWebhookEventForApp(deps({ syncRepos }), name, payload, randomUUID(), 'team_readonly');
        expect(result).toEqual({ handled: false, reason: 'inert_app_kind' });
      }
      expect(await attached(a)).toEqual([{ id: 1, installation_id: ro.id }]);
      expect(syncRepos).not.toHaveBeenCalled();
    });
  });

  it('added runs the sync after commit; a failing sync is logged without names and never fails the delivery', async () => {
    const a = await account();
    const inst = await install(a);
    const warn = vi.fn();
    const seen: string[] = [];
    const syncRepos = vi.fn(async (id: string) => {
      seen.push(id);
      throw new Error('boom secret-repo-name ghs_token');
    });
    const reports = captureReports();
    const out = await deliver(deps({ syncRepos, warn }), event(inst.gh, 'added', [11]));
    expect(out).toMatchObject({ handled: true, result: { applied: 'repos_detached', syncRequested: true } });
    expect(seen).toEqual([inst.id]);
    // The same failure goes to the reporter as a class: the webhook route, no repo name, no token.
    expect(reports.classes).toHaveLength(1);
    expect(reports.classes[0]).toMatchObject({ service: 'test', route: '/api/github/webhook', code: 'other' });
    expect(reports.everything()).not.toMatch(/secret-repo-name|ghs_token/);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/^github repo sync failed \([A-Za-z0-9_. -]+\); the next event retries$/);
    // removed (nothing added) does not sync
    await deliver(deps({ syncRepos, warn }), event(inst.gh, 'removed', [11]));
    expect(syncRepos).toHaveBeenCalledTimes(1);
  });

  it('H1b: the post-commit sync used by the install callback reports its failure as a class without names', async () => {
    const a = await account();
    const inst = await install(a);
    const warn = vi.fn();
    const reports = captureReports();
    const syncRepos = vi.fn(async () => {
      throw new Error('boom secret-repo-name ghs_token');
    });
    await syncClaimedInstallation({ platformOpsPool, syncRepos, warn }, 'team', inst.gh);
    expect(syncRepos).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(reports.classes).toHaveLength(1);
    expect(reports.classes[0]).toMatchObject({ service: 'test', route: '/', code: 'other' });
    expect(reports.everything()).not.toMatch(/secret-repo-name|ghs_token/);
  });

  it('the claim path syncs only after the claim transaction committed, and a sync failure leaves the claim intact', async () => {
    const acc = await account();
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [acc, userId]);
    const gh = nextGh++;
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team', 7001)`, [gh]);
    const visible: unknown[] = [];
    const warn = vi.fn();
    const syncRepos = vi.fn(async () => {
      visible.push((await admin.query(`SELECT id FROM installations WHERE gh_installation_id = $1`, [gh])).rowCount);
      throw new Error('sync down');
    });
    const outcome = await completeInstall(
      {
        platformOpsPool,
        appCredentials: () => ({ appId: '7', privateKeyPem: '', webhookSecret: '' }),
        env: { GITHUB_APP_TEAM_CLIENT_ID: 'i', GITHUB_APP_TEAM_CLIENT_SECRET: 's' },
        fetchImpl: (async (url: string | URL | Request) =>
          String(url).includes('/login/oauth/')
            ? Response.json({ access_token: 'ghu_x' })
            : String(url) === 'https://api.github.com/user'
              ? Response.json({ id: 7001 })
              : Response.json({ installations: [{ id: gh, app_id: 7 }] })) as unknown as typeof fetch,
        recheck: async () => true,
        syncRepos,
        warn,
      },
      { kind: 'team', accountId: acc, userId, installationId: String(gh), code: 'c0de' },
    );
    expect(outcome).toBe('ok');
    expect(visible).toEqual([1]); // committed before the sync ran (a sync inside the transaction would see 0 rows)
    expect(warn).toHaveBeenCalledTimes(1);

    // the webhook path: a pending claim completed by the installation.created delivery
    const gh2 = nextGh++;
    await admin.query(`INSERT INTO installation_pending_claims (gh_installation_id, app_kind, gh_user_id, account_id, user_id, expires_at) VALUES ($1, 'team', 7001, $2, $3, now() + interval '5 minutes')`, [gh2, acc, userId]);
    visible.length = 0;
    const syncRepos2 = vi.fn(async () => {
      visible.push((await admin.query(`SELECT id FROM installations WHERE gh_installation_id = $1`, [gh2])).rowCount);
    });
    await recordInstallationLifecycle(
      { platformOpsPool, appUserPool, appCredentials: () => ({ appId: '7', privateKeyPem: '', webhookSecret: '' }), recheck: async () => true, syncRepos: syncRepos2, warn },
      'team',
      { action: 'created', installation: { id: gh2 }, sender: { id: 7001 } },
    );
    expect(visible).toEqual([1]);
  });

  describe('suspended / deleted stop', () => {
    function syncDeps(fetchImpl: typeof fetch): SyncDeps {
      return {
        platformOpsPool,
        appUserPool,
        appCredentials: () => ({ appId: '7', privateKeyPem: pem, webhookSecret: '' }),
        requester: async () => ({ token: 'ghs_t', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
        cache: new InstallationTokenCache(),
        fetchImpl,
      };
    }
    const lifecycle = (gh: number, action: string) =>
      recordInstallationLifecycle({ platformOpsPool, appUserPool, appCredentials: () => ({ appId: '7', privateKeyPem: '', webhookSecret: '' }) }, 'team', {
        action,
        installation: { id: gh },
        sender: { id: 1 },
      });

    it.each(['suspend', 'deleted'])('a sync that started before a %s writes nothing after it', async (action) => {
      const acc = await account();
      const inst = await install(acc);
      const fetchImpl = (async () => {
        await lifecycle(inst.gh, action); // lands while the sync is between its entry gate and its write
        return Response.json({ total_count: 1, repositories: [{ id: 21, name: 'x', owner: { login: 'acme' } }] });
      }) as unknown as typeof fetch;
      expect(await syncInstallationRepos(syncDeps(fetchImpl), inst.id)).toEqual({ status: 'skipped', reason: 'inactive' });
      expect(await attached(acc)).toEqual([]);
    });

    it('a team_readonly unsuspend and webhook claim completion trigger a sync of that installation; suspend, and a sitekit claim, do not', async () => {
      const acc = await account();
      const userId = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [acc, userId]);
      const ro = await install(acc, 'team_readonly');
      const syncRepos = vi.fn(async () => {});
      const d = { platformOpsPool, appUserPool, appCredentials: () => ({ appId: '7', privateKeyPem: '', webhookSecret: '' }), recheck: async () => true, syncRepos };
      await recordInstallationLifecycle(d, 'team_readonly', { action: 'suspend', installation: { id: ro.gh } });
      expect(syncRepos).not.toHaveBeenCalled();
      await recordInstallationLifecycle(d, 'team_readonly', { action: 'unsuspend', installation: { id: ro.gh } });
      expect(syncRepos).toHaveBeenCalledTimes(1);
      expect(syncRepos).toHaveBeenLastCalledWith(ro.id);

      // a webhook-bound pending claim: the claim lands, then the new installation is synced
      const gh = nextGh++;
      await admin.query(`INSERT INTO installation_pending_claims (gh_installation_id, app_kind, gh_user_id, account_id, user_id, expires_at) VALUES ($1, 'team_readonly', 7001, $2, $3, now() + interval '5 minutes')`, [gh, acc, userId]);
      await recordInstallationLifecycle(d, 'team_readonly', { action: 'created', installation: { id: gh }, sender: { id: 7001 } });
      const claimed = await admin.query<{ id: string }>(`SELECT id FROM installations WHERE gh_installation_id = $1`, [gh]);
      expect(claimed.rowCount).toBe(1);
      expect(syncRepos).toHaveBeenCalledTimes(2);
      expect(syncRepos).toHaveBeenLastCalledWith(claimed.rows[0]!.id);

      // the site-kit App keeps its own flow: its claim completion syncs nothing here
      const skGh = nextGh++;
      await admin.query(`INSERT INTO installation_pending_claims (gh_installation_id, app_kind, gh_user_id, account_id, user_id, expires_at) VALUES ($1, 'sitekit', 7001, $2, $3, now() + interval '5 minutes')`, [skGh, acc, userId]);
      await recordInstallationLifecycle(d, 'sitekit', { action: 'created', installation: { id: skGh }, sender: { id: 7001 } });
      expect(syncRepos).toHaveBeenCalledTimes(2);
    });

    it('a suspend arriving while a sync holds its tenant write waits for that commit', async () => {
      const acc = await account();
      const inst = await install(acc);
      const blocker = await adminPool.connect();
      await blocker.query('BEGIN');
      // Park the sync inside its tenant write, on the first repo's lock.
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`repos-sync:${acc}:1:team`]);
      const listing = (async () => Response.json({ total_count: 2, repositories: [1, 2].map((id) => ({ id, name: `r${id}`, owner: { login: 'acme' } })) })) as unknown as typeof fetch;
      const syncP = syncInstallationRepos(syncDeps(listing), inst.id);
      for (let i = 0; i < 200; i++) {
        const w = await admin.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
        if (w.rows[0].n > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      let suspended = false;
      const suspendP = lifecycle(inst.gh, 'suspend').then(() => { suspended = true; });
      await new Promise((r) => setTimeout(r, 400));
      const early = suspended;
      await blocker.query('COMMIT');
      blocker.release();
      expect(await syncP).toMatchObject({ status: 'synced', inserted: 2 });
      await suspendP;
      expect(early).toBe(false);
    });

    it('unsuspend triggers a sync; suspend does not', async () => {
      const acc = await account();
      const inst = await install(acc);
      const syncRepos = vi.fn(async () => {});
      const d = { platformOpsPool, appUserPool, appCredentials: () => ({ appId: '7', privateKeyPem: '', webhookSecret: '' }), syncRepos };
      await recordInstallationLifecycle(d, 'team', { action: 'suspend', installation: { id: inst.gh } });
      expect(syncRepos).not.toHaveBeenCalled();
      await recordInstallationLifecycle(d, 'team', { action: 'unsuspend', installation: { id: inst.gh } });
      expect(syncRepos).toHaveBeenCalledWith(inst.id);
    });
  });

  // ONBOARDING-STATE: an uninstalled or paused installation must not leave its repos listed as installed.
  describe('detach on deleted / suspend', () => {
    const creds = () => ({ appId: '7', privateKeyPem: '', webhookSecret: '' });
    const life = (gh: number, kind: 'team' | 'team_readonly' | 'sitekit', action: string) =>
      recordInstallationLifecycle({ platformOpsPool, appUserPool, appCredentials: creds }, kind, { action, installation: { id: gh }, sender: { id: 1 } });
    const events = async (accountId: string) =>
      (await admin.query(`SELECT type, subject_id, payload FROM domain_events WHERE account_id = $1 AND type IN ('installation.changed', 'repos.changed') ORDER BY seq`, [accountId])).rows;
    const rows = async (accountId: string) =>
      (await admin.query(`SELECT gh_repo_id::int AS id, installation_id, gh_owner, gh_name FROM repos WHERE account_id = $1 ORDER BY gh_repo_id`, [accountId])).rows;

    it.each([
      ['deleted', 'deleted'],
      ['suspend', 'suspended'],
    ])('%s detaches that installation\'s repos (rows kept, names kept), leaves every other installation and account alone, and says so once', async (action, state) => {
      const a = await account();
      const b = await account();
      const gone = await install(a, 'team_readonly');
      const stays = await install(a, 'team');
      const theirs = await install(b, 'team_readonly');
      await repo(a, gone.id, 1);
      await repo(a, gone.id, 2);
      await repo(a, stays.id, 3);
      await repo(b, theirs.id, 4);
      await life(gone.gh, 'team_readonly', action);
      expect(await rows(a)).toEqual([
        { id: 1, installation_id: null, gh_owner: 'acme', gh_name: 'r1' },
        { id: 2, installation_id: null, gh_owner: 'acme', gh_name: 'r2' },
        { id: 3, installation_id: stays.id, gh_owner: 'acme', gh_name: 'r3' },
      ]);
      expect((await rows(b))[0]!.installation_id).toBe(theirs.id);
      const ev = await events(a);
      // repos.changed commits with the detach (tenant transaction), so it lands before the outer installation.changed.
      expect(ev.map((e) => e.type)).toEqual(['repos.changed', 'installation.changed']);
      expect(ev[1]).toMatchObject({ subject_id: gone.id, payload: { kind: 'team_readonly', state } });
      expect(ev[0]!.payload).toEqual({ kind: 'team_readonly', detached: 2 });
      expect(await events(b)).toEqual([]);
    });

    it.each(['deleted', 'suspend'])('%s: if the outer platform_ops transaction fails after the detach, the detach persists and so does its repos.changed event', async (action) => {
      const a = await account();
      const inst = await install(a, 'team_readonly');
      await repo(a, inst.id, 1);
      await repo(a, inst.id, 2);
      // A platform_ops pool whose clients fail the outer transaction when it emits installation.changed (after the detach).
      const failingOps = {
        connect: async () => {
          const c = await platformOpsPool.connect();
          const original = c.query;
          const release = c.release.bind(c);
          const query = c.query.bind(c) as (...q: unknown[]) => Promise<unknown>;
          // The pooled client is reused by later tests: put its query back when it is handed back.
          (c as unknown as { release: unknown }).release = (...r: unknown[]) => {
            c.query = original;
            return (release as (...a: unknown[]) => void)(...r);
          };
          (c as unknown as { query: unknown }).query = async (...q: unknown[]) => {
            if (typeof q[0] === 'string' && q[0].includes('INSERT INTO domain_events') && Array.isArray(q[1]) && q[1].includes('installation.changed')) {
              throw new Error('outer transaction failed');
            }
            return query(...q);
          };
          return c;
        },
      } as unknown as Pool;
      await expect(
        recordInstallationLifecycle({ platformOpsPool: failingOps, appUserPool, appCredentials: creds }, 'team_readonly', { action, installation: { id: inst.gh }, sender: { id: 1 } }),
      ).rejects.toThrow('outer transaction failed');
      // The detach committed in its own transaction ...
      expect((await rows(a)).map((r) => r.installation_id)).toEqual([null, null]);
      // ... so its event must have committed with it; the outer installation.changed rolled back.
      expect((await events(a)).map((e) => [e.type, e.payload])).toEqual([['repos.changed', { kind: 'team_readonly', detached: 2 }]]);
    });

    it('an installation with no repos still emits installation.changed (the Onboarding step depends on it), and an unknown installation emits nothing', async () => {
      const a = await account();
      const inst = await install(a, 'team_readonly');
      await life(inst.gh, 'team_readonly', 'deleted');
      expect((await events(a)).map((e) => e.type)).toEqual(['installation.changed']);
      const before = Number((await admin.query(`SELECT count(*) AS n FROM domain_events`)).rows[0].n);
      await life(nextGh++, 'team_readonly', 'deleted');
      expect(Number((await admin.query(`SELECT count(*) AS n FROM domain_events`)).rows[0].n)).toBe(before);
    });

    it('the detach runs under the installation advisory lock: a suspend waits for a holder and detaches only once it is released', async () => {
      const a = await account();
      const inst = await install(a);
      await repo(a, inst.id, 1);
      const blocker = await adminPool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1::bigint)', [inst.gh]);
      let done = false;
      const p = life(inst.gh, 'team', 'suspend').then(() => { done = true; });
      await new Promise((r) => setTimeout(r, 400));
      expect(done).toBe(false);
      expect((await rows(a))[0]!.installation_id).toBe(inst.id);
      await blocker.query('COMMIT');
      blocker.release();
      await p;
      expect((await rows(a))[0]!.installation_id).toBeNull();
    });

    it('suspend then unsuspend: repos come back through the real sync, and each step is announced', async () => {
      const a = await account();
      const inst = await install(a, 'team_readonly');
      await repo(a, inst.id, 1);
      await life(inst.gh, 'team_readonly', 'suspend');
      expect((await rows(a))[0]!.installation_id).toBeNull();
      const listing = (async () => Response.json({ total_count: 1, repositories: [{ id: 1, name: 'r1', owner: { login: 'acme' } }] })) as unknown as typeof fetch;
      const sync = (id: string) => syncInstallationRepos({
        platformOpsPool, appUserPool, appCredentials: () => ({ appId: '7', privateKeyPem: pem, webhookSecret: '' }),
        requester: async () => ({ token: 'ghs_t', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), cache: new InstallationTokenCache(), fetchImpl: listing,
      }, id);
      // while suspended the sync writes nothing
      expect(await sync(inst.id)).toEqual({ status: 'skipped', reason: 'inactive' });
      await recordInstallationLifecycle({ platformOpsPool, appUserPool, appCredentials: creds, syncRepos: sync }, 'team_readonly', { action: 'unsuspend', installation: { id: inst.gh } });
      expect((await rows(a))[0]!.installation_id).toBe(inst.id);
      expect((await events(a)).map((e) => `${e.type}:${e.payload.state ?? e.payload.detached ?? e.payload.inserted}`)).toEqual([
        'repos.changed:1', 'installation.changed:suspended', 'installation.changed:unsuspended', 'repos.changed:0',
      ]);
    });

    it('a repo listed under a site-kit installation is detached too, and a delete of a different kind with the same GitHub id is not mistaken for it', async () => {
      const a = await account();
      const sk = await install(a, 'sitekit');
      const gh = sk.gh;
      await admin.query(`INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, 'team')`, [a, gh]);
      await repo(a, sk.id, 1);
      await life(gh, 'team', 'deleted'); // the team record of that id does not exist: nothing of the site-kit installation moves
      expect((await rows(a))[0]!.installation_id).toBe(sk.id);
      await life(gh, 'sitekit', 'deleted');
      expect((await rows(a))[0]!.installation_id).toBeNull();
    });
  });
});
