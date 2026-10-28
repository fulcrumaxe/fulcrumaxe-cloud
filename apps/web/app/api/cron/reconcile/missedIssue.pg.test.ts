import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type EphemeralPostgres } from "@fx/db/test/support/ephemeral-pg.js";
import { createIssueAuthorLookup, importMissedIssues, InstallationTokenCache, syncInstallationRepos, MISSED_ISSUES_PER_REPO, type AppCredentialsSource } from "@fx/github";
import { createGithubReposJob, runTick, type ReconcileJob, type TickDeps } from "@fx/reconcile";
import { markWorkPending, setPendingHooks } from "@fx/core/src/pendingWork";
import { startStrictGithubApps, nodeIdOf, type FakeIssue, type StrictGithubApps } from "../../../../../../packages/reconcile/test/helpers/strictGithubApps";
import { makeRegion, storeOf, type FakeRegion } from "../../../../test/support/runtimeCacheFake";
import { reconcileHandler } from "./handler";

/**
 * [pg] An issue was opened while the app could not take the delivery, and GitHub does not send it again. The reconciler's repo re-sync job must find it on
 * its next connect: through the REAL cron handler, real Postgres, and a strict GitHub fake reached over real TLS (User-Agent, API version, installation
 * tokens that see only their own repositories). The issue goes through the webhook's own intake, so the author's permission is READ from GitHub (the
 * item's `author_association` is never believed), and no job, schedule or wake is added: the pass rides the existing job and its allowance.
 */
const SECRET = "test-cron-secret";
const DAY = 24 * 60 * 60_000;
const clock = { value: Date.now() };

describe("a missed issues.opened delivery is repaired by a reconcile pass [pg]", () => {
  let pg: EphemeralPostgres;
  let admin: Pool;
  let platformOps: Pool;
  let appUser: Pool;
  let gh: StrictGithubApps;
  let region: FakeRegion;
  const reports: unknown[] = [];
  let accountId: string;
  let installationId: string;
  let repoId: string;
  const GH_INSTALLATION = 7_800_001;
  const GH_REPO = 6_200_001;
  const FULL = "octo-org/widgets";

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: "fx_web_missed_issue_test", tmpPrefix: "fx-web-missed-issue-" });
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
    clock.value = Date.now();
    reports.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock.value);
    gh = await startStrictGithubApps();
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.spyOn(console, "log").mockImplementation(() => {});
    region = makeRegion(clock);
    setPendingHooks({ store: storeOf(region) });
    for (const t of ["proposal_intake_events", "proposals", "work_items", "repos", "installations", "installation_installers"]) await admin.query(`DELETE FROM ${t}`);
    accountId = randomUUID();
    installationId = randomUUID();
    repoId = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [installationId, accountId, GH_INSTALLATION]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team', 1)`, [GH_INSTALLATION]);
    // The repository was enabled two days ago; the issues below are newer unless a test says otherwise.
    await admin.query(
      `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, gh_node_id, created_at) VALUES ($1, $2, $3, $4, 'team', 'octo-org', 'widgets', $5, now() - interval '2 days')`,
      [repoId, accountId, installationId, GH_REPO, nodeIdOf(GH_REPO)],
    );
    gh.world.installations.push({ id: GH_INSTALLATION, kind: "team", suspended: false });
    gh.world.repos[GH_INSTALLATION] = [{ id: GH_REPO, name: "widgets", owner: "octo-org" }];
    gh.world.roles[FULL] = { boss: "admin", reader: "read" };
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() + interval '30 days', lease_owner = NULL, lease_expires_at = NULL`);
  });
  afterEach(async () => {
    await gh.close();
    setPendingHooks(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const credentials: AppCredentialsSource = (kind) => ({ appId: String(gh.keys[kind as "team"].appId), privateKeyPem: gh.keys[kind as "team"].privateKeyPem, webhookSecret: "x" });
  const issue = (n: number, login: string, over: Partial<FakeIssue> = {}): FakeIssue => ({
    number: n,
    title: `Issue ${n}`,
    body: `Body ${n}`,
    state: "open",
    login,
    // The item claims its author owns the repository; only the permission read may decide that.
    association: "OWNER",
    createdAt: new Date(Date.now() - (1000 - n) * 1000).toISOString(),
    ...over,
  });
  const issuesCalls = () => gh.calls.filter((c) => /^\/repos\/[^/]+\/[^/]+\/issues$/.test(c.path)).length;
  const issueReads = (n: number) => gh.calls.filter((c) => c.path === `/repos/${FULL}/issues/${n}`).length;

  const reposJob = (): ReconcileJob => {
    const cache = new InstallationTokenCache();
    const fetchImpl = gh.fetch;
    const lookup = createIssueAuthorLookup({ resolveInstallation: async () => ({ installationId: GH_INSTALLATION, appKind: "team" }), appCredentials: credentials, requester: gh.requester, cache, fetchImpl });
    return createGithubReposJob({
      reportError: (e) => void reports.push(e),
      sync: async (target, conditional) => {
        const result = await syncInstallationRepos(
          { platformOpsPool: platformOps, appUserPool: appUser, appCredentials: credentials, requester: gh.requester, cache, fetchImpl, warn: () => undefined, conditional },
          target.installationId,
        );
        return result.status === "synced" ? { status: "synced", ...(result.etags ? { etags: result.etags } : {}) } : { status: "skipped", reason: result.reason };
      },
      importIssues: (target, gate) =>
        importMissedIssues(
          {
            webhook: {
              appUserPool: appUser,
              platformOpsPool: platformOps,
              issueAuthorPermission: async (input) => {
                const found = await lookup(input);
                return found.status === "found" ? { login: found.login, permission: found.permission } : null;
              },
              repoHasEngineLoop: async () => false,
              warn: () => undefined,
            },
            appCredentials: credentials,
            requester: gh.requester,
            cache,
            fetchImpl,
          },
          target.installationId,
          gate,
        ),
    });
  };
  const cronTick = async () => {
    const res = await reconcileHandler(
      new NextRequest("https://example.test/api/cron/reconcile", { headers: { authorization: `Bearer ${SECRET}` } }),
      { cronSecret: SECRET, enabled: true, platformOpsPool: platformOps, reportError: () => {}, opsAlertSink: null },
      (deps: TickDeps) => runTick({ ...deps, jobs: [reposJob()] }),
    );
    return (await res.json()) as Record<string, unknown>;
  };
  /** One pass of the repo re-sync job through the real handler: the first tick after a deploy connects, a marked one connects after that. */
  let primed = false;
  const pass = async () => {
    if (!primed) {
      await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() + interval '1 hour' WHERE name = 'github_repos'`);
      await cronTick();
      primed = true;
    }
    clock.value += 60_000;
    vi.setSystemTime(clock.value);
    await admin.query(`UPDATE reconcile_jobs SET next_due_at = now() - interval '1 second', cursor = NULL WHERE name = 'github_repos'`);
    await markWorkPending("reconcile", { now: clock.value });
    const out = await cronTick();
    return out;
  };
  beforeEach(() => {
    primed = false;
  });

  const items = async (n?: number) =>
    (await admin.query(`SELECT gh_number::int AS n, kind, provenance FROM work_items WHERE account_id = $1 ${n ? "AND gh_number = $2" : ""} ORDER BY gh_number`, n ? [accountId, n] : [accountId])).rows;
  const proposals = async () => (await admin.query(`SELECT gh_number::int AS n, state, provenance FROM proposals WHERE account_id = $1 ORDER BY gh_number`, [accountId])).rows;

  it("a trusted author's missed issue becomes its work item in one pass; a second pass changes nothing and reads no issue again", async () => {
    gh.world.issues[FULL] = [issue(7, "boss")];
    expect(await items()).toEqual([]); // the opened delivery never made it

    const first = await pass();
    expect(reports.map(String)).toEqual([]);
    expect(first).toMatchObject({ enabled: true, results: [{ job: "github_repos", result: "ok" }] });
    expect(await items()).toEqual([{ n: 7, kind: "issue", provenance: "internal" }]);
    expect(issueReads(7)).toBe(1); // the permission lookup read the issue once
    const listsBefore = issuesCalls();

    await pass();
    expect(await items()).toHaveLength(1);
    expect(issueReads(7)).toBe(1); // known now: no lookup, no second item
    expect(issuesCalls()).toBe(listsBefore + 1); // one list request per repository per pass
    expect(reports).toEqual([]);
  });

  it("the opened path's rules apply: an outside author's issue is one proposal and no work item; pull requests, closed issues and issues older than the repository's enablement are left alone", async () => {
    gh.world.issues[FULL] = [
      issue(1, "reader"),
      issue(2, "boss", { pull: true }),
      issue(3, "boss", { state: "closed" }),
      issue(4, "boss", { createdAt: new Date(Date.now() - 5 * DAY).toISOString() }), // created before the repository was enabled
    ];
    await pass();
    expect(await items()).toEqual([]);
    expect(await proposals()).toEqual([{ n: 1, state: "new", provenance: "external" }]);
    expect(gh.calls.filter((c) => /\/issues\/[234]$/.test(c.path))).toEqual([]); // none of them was even read
    expect(reports).toEqual([]);
  });

  it("is bounded: at most the per-repository share of unknown issues is taken in per pass, oldest first, and the rest follow on the next pass", async () => {
    gh.world.issues[FULL] = Array.from({ length: 8 }, (_, i) => issue(10 + i, "boss"));
    await pass();
    expect((await items()).map((r) => r.n)).toEqual([10, 11, 12, 13, 14].slice(0, MISSED_ISSUES_PER_REPO));
    expect(MISSED_ISSUES_PER_REPO).toBe(5);
    await pass();
    expect((await items()).map((r) => r.n)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("an issue that already has a work item is never imported again, and a repository detached from its installation is not read", async () => {
    gh.world.issues[FULL] = [issue(30, "boss")];
    await admin.query(`INSERT INTO work_items (account_id, repo_id, kind, gh_number, provenance) VALUES ($1, $2, 'feature', 30, 'internal')`, [accountId, repoId]);
    await pass();
    expect(await items(30)).toHaveLength(1);
    expect(issueReads(30)).toBe(0);

    await admin.query(`DELETE FROM work_items WHERE account_id = $1`, [accountId]);
    await admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [repoId]);
    const before = issuesCalls();
    await pass();
    expect(await items()).toEqual([]);
    expect(issuesCalls()).toBe(before);
  });

  it("the owner-process read of an outside author's issue is drawn from the same allowance: the run never goes over it", async () => {
    gh.world.issues[FULL] = Array.from({ length: 5 }, (_, i) => issue(50 + i, "reader"));
    const cache = new InstallationTokenCache();
    const lookup = createIssueAuthorLookup({ resolveInstallation: async () => ({ installationId: GH_INSTALLATION, appKind: "team" }), appCredentials: credentials, requester: gh.requester, cache, fetchImpl: gh.fetch });
    let taken = 0;
    let ownerReads = 0;
    const ALLOWANCE = 17; // the repository (2), then 6 per outside issue (3 + 3 for the owner read): two whole issues, then the third is refused at its owner read
    const out = await importMissedIssues(
      {
        webhook: {
          appUserPool: appUser,
          platformOpsPool: platformOps,
          issueAuthorPermission: async (input) => {
            const found = await lookup(input);
            return found.status === "found" ? { login: found.login, permission: found.permission } : null;
          },
          repoHasEngineLoop: async () => {
            ownerReads += 1;
            return false;
          },
          warn: () => undefined,
        },
        appCredentials: credentials,
        requester: gh.requester,
        cache,
        fetchImpl: gh.fetch,
      },
      installationId,
      { take: (n) => (taken + n <= ALLOWANCE ? ((taken += n), true) : false), stopped: () => false },
    );
    expect(taken).toBeLessThanOrEqual(ALLOWANCE);
    expect(out.stop).toBe("budget");
    expect(ownerReads).toBe(2);
    expect((await proposals()).map((r) => r.n)).toEqual([50, 51]);
  });

  it("a GitHub failure on the list is reported once and the pass still ends, and the next pass imports", async () => {
    gh.world.issues[FULL] = [issue(40, "boss")];
    gh.world.failNext.push({ status: 500, match: /^\/repos\/[^/]+\/[^/]+\/issues$/ });
    await pass();
    expect(await items()).toEqual([]);
    expect(reports).toHaveLength(1);
    await pass();
    expect((await items()).map((r) => r.n)).toEqual([40]);
  });
});
