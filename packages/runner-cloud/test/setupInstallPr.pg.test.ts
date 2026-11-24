import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_BASE_COMMIT, MACHINE_JOB_CLAIM_PATH, setupProgressPath } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { HELLO_PATH, machineJobClaimRun, runnerHello, setupProgressRun } from "../src/index.js";
import { claimSetupInstall, completeSetupInstall, installPathRefused, installPullRequestText, type SetupInstallClaim } from "../src/setupInstallPr.js";
import { createRunPullRequestPort } from "../src/runPullRequest.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";
import { issueTestJob } from "./helpers/machineJobIssuer.js";
import { FAKE_APP_LOGIN, FakeGithub, type FakeRepo } from "./helpers/githubFake.js";

const BASE = "a".repeat(40);
const HEAD = "c".repeat(40);
const BRANCH = "fx/engine-install-1.2.3";

/**
 * [pg] D#845 ON-8f2a: the install pull request step. The cloud side runs as the platform_ops login through the real definers (migration 1072) with row security forced; the GitHub side is the real run port over a strict
 * fake of GitHub (its own table, written without the production allowlist). What the fake cannot do: GitHub's own branch protection, push rules, rate limits and GraphQL schema validation.
 */
describe("the install pull request step [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());
  // setups other tests of this database left due are parked (their push was "long ago"), so a claim here is always this test's own
  beforeEach(async () => {
    await h.admin.query("UPDATE project_setups SET updated_at = now() - interval '7 hours'");
  });

  interface Rig { who: SeedRefs; key: TestKey; runnerId: string; setupId: string; jobId: string }
  async function rig(o: { mode?: "pr" | "direct"; head?: string } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const key = newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    const hello = await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, { protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: ["project_setup_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" } })));
    expect(hello.status).toBe(200);
    const setupId = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase, engine_version) VALUES ($1, $2, 'existing', $3, 'install', '1.2.3') RETURNING id", [who.accountId, who.repoId, who.userId])).rows[0]!.id;
    const direct = o.mode === "direct";
    const issued = await issueTestJob(h.appPool, h.admin, { accountId: who.accountId, userId: who.userId, runnerId, repoId: who.repoId, setupId, args: direct ? { mode: "direct", base_sha: EMPTY_BASE_COMMIT } : { base_sha: BASE } });
    expect((await respond(() => machineJobClaimRun(h.deps(), signed(key, MACHINE_JOB_CLAIM_PATH, {})))).status).toBe(200);
    const r = { who, key, runnerId, setupId, jobId: issued.id };
    let seq = 0;
    const report = (body: Record<string, unknown>) => respond(() => setupProgressRun(h.deps(), signed(key, setupProgressPath(setupId), { job_id: issued.id, seq: seq++, ...body }), setupId));
    expect((await report({ sub_step: "push", state: "started" })).status).toBe(200);
    expect((await report({ sub_step: "push", state: "ok", head_sha: o.head ?? HEAD })).status).toBe(200);
    return r;
  }

  /** acme/widgets with its default branch at BASE (or empty), the install branch at HEAD whose only parent is BASE, and the given files. */
  function github(o: { files?: string[]; parents?: string[]; branchOid?: string; direct?: boolean } = {}) {
    const fake = new FakeGithub();
    const repo: FakeRepo = fake.addRepo("acme", "widgets");
    if (o.direct === true) {
      repo.branches.get("main")!.oid = HEAD;
      repo.commits.set(HEAD, o.parents ?? []);
    } else {
      fake.pushBranch(repo, BRANCH, { oid: o.branchOid ?? HEAD, files: (o.files ?? [".fulcrumaxe/engine.json", "scripts/start.sh"]).map((path) => ({ path, changeType: "ADDED" })) });
      repo.commits.set(HEAD, o.parents ?? [BASE]);
    }
    const port = createRunPullRequestPort({ open: async () => fake, appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
    return { fake, repo, port };
  }
  const claimOf = async (r: Rig): Promise<SetupInstallClaim> => {
    const c = await claimSetupInstall(h.opsPool);
    if (c === null || c === "malformed") throw new Error(`no claim for ${r.setupId}`);
    expect(c.setupId).toBe(r.setupId);
    return c;
  };
  const setup = async (id: string) => (await h.admin.query("SELECT phase, sub_step, state, failure_code, install_pr, install_head_sha FROM project_setups WHERE id = $1", [id])).rows[0];
  const jobState = async (id: string) => (await h.admin.query<{ state: string }>("SELECT state FROM machine_jobs WHERE id = $1", [id])).rows[0]!.state;

  describe("the push report", () => {
    it("marks the reconciler when the push is recorded (and only then), so the step runs on the next tick and not in the request", async () => {
      const marks: string[] = [];
      setPendingHooks({ store: { get: async () => null, set: async (k: string) => void marks.push(k), delete: async () => undefined } as never });
      try {
        const r = await rig();
        await Promise.resolve();
        expect(marks.filter((k) => k.includes("reconcile"))).not.toEqual([]);
        // the report returned before any GitHub call could have been made: nothing is open yet and the setup still says push ok
        expect(await setup(r.setupId)).toMatchObject({ phase: "install", sub_step: "push", state: "ok", install_pr: null });
      } finally {
        setPendingHooks(null);
      }
    });
  });

  describe("pull request mode", () => {
    it("holds the commit to the job, opens the pull request as a draft, reads its files, and only then marks it ready; records the number and ends the job", async () => {
      const r = await rig();
      const { fake, repo, port } = github();
      const claim = await claimOf(r);
      expect(claim).toMatchObject({ accountId: r.who.accountId, userId: r.who.userId, mode: "pr", baseSha: BASE, branch: BRANCH, headSha: HEAD, version: "1.2.3", owner: "acme", name: "widgets" });
      expect(await completeSetupInstall({ pool: h.opsPool, port }, claim)).toBe("opened");
      const pr = repo.pulls[0]!;
      expect(repo.pulls).toHaveLength(1);
      expect(pr).toMatchObject({ head: BRANCH, base: "main", draft: false, state: "open", title: "Add the engine (v1.2.3)" });
      expect(fake.calls.map((c) => c.label)).toEqual(["A2", "A1 RunBranchState", "A1 CommitParents", "A3", "A4", "A1 PullRequestFiles", "A1 MarkReady"]);
      expect(fake.denied).toBe(0);
      expect(await setup(r.setupId)).toMatchObject({ phase: "await_merge", sub_step: "pr_open", state: "ok", failure_code: null, install_pr: pr.number, install_head_sha: HEAD });
      expect(await jobState(r.jobId)).toBe("done");
      // nothing is due now, and a second record for the same claim changes nothing
      expect(await claimSetupInstall(h.opsPool)).toBeNull();
      expect((await h.opsPool.query("SELECT setup_install_pr_record($1::uuid, $2::int, $3, $4::int) AS ok", [r.setupId, claim.attempt, HEAD, pr.number + 1])).rows[0].ok).toBe(false);
      expect(await setup(r.setupId)).toMatchObject({ install_pr: pr.number });
    });

    it("the text of the pull request is fixed words and the engine version of our own row", () => {
      expect(installPullRequestText("1.2.3").title).toBe("Add the engine (v1.2.3)");
      expect(installPullRequestText("1.2.3; DROP").title).toBe("Add the engine");
      expect(installPullRequestText(null).body).not.toMatch(/\{|\$/);
    });

    it("reuses the open pull request of a rerun, and never opens a second", async () => {
      const r = await rig();
      const { repo, port } = github();
      const first = await port.openDraft({ repo: { id: r.who.repoId, owner: "acme", name: "widgets" }, branch: BRANCH, base: "main", text: installPullRequestText("1.2.3") });
      expect(await completeSetupInstall({ pool: h.opsPool, port }, await claimOf(r))).toBe("opened");
      expect(repo.pulls).toHaveLength(1);
      expect(await setup(r.setupId)).toMatchObject({ phase: "await_merge", install_pr: first.number });
    });

    it("refuses a branch somebody moved since the push (install_head_changed), opens nothing and fails the job", async () => {
      const r = await rig();
      const { repo, port } = github({ branchOid: "d".repeat(40) });
      repo.commits.set("d".repeat(40), [BASE]);
      expect(await completeSetupInstall({ pool: h.opsPool, port }, await claimOf(r))).toBe("failed");
      expect(repo.pulls).toEqual([]);
      expect(await setup(r.setupId)).toMatchObject({ phase: "install", state: "failed", failure_code: "install_head_changed", install_pr: null });
      expect(await jobState(r.jobId)).toBe("failed");
    });

    it("refuses a pushed commit that does not sit directly on the job's base: a different parent, two parents, none, or a commit GitHub does not have", async () => {
      for (const parents of [["e".repeat(40)], [BASE, "e".repeat(40)], [], null] as const) {
        const r = await rig();
        const { repo, port } = github();
        if (parents === null) repo.commits.delete(HEAD);
        else repo.commits.set(HEAD, [...parents]);
        expect(await completeSetupInstall({ pool: h.opsPool, port }, await claimOf(r))).toBe("failed");
        expect(repo.pulls).toEqual([]);
        expect(await setup(r.setupId)).toMatchObject({ state: "failed", failure_code: "install_head_changed" });
      }
    });

    it("closes a pull request that holds a workflow file or an odd path, never marks it ready, and fails it pr_scope_refused", async () => {
      for (const path of [".github/workflows/ci.yml", ".GitHub/Workflows/x.yml", ".github", "a/../b", "a//b", ".git/config"]) {
        const r = await rig();
        const { fake, repo, port } = github({ files: ["ok.md", path] });
        expect(await completeSetupInstall({ pool: h.opsPool, port }, await claimOf(r)), path).toBe("failed");
        expect(repo.pulls[0]).toMatchObject({ state: "closed", draft: true });
        expect(fake.calls.some((c) => c.label === "A1 MarkReady")).toBe(false);
        expect(await setup(r.setupId)).toMatchObject({ phase: "install", state: "failed", failure_code: "pr_scope_refused", install_pr: null });
      }
    });

    it("path policy: the workflow rule the runner holds the bundle to, on lower-cased segments, and odd paths", () => {
      for (const p of [".github/workflows/a.yml", ".GITHUB/workflows", ".github", ".github/ISSUE_TEMPLATE/x.md".replace("ISSUE_TEMPLATE", "workflows"), "/abs", "a\\b", "a/./b", "", "x\u0000y", ".git/hooks/pre-commit"]) expect(installPathRefused(p), p).toBe(true);
      for (const p of [".github/ISSUE_TEMPLATE/x.md", ".fulcrumaxe/a.json", "src/.github/workflows/x", "docs/.gitignore", "a.b/c"]) expect(installPathRefused(p), p).toBe(false);
    });

    it("an incomplete file list is refused too (a pull request with too many files is not one a person can review)", async () => {
      const r = await rig();
      const { fake, repo, port } = github();
      fake.inject = { label: /PullRequestFiles/, reply: { status: 200, body: { data: { repository: { pullRequest: { files: { totalCount: 3, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ path: "a", changeType: "ADDED" }] } } } } } } };
      expect(await completeSetupInstall({ pool: h.opsPool, port }, await claimOf(r))).toBe("failed");
      expect(repo.pulls[0]).toMatchObject({ state: "closed" });
      expect(await setup(r.setupId)).toMatchObject({ failure_code: "pr_scope_refused" });
    });
  });

  describe("direct mode", () => {
    it("skips the pull request: the default branch's head is the pushed root commit, and the setup goes to finish with no pull request", async () => {
      const r = await rig({ mode: "direct" });
      const { fake, repo, port } = github({ direct: true });
      const claim = await claimOf(r);
      expect(claim).toMatchObject({ mode: "direct", baseSha: EMPTY_BASE_COMMIT });
      expect(await completeSetupInstall({ pool: h.opsPool, port }, claim)).toBe("finished");
      expect(repo.pulls).toEqual([]);
      expect(fake.calls.map((c) => c.label)).toEqual(["A2", "A1 RunBranchState", "A1 CommitParents"]);
      expect(await setup(r.setupId)).toMatchObject({ phase: "finish", sub_step: "push", state: "ok", install_pr: null, install_head_sha: HEAD });
      expect(await jobState(r.jobId)).toBe("done");
    });

    it("refuses a default branch that moved on, or a pushed commit that is not a root commit (install_head_changed)", async () => {
      const moved = await rig({ mode: "direct" });
      const a = github({ direct: true });
      a.repo.branches.get("main")!.oid = "d".repeat(40);
      expect(await completeSetupInstall({ pool: h.opsPool, port: a.port }, await claimOf(moved))).toBe("failed");
      expect(await setup(moved.setupId)).toMatchObject({ phase: "install", state: "failed", failure_code: "install_head_changed" });
      const notRoot = await rig({ mode: "direct" });
      const b = github({ direct: true, parents: [BASE] });
      expect(await completeSetupInstall({ pool: h.opsPool, port: b.port }, await claimOf(notRoot))).toBe("failed");
      expect(await setup(notRoot.setupId)).toMatchObject({ failure_code: "install_head_changed" });
    });

    it("a pull request number cannot be recorded for a direct job, and a direct finish cannot be recorded for a pull request job", async () => {
      const d = await rig({ mode: "direct" });
      const dc = await claimOf(d);
      expect((await h.opsPool.query("SELECT setup_install_pr_record($1::uuid, $2::int, $3, 7) AS ok", [d.setupId, dc.attempt, HEAD])).rows[0].ok).toBe(false);
      const p = await rig();
      const pc = await claimOf(p);
      expect((await h.opsPool.query("SELECT setup_install_pr_record($1::uuid, $2::int, $3, NULL) AS ok", [p.setupId, pc.attempt, HEAD])).rows[0].ok).toBe(false);
      expect(await setup(p.setupId)).toMatchObject({ phase: "install" });
    });
  });

  describe("when GitHub cannot be asked", () => {
    it("leaves the setup as it was, keeps the lease, and does it on a later pass; a refusal no retry fixes fails it pr_open_failed", async () => {
      const r = await rig();
      const { fake, repo, port } = github();
      fake.inject = { label: /^A2$/, reply: { status: 502, body: { message: "Bad Gateway" } } };
      expect(await completeSetupInstall({ pool: h.opsPool, port }, await claimOf(r))).toBe("retry");
      expect(await setup(r.setupId)).toMatchObject({ phase: "install", sub_step: "push", state: "ok", install_pr: null });
      expect(await claimSetupInstall(h.opsPool)).toBeNull();
      await h.admin.query("UPDATE project_setups SET install_pr_claim_at = now() - interval '11 minutes' WHERE id = $1", [r.setupId]);
      expect(await completeSetupInstall({ pool: h.opsPool, port }, await claimOf(r))).toBe("opened");
      expect(repo.pulls).toHaveLength(1);

      const refused = await rig();
      const g = github();
      g.fake.inject = { label: /^A4$/, reply: { status: 403, body: { message: "Resource not accessible by integration" } } };
      expect(await completeSetupInstall({ pool: h.opsPool, port: g.port }, await claimOf(refused))).toBe("failed");
      expect(await setup(refused.setupId)).toMatchObject({ state: "failed", failure_code: "pr_open_failed" });
    });
  });

  describe("the claim and the definers", () => {
    it("two overlapping passes take one setup once; a lapsed lease is taken again and a new commit is due at once", async () => {
      const r = await rig();
      const [a, b] = await Promise.all([claimSetupInstall(h.opsPool), claimSetupInstall(h.opsPool)]);
      expect([a, b].filter((c) => c !== null)).toHaveLength(1);
      expect(await claimSetupInstall(h.opsPool)).toBeNull();
      await h.admin.query("UPDATE project_setups SET install_head_sha = $2 WHERE id = $1", [r.setupId, "d".repeat(40)]);
      expect((await claimSetupInstall(h.opsPool) as SetupInstallClaim).headSha).toBe("d".repeat(40));
    });

    it("takes nothing that is not due: no push yet, a pull request already, an old push, a later attempt's job, a deleted account, a job that is not the runner's", async () => {
      const early = await rig();
      await h.admin.query("UPDATE project_setups SET sub_step = 'bootstrap', state = 'started' WHERE id = $1", [early.setupId]);
      const done = await rig();
      await h.admin.query("UPDATE project_setups SET install_pr = 5 WHERE id = $1", [done.setupId]);
      const old = await rig();
      await h.admin.query("UPDATE project_setups SET updated_at = now() - interval '7 hours' WHERE id = $1", [old.setupId]);
      const superseded = await rig();
      await issueTestJob(h.appPool, h.admin, { accountId: superseded.who.accountId, userId: superseded.who.userId, runnerId: superseded.runnerId, repoId: superseded.who.repoId, setupId: superseded.setupId });
      const gone = await rig();
      await h.admin.query("UPDATE accounts SET deleted_at = now() WHERE id = $1", [gone.who.accountId]);
      const ended = await rig();
      await h.admin.query("UPDATE machine_jobs SET state = 'expired' WHERE id = $1", [ended.jobId]);
      expect(await claimSetupInstall(h.opsPool)).toBeNull();
      expect((await h.opsPool.query("SELECT setup_install_pr_pending() AS p")).rows[0].p).toBe(false);
    });

    it("only the platform_ops login can run them: a tenant session, a runner session and the app login are refused", async () => {
      const r = await rig();
      const calls = ["SELECT * FROM setup_install_pr_claim()", "SELECT setup_install_pr_pending()", `SELECT setup_install_pr_record('${r.setupId}', 1, '${HEAD}', 1)`, `SELECT setup_install_pr_fail('${r.setupId}', 1, '${HEAD}', 'pr_open_failed')`];
      for (const sql of calls) {
        await expect(withTenant(h.appPool, r.who.accountId, r.who.userId, (c) => c.query(sql)), sql).rejects.toThrow();
        await expect(h.appPool.query(sql), sql).rejects.toThrow();
      }
      expect(await setup(r.setupId)).toMatchObject({ phase: "install", state: "ok" });
    });

    it("a failure code outside the closed three, or a stale commit or attempt, changes nothing", async () => {
      const r = await rig();
      const c = await claimOf(r);
      await expect(h.opsPool.query("SELECT setup_install_pr_fail($1::uuid, $2::int, $3, 'job_expired')", [r.setupId, c.attempt, HEAD])).rejects.toThrow();
      expect((await h.opsPool.query("SELECT setup_install_pr_fail($1::uuid, $2::int, $3, 'pr_open_failed') AS ok", [r.setupId, c.attempt, "d".repeat(40)])).rows[0].ok).toBe(false);
      expect((await h.opsPool.query("SELECT setup_install_pr_fail($1::uuid, $2::int, $3, 'pr_open_failed') AS ok", [r.setupId, c.attempt + 1, HEAD])).rows[0].ok).toBe(false);
      // the success record holds to the same commit and attempt
      expect((await h.opsPool.query("SELECT setup_install_pr_record($1::uuid, $2::int, $3, 9) AS ok", [r.setupId, c.attempt, "d".repeat(40)])).rows[0].ok).toBe(false);
      expect((await h.opsPool.query("SELECT setup_install_pr_record($1::uuid, $2::int, $3, 9) AS ok", [r.setupId, c.attempt + 1, HEAD])).rows[0].ok).toBe(false);
      expect(await setup(r.setupId)).toMatchObject({ phase: "install", state: "ok", failure_code: null, install_pr: null });
      expect(await jobState(r.jobId)).toBe("delivered");
    });

    it("another account's rows are never touched: finishing this setup leaves a second account's due setup as it was", async () => {
      const a = await rig();
      const b = await rig();
      const { port } = github();
      expect(await completeSetupInstall({ pool: h.opsPool, port }, await claimOf(a))).toBe("opened");
      expect(await setup(b.setupId)).toMatchObject({ phase: "install", sub_step: "push", state: "ok", install_pr: null });
      expect(await jobState(b.jobId)).toBe("delivered");
    });
  });
});
