import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { InstallationTokenCache, mintAppJwt, recordInstallationLifecycle, syncInstallationRepos, type AppCredentialsSource } from '@fx/github';
import { seedAccount } from '../../billing/test/helpers/seed.js';
import {
  createGithubAppApi,
  createGithubInstallationsJob,
  createGithubReposJob,
  GITHUB_CALLS_PER_RUN,
  GITHUB_REPOS_CALLS_PER_RUN,
  GITHUB_REPOS_INSTALLATIONS_PER_RUN,
  runTick,
  type InstallationKind,
  type JobContext,
  type ReconcileJob,
  type ReportError,
} from '../src/index.js';
import { startStrictGithubApps, type StrictGithubApps } from './helpers/strictGithubApps.js';

/**
 * D#454 H2c against real Postgres and a strict GitHub fake reached over real TLS: the repo re-sync reconciler. It runs the
 * webhook path's own `syncInstallationRepos` for each live installation under a per-run budget and a cursor, mints with
 * each kind's own App key, sends the saved ETags so an unchanged list costs nothing, and never decides that anything is
 * gone from a missing list entry, a failed call or an unfinished list.
 */
const JOB = 'github_repos';
const KINDS: InstallationKind[] = ['team', 'team_readonly', 'sitekit'];

describe('github repo re-sync reconcile job', () => {
  let admin: Pool;
  let adminClient: PoolClient;
  let platformOps: Pool;
  let appUser: Pool;
  let gh: StrictGithubApps;
  let nextGh = 8_000_000;
  let nextRepo = 6_000_000;
  const reports: { err: unknown; ctx: { stage: string; route: string; code?: string } }[] = [];
  const report: ReportError = (err, ctx) => {
    reports.push({ err, ctx });
  };
  const codes = () => reports.map((r) => r.ctx.code ?? 'none');

  beforeAll(async () => {
    admin = createPool(process.env.DATABASE_URL!);
    adminClient = await admin.connect();
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appUser = createPool(process.env.DATABASE_URL_APP_USER!);
    gh = await startStrictGithubApps();
  });
  afterAll(async () => {
    await gh.close();
    adminClient.release();
    await admin.end();
    await platformOps.end();
    await appUser.end();
  });
  beforeEach(async () => {
    reports.length = 0;
    gh.calls.length = 0;
    gh.server.seen.length = 0;
    gh.world.installations.length = 0;
    gh.world.failNext.length = 0;
    gh.world.repos = {};
    await admin.query('DELETE FROM repos');
    await admin.query('DELETE FROM installations');
    await admin.query('DELETE FROM installation_installers');
    await admin.query(
      `UPDATE reconcile_jobs SET cursor = NULL, next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL, last_result_code = NULL, last_full_pass_at = NULL WHERE name = $1`,
      [JOB],
    );
  });

  /** Each kind signs with its own App's key, unless a test says a kind is wired to another kind's key or is not configured. */
  const credentialsFor = (wiring: Partial<Record<InstallationKind, InstallationKind | null>> = {}): AppCredentialsSource => (kind) => {
    const k = kind as InstallationKind;
    const use = wiring[k] === undefined ? k : wiring[k];
    if (use === null) throw new Error('not configured');
    return { appId: String(gh.keys[use].appId), privateKeyPem: gh.keys[use].privateKeyPem, webhookSecret: 'x' };
  };
  const job = (opts: { wiring?: Partial<Record<InstallationKind, InstallationKind | null>>; perRun?: number; fetchImpl?: typeof fetch; callsPerRun?: number } = {}): ReconcileJob => {
    const appCredentials = credentialsFor(opts.wiring);
    const cache = new InstallationTokenCache();
    return createGithubReposJob({
      installationsPerRun: opts.perRun ?? GITHUB_REPOS_INSTALLATIONS_PER_RUN,
      ...(opts.callsPerRun ? { callsPerRun: opts.callsPerRun } : {}),
      reportError: report,
      sync: async (target, conditional) => {
        try {
          appCredentials(target.kind);
        } catch {
          return { status: 'skipped', reason: 'not_configured' };
        }
        const result = await syncInstallationRepos(
          { platformOpsPool: platformOps, appUserPool: appUser, appCredentials, requester: gh.requester, cache, fetchImpl: opts.fetchImpl ?? gh.fetch, warn: () => undefined, conditional },
          target.installationId,
        );
        return result.status === 'synced' ? { status: 'synced', ...(result.etags ? { etags: result.etags } : {}) } : { status: 'skipped', reason: result.reason };
      },
    });
  };
  const tick = (j: ReconcileJob = job()) => runTick({ pool: platformOps, jobs: [j], enabled: true, reportError: report });
  const jobRow = async () => (await admin.query(`SELECT cursor, last_result_code, last_full_pass_at FROM reconcile_jobs WHERE name = $1`, [JOB])).rows[0];

  interface Seeded { gh: number; kind: InstallationKind; accountId: string; installationId: string }
  const repoOf = (id: number) => ({ id, name: `repo-${id}`, owner: 'octo-org' });
  /**
   * One live installation of ours. `inDb` repos are linked to it here; `onGithub` is what GitHub lists for it (by default the
   * same repos). `github: 'gone'` leaves it unknown to GitHub entirely.
   */
  async function seed(
    kind: InstallationKind,
    opts: { inDb?: number[]; onGithub?: number[]; github?: 'active' | 'gone'; suspendedHere?: boolean; deletedHere?: boolean } = {},
  ): Promise<Seeded> {
    const ghId = nextGh++;
    const accountId = randomUUID();
    const installationId = randomUUID();
    await seedAccount(adminClient, accountId, { status: 'unsubscribed' });
    await adminClient.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [installationId, accountId, ghId, kind]);
    await adminClient.query(
      `INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id, suspended_at, deleted_at) VALUES ($1, $2, 1, $3, $4)`,
      [ghId, kind, opts.suspendedHere ? new Date() : null, opts.deletedHere ? new Date() : null],
    );
    const inDb = opts.inDb ?? [nextRepo++];
    for (const id of inDb) {
      await adminClient.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, $5, 'octo-org', $6)`, [
        randomUUID(), accountId, installationId, id, kind === 'sitekit' ? 'sitekit' : 'team', `repo-${id}`,
      ]);
    }
    if ((opts.github ?? 'active') !== 'gone') {
      gh.world.installations.push({ id: ghId, kind, suspended: false });
      gh.world.repos[ghId] = (opts.onGithub ?? inDb).map(repoOf);
    }
    return { gh: ghId, kind, accountId, installationId };
  }
  const links = async (s: Seeded) =>
    (await admin.query(`SELECT gh_repo_id::text AS id, installation_id FROM repos WHERE account_id = $1 ORDER BY gh_repo_id`, [s.accountId])).rows.map((r) => ({ id: Number(r.id), linked: r.installation_id !== null }));
  const installer = async (s: Seeded) => (await admin.query(`SELECT deleted_at, suspended_at, repo_list_etags FROM installation_installers WHERE gh_installation_id = $1 AND app_kind = $2`, [s.gh, s.kind])).rows[0];
  const events = async (s: Seeded) => (await admin.query(`SELECT type FROM domain_events WHERE account_id = $1 ORDER BY id`, [s.accountId])).rows.map((r) => r.type as string);
  const listCalls = () => gh.calls.filter((c) => c.path === '/installation/repositories');
  const mints = () => gh.calls.filter((c) => c.method === 'POST');

  describe('repairs repo drift toward GitHub', () => {
    it('adds a repo GitHub lists and detaches (keeps) one it no longer lists, for each of the three kinds, each with its own App JWT', async () => {
      const seeded: Seeded[] = [];
      for (const kind of KINDS) {
        const keep = nextRepo++;
        const drop = nextRepo++;
        const add = nextRepo++;
        seeded.push(await seed(kind, { inDb: [keep, drop], onGithub: [keep, add] }));
      }
      const out = await tick();
      expect(out.results).toEqual([{ job: JOB, result: 'ok' }]);
      for (const s of seeded) {
        const rows = await links(s);
        expect(rows).toHaveLength(3); // nothing deleted
        expect(rows.filter((r) => r.linked)).toHaveLength(2); // the kept one and the added one
        expect(rows.filter((r) => !r.linked)).toHaveLength(1); // the dropped one, detached
        expect(await events(s)).toContain('repos.changed');
      }
      // Each kind's mint was signed by that kind's own App (the fake answers 404 to any other App's JWT).
      expect(mints().map((c) => c.as).sort()).toEqual([...KINDS].sort());
      expect(reports).toEqual([]);
      expect((await jobRow()).last_full_pass_at).not.toBeNull();
    });

    it('does not touch suspended or deleted installations, and makes no GitHub call for them', async () => {
      const a = await seed('team', { suspendedHere: true, onGithub: [] });
      const b = await seed('team', { deletedHere: true, onGithub: [] });
      await tick();
      expect(gh.calls).toEqual([]);
      expect(await links(a)).toEqual([{ id: expect.any(Number), linked: true }]);
      expect(await links(b)).toEqual([{ id: expect.any(Number), linked: true }]);
    });
  });

  describe('nothing is gone except by the sync rules: no change from a failed call, a 404, or an unfinished list', () => {
    it('a mint refused for another kind\'s key (404) changes nothing: not deleted, repos kept, reported', async () => {
      const s = await seed('team_readonly', { inDb: [nextRepo++, nextRepo++], onGithub: [] });
      // team_readonly is wired to the team App's key, so GitHub says 404 for this installation.
      await tick(job({ wiring: { team_readonly: 'team' } }));
      expect((await installer(s)).deleted_at).toBeNull();
      expect((await links(s)).every((r) => r.linked)).toBe(true);
      expect(reports).toHaveLength(1);
      expect((await jobRow()).last_result_code).toBe('error');
    });

    it('an installation GitHub answers 404 for (gone) is not marked deleted here: that is the installation job\'s call', async () => {
      const s = await seed('team', { github: 'gone' });
      await tick();
      expect((await installer(s)).deleted_at).toBeNull();
      expect((await links(s)).every((r) => r.linked)).toBe(true);
      expect(reports).toHaveLength(1);
    });

    it('a list that did not finish (page 2 fails) detaches nothing and saves no ETags', async () => {
      const ids = Array.from({ length: 130 }, () => nextRepo++);
      const s = await seed('team', { inDb: [...ids, nextRepo++], onGithub: ids }); // one extra repo in our rows
      gh.world.failNext.push({ status: 500, match: /^\/installation\/repositories$/, query: /page=2/ });
      await tick();
      expect((await links(s)).every((r) => r.linked)).toBe(true);
      expect((await installer(s)).repo_list_etags).toBeNull();
      expect(reports).toHaveLength(1);
    });

    it('a list whose pages do not add up to its total_count (a short page 2) detaches nothing and saves no ETags', async () => {
      const ids = Array.from({ length: 130 }, () => nextRepo++);
      const s = await seed('team', { inDb: ids });
      // GitHub's answer for page 2 arrives with 10 entries missing while total_count still says 130.
      const shortPage2: typeof fetch = async (input, init) => {
        const res = await gh.fetch(input, init);
        if (!String(input).includes('page=2')) return res;
        const body = (await res.json()) as { repositories: unknown[] };
        body.repositories = body.repositories.slice(10);
        return new Response(JSON.stringify(body), { status: 200, headers: res.headers });
      };
      await tick(job({ fetchImpl: shortPage2 }));
      expect((await links(s)).every((r) => r.linked)).toBe(true); // the 10 unseen repos are not read as removed
      expect((await installer(s)).repo_list_etags).toBeNull();
    });

    it('a listing that does not add up changes no row, not even to add a repo we lack, and is reported once', async () => {
      const ids = Array.from({ length: 130 }, () => nextRepo++);
      const s = await seed('team', { inDb: ids.slice(0, 100), onGithub: ids }); // 130 on GitHub, 100 here
      // Page 2 would carry 30 repos we do not have; it arrives 10 short while total_count still says 130.
      const shortPage2: typeof fetch = async (input, init) => {
        const res = await gh.fetch(input, init);
        if (!String(input).includes('page=2')) return res;
        const body = (await res.json()) as { repositories: unknown[] };
        body.repositories = body.repositories.slice(10);
        return new Response(JSON.stringify(body), { status: 200, headers: res.headers });
      };
      await tick(job({ fetchImpl: shortPage2 }));
      expect(await links(s)).toEqual(ids.slice(0, 100).map((id) => ({ id, linked: true }))); // none added, none detached
      expect((await installer(s)).repo_list_etags).toBeNull();
      expect(await events(s)).toEqual([]);
      expect(reports).toHaveLength(1);
      expect((reports[0]!.err as Error).name).toBe('RepoListIncompleteError');
    });

    it('a 5xx on the first page detaches nothing', async () => {
      const s = await seed('team', { inDb: [nextRepo++, nextRepo++] });
      gh.world.failNext.push({ status: 503, match: /^\/installation\/repositories$/ });
      await tick();
      expect((await links(s)).every((r) => r.linked)).toBe(true);
    });
  });

  describe('ETags: an unchanged list costs nothing', () => {
    it('saves ETags after a complete sync; the next run sends them, gets 304 on every page and writes nothing', async () => {
      const ids = Array.from({ length: 120 }, () => nextRepo++); // two pages
      const s = await seed('team', { inDb: ids });
      await tick();
      const first = (await installer(s)).repo_list_etags as string[];
      expect(first).toHaveLength(2);
      const eventsBefore = await events(s);
      const updatedBefore = (await admin.query(`SELECT max(updated_at) AS m FROM repos WHERE account_id = $1`, [s.accountId])).rows[0].m as Date;
      gh.calls.length = 0;
      await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() WHERE name = $1`, [JOB]);
      await tick();
      const lists = listCalls();
      expect(lists.map((c) => c.ifNoneMatch)).toEqual(first); // conditional, page by page
      expect(lists).toHaveLength(2); // and nothing more: no full read
      expect(await events(s)).toEqual(eventsBefore);
      expect((await admin.query(`SELECT max(updated_at) AS m FROM repos WHERE account_id = $1`, [s.accountId])).rows[0].m).toEqual(updatedBefore);
      expect(reports).toEqual([]);
    });

    it('a changed list (a repo added, another removed so the count is the same) is read in full and written', async () => {
      const ids = Array.from({ length: 120 }, () => nextRepo++);
      const s = await seed('team', { inDb: ids });
      await tick();
      const before = (await installer(s)).repo_list_etags as string[];
      const added = nextRepo++;
      gh.world.repos[s.gh] = [...gh.world.repos[s.gh]!.slice(1), repoOf(added)];
      gh.calls.length = 0;
      await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() WHERE name = $1`, [JOB]);
      await tick();
      const rows = await links(s);
      expect(rows.find((r) => r.id === added)?.linked).toBe(true);
      expect(rows.find((r) => r.id === ids[0])?.linked).toBe(false); // detached, row kept
      expect((await installer(s)).repo_list_etags).not.toEqual(before);
      expect(listCalls().length).toBeGreaterThan(2); // the conditional pass, then the full read
    });

    it('a suspend or unsuspend clears the saved ETags, so the next run reads in full once', async () => {
      const s = await seed('team');
      await tick();
      expect((await installer(s)).repo_list_etags).not.toBeNull();
      await recordInstallationLifecycle(
        { platformOpsPool: platformOps, appUserPool: appUser, appCredentials: credentialsFor() },
        'team',
        { action: 'suspend', installation: { id: s.gh } },
      );
      expect((await installer(s)).repo_list_etags).toBeNull();
    });

    it('the save never puts ETags onto an installation that was suspended or deleted since the sync', async () => {
      const s = await seed('team');
      const racing = createGithubReposJob({
        reportError: report,
        sync: async () => {
          const out = { status: 'synced' as const, etags: ['W/"late"'] };
          // The suspension lands after the sync finished and before the job saves.
          await admin.query(`UPDATE installation_installers SET suspended_at = now() WHERE gh_installation_id = $1`, [s.gh]);
          return out;
        },
      });
      await tick(racing);
      expect((await installer(s)).repo_list_etags).toBeNull();
    });
  });

  describe('budgets, the cursor and rate limits', () => {
    it('the per-run budget of installations is 30', () => {
      expect(GITHUB_REPOS_INSTALLATIONS_PER_RUN).toBe(30);
    });

    it('stops at the installation budget, saves the cursor, and the next run continues and completes the pass', async () => {
      for (let i = 0; i < 5; i++) await seed('team');
      const order = (await admin.query(`SELECT gh_installation_id::text AS g FROM installations ORDER BY id`)).rows.map((r) => Number(r.g));
      const j = job({ perRun: 2 });
      await tick(j);
      expect(mints().map((c) => c.path)).toEqual(order.slice(0, 2).map((g) => `/app/installations/${g}/access_tokens`));
      let row = await jobRow();
      expect(row.last_result_code).toBe('budget');
      expect(row.cursor).not.toBeNull();
      expect(row.last_full_pass_at).toBeNull(); // not a full pass yet
      gh.calls.length = 0;
      await tick(j);
      expect(mints().map((c) => c.path)).toEqual(order.slice(2, 4).map((g) => `/app/installations/${g}/access_tokens`));
      gh.calls.length = 0;
      await tick(j);
      expect(mints()).toHaveLength(1);
      row = await jobRow();
      expect(row.last_result_code).toBe('ok');
      expect(row.cursor).toBeNull();
      expect(row.last_full_pass_at).not.toBeNull(); // the cursor wrapped: a full pass
    });

    it('a secondary rate limit stops the run, saves the cursor at the last finished installation and keeps going from there next time', async () => {
      for (let i = 0; i < 3; i++) await seed('team');
      const order = (await admin.query(`SELECT id, gh_installation_id::text AS g FROM installations ORDER BY id`)).rows;
      // The second installation's list request is rate limited (the first one's passes).
      gh.world.failNext.push({ status: 403, headers: { 'retry-after': '60' }, match: /^\/installation\/repositories$/, skip: 1 });
      const j = job();
      await tick(j);
      const row = await jobRow();
      expect(row.last_result_code).toBe('error');
      expect(codes()).toContain('rate_limited');
      expect(row.cursor).toBe(order[0].id); // finished the first, stopped on the second
      expect(mints()).toHaveLength(2); // no call for the third
      gh.calls.length = 0;
      await tick(job());
      expect(mints().map((c) => c.path)).toEqual(order.slice(1).map((r) => `/app/installations/${r.g}/access_tokens`));
    });

    it('stops on the outside-call budget without an error and keeps its place', async () => {
      for (let i = 0; i < 4; i++) await seed('team');
      const order = (await admin.query(`SELECT id FROM installations ORDER BY id`)).rows.map((r) => r.id as string);
      let used = 0;
      const ctx: JobContext = {
        pool: platformOps,
        cursor: null,
        signal: new AbortController().signal,
        calls: { limit: 4, get used() { return used; }, take: (n = 1) => (used + n > 4 ? false : ((used += n), true)) },
        msLeft: () => 60_000,
        checkpoint: () => undefined,
      };
      // Each installation costs one call for the mint and one for its single list page: two installations fit in 4.
      const result = await job().run(ctx);
      expect(result).toEqual({ cursor: order[1], wrapped: false });
      expect(reports).toEqual([]);
    });

    it('three failures in a row end the run, and a failure moves the cursor past the bad installation', async () => {
      for (let i = 0; i < 5; i++) await seed('team', { github: 'gone' });
      await tick();
      expect(reports).toHaveLength(3);
      expect(mints()).toHaveLength(3);
      const row = await jobRow();
      expect(row.last_result_code).toBe('error');
      expect(row.cursor).not.toBeNull();
    });

    it('a kind that is not configured is skipped without a call or an error; the others still run', async () => {
      const a = await seed('sitekit', { inDb: [nextRepo++], onGithub: [] });
      const b = await seed('team', { inDb: [nextRepo++], onGithub: [] });
      await tick(job({ wiring: { sitekit: null } }));
      expect(mints().map((c) => c.as)).toEqual(['team']);
      expect((await links(a)).every((r) => r.linked)).toBe(true);
      expect((await links(b)).every((r) => !r.linked)).toBe(true); // GitHub lists none: detached, kept
      expect(reports).toEqual([]);
    });
  });

  describe('C2-H2c-4: only a strict, complete listing detaches', () => {
    it('a complete list missing one repo detaches exactly that repo and deletes no row; it reappearing re-attaches it', async () => {
      const keep = [nextRepo++, nextRepo++];
      const drop = nextRepo++;
      const s = await seed('team', { inDb: [...keep, drop], onGithub: keep });
      await tick();
      expect(await links(s)).toEqual([...keep, drop].sort((a, b) => a - b).map((id) => ({ id, linked: id !== drop })));
      gh.world.repos[s.gh] = [...keep, drop].map(repoOf);
      await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() WHERE name = $1`, [JOB]);
      await tick();
      expect((await links(s)).every((r) => r.linked)).toBe(true);
      expect((await links(s)).length).toBe(3);
    });

    it('a non-200 page mid-list detaches nothing', async () => {
      const ids = Array.from({ length: 130 }, () => nextRepo++);
      const s = await seed('team', { inDb: [...ids, nextRepo++], onGithub: ids });
      gh.world.failNext.push({ status: 404, match: /^\/installation\/repositories$/, query: /page=2/ });
      await tick();
      expect((await links(s)).every((r) => r.linked)).toBe(true);
    });

    it('running out of calls on page 2 detaches nothing, saves no ETags, and ends the run budget without an error', async () => {
      const ids = Array.from({ length: 130 }, () => nextRepo++);
      const s = await seed('team', { inDb: [...ids, nextRepo++], onGithub: ids });
      const base = job();
      let used = 0;
      const ctx: JobContext = {
        pool: platformOps, cursor: null, signal: new AbortController().signal,
        calls: { limit: 2, get used() { return used; }, take: (n = 1) => (used + n > 2 ? false : ((used += n), true)) },
        msLeft: () => 60_000, checkpoint: () => undefined,
      };
      // The job's own ask takes the first of the two calls and page 1 takes the second; page 2's ask is refused. (The
      // token mint is not counted against this meter in this wiring.)
      const out = await base.run(ctx);
      expect((await links(s)).every((r) => r.linked)).toBe(true);
      expect((await installer(s)).repo_list_etags).toBeNull();
      expect(out.wrapped).toBe(false);
      expect(reports).toEqual([]);
    });

    it('a short page that still carries rel="next" is not the last page: with page 2 failing, nothing is detached', async () => {
      const ids = [nextRepo++, nextRepo++];
      const s = await seed('team', { inDb: [...ids, nextRepo++], onGithub: ids }); // one extra repo in our rows
      const shortButMore: typeof fetch = async (input, init) => {
        if (String(input).includes('page=2')) return new Response('{}', { status: 500 });
        const res = await gh.fetch(input, init);
        const headers = new Headers(res.headers);
        headers.set('link', '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"');
        return new Response(await res.text(), { status: res.status, headers });
      };
      await tick(job({ fetchImpl: shortButMore }));
      expect((await links(s)).every((r) => r.linked)).toBe(true);
      expect((await installer(s)).repo_list_etags).toBeNull();
    });

    it('a list with no total_count is not complete: nothing is detached', async () => {
      const s = await seed('team', { inDb: [nextRepo++, nextRepo++], onGithub: [] });
      const noCount: typeof fetch = async (input, init) => {
        const res = await gh.fetch(input, init);
        const body = (await res.json()) as Record<string, unknown>;
        delete body.total_count;
        return new Response(JSON.stringify(body), { status: 200, headers: res.headers });
      };
      await tick(job({ fetchImpl: noCount }));
      expect((await links(s)).every((r) => r.linked)).toBe(true);
      expect(reports).toHaveLength(1);
    });
  });

  describe('C2-H2c-1..3: the un-suspend re-sync counts against the installation job\'s call meter', () => {
    const installationsJob = (opts: { callsPerRun?: number } = {}): ReconcileJob => {
      const appCredentials = credentialsFor();
      const cache = new InstallationTokenCache();
      const api = (k: InstallationKind) => createGithubAppApi(() => mintAppJwt(String(gh.keys[k].appId), gh.keys[k].privateKeyPem), { port: gh.port, ca: gh.ca, lookup: gh.lookup });
      return createGithubInstallationsJob({
        api,
        reportError: report,
        ...(opts.callsPerRun ? { callsPerRun: opts.callsPerRun } : {}),
        apply: (change, meter) =>
          recordInstallationLifecycle(
            {
              platformOpsPool: platformOps,
              appUserPool: appUser,
              appCredentials,
              syncRepos: (id, m) =>
                syncInstallationRepos({ platformOpsPool: platformOps, appUserPool: appUser, appCredentials, requester: gh.requester, cache, fetchImpl: gh.fetch, warn: () => undefined, ...(m ? { meter: m } : {}) }, id),
            },
            change.kind,
            { action: change.action, installation: { id: change.ghInstallationId } },
            meter,
          ),
      });
    };
    const bigList = (n: number) => Array.from({ length: n }, () => nextRepo++);
    const INST = 'github_installations';
    const instRow = async () => (await admin.query(`SELECT cursor, last_result_code FROM reconcile_jobs WHERE name = $1`, [INST])).rows[0];
    beforeEach(async () => {
      await admin.query(`UPDATE reconcile_jobs SET cursor = NULL, next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL, last_result_code = NULL WHERE name = $1`, [INST]);
    });

    it('C2-H2c-2: with 3 calls left and a 5-page list, the un-suspend is applied, repo rows are untouched, at most 3 calls are made, and the run ends budget', async () => {
      const dbRepos = [nextRepo++, nextRepo++];
      const s = await seed('team', { inDb: dbRepos, suspendedHere: true });
      gh.world.repos[s.gh] = bigList(450).map(repoOf); // 5 pages
      const before = JSON.stringify((await admin.query(`SELECT * FROM repos WHERE account_id = $1 ORDER BY id`, [s.accountId])).rows);
      let used = 0;
      const limit = 4; // 1 for the installations list (it finds the installation suspended here), leaving 3 for the re-sync
      const ctx: JobContext = {
        pool: platformOps, cursor: null, signal: new AbortController().signal,
        calls: { limit, get used() { return used; }, take: (n = 1) => (used + n > limit ? false : ((used += n), true)) },
        msLeft: () => 60_000, checkpoint: () => undefined,
      };
      const out = await installationsJob().run(ctx);
      expect((await installer(s)).suspended_at).toBeNull(); // the mirror is in
      expect(JSON.stringify((await admin.query(`SELECT * FROM repos WHERE account_id = $1 ORDER BY id`, [s.accountId])).rows)).toBe(before);
      expect(gh.calls.length).toBeLessThanOrEqual(limit);
      expect(used).toBe(limit);
      expect(out.wrapped).toBe(false);
      expect(out.cursor).not.toBeNull(); // budget: it keeps its place
      expect(out.code).toBeUndefined();
      expect(reports).toEqual([]);
    });

    it('C2-H2c-3: in one tick each job makes at most its own allowance of GitHub calls, and the allowance is per job (not shared)', async () => {
      // Installation job: several un-suspends with huge lists soak its whole allowance. Repo job: its own huge lists.
      for (let i = 0; i < 3; i++) {
        const s = await seed('team', { inDb: [nextRepo++], suspendedHere: true });
        gh.world.repos[s.gh] = bigList(4_000).map(repoOf); // 40 pages: more than the test allowance
      }
      for (let i = 0; i < 3; i++) {
        const s = await seed('sitekit', { inDb: [nextRepo++] });
        gh.world.repos[s.gh] = bigList(4_000).map(repoOf);
      }
      // The real allowance is 300 per job (constants asserted here); the run uses a small one so the test stays fast.
      expect([GITHUB_CALLS_PER_RUN, GITHUB_REPOS_CALLS_PER_RUN]).toEqual([300, 300]);
      const CAP = 20;
      const spans: Record<string, number> = {};
      const measured = (j: ReconcileJob): ReconcileJob => ({
        ...j,
        run: async (ctx) => {
          const start = gh.calls.length;
          try {
            return await j.run(ctx);
          } finally {
            spans[j.name] = gh.calls.length - start;
          }
        },
      });
      await runTick({ pool: platformOps, jobs: [measured(installationsJob({ callsPerRun: CAP })), measured(job({ callsPerRun: CAP }))], enabled: true, reportError: report });
      expect(spans['github_installations']).toBeLessThanOrEqual(CAP);
      expect(spans['github_repos']).toBeLessThanOrEqual(CAP);
      expect(spans['github_installations']).toBe(CAP); // it used its whole allowance (the un-suspend re-sync included)...
      expect(spans['github_repos']).toBe(CAP); // ...and the repo job still got a full one of its own
      expect((await instRow()).last_result_code).toBe('budget');
    });
  });
});
