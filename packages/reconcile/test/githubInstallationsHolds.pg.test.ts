import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { RepoListBudgetError, mintAppJwt, recordInstallationLifecycle, restoreInstallation } from '@fx/github';
import { seedAccount } from '../../billing/test/helpers/seed.js';
import {
  RESTORE_CALL_ALLOWANCE,
  breakerAllowance,
  createGithubAppApi,
  createGithubInstallationsJob,
  handleReleaseRequest,
  readBreakerHoldHealth,
  recordTrip,
  releaseHold,
  runTick,
  type GithubAppApi,
  type InstallationChange,
  type InstallationKind,
  type ReconcileJob,
  type ReleaseApiDeps,
  type ReportError,
} from '../src/index.js';
import { APP_SLUGS, startStrictGithubApps, type StrictGithubApps } from './helpers/strictGithubApps.js';

/**
 * D#454 H2b2 against real Postgres and the strict GitHub App fake over real TLS: the owner-released breaker hold, the
 * small-estate allowance, the per-kind identity check, the cursor after a trip, and detect-and-alert self-repair with the
 * owner's restore. The H2b suite (githubInstallations.pg.test.ts) keeps the rest of the job's behaviour.
 */
const JOB = 'github_installations';
const TOKEN = 'a-release-token-that-is-long-enough-0123456789';
const URL_ = 'https://example.test/api/internal/reconcile/release';

describe('github installation reconcile: breaker hold, identity, cursor, self-repair', () => {
  let admin: Pool;
  let adminClient: PoolClient;
  let platformOps: Pool;
  let appUser: Pool;
  let gh: StrictGithubApps;
  let nextGh = 9_000_000;
  const reports: { err: unknown; ctx: { stage: string; route: string; code?: string } }[] = [];
  const report: ReportError = (err, ctx) => {
    reports.push({ err, ctx });
  };
  const codes = () => reports.map((r) => r.ctx.code ?? 'none');
  const count = (code: string) => codes().filter((c) => c === code).length;
  let slugs: Record<InstallationKind, string | null>;

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
    slugs = { ...APP_SLUGS };
    await admin.query('DELETE FROM repos');
    await admin.query('DELETE FROM installations');
    await admin.query('DELETE FROM installation_installers');
    await admin.query('DELETE FROM reconcile_breaker_holds');
    await admin.query(
      `UPDATE reconcile_jobs SET cursor = NULL, next_due_at = now() - interval '1 second', lease_owner = NULL, lease_expires_at = NULL, last_result_code = NULL, last_full_pass_at = NULL WHERE name = $1`,
      [JOB],
    );
  });

  const apiFor = (kind: InstallationKind, as: InstallationKind = kind): GithubAppApi =>
    createGithubAppApi(() => mintAppJwt(String(gh.keys[as].appId), gh.keys[as].privateKeyPem), { port: gh.port, ca: gh.ca, lookup: gh.lookup });
  const lifecycleDeps = () => ({ platformOpsPool: platformOps, appUserPool: appUser, appCredentials: () => ({ appId: '1', privateKeyPem: '', webhookSecret: '' }) });
  const apply = (change: InstallationChange) =>
    recordInstallationLifecycle(lifecycleDeps(), change.kind, { action: change.action, installation: { id: change.ghInstallationId } });
  const job = (): ReconcileJob => createGithubInstallationsJob({ api: (k) => apiFor(k), slug: (k) => slugs[k], apply, reportError: report });
  const tick = (j: ReconcileJob = job()) => runTick({ pool: platformOps, jobs: [j], enabled: true, reportError: report });
  const again = () => admin.query(`UPDATE reconcile_jobs SET next_due_at = now() WHERE name = $1`, [JOB]);
  const jobRow = async () => (await admin.query(`SELECT cursor, last_result_code, last_full_pass_at FROM reconcile_jobs WHERE name = $1`, [JOB])).rows[0];

  interface Seeded { gh: number; kind: InstallationKind; accountId: string; installationId: string }
  async function seed(kind: InstallationKind, opts: { github?: 'active' | 'suspended' | 'gone'; deletedHere?: boolean } = {}): Promise<Seeded> {
    const ghId = nextGh++;
    const accountId = randomUUID();
    const installationId = randomUUID();
    await seedAccount(adminClient, accountId, { status: 'unsubscribed' });
    await adminClient.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [installationId, accountId, ghId, kind]);
    await adminClient.query(
      `INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id, deleted_at) VALUES ($1, $2, 1, $3)`,
      [ghId, kind, opts.deletedHere ? new Date() : null],
    );
    const github = opts.github ?? 'active';
    if (github !== 'gone') gh.world.installations.push({ id: ghId, kind, suspended: github === 'suspended' });
    return { gh: ghId, kind, accountId, installationId };
  }
  const estate = async (kind: InstallationKind, n: number): Promise<Seeded[]> => {
    const out: Seeded[] = [];
    for (let i = 0; i < n; i++) out.push(await seed(kind));
    return out;
  };
  const goneOnGithub = (...ss: Seeded[]) => {
    const ids = new Set(ss.map((s) => s.gh));
    gh.world.installations = gh.world.installations.filter((i) => !ids.has(i.id));
  };
  const installer = async (s: Seeded) => (await admin.query(`SELECT deleted_at, suspended_at FROM installation_installers WHERE gh_installation_id = $1 AND app_kind = $2`, [s.gh, s.kind])).rows[0];
  const deletedCount = async (ss: Seeded[]) => {
    let n = 0;
    for (const s of ss) if ((await installer(s)).deleted_at !== null) n++;
    return n;
  };
  const events = async (s: Seeded) => (await admin.query(`SELECT type FROM domain_events WHERE account_id = $1 ORDER BY id`, [s.accountId])).rows.map((r) => r.type as string);
  const holds = async () => (await admin.query(`SELECT * FROM reconcile_breaker_holds ORDER BY id`)).rows;
  const lists = (as: InstallationKind) => gh.calls.filter((c) => c.path === '/app/installations' && c.as === as);
  /** A team estate of 10 where 3 are gone on GitHub: over the allowance of 2, so the run trips. */
  const tripTeam = async () => {
    const all = await estate('team', 10);
    const gone = all.slice(0, 3);
    goneOnGithub(...gone);
    return { all, gone };
  };

  describe('1. the allowance is min(5, max(2, floor(0.1 x live)))', () => {
    it('the function: 1 and 2 live allow 2, 12 allows 2, 30 allows 3, 50 allows 5, 200 allows 5', () => {
      expect([1, 2, 3, 12, 29, 30, 50, 200].map(breakerAllowance)).toEqual([2, 2, 2, 2, 2, 3, 5, 5]);
    });
    it('live = 1: its one possible detach applies (the allowance is 2)', async () => {
      const [only] = await estate('team', 1);
      goneOnGithub(only!);
      expect((await tick()).results).toEqual([{ job: JOB, result: 'ok' }]);
      expect((await installer(only!)).deleted_at).not.toBeNull();
    });
    it('live = 3: 2 detaches apply, and the lone third that follows applies too', async () => {
      const all = await estate('team', 3);
      goneOnGithub(all[0]!, all[1]!);
      expect((await tick()).results).toEqual([{ job: JOB, result: 'ok' }]);
      expect(await deletedCount(all)).toBe(2);
      goneOnGithub(all[2]!);
      await again();
      // live is now 1 (two are deleted): the third is a lone detach, which the allowance of 2 lets through.
      expect((await tick()).results).toEqual([{ job: JOB, result: 'ok' }]);
    });
    it('live = 3: all 3 gone at once trips (3 > 2)', async () => {
      const all = await estate('team', 3);
      goneOnGithub(...all);
      // Every installation vanishing is also what a wrong key looks like; here the slug is right but the list shows none of
      // ours, so the zero-overlap rule holds the run back before the breaker is reached.
      const out = await tick();
      expect(out.results).toEqual([{ job: JOB, result: 'error' }]);
      expect(await deletedCount(all)).toBe(0);
    });
    it('live = 30: 3 apply and 4 trip', async () => {
      const all = await estate('team', 30);
      goneOnGithub(...all.slice(0, 3));
      expect((await tick()).results).toEqual([{ job: JOB, result: 'ok' }]);
      expect(await deletedCount(all)).toBe(3);
      const all2 = await estate('sitekit', 30);
      goneOnGithub(...all2.slice(0, 4));
      await again();
      expect((await tick()).results).toEqual([{ job: JOB, result: 'breaker_tripped' }]);
      expect(await deletedCount(all2)).toBe(0);
    }, 60_000);
    it('live = 200: 5 apply and 6 trip', async () => {
      const all = await estate('team', 200);
      goneOnGithub(...all.slice(0, 5));
      expect((await tick()).results).toEqual([{ job: JOB, result: 'ok' }]);
      expect(await deletedCount(all)).toBe(5);
      const all2 = await estate('sitekit', 200);
      goneOnGithub(...all2.slice(0, 6));
      await again();
      expect((await tick()).results).toEqual([{ job: JOB, result: 'breaker_tripped' }]);
      expect(await deletedCount(all2)).toBe(0);
    }, 120_000);
  });

  describe('2. a trip records a hold; an identical trip alerts once; a different set replaces it', () => {
    it('stores only numeric ids and the kind, and alerts on the first trip only (trip_count rises, the alert count stays one)', async () => {
      const { gone } = await tripTeam();
      await tick();
      await again();
      await tick();
      await again();
      await tick();
      const h = await holds();
      expect(h).toHaveLength(1);
      expect(h[0].trip_count).toBe(3);
      expect(h[0].gh_installation_ids.map(Number).sort()).toEqual(gone.map((g) => g.gh).sort());
      expect(h[0].app_kind).toBe('team');
      expect(h[0].released_at).toBeNull(); // nothing released it on its own, however many identical trips
      expect(Object.keys(h[0]).sort()).toEqual(
        ['app_kind', 'consumed_at', 'first_tripped_at', 'gh_installation_ids', 'id', 'job', 'last_tripped_at', 'released_at', 'released_note', 'trip_count'],
      );
      expect(count('breaker_tripped')).toBe(1);
      expect(await deletedCount(gone)).toBe(0);
    });
    it('a different set replaces the hold, resets the count and alerts again', async () => {
      const { all } = await tripTeam();
      await tick();
      goneOnGithub(all[3]!); // now four are gone: a different set
      await again();
      await tick();
      const h = await holds();
      expect(h).toHaveLength(1); // replaced in place, never two open holds for one kind
      expect(h[0].trip_count).toBe(1);
      expect(h[0].gh_installation_ids).toHaveLength(4);
      expect(count('breaker_tripped')).toBe(2);
    });
  });

  describe('3. the owner releases; the next run applies exactly that; nothing releases on its own', () => {
    const request = (method: string, auth: string | null, body?: unknown) =>
      new Request(URL_, { method, headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const deps = (over: Partial<ReleaseApiDeps> = {}): ReleaseApiDeps => ({
      token: TOKEN,
      pool: () => platformOps,
      api: (k) => apiFor(k),
      restore: (k, id, meter) => restoreInstallation(lifecycleDeps(), k, id, meter),
      ...over,
    });
    const release = async (h: { id: number | string; gh_installation_ids: (number | string)[] }, auth: string | null = `Bearer ${TOKEN}`, over: Partial<ReleaseApiDeps> = {}) =>
      handleReleaseRequest(request('POST', auth, { action: 'release', hold_id: Number(h.id), gh_installation_ids: h.gh_installation_ids.map(Number), note: 'checked by the owner' }), deps(over));

    it('an unset secret is a 503 and writes nothing; a wrong or missing secret is a 401 and writes nothing', async () => {
      await tripTeam();
      await tick();
      const [h] = await holds();
      const before = JSON.stringify(await holds());
      expect((await release(h, `Bearer ${TOKEN}`, { token: undefined })).status).toBe(503);
      expect((await release(h, 'Bearer wrong')).status).toBe(401);
      expect((await release(h, null)).status).toBe(401);
      expect((await release(h, `bearer ${TOKEN}`)).status).toBe(401); // the scheme is exact
      expect((await handleReleaseRequest(request('GET', null), deps())).status).toBe(401);
      expect(JSON.stringify(await holds())).toBe(before);
    });

    it('the right token releases exactly the named hold, and a replay changes nothing', async () => {
      await tripTeam();
      const kit = await estate('sitekit', 10);
      goneOnGithub(kit[0]!, kit[1]!, kit[2]!);
      await tick();
      const [a, b] = await holds();
      expect([a.app_kind, b.app_kind]).toEqual(['team', 'sitekit']);
      const res = await release(a);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'released' });
      const after = await holds();
      expect(after[0].released_at).not.toBeNull();
      expect(after[0].released_note).toBe('checked by the owner');
      expect(after[1].released_at).toBeNull(); // the other kind's hold is untouched
      const stamp = String(after[0].released_at);
      const replay = await release(a);
      expect(await replay.json()).toEqual({ status: 'already_released' });
      expect(String((await holds())[0].released_at)).toBe(stamp);
    });

    it('a release for ids the hold no longer covers is refused (409) and releases nothing', async () => {
      const { all } = await tripTeam();
      await tick();
      const [seen] = await holds();
      goneOnGithub(all[3]!);
      await again();
      await tick(); // the hold now covers a different, larger set
      const res = await release(seen);
      expect(res.status).toBe(409);
      expect((await holds())[0].released_at).toBeNull();
    });

    it('a hold replaced between the owner\'s read and the write is not released: the id set is part of the one UPDATE', async () => {
      const { all } = await tripTeam();
      await tick();
      const [seen] = await holds();
      const seenIds = (seen.gh_installation_ids as string[]).map(Number);
      // Just before the release statement runs, a run replaces the hold's set in place (same row id, a larger set).
      let replaced = false;
      const racing = {
        query: async (sql: string, params?: unknown[]) => {
          if (!replaced && /SET released_at = now\(\)/.test(sql)) {
            replaced = true;
            await recordTrip(platformOps, seen.job, seen.app_kind, [...seenIds, all[3]!.gh]);
          }
          return platformOps.query(sql, params);
        },
      } as unknown as Pool;
      const out = await releaseHold(racing, { holdId: Number(seen.id), ids: seenIds, note: 'owner' });
      expect(replaced).toBe(true);
      expect(out.status).toBe('ids_changed');
      const [after] = await holds();
      expect(after.released_at).toBeNull();
      expect((after.gh_installation_ids as string[]).map(Number).sort((a, b) => a - b)).toEqual([...seenIds, all[3]!.gh].sort((a, b) => a - b));
    });

    it('a secret shorter than 32 characters is treated as unset: 503, and even the matching header releases nothing', async () => {
      await tripTeam();
      await tick();
      const [h] = await holds();
      const short = 'short-secret-0123456789';
      const res = await release(h, `Bearer ${short}`, { token: short });
      expect(res.status).toBe(503);
      expect((await holds())[0].released_at).toBeNull();
    });

    it('a body over 64 KB is refused while it is being read: the stream is cut off, not read to its end', async () => {
      await tripTeam();
      await tick();
      const before = JSON.stringify(await holds());
      let pulled = 0;
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(16 * 1024).fill(32));
        },
      });
      const req = new Request(URL_, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: endless, duplex: 'half' } as RequestInit);
      const res = await handleReleaseRequest(req, deps());
      expect(res.status).toBe(400);
      expect(pulled).toBeLessThan(12);
      expect(JSON.stringify(await holds())).toBe(before);
    });

    it('GET lists the open holds (ids and counts only)', async () => {
      await tripTeam();
      await tick();
      const res = await handleReleaseRequest(request('GET', `Bearer ${TOKEN}`), deps());
      const body = (await res.json()) as { holds: Record<string, unknown>[] };
      expect(body.holds).toHaveLength(1);
      expect(Object.keys(body.holds[0]!).sort()).toEqual(['first_tripped_at', 'gh_installation_ids', 'id', 'job', 'kind', 'last_tripped_at', 'released', 'trip_count']);
    });

    it('the next run applies all of a released set, consumes the hold and reports breaker_released; the hold is not reused', async () => {
      const { gone } = await tripTeam();
      await tick();
      await release((await holds())[0]);
      reports.length = 0;
      await again();
      const out = await tick();
      expect(out.results).toEqual([{ job: JOB, result: 'ok' }]);
      expect(await deletedCount(gone)).toBe(3);
      expect(count('breaker_released')).toBe(1);
      expect((await holds())[0].consumed_at).not.toBeNull();
      expect((await jobRow()).last_full_pass_at).not.toBeNull();
    });

    it('a superset of the released ids trips again, as a new hold, and applies nothing', async () => {
      const { all, gone } = await tripTeam();
      await tick();
      await release((await holds())[0]);
      goneOnGithub(all[3]!); // one more: a superset
      reports.length = 0;
      await again();
      expect((await tick()).results).toEqual([{ job: JOB, result: 'breaker_tripped' }]);
      expect(await deletedCount(all)).toBe(0);
      const h = (await holds())[0];
      expect(h.released_at).toBeNull();
      expect(h.gh_installation_ids).toHaveLength(4);
      expect(h.consumed_at).toBeNull();
      expect(count('breaker_tripped')).toBe(1); // a new hold alerts again
      expect(gone).toHaveLength(3);
    });

    it('a release older than 48 hours that no run consumed lapses: the next run trips again', async () => {
      const { all } = await tripTeam();
      await tick();
      await release((await holds())[0]);
      await admin.query(`UPDATE reconcile_breaker_holds SET released_at = now() - interval '49 hours'`);
      await again();
      expect((await tick()).results).toEqual([{ job: JOB, result: 'breaker_tripped' }]);
      expect(await deletedCount(all)).toBe(0);
    });

    it('a release 47 hours old still covers the run', async () => {
      const { all } = await tripTeam();
      await tick();
      await release((await holds())[0]);
      await admin.query(`UPDATE reconcile_breaker_holds SET released_at = now() - interval '47 hours'`);
      await again();
      expect((await tick()).results).toEqual([{ job: JOB, result: 'ok' }]);
      expect(await deletedCount(all)).toBe(3);
    });
  });

  describe('4. the launch check: Reconcilers healthy', () => {
    it('red while a hold has no release; green once a release is consumed, with no other change', async () => {
      const { gone } = await tripTeam();
      expect((await readBreakerHoldHealth(platformOps)).healthy).toBe(true);
      await tick();
      const red = await readBreakerHoldHealth(platformOps);
      expect(red.healthy).toBe(false);
      expect(red.red).toEqual([{ job: JOB, kind: 'team', tripCount: 1 }]);
      await tick();
      expect((await readBreakerHoldHealth(platformOps)).healthy).toBe(false); // still red after another identical trip
      const [h] = await holds();
      await handleReleaseRequest(
        new Request(URL_, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ action: 'release', hold_id: Number(h.id), gh_installation_ids: h.gh_installation_ids.map(Number) }) }),
        { token: TOKEN, pool: () => platformOps, api: (k) => apiFor(k), restore: async () => false },
      );
      await again();
      await tick();
      expect(await deletedCount(gone)).toBe(3);
      expect((await readBreakerHoldHealth(platformOps)).healthy).toBe(true);
    });
    it('a lapsed release is red again', async () => {
      await tripTeam();
      await tick();
      await admin.query(`UPDATE reconcile_breaker_holds SET released_at = now() - interval '49 hours'`);
      expect((await readBreakerHoldHealth(platformOps)).healthy).toBe(false);
    });
  });

  describe('5. identity: the kind must prove which App it is, or it changes nothing', () => {
    it('a wrong slug: zero changes (no detach, no suspension mirror, no hold), one alert, and the other kinds still run', async () => {
      const team = await estate('team', 12);
      const kit = await estate('sitekit', 12);
      goneOnGithub(team[0]!);
      gh.world.installations.find((i) => i.id === team[1]!.gh)!.suspended = true;
      goneOnGithub(kit[0]!);
      gh.world.slugs.team = 'someone-elses-app';
      const out = await tick();
      expect(out.results).toEqual([{ job: JOB, result: 'error' }]);
      expect(count('app_identity_mismatch')).toBe(1);
      expect(gh.calls.filter((c) => c.as === 'team').map((c) => c.path)).toEqual(['/app']); // nothing was looked up for team
      expect(await deletedCount(team)).toBe(0);
      expect((await installer(team[1]!)).suspended_at).toBeNull();
      expect(await events(team[0]!)).toEqual([]);
      expect(await holds()).toEqual([]);
      expect(await deletedCount(kit)).toBe(1); // sitekit ran
      expect(JSON.stringify(reports.map((r) => String((r.err as Error).message)))).not.toMatch(/someone-elses|fx-team/);
    });
    it('an unset slug setting: zero changes and no call for that kind', async () => {
      const team = await estate('team', 12);
      goneOnGithub(team[0]!);
      slugs.team = null;
      expect((await tick()).results).toEqual([{ job: JOB, result: 'error' }]);
      expect(count('app_identity_mismatch')).toBe(1);
      expect(gh.calls.filter((c) => c.as === 'team')).toEqual([]);
      expect(await deletedCount(team)).toBe(0);
    });
    it.each([[500], [404], [401]])('GET /app answering %i: zero changes', async (status) => {
      const team = await estate('team', 12);
      goneOnGithub(team[0]!);
      gh.world.failNext.push({ status, match: /^\/app$/ });
      expect((await tick()).results).toEqual([{ job: JOB, result: 'error' }]);
      expect(count('app_identity_mismatch')).toBe(1);
      expect(await deletedCount(team)).toBe(0);
    });
    it('a finished list that shares no id with 3 or more live installations: zero changes, with no per-installation lookup', async () => {
      const team = await estate('team', 4);
      gh.world.installations = []; // GitHub shows a different App's estate instead
      for (let i = 0; i < 5; i++) gh.world.installations.push({ id: 1_234_500 + i, kind: 'team', suspended: false });
      expect((await tick()).results).toEqual([{ job: JOB, result: 'error' }]);
      expect(count('app_identity_mismatch')).toBe(1);
      expect(gh.calls.filter((c) => c.path.startsWith('/app/installations/'))).toEqual([]);
      expect(await deletedCount(team)).toBe(0);
    });
    it('with fewer than 3 live, no overlap is not an identity finding (the per-installation 404 rule decides)', async () => {
      const team = await estate('team', 2);
      goneOnGithub(...team);
      expect((await tick()).results).toEqual([{ job: JOB, result: 'ok' }]);
      expect(count('app_identity_mismatch')).toBe(0);
      expect(await deletedCount(team)).toBe(2);
    });
    it('an unfinished list is not an identity finding either (it proves nothing)', async () => {
      await estate('team', 12);
      gh.world.failNext.push({ status: 502, match: /^\/app\/installations$/ });
      await tick();
      expect(count('app_identity_mismatch')).toBe(0);
    });
    it('every GET /app is one counted call, as that kind, and the kinds are told apart by their own JWT', async () => {
      await estate('team', 3);
      await estate('team_readonly', 3);
      await estate('sitekit', 3);
      await tick();
      for (const kind of ['team', 'team_readonly', 'sitekit'] as const) {
        expect(gh.calls.filter((c) => c.as === kind && c.path === '/app')).toHaveLength(1);
      }
      expect(reports).toEqual([]);
    });
  });

  describe('6. a tripped kind neither ends the run nor clears the cursor', () => {
    it('team trips every run and the budget fits one kind per run: read-only and site kit are each listed within 3 runs', async () => {
      const team = await estate('team', 10);
      goneOnGithub(team[0]!, team[1]!, team[2]!); // 3 of 10: trips (identity + list + 3 lookups = 5 calls)
      const ro = await estate('team_readonly', 10);
      const kit = await estate('sitekit', 10);
      goneOnGithub(ro[0]!);
      goneOnGithub(kit[0]!);
      const small: ReconcileJob = { ...job(), maxCalls: 5 };
      const seenAfter: number[][] = [];
      for (let run = 1; run <= 3; run++) {
        await again();
        await tick(small);
        seenAfter.push([lists('team').length, lists('team_readonly').length, lists('sitekit').length]);
        if (run === 1) {
          const row = await jobRow();
          expect(row.cursor).not.toBeNull(); // not nulled by the trip: it points at the next kind
          expect(row.cursor).toMatch(/^1:\d+:t$/);
          expect(row.last_result_code).toBe('budget');
        }
      }
      expect(seenAfter[0]![1]).toBe(0);
      expect(seenAfter[1]![1]).toBeGreaterThan(0); // listed by run 2
      expect(seenAfter[2]![2]).toBeGreaterThan(0); // listed by run 3
      expect(await deletedCount(ro)).toBe(1);
      expect(await deletedCount(kit)).toBe(1);
      expect(await deletedCount(team)).toBe(0);
      // The pass that carried a trip is not a full pass, and it ends as breaker_tripped, not ok.
      const row = await jobRow();
      expect(row.last_result_code).toBe('breaker_tripped');
      expect(row.last_full_pass_at).toBeNull();
      expect(row.cursor).toBeNull();
    }, 60_000);

    it('a pass with a trip in the run itself continues to the later kinds and ends breaker_tripped without a full pass', async () => {
      const team = await estate('team', 10);
      goneOnGithub(team[0]!, team[1]!, team[2]!);
      const kit = await estate('sitekit', 10);
      goneOnGithub(kit[0]!);
      expect((await tick()).results).toEqual([{ job: JOB, result: 'breaker_tripped' }]);
      expect(await deletedCount(kit)).toBe(1); // read after the tripped kind
      expect((await jobRow()).last_full_pass_at).toBeNull();
    });
  });

  describe('7. self-repair: detect and alert, then an owner restore', () => {
    const restoreReq = (kind: string, id: number, auth: string | null = `Bearer ${TOKEN}`) =>
      new Request(URL_, { method: 'POST', headers: { ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ action: 'restore', kind, gh_installation_id: id }) });
    const deps = (over: Partial<ReleaseApiDeps> = {}): ReleaseApiDeps => ({
      token: TOKEN,
      pool: () => platformOps,
      api: (k) => apiFor(k),
      restore: (k, id, meter) => restoreInstallation(lifecycleDeps(), k, id, meter),
      ...over,
    });

    it('deleted_but_listed is reported and changes nothing, at most 20 a run', async () => {
      await estate('team', 5);
      const del: Seeded[] = [];
      for (let i = 0; i < 25; i++) del.push(await seed('team', { deletedHere: true }));
      await tick();
      expect(count('deleted_but_listed')).toBe(20);
      for (const d of del) {
        expect((await installer(d)).deleted_at).not.toBeNull();
        expect(await events(d)).toEqual([]);
      }
      expect(JSON.stringify(reports.map((r) => String((r.err as Error).message)))).not.toMatch(/\d{6,}/);
    });

    it('an unfinished list reports none (it proves nothing)', async () => {
      await estate('team', 5);
      await seed('team', { deletedHere: true });
      gh.world.failNext.push({ status: 502, match: /^\/app\/installations$/ });
      await tick();
      expect(count('deleted_but_listed')).toBe(0);
    });

    it('restore: a fresh 200 for the same id clears the deleted flag through the lifecycle code (event emitted) and a second restore changes nothing', async () => {
      await estate('team', 5);
      const d = await seed('team', { deletedHere: true });
      const res = await handleReleaseRequest(restoreReq('team', d.gh), deps());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'restored' });
      expect((await installer(d)).deleted_at).toBeNull();
      expect(await events(d)).toEqual(['installation.changed']);
      const replay = await handleReleaseRequest(restoreReq('team', d.gh), deps());
      expect(await replay.json()).toEqual({ status: 'nothing_to_restore' });
      expect(await events(d)).toEqual(['installation.changed']);
      // And it is not reported again.
      reports.length = 0;
      await tick();
      expect(count('deleted_but_listed')).toBe(0);
    });

    it('restore: clears the saved repo-list ETags, like every other lifecycle change', async () => {
      await estate('team', 5);
      const d = await seed('team', { deletedHere: true });
      await admin.query(`UPDATE installation_installers SET repo_list_etags = ARRAY['"abc"'] WHERE gh_installation_id = $1 AND app_kind = $2`, [d.gh, d.kind]);
      const res = await handleReleaseRequest(restoreReq('team', d.gh), deps());
      expect(await res.json()).toEqual({ status: 'restored' });
      const row = (await admin.query(`SELECT repo_list_etags FROM installation_installers WHERE gh_installation_id = $1 AND app_kind = $2`, [d.gh, d.kind])).rows[0];
      expect(row.repo_list_etags).toBeNull();
    });

    it('restore: GitHub answering 404 for the id changes nothing', async () => {
      const d = await seed('team', { deletedHere: true, github: 'gone' });
      const res = await handleReleaseRequest(restoreReq('team', d.gh), deps());
      expect(res.status).toBe(409);
      expect((await installer(d)).deleted_at).not.toBeNull();
      expect(await events(d)).toEqual([]);
    });

    it.each([[500], [403], [401], [429]])('restore: a %i on the confirming lookup changes nothing', async (status) => {
      const d = await seed('team', { deletedHere: true });
      gh.world.failNext.push({ status, match: new RegExp(`^/app/installations/${d.gh}$`) });
      const res = await handleReleaseRequest(restoreReq('team', d.gh), deps());
      expect(res.status).toBe(409);
      expect((await installer(d)).deleted_at).not.toBeNull();
    });

    it('restore: a 200 that names a different id changes nothing', async () => {
      const d = await seed('team', { deletedHere: true });
      const liar: GithubAppApi = { get: async () => ({ status: 200, headers: {}, body: { id: d.gh + 1 } }) };
      const res = await handleReleaseRequest(restoreReq('team', d.gh), deps({ api: () => liar }));
      expect(res.status).toBe(409);
      expect((await installer(d)).deleted_at).not.toBeNull();
    });

    it("restore: the lookup uses the kind's own App; another kind's JWT sees a 404 and nothing changes", async () => {
      const d = await seed('team', { deletedHere: true });
      const res = await handleReleaseRequest(restoreReq('team', d.gh), deps({ api: (k) => apiFor(k, 'sitekit') }));
      expect(res.status).toBe(409);
      expect((await installer(d)).deleted_at).not.toBeNull();
      expect(gh.calls.every((c) => c.as === 'sitekit')).toBe(true);
    });

    it('restore: the re-sync draws on the request allowance; when it runs out the restore stands, the answer is budget, and no more than the allowance is spent', async () => {
      const d = await seed('team', { deletedHere: true });
      let spent = 0;
      const greedy = (k: InstallationKind, id: number, meter: { take(n?: number): boolean }) =>
        restoreInstallation(
          { ...lifecycleDeps(), syncRepos: async (_installation: string, m?: { take(n?: number): boolean }) => { for (let i = 0; i < 50; i++) { if (!m!.take(1)) throw new RepoListBudgetError(); spent++; } } },
          k,
          id,
          meter,
        );
      const res = await handleReleaseRequest(restoreReq('team', d.gh), deps({ restore: greedy }));
      expect(await res.json()).toEqual({ status: 'budget' });
      expect((await installer(d)).deleted_at).toBeNull(); // the restore itself committed
      expect(spent).toBe(RESTORE_CALL_ALLOWANCE - 1); // the confirming lookup took one of the allowance
      expect(gh.calls.filter((c) => c.path.startsWith('/app/installations/'))).toHaveLength(1);
    });

    it('restore: a transport failure, an unconfigured kind, bad input and a missing token change nothing', async () => {
      const d = await seed('team', { deletedHere: true });
      const boom: GithubAppApi = { get: async () => { throw new Error('transport'); } };
      expect((await handleReleaseRequest(restoreReq('team', d.gh), deps({ api: () => boom }))).status).toBe(409);
      expect((await handleReleaseRequest(restoreReq('team', d.gh), deps({ api: () => null }))).status).toBe(409);
      expect((await handleReleaseRequest(restoreReq('nope', d.gh), deps())).status).toBe(400);
      expect((await handleReleaseRequest(restoreReq('team', -1), deps())).status).toBe(400);
      expect((await handleReleaseRequest(restoreReq('team', d.gh, null), deps())).status).toBe(401);
      expect((await handleReleaseRequest(restoreReq('team', d.gh), deps({ token: undefined }))).status).toBe(503);
      expect((await installer(d)).deleted_at).not.toBeNull();
    });
  });
});
