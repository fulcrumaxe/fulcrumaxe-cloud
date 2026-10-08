import { randomUUID } from 'node:crypto';
import type { LookupFunction } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { mintAppJwt, recordInstallationLifecycle } from '@fx/github';
import { seedAccount } from '../../billing/test/helpers/seed.js';
import {
  createGithubAppApi,
  createGithubInstallationsJob,
  runTick,
  type GithubAppApi,
  type InstallationChange,
  type InstallationKind,
  type ReconcileJob,
  type ReportError,
} from '../src/index.js';
import { APP_KINDS, APP_SLUGS, startStrictGithubApps, type StrictGithubApps } from './helpers/strictGithubApps.js';

/**
 * D#454 H2b against real Postgres and a strict GitHub App API reached over real TLS: installation state for all three
 * kinds. Gone only on a per-installation 404 with that kind's own App JWT; the list is for suspension and orphans; the
 * breaker; and that every change is the webhook path's own lifecycle function (repos detached and kept, events emitted).
 */
const JOB = 'github_installations';

describe('github installation state reconcile job', () => {
  let admin: Pool;
  let adminClient: PoolClient;
  let platformOps: Pool;
  let appUser: Pool;
  let gh: StrictGithubApps;
  let nextGh = 7_000_000;
  let nextRepo = 5_000_000;
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
    gh.world.slugs = { ...APP_SLUGS };
    await admin.query('DELETE FROM repos');
    await admin.query('DELETE FROM installations');
    await admin.query('DELETE FROM installation_installers');
    await admin.query(
      `UPDATE reconcile_jobs SET cursor = NULL, next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL, last_result_code = NULL, last_full_pass_at = NULL WHERE name = $1`,
      [JOB],
    );
  });

  const apiFor = (kind: InstallationKind, as: InstallationKind = kind, lookup: LookupFunction = gh.lookup): GithubAppApi =>
    createGithubAppApi(() => mintAppJwt(String(gh.keys[as].appId), gh.keys[as].privateKeyPem), { port: gh.port, ca: gh.ca, lookup });
  const apply = (change: InstallationChange, _meter?: unknown) =>
    recordInstallationLifecycle(
      { platformOpsPool: platformOps, appUserPool: appUser, appCredentials: () => ({ appId: '1', privateKeyPem: '', webhookSecret: '' }) },
      change.kind,
      { action: change.action, installation: { id: change.ghInstallationId } },
    );
  const job = (api: (kind: InstallationKind) => GithubAppApi | null = (k) => apiFor(k)): ReconcileJob =>
    createGithubInstallationsJob({ api, slug: (k) => APP_SLUGS[k], apply, reportError: report });
  const tick = (j: ReconcileJob = job()) => runTick({ pool: platformOps, jobs: [j], enabled: true, reportError: report });
  const jobRow = async () => (await admin.query(`SELECT cursor, last_result_code, last_full_pass_at FROM reconcile_jobs WHERE name = $1`, [JOB])).rows[0];

  interface Seeded { gh: number; kind: InstallationKind; accountId: string; installationId: string }
  /** One live installation of ours (account, installation, installer record, optionally repos), and whether GitHub knows it. */
  async function seed(kind: InstallationKind, opts: { repos?: number; github?: 'active' | 'suspended' | 'gone'; suspendedHere?: boolean } = {}): Promise<Seeded> {
    const ghId = nextGh++;
    const accountId = randomUUID();
    const installationId = randomUUID();
    await seedAccount(adminClient, accountId, { status: 'unsubscribed' });
    await adminClient.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [installationId, accountId, ghId, kind]);
    await adminClient.query(
      `INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id, suspended_at) VALUES ($1, $2, 1, $3)`,
      [ghId, kind, opts.suspendedHere ? new Date() : null],
    );
    for (let i = 0; i < (opts.repos ?? 0); i++) {
      await adminClient.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [randomUUID(), accountId, installationId, nextRepo++]);
    }
    const github = opts.github ?? 'active';
    if (github !== 'gone') gh.world.installations.push({ id: ghId, kind, suspended: github === 'suspended' });
    return { gh: ghId, kind, accountId, installationId };
  }
  const installer = async (s: Seeded) => (await admin.query(`SELECT deleted_at, suspended_at FROM installation_installers WHERE gh_installation_id = $1 AND app_kind = $2`, [s.gh, s.kind])).rows[0];
  const repoLinks = async (s: Seeded) => (await admin.query(`SELECT installation_id FROM repos WHERE account_id = $1`, [s.accountId])).rows.map((r) => r.installation_id as string | null);
  const events = async (s: Seeded) => (await admin.query(`SELECT type FROM domain_events WHERE account_id = $1 ORDER BY id`, [s.accountId])).rows.map((r) => r.type as string);
  const lookupsFor = (id: number) => gh.calls.filter((c) => c.path === `/app/installations/${id}`);
  const lookups = () => gh.calls.filter((c) => c.path.startsWith('/app/installations/'));
  /** The list calls made as one App (every kind lists once per pass, even with no installation of ours). */
  const lists = (as: InstallationKind = 'team') => gh.calls.filter((c) => c.path === '/app/installations' && c.as === as);
  /** A set of live installations that makes the 10% breaker allow one change (12 -> 8.3%). */
  const estate = async (kind: InstallationKind, n = 12) => (async () => { const out: Seeded[] = []; for (let i = 0; i < n; i++) out.push(await seed(kind, { repos: 1 })); return out; })();

  describe('repairs drift toward GitHub', () => {
    it('an installation that answers 404 for its own App is marked deleted, its repos are detached (kept), and nothing else changes', async () => {
      const all = await estate('team');
      const gone = all[3]!;
      gh.world.installations = gh.world.installations.filter((i) => i.id !== gone.gh);
      const out = await tick();
      expect(out.results).toEqual([{ job: JOB, result: 'ok' }]);
      expect((await installer(gone)).deleted_at).not.toBeNull();
      expect(await repoLinks(gone)).toEqual([null]); // detached, row kept
      expect((await events(gone)).sort()).toEqual(['installation.changed', 'repos.changed']); // the webhook path's own events
      for (const other of all.filter((a) => a !== gone)) {
        expect((await installer(other)).deleted_at).toBeNull();
        expect(await repoLinks(other)).toEqual([other.installationId]);
      }
      expect(reports).toEqual([]);
      expect((await jobRow()).last_full_pass_at).not.toBeNull(); // the pass completed
      // One list, one per-installation lookup (only the one the list did not show), as that kind's App.
      expect(lists()).toHaveLength(1);
      expect(lookups()).toEqual([{ as: 'team', path: `/app/installations/${gone.gh}`, query: '' }]);
    });

    it('is idempotent: a second pass over the repaired state calls nothing new and changes nothing', async () => {
      const all = await estate('team');
      gh.world.installations = gh.world.installations.filter((i) => i.id !== all[0]!.gh);
      await tick();
      await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() WHERE name = $1`, [JOB]);
      const before = await events(all[0]!);
      await tick();
      expect(await events(all[0]!)).toEqual(before);
      expect(reports).toEqual([]);
    });

    it('a suspension on GitHub is mirrored and detaches the repos; the reverse is mirrored without touching repos', async () => {
      await estate('team', 20); // so one detaching change is under the 10% breaker
      const a = await seed('team', { repos: 2, github: 'suspended' });
      const b = await seed('team', { repos: 1, suspendedHere: true, github: 'active' });
      const c = await seed('team', { repos: 1 });
      await tick();
      expect((await installer(a)).suspended_at).not.toBeNull();
      expect(await repoLinks(a)).toEqual([null, null]);
      expect((await installer(b)).suspended_at).toBeNull();
      expect(await events(b)).toEqual(['installation.changed']);
      expect(await events(c)).toEqual([]);
      expect(reports).toEqual([]);
    });
  });

  describe('the list is never what says "gone"', () => {
    it('follows the Link header across pages: an installation on page 3 is seen there and needs no lookup', async () => {
      await estate('team', 20);
      const mine = await seed('team', { github: 'suspended' });
      // 230 more of the same App on GitHub, unknown to us and with lower ids, so the one that matters sorts onto page 3.
      for (let i = 1; i <= 230; i++) gh.world.installations.push({ id: 6_000_000 + i, kind: 'team', suspended: false });
      await tick();
      expect(lists().map((c) => c.query)).toEqual(['per_page=100', 'per_page=100&page=2', 'per_page=100&page=3']);
      expect(lookups()).toEqual([]);
      expect((await installer(mine)).suspended_at).not.toBeNull(); // mirrored from page 3
    });

    it('a list that could not finish marks nothing deleted: an installation it did not show is read one by one, and a 200 keeps it', async () => {
      const all = await estate('team');
      gh.world.failNext.push({ status: 502, match: /^\/app\/installations$/ }); // the only list call fails
      await tick();
      for (const a of all) expect((await installer(a)).deleted_at).toBeNull();
      expect(lookups()).toHaveLength(all.length); // every one checked individually, each answered 200
      expect(codes()).toEqual(['none']); // the failed list is reported once, with no installation name
      expect(lookups().every((c) => c.as === 'team')).toBe(true);
    });

    it('an installation the list does not show but whose own lookup is 404 IS deleted even when the list failed', async () => {
      const all = await estate('team');
      gh.world.installations = gh.world.installations.filter((i) => i.id !== all[5]!.gh);
      gh.world.failNext.push({ status: 500, match: /^\/app\/installations$/ });
      await tick();
      expect((await installer(all[5]!)).deleted_at).not.toBeNull();
      expect((await installer(all[4]!)).deleted_at).toBeNull();
    });

    it.each([
      ['a 500', { status: 500 }],
      ['a 403 that is not a rate limit', { status: 403 }],
      ['a 401 (the App key was rejected)', { status: 401 }],
      ['a 429', { status: 429 }],
    ])('%s on the lookup changes nothing', async (_label, rule) => {
      const all = await estate('team');
      const target = all[2]!;
      gh.world.installations = gh.world.installations.filter((i) => i.id !== target.gh);
      gh.world.failNext.push({ ...rule, match: new RegExp(`^/app/installations/${target.gh}$`) });
      await tick();
      expect((await installer(target)).deleted_at).toBeNull();
      expect(await repoLinks(target)).toEqual([target.installationId]);
      expect(reports.length).toBeGreaterThan(0); // never silent
    });

    it('a transport failure (the name does not resolve) changes nothing, is reported, and the same fake repairs it once reachable', async () => {
      const all = await estate('team');
      gh.world.installations = gh.world.installations.filter((i) => i.id !== all[1]!.gh);
      const unresolvable = ((_h: string, _o: unknown, cb: (...a: unknown[]) => void) => cb(Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }))) as unknown as LookupFunction;
      const out = await tick(job((k) => apiFor(k, k, unresolvable)));
      for (const a of all) expect((await installer(a)).deleted_at).toBeNull();
      expect(out.results).toEqual([{ job: JOB, result: 'error' }]);
      expect(reports.length).toBeGreaterThan(0);
      expect(JSON.stringify(reports.map((r) => String((r.err as Error).message)))).not.toMatch(/api\.github\.com|ENOTFOUND/); // a fixed word, never the request
      await admin.query(`UPDATE reconcile_jobs SET next_due_at = now(), cursor = NULL WHERE name = $1`, [JOB]);
      await tick();
      expect((await installer(all[1]!)).deleted_at).not.toBeNull();
    });

    it("a different kind's 404: each kind is checked with its own App, so installations of all three kinds survive a pass", async () => {
      const seeded = [...(await estate('team')), ...(await estate('team_readonly')), ...(await estate('sitekit'))];
      gh.world.installations = [...gh.world.installations]; // all live
      gh.world.failNext.push({ status: 500, match: /^\/app\/installations$/ }, { status: 500, match: /^\/app\/installations$/ }, { status: 500, match: /^\/app\/installations$/ });
      await tick(); // lists all fail: every installation is read individually
      expect(lookups()).toHaveLength(seeded.length);
      for (const s of seeded) {
        expect(lookupsFor(s.gh)).toEqual([{ as: s.kind, path: `/app/installations/${s.gh}`, query: '' }]);
        expect((await installer(s)).deleted_at).toBeNull();
      }
      // The fake answers 404 for another kind's JWT; that is exactly what a wrong-kind lookup would see.
      const wrong = await apiFor('team', 'sitekit').get(`/app/installations/${seeded[0]!.gh}`, { timeoutMs: 5000 });
      expect(wrong.status).toBe(404);
    });
  });

  describe('orphans', () => {
    it('an installation GitHub shows and we do not know is reported for the digest and never bound', async () => {
      await estate('team');
      gh.world.installations.push({ id: 8_888_001, kind: 'team', suspended: false });
      const before = (await admin.query('SELECT count(*)::int n FROM installations')).rows[0].n;
      await tick();
      expect(codes()).toEqual(['orphan_installation']);
      expect((await admin.query('SELECT count(*)::int n FROM installations')).rows[0].n).toBe(before);
      expect((await admin.query('SELECT count(*)::int n FROM installation_installers WHERE gh_installation_id = 8888001')).rows[0].n).toBe(0);
      expect(JSON.stringify(reports.map((r) => String((r.err as Error).message)))).not.toMatch(/8888001|octo-org/);
    });

    it('a list that could not finish reports no orphans (it proves nothing about what is missing)', async () => {
      await estate('team');
      for (let i = 0; i < 150; i++) gh.world.installations.push({ id: 6_000_000 + i, kind: 'team', suspended: false });
      gh.world.failNext.push({ status: 502, match: /^\/app\/installations$/, query: /page=2/ });
      await tick();
      expect(codes().filter((c) => c === 'orphan_installation')).toEqual([]);
      expect(lists().map((c) => c.query)).toEqual(['per_page=100', 'per_page=100&page=2']);
    });

    it('reports at most 20 per run', async () => {
      await estate('team');
      for (let i = 0; i < 30; i++) gh.world.installations.push({ id: 8_777_000 + i, kind: 'team', suspended: false });
      await tick();
      expect(codes().filter((c) => c === 'orphan_installation')).toHaveLength(20);
    });
  });

  describe('the breaker', () => {
    it('more than 5 detaching changes for a kind: none applied, the run ends breaker_tripped, one alert, and the pass restarts', async () => {
      const all = await estate('team', 100);
      for (const a of all.slice(0, 6)) gh.world.installations = gh.world.installations.filter((i) => i.id !== a.gh); // 6 gone: 6% but over 5
      const out = await tick();
      expect(out.results).toEqual([{ job: JOB, result: 'breaker_tripped' }]);
      for (const a of all) expect((await installer(a)).deleted_at).toBeNull();
      expect(await repoLinks(all[0]!)).toEqual([all[0]!.installationId]);
      expect(codes()).toEqual(['breaker_tripped']);
      const row = await jobRow();
      expect(row.last_result_code).toBe('breaker_tripped');
      expect(row.cursor).toBeNull();
      expect(row.last_full_pass_at).toBeNull(); // not a completed pass
    }, 60_000);

    it('exactly 5 gone of 100 (5%) is allowed', async () => {
      const all = await estate('team', 100);
      for (const a of all.slice(0, 5)) gh.world.installations = gh.world.installations.filter((i) => i.id !== a.gh);
      const out = await tick();
      expect(out.results).toEqual([{ job: JOB, result: 'ok' }]);
      for (const a of all.slice(0, 5)) expect((await installer(a)).deleted_at).not.toBeNull();
      expect((await installer(all[5]!)).deleted_at).toBeNull();
    }, 60_000);

    it('a small estate may detach 2: 2 of 12 applies, 3 of 12 trips (the allowance is min(5, max(2, floor(0.1 x live))))', async () => {
      const twelve = await estate('team');
      gh.world.installations = gh.world.installations.filter((i) => i.id !== twelve[0]!.gh && i.id !== twelve[1]!.gh);
      expect((await tick()).results).toEqual([{ job: JOB, result: 'ok' }]);
      expect((await installer(twelve[0]!)).deleted_at).not.toBeNull();
      expect((await installer(twelve[1]!)).deleted_at).not.toBeNull();
      const three = await estate('sitekit');
      gh.world.installations = gh.world.installations.filter((i) => ![three[0]!.gh, three[1]!.gh, three[2]!.gh].includes(i.id));
      await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() WHERE name = $1`, [JOB]);
      expect((await tick()).results).toEqual([{ job: JOB, result: 'breaker_tripped' }]);
      for (const a of three) expect((await installer(a)).deleted_at).toBeNull();
    });

    it('exactly 10% is not "more than 10%"', async () => {
      const thirty = await estate('sitekit', 30);
      for (const a of thirty.slice(0, 3)) gh.world.installations = gh.world.installations.filter((i) => i.id !== a.gh);
      expect((await tick()).results).toEqual([{ job: JOB, result: 'ok' }]);
      for (const a of thirty.slice(0, 3)) expect((await installer(a)).deleted_at).not.toBeNull();
    });

    it('is per kind, and suspensions count as detaching while un-suspending does not', async () => {
      const team = await estate('team');
      const readonly = await estate('team_readonly');
      // Three of the 12 read-only installations are suspended on GitHub: over the allowance of 2, tripped. One team installation gone: allowed.
      for (const a of readonly.slice(0, 3)) gh.world.installations.find((i) => i.id === a.gh)!.suspended = true;
      gh.world.installations = gh.world.installations.filter((i) => i.id !== team[0]!.gh);
      // And a suspended-here installation that GitHub shows active (un-suspend) must still be applied under the trip.
      const back = readonly[5]!;
      await admin.query(`UPDATE installation_installers SET suspended_at = now() WHERE gh_installation_id = $1`, [back.gh]);
      const out = await tick();
      expect(out.results).toEqual([{ job: JOB, result: 'breaker_tripped' }]);
      expect((await installer(readonly[0]!)).suspended_at).toBeNull(); // not applied
      expect((await installer(team[0]!)).deleted_at).not.toBeNull(); // the other kind is unaffected
      expect((await installer(back)).suspended_at).toBeNull(); // un-suspend detaches nothing, so it is not held back
    });
  });

  describe('budgets, rate limits and configuration', () => {
    it('a secondary rate limit (403 + retry-after) stops the job, saves the cursor, and the next run resumes after it', async () => {
      const all = await estate('team');
      const sorted = [...all].sort((a, b) => a.gh - b.gh);
      gh.world.failNext.push({ status: 502, match: /^\/app\/installations$/ }); // force individual lookups
      gh.world.failNext.push({ status: 403, headers: { 'retry-after': '60' }, match: new RegExp(`^/app/installations/${sorted[3]!.gh}$`) });
      const out = await tick();
      expect(out.results).toEqual([{ job: JOB, result: 'error' }]);
      expect(codes()).toContain('rate_limited');
      expect((await jobRow()).cursor).toBe(`0:${sorted[2]!.gh}`);
      gh.calls.length = 0;
      gh.world.failNext.push({ status: 502, match: /^\/app\/installations$/ }); // lookups needed again: only the ones after the cursor
      await tick();
      expect(lookupsFor(sorted[0]!.gh).concat(lookupsFor(sorted[1]!.gh), lookupsFor(sorted[2]!.gh))).toEqual([]); // not read again
      expect(lookupsFor(sorted[3]!.gh)).toHaveLength(1); // resumed at the one that was limited
      expect((await jobRow()).last_full_pass_at).not.toBeNull();
    });

    it('the per-run call budget stops the pass without error and the next run continues from the cursor', async () => {
      const all = await estate('team', 6);
      const sorted = [...all].sort((a, b) => a.gh - b.gh);
      gh.world.failNext.push({ status: 502, match: /^\/app\/installations$/ });
      const small: ReconcileJob = { ...job(), maxCalls: 4 }; // identity + the list + two lookups
      const out = await tick(small);
      expect(out.results).toEqual([{ job: JOB, result: 'budget' }]);
      expect((await jobRow()).cursor).toBe(`0:${sorted[1]!.gh}`);
      expect(reports.map((r) => r.ctx.code ?? 'none')).toEqual(['none']); // only the failed list; a budget is not an error
      const again = await tick({ ...job(), maxCalls: 6 }); // identity + list for each of the three kinds
      expect(again.results).toEqual([{ job: JOB, result: 'ok' }]);
      expect((await jobRow()).last_full_pass_at).not.toBeNull();
    });

    it('a kind with no configuration is skipped, never borrowed from another kind; none configured records not_configured', async () => {
      const team = await estate('team');
      gh.world.installations = gh.world.installations.filter((i) => i.id !== team[0]!.gh);
      const onlyReadonly = await tick(job((k) => (k === 'team_readonly' ? apiFor(k) : null)));
      expect(onlyReadonly.results).toEqual([{ job: JOB, result: 'ok' }]);
      expect(gh.calls.every((c) => c.as === 'team_readonly')).toBe(true);
      expect((await installer(team[0]!)).deleted_at).toBeNull();
      await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() WHERE name = $1`, [JOB]);
      expect((await tick(job(() => null))).results).toEqual([{ job: JOB, result: 'not_configured' }]);
    });

    it('an App key GitHub rejects (401 on the list) is reported for that kind, changes nothing, and the other kinds still run', async () => {
      const team = await estate('team');
      const kit = await estate('sitekit');
      gh.world.installations = gh.world.installations.filter((i) => i.id !== team[0]!.gh && i.id !== kit[0]!.gh);
      const bad = createGithubAppApi(async () => 'aaa.bbb.ccc', { port: gh.port, ca: gh.ca, lookup: gh.lookup });
      const out = await tick(job((k) => (k === 'team' ? bad : apiFor(k))));
      expect(out.results).toEqual([{ job: JOB, result: 'error' }]);
      expect(codes()).toContain('app_identity_mismatch'); // GET /app is the first call, and a 401 is not a 200
      expect((await installer(team[0]!)).deleted_at).toBeNull(); // team was never read
      expect((await installer(kit[0]!)).deleted_at).not.toBeNull(); // sitekit ran
    });
  });

  describe('what GitHub says never leaves memory', () => {
    it('no JWT, key, installation id or account login appears in anything reported', async () => {
      const all = await estate('team');
      gh.world.installations = gh.world.installations.filter((i) => i.id !== all[0]!.gh);
      gh.world.failNext.push({ status: 500, match: /^\/app\/installations$/ }, { status: 500, match: /^\/app\/installations\// });
      await tick();
      const text = JSON.stringify(reports.map((r) => ({ m: String((r.err as Error).message), n: (r.err as Error).name, c: r.ctx })));
      expect(text).not.toMatch(/BEGIN PRIVATE KEY|eyJ|octo-org|Bearer /);
      expect(text).not.toContain(String(all[0]!.gh));
    });

    it('every request carried the headers GitHub requires (User-Agent, Accept, API version, App JWT) and was a GET to /app or /app/installations', async () => {
      await estate('team', 2);
      await tick();
      expect(gh.server.seen.length).toBeGreaterThan(0);
      for (const r of gh.server.seen) {
        expect(r.method).toBe('GET');
        expect(r.path).toMatch(/^\/app(\/installations(\/[0-9]+)?)?$/);
        expect(r.headers['user-agent']).toBeTruthy();
        expect(r.headers['x-github-api-version']).toBe('2022-11-28');
        expect(r.headers['authorization']).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
        expect(r.servername).toBe('api.github.com');
      }
    });

    it('the client refuses any path other than the two installation endpoints', async () => {
      const api = apiFor('team');
      for (const p of ['/app?x=1', '/app/', '/repos/x/y', '/app/installations/../user', '/app/installations/1/access_tokens', 'https://evil.test/app/installations']) {
        await expect(api.get(p, { timeoutMs: 1000 })).rejects.toThrow('path_refused');
      }
      expect(gh.calls).toEqual([]);
    });
  });

  it('every kind the job covers is a kind the fake serves', () => {
    expect([...APP_KINDS]).toEqual(['team', 'team_readonly', 'sitekit']);
  });
});
