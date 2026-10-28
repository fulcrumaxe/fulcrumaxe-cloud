import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type EphemeralPostgres } from "@fx/db/test/support/ephemeral-pg.js";
import { InstallationTokenCache, syncInstallationRepos, type AppCredentialsSource } from "@fx/github";
import { createGithubReposJob, runTick, type ReconcileJob, type TickDeps } from "@fx/reconcile";
import { ACTIVITY_KEY, markWorkPending, setPendingHooks } from "@fx/core/src/pendingWork";
import { startStrictGithubApps, nodeIdOf, type StrictGithubApps } from "../../../../../../packages/reconcile/test/helpers/strictGithubApps";
import { makeRegion, storeOf, type FakeRegion } from "../../../../test/support/runtimeCacheFake";
import { reconcileHandler } from "./handler";

/**
 * [pg] CRON-OBS-1: a repository was added to an installation on GitHub and the `installation_repositories` delivery never made it (or its own repo sync
 * was lost). The reconciler's repo re-sync must still bring the repo in, through the REAL cron handler, the REAL no-database gate and real Postgres,
 * against a strict GitHub fake reached over real TLS. Two ways the reconciler gets to connect:
 *  - nothing woke it: the gate lets it in on its backstop slot (every fourth slot, so up to two hours), and not before;
 *  - the delivery arrived and marked `reconcile` (what the webhook now does for a repositories-added delivery): the very next cron tick connects.
 * `createPool` of the handler is never used here: the pool is injected, and a skipped tick must not touch it.
 */
const SECRET = "test-cron-secret";
const MIN = 60_000;
const SLOT = 30 * MIN;
// The start of a 2-hour period: reconcile's own slot is four 30-minute slots, so a known place in it makes the arithmetic exact.
const START = Math.floor(Date.now() / (4 * SLOT)) * 4 * SLOT;
const clock = { value: START };

describe("a missed repositories-added webhook is repaired by a reconcile tick [pg]", () => {
  let pg: EphemeralPostgres;
  let admin: Pool;
  let platformOps: Pool;
  let appUser: Pool;
  let gh: StrictGithubApps;
  let region: FakeRegion;
  const reports: unknown[] = [];
  let accountId: string;
  let installationId: string;
  const GH_INSTALLATION = 7_700_001;
  const OLD_REPO = 6_100_001;
  const NEW_REPO = 6_100_002;

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: "fx_web_repo_added_test", tmpPrefix: "fx-web-repo-added-" });
    admin = createPool(pg.url);
    await runMigrations(admin);
    platformOps = createPool(pg.platformOpsUrl);
    appUser = createPool(pg.appUserUrl);
  }, 180_000);
  afterAll(async () => {
    for (const p of [platformOps, appUser, admin]) await p?.end();
    pg?.cleanup();
  });

  beforeEach(async () => {
    clock.value = START;
    reports.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock.value);
    // Started AFTER the clock is faked: the strict GitHub server judges JWT expiry with the Date.now it captured at start, which must be the fake one.
    gh = await startStrictGithubApps();
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.spyOn(console, "log").mockImplementation(() => {});
    region = makeRegion(clock);
    setPendingHooks({ store: storeOf(region) });
    gh.calls.length = 0;
    gh.world.installations.length = 0;
    gh.world.failNext.length = 0;
    gh.world.repos = {};
    await admin.query("DELETE FROM repos");
    await admin.query("DELETE FROM installations");
    await admin.query("DELETE FROM installation_installers");
    accountId = randomUUID();
    installationId = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [installationId, accountId, GH_INSTALLATION]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team', 1)`, [GH_INSTALLATION]);
    await admin.query(
      `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, gh_node_id) VALUES ($1, $2, $3, $4, 'team', 'octo-org', $5, $6)`,
      [randomUUID(), accountId, installationId, OLD_REPO, `repo-${OLD_REPO}`, nodeIdOf(OLD_REPO)],
    );
    // GitHub already lists the new repo; our rows do not (the delivery that would have synced it is the one that was lost).
    gh.world.installations.push({ id: GH_INSTALLATION, kind: "team", suspended: false });
    gh.world.repos[GH_INSTALLATION] = [OLD_REPO, NEW_REPO].map((id) => ({ id, name: `repo-${id}`, owner: "octo-org" }));
    // Only the repo re-sync job is due; the rest of the reconciler's jobs are not what this test is about.
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() + interval '30 days', lease_owner = NULL, lease_expires_at = NULL`);
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second', cursor = NULL, last_full_pass_at = NULL WHERE name = 'github_repos'`);
  });
  afterEach(async () => {
    await gh.close();
    setPendingHooks(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const credentials: AppCredentialsSource = (kind) => ({ appId: String(gh.keys[kind as "team"].appId), privateKeyPem: gh.keys[kind as "team"].privateKeyPem, webhookSecret: "x" });
  const reposJob = (): ReconcileJob => {
    const cache = new InstallationTokenCache();
    return createGithubReposJob({
      reportError: (e) => void reports.push(e),
      sync: async (target, conditional) => {
        const result = await syncInstallationRepos(
          { platformOpsPool: platformOps, appUserPool: appUser, appCredentials: credentials, requester: gh.requester, cache, fetchImpl: gh.fetch, warn: () => undefined, conditional },
          target.installationId,
        );
        return result.status === "synced" ? { status: "synced", ...(result.etags ? { etags: result.etags } : {}) } : { status: "skipped", reason: result.reason };
      },
    });
  };
  /** The real cron handler; only the tick is swapped for one that runs the repo re-sync job alone against the strict GitHub fake. */
  const cronTick = async () => {
    const res = await reconcileHandler(
      new NextRequest("https://example.test/api/cron/reconcile", { headers: { authorization: `Bearer ${SECRET}` } }),
      { cronSecret: SECRET, enabled: true, platformOpsPool: platformOps, reportError: () => {}, opsAlertSink: null },
      (deps: TickDeps) => runTick({ ...deps, jobs: [reposJob()] }),
    );
    return (await res.json()) as Record<string, unknown>;
  };
  const advance = (ms: number) => {
    clock.value += ms;
    vi.setSystemTime(clock.value);
  };
  const repoIds = async () => (await admin.query(`SELECT gh_repo_id::text AS id FROM repos WHERE account_id = $1 AND installation_id IS NOT NULL ORDER BY gh_repo_id`, [accountId])).rows.map((r) => Number(r.id));
  const syncedEvents = async () => (await admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE account_id = $1 AND type = 'repos.changed'`, [accountId])).rows[0].n as number;

  it("nothing woke the reconciler: ticks inside the slot end at the gate and add nothing; the backstop tick connects and the repo appears", async () => {
    // The first tick after a deploy is a backstop connect. The job runs, finds the repo, so make it not-yet-due for this one to model "the delivery
    // was lost AFTER the job last ran": put the job's due time in the future, run the tick, then make it due again.
    // A deployment with work in the last 24 hours uses the 2-hour backstop slot (an idle one uses 4 hours, aligned to 4-hour boundaries, so the result
    // would depend on the wall-clock hour the suite happens to run in). Record that activity so the slot under test is the 2-hour one at any hour.
    await storeOf(region).set(ACTIVITY_KEY, START, 24 * 60 * 60);
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() + interval '1 hour' WHERE name = 'github_repos'`);
    expect(await cronTick()).toMatchObject({ enabled: true }); // connected (no last-run on record), nothing due
    expect(await repoIds()).toEqual([OLD_REPO]);
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second' WHERE name = 'github_repos'`);

    for (const step of [MIN, 14 * MIN, 14 * MIN]) {
      advance(step); // minutes 1, 15 and 29 of the slot
      expect(await cronTick(), `at +${(clock.value - START) / MIN} min`).toEqual({ skipped: true, reason: "not_due" });
    }
    expect(await repoIds()).toEqual([OLD_REPO]); // the repo is still missing: this is the gap the marker closes
    expect(gh.calls).toEqual([]); // and a skipped tick asked GitHub nothing

    // Two hours later (the reconciler connects on every fourth 30-minute slot) the backstop opens the gate.
    advance(4 * SLOT - 29 * MIN);
    const out = await cronTick();
    expect(out).toMatchObject({ enabled: true, results: [{ job: "github_repos", result: "ok" }] });
    expect(await repoIds()).toEqual([OLD_REPO, NEW_REPO]);
    expect(await syncedEvents()).toBeGreaterThan(0);
    expect(reports).toEqual([]);
  });

  it("the delivery marked reconcile: the very next cron tick connects, runs the repo re-sync and the repo appears", async () => {
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() + interval '1 hour' WHERE name = 'github_repos'`);
    await cronTick(); // the first tick after a deploy connects; the job is not due, so nothing is synced
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second' WHERE name = 'github_repos'`);
    advance(MIN);
    expect(await cronTick()).toEqual({ skipped: true, reason: "not_due" });
    expect(await repoIds()).toEqual([OLD_REPO]);

    advance(MIN);
    await markWorkPending("reconcile", { now: clock.value }); // what the webhook handler does for a repositories-added delivery
    expect(await cronTick()).toMatchObject({ enabled: true, results: [{ job: "github_repos", result: "ok" }] });
    expect(await repoIds()).toEqual([OLD_REPO, NEW_REPO]);
    expect(reports).toEqual([]);
  });
});
