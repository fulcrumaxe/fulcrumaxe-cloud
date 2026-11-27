import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_BASE_COMMIT, MACHINE_JOB_CLAIM_PATH, setupProgressPath } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { HELLO_PATH, machineJobClaimRun, runnerHello, setupProgressRun } from "../src/index.js";
import { SETUP_PR_FAILURE_EVENT, claimSetupInstall, completeSetupInstall, installPathRefused, installPullRequestText, type SetupInstallClaim } from "../src/setupInstallPr.js";
import { createRunPullRequestPort } from "../src/runPullRequest.js";
import { SETUP_INSTALL_LABELS, LocalOnlyGithubError } from "../src/localOnlyGithub.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";
import { issueTestJob } from "./helpers/machineJobIssuer.js";
import { FAKE_APP_LOGIN, FakeGithub, openInstallationKinds, type FakeRepo } from "./helpers/githubFake.js";

const BASE = "a".repeat(40);
const HEAD = "c".repeat(40);
const BRANCH = "fx/engine-install-1.2.3";
const LABEL_CALLS = SETUP_INSTALL_LABELS.map(() => "A26");

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
  async function rig(o: { mode?: "pr" | "direct"; head?: string; afterSetupPush?: (setupId: string) => void } = {}): Promise<Rig> {
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
    const report = (body: Record<string, unknown>) => respond(() => setupProgressRun(h.deps(o.afterSetupPush ? { afterSetupPush: o.afterSetupPush } : {}), signed(key, setupProgressPath(setupId), { job_id: issued.id, seq: seq++, ...body }), setupId));
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
    const port = createRunPullRequestPort({ open: openInstallationKinds(fake), appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
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

  describe("the push report hands the install over right away (Ruling 122)", () => {
    /** What the app's hand-off does after the answer: the tick's own claim and completion, over the given port. Errors are the hand-off's to report, never the request's. */
    const handoff = (port: ReturnType<typeof github>["port"], runs: Promise<string>[]) => (_setupId: string) => {
      runs.push((async () => {
        const claim = await claimSetupInstall(h.opsPool);
        if (claim === null || claim === "malformed") return "none";
        return completeSetupInstall({ pool: h.opsPool, port }, claim);
      })());
    };

    it("calls the hook once per push ok, with the setup, and never for a step that is not the pushed one", async () => {
      const seen: string[] = [];
      const r = await rig({ afterSetupPush: (id) => void seen.push(id) });
      expect(seen).toEqual([r.setupId]);
    });

    it("answers the report 200 even when the hook throws, and the setup still says push ok", async () => {
      // rig() asserts both reports (started, ok) were answered 200
      const r = await rig({ afterSetupPush: () => { throw new Error("boom"); } });
      expect(await setup(r.setupId)).toMatchObject({ sub_step: "push", state: "ok", install_pr: null });
    });

    it("opens the install pull request with no tick: the report's own hand-off claims the setup and finishes it over a fake GitHub", async () => {
      const { repo, port } = github();
      const runs: Promise<string>[] = [];
      const r = await rig({ afterSetupPush: handoff(port, runs) });
      expect(await Promise.all(runs)).toEqual(["opened"]);
      expect(repo.pulls).toHaveLength(1);
      expect(repo.pulls[0]).toMatchObject({ head: BRANCH, state: "open", draft: false });
      expect(await setup(r.setupId)).toMatchObject({ phase: "await_merge", install_pr: repo.pulls[0]!.number });
      // the tick that comes later finds nothing due
      expect(await claimSetupInstall(h.opsPool)).toBeNull();
    });

    it("a failing hand-off leaves the claim for the tick, which then does it", async () => {
      const { fake, repo, port } = github();
      fake.inject = { label: /^A2$/, reply: { status: 502, body: { message: "Bad Gateway" } } };
      const runs: Promise<string>[] = [];
      const r = await rig({ afterSetupPush: handoff(port, runs) });
      expect(await Promise.all(runs)).toEqual(["retry"]);
      expect(repo.pulls).toEqual([]);
      expect(await setup(r.setupId)).toMatchObject({ phase: "install", sub_step: "push", state: "ok", install_pr: null });
      // the tick cannot take it while the hand-off's lease holds, and takes it once the lease lapses
      expect(await claimSetupInstall(h.opsPool)).toBeNull();
      await h.admin.query("UPDATE project_setups SET install_pr_claim_at = now() - interval '11 minutes' WHERE id = $1", [r.setupId]);
      fake.inject = null;
      expect(await completeSetupInstall({ pool: h.opsPool, port }, await claimOf(r))).toBe("opened");
      expect(repo.pulls).toHaveLength(1);
    });

    it("a second claim inside the lease window gets nothing, one run after the other, so it is the lease and not row locking that keeps it off", async () => {
      const r = await rig();
      const first = await claimSetupInstall(h.opsPool);
      expect(first).not.toBeNull();
      // the first claim's transaction is long over (SKIP LOCKED has nothing left to skip); only the lease can hold the second back
      expect(await claimSetupInstall(h.opsPool)).toBeNull();
      expect(await claimSetupInstall(h.opsPool)).toBeNull();
      // once the lease lapses the setup is claimable again
      await h.admin.query("UPDATE project_setups SET install_pr_claim_at = now() - interval '11 minutes' WHERE id = $1", [r.setupId]);
      expect(await claimSetupInstall(h.opsPool)).not.toBeNull();
    });

    it("the hand-off and a tick that race open one pull request between them", async () => {
      const { repo, port } = github();
      const runs: Promise<string>[] = [];
      let tick: Promise<string> | undefined;
      const r = await rig({
        afterSetupPush: (id) => {
          handoff(port, runs)(id);
          // the tick starts in the same moment, through the same claim
          tick = (async () => {
            const claim = await claimSetupInstall(h.opsPool);
            return claim === null || claim === "malformed" ? "none" : completeSetupInstall({ pool: h.opsPool, port }, claim);
          })();
        },
      });
      const outcomes = [...(await Promise.all(runs)), await tick!];
      expect(outcomes.filter((o) => o === "opened")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "none")).toHaveLength(1);
      expect(repo.pulls).toHaveLength(1);
      expect(await setup(r.setupId)).toMatchObject({ phase: "await_merge" });
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
      expect(fake.calls.map((c) => c.label)).toEqual(["A2", "A1 RunBranchState", "A1 CommitParents", ...LABEL_CALLS, "A3", "A4", "A1 PullRequestFiles", "A1 MarkReady"]);
      expect([...repo.labels.values()].map((l) => l.name).sort()).toEqual(SETUP_INSTALL_LABELS.map((l) => l.name).sort());
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
      expect(fake.calls.map((c) => c.label)).toEqual(["A2", "A1 RunBranchState", "A1 CommitParents", ...LABEL_CALLS]);
      expect(repo.labels.size).toBe(SETUP_INSTALL_LABELS.length);
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

  describe("a pull request that cannot be marked ready (FU-317)", () => {
    const REPO = { id: "r", owner: "acme", name: "widgets" };
    const FORBIDDEN = { status: 200, body: { data: { markPullRequestReadyForReview: null }, errors: [{ type: "FORBIDDEN", path: ["markPullRequestReadyForReview"], message: "Resource not accessible by integration" }] } };

    it("a FORBIDDEN answer to MarkReady fails the setup pr_open_failed and logs the call, the status and the type, with nothing GitHub wrote", async () => {
      const r = await rig();
      const g = github();
      g.fake.inject = { label: /^A1 MarkReady$/, reply: FORBIDDEN };
      const lines: string[] = [];
      expect(await completeSetupInstall({ pool: h.opsPool, port: g.port, log: (l) => lines.push(l) }, await claimOf(r))).toBe("failed");
      expect(await setup(r.setupId)).toMatchObject({ state: "failed", failure_code: "pr_open_failed", install_pr: null });
      expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: SETUP_PR_FAILURE_EVENT, step: "setup_install_pr", id: r.setupId, op: "MarkReady", reason: "rejected", status: 200, graphql_types: ["FORBIDDEN"] }]);
      expect(lines.join("")).not.toMatch(/Resource not accessible|acme|widgets|ghs_/);
    });

    it("a malformed answer to MarkReady is logged as malformed with its call; a GitHub that cannot be asked logs nothing and retries", async () => {
      const r = await rig();
      const g = github();
      g.fake.inject = { label: /^A1 MarkReady$/, reply: { status: 200, body: { data: { markPullRequestReadyForReview: { pullRequest: { number: 99, isDraft: false } } } } } };
      const lines: string[] = [];
      expect(await completeSetupInstall({ pool: h.opsPool, port: g.port, log: (l) => lines.push(l) }, await claimOf(r))).toBe("failed");
      expect(lines.map((l) => JSON.parse(l))).toMatchObject([{ op: "markReady", reason: "malformed", status: null, graphql_types: [] }]);

      const later = await rig();
      const t = github();
      t.fake.inject = { label: /^A2$/, reply: { status: 502, body: { message: "Bad Gateway" } } };
      const quiet: string[] = [];
      expect(await completeSetupInstall({ pool: h.opsPool, port: t.port, log: (l) => quiet.push(l) }, await claimOf(later))).toBe("retry");
      expect(quiet).toEqual([]);
    });

    it("a reused pull request that is already ready counts as success: the mutation is not sent again", async () => {
      const r = await rig();
      const g = github();
      const first = await g.port.openDraft({ repo: REPO, branch: BRANCH, base: "main", text: installPullRequestText("1.2.3") });
      await g.port.markReady({ repo: REPO, pullRequest: first });
      expect(g.repo.pulls[0]!.draft).toBe(false);
      // a refusal of the mutation would fail the setup, so a success proves it was not asked
      g.fake.inject = { label: /^A1 MarkReady$/, reply: FORBIDDEN };
      const lines: string[] = [];
      expect(await completeSetupInstall({ pool: h.opsPool, port: g.port, log: (l) => lines.push(l) }, await claimOf(r))).toBe("opened");
      expect(await setup(r.setupId)).toMatchObject({ install_pr: 1 });
      expect(lines).toEqual([]);
    });

    it("a call the fence refuses is logged by its rule and fails the setup pr_open_failed", async () => {
      const r = await rig();
      const g = github();
      const lines: string[] = [];
      const port = { ...g.port, markReady: async () => { throw new LocalOnlyGithubError("not_allowlisted"); } };
      expect(await completeSetupInstall({ pool: h.opsPool, port, log: (l) => lines.push(l) }, await claimOf(r))).toBe("failed");
      expect(lines.map((l) => JSON.parse(l))).toMatchObject([{ step: "setup_install_pr", op: "fence", rule: "not_allowlisted" }]);
    });

    it("a log writer that throws changes nothing", async () => {
      const r = await rig();
      const g = github();
      g.fake.inject = { label: /^A1 MarkReady$/, reply: FORBIDDEN };
      expect(await completeSetupInstall({ pool: h.opsPool, port: g.port, log: () => { throw new Error("sink down"); } }, await claimOf(r))).toBe("failed");
    });
  });

  describe("the engine's labels (A26)", () => {
    it("makes all 11 labels once the commit is held to the job, before the pull request exists; labels that already exist (in any case) count as made", async () => {
      const r = await rig();
      const { fake, repo, port } = github();
      repo.labels.set("spec_ready", { name: "spec_ready", color: "ededed", description: "somebody else's" });
      repo.labels.set("team-log", { name: "team-log", color: "ededed", description: "" });
      expect(await completeSetupInstall({ pool: h.opsPool, port }, await claimOf(r))).toBe("opened");
      expect(repo.labels.size).toBe(SETUP_INSTALL_LABELS.length);
      // an existing label is left as it was; the one this step made has exactly the table's colour and words
      expect(repo.labels.get("spec_ready")).toMatchObject({ color: "ededed" });
      expect(repo.labels.get("code-review-passed")).toMatchObject({ name: "code-review-passed", color: "0E8A16", description: "Code review passed — ready for next gate" });
      const labels = fake.calls.map((c) => c.label);
      expect(labels.indexOf("A26")).toBeLessThan(labels.indexOf("A3"));
      expect(labels.filter((l) => l === "A26")).toHaveLength(SETUP_INSTALL_LABELS.length);
      expect(fake.denied).toBe(0);
    });

    it("a repository whose labels GitHub will not take fails the setup pr_open_failed and opens no pull request; a GitHub that cannot be asked leaves the setup to a later pass", async () => {
      const refused = await rig();
      const a = github();
      a.fake.inject = { label: /^A26$/, reply: { status: 403, body: { message: "Resource not accessible by integration" } } };
      expect(await completeSetupInstall({ pool: h.opsPool, port: a.port }, await claimOf(refused))).toBe("failed");
      expect(a.repo.pulls).toEqual([]);
      expect(await setup(refused.setupId)).toMatchObject({ state: "failed", failure_code: "pr_open_failed", install_pr: null });
      // a 422 that is not "already exists" is a refusal, not a label that exists
      const odd = await rig();
      const b = github();
      b.fake.inject = { label: /^A26$/, reply: { status: 422, body: { message: "Validation Failed", errors: [{ resource: "Label", code: "invalid", field: "color" }] } } };
      expect(await completeSetupInstall({ pool: h.opsPool, port: b.port }, await claimOf(odd))).toBe("failed");
      expect(await setup(odd.setupId)).toMatchObject({ failure_code: "pr_open_failed" });

      const later = await rig();
      const c = github();
      c.fake.inject = { label: /^A26$/, reply: { status: 502, body: { message: "Bad Gateway" } } };
      expect(await completeSetupInstall({ pool: h.opsPool, port: c.port }, await claimOf(later))).toBe("retry");
      expect(await setup(later.setupId)).toMatchObject({ phase: "install", sub_step: "push", state: "ok", install_pr: null });
      await h.admin.query("UPDATE project_setups SET install_pr_claim_at = now() - interval '11 minutes' WHERE id = $1", [later.setupId]);
      expect(await completeSetupInstall({ pool: h.opsPool, port: c.port }, await claimOf(later))).toBe("opened");
    });

    it("direct mode makes the labels too, before the setup finishes", async () => {
      const r = await rig({ mode: "direct" });
      const { fake, repo, port } = github({ direct: true });
      fake.inject = { label: /^A26$/, reply: { status: 403, body: { message: "Resource not accessible by integration" } } };
      expect(await completeSetupInstall({ pool: h.opsPool, port }, await claimOf(r))).toBe("failed");
      expect(await setup(r.setupId)).toMatchObject({ phase: "install", failure_code: "pr_open_failed" });
      expect(repo.labels.size).toBe(0);
    });
  });

  describe("the head of the opened pull request, and a refused call (FU-235)", () => {
    it("closes a pull request whose head is not the pushed commit and refuses it install_head_changed, before it is marked ready", async () => {
      const r = await rig();
      const { fake, repo, port } = github();
      // the branch moves after the step read it and before GitHub shows the pull request
      fake.before = (req) => {
        if (req.method === "GET" && req.path.endsWith("/pulls")) {
          repo.branches.get(BRANCH)!.oid = "d".repeat(40);
          fake.before = null;
        }
      };
      expect(await completeSetupInstall({ pool: h.opsPool, port }, await claimOf(r))).toBe("failed");
      expect(repo.pulls[0]).toMatchObject({ state: "closed" });
      expect(fake.calls.some((c) => c.label === "A1 MarkReady")).toBe(false);
      expect(await setup(r.setupId)).toMatchObject({ phase: "install", state: "failed", failure_code: "install_head_changed", install_pr: null });
      expect(await jobState(r.jobId)).toBe("failed");
    });

    it("a pull request that carries no head commit is treated as a moved head (fail closed)", async () => {
      const r = await rig();
      const { fake, repo, port } = github();
      const real = port.openDraft;
      const noHead = { ...port, openDraft: async (i: Parameters<typeof real>[0]) => ({ ...(await real(i)), headSha: undefined }) };
      expect(await completeSetupInstall({ pool: h.opsPool, port: noHead }, await claimOf(r))).toBe("failed");
      expect(repo.pulls[0]).toMatchObject({ state: "closed" });
      expect(fake.calls.some((c) => c.label === "A1 MarkReady")).toBe(false);
      expect(await setup(r.setupId)).toMatchObject({ failure_code: "install_head_changed" });
    });

    it("records a refused call as a failure (pr_open_failed) and does not throw; the lease is released by the failure, not left to lapse", async () => {
      const r = await rig();
      const { port } = github();
      const refusing = { ...port, ensureLabels: async () => { throw new LocalOnlyGithubError("not_allowlisted"); } };
      expect(await completeSetupInstall({ pool: h.opsPool, port: refusing }, await claimOf(r))).toBe("failed");
      expect(await setup(r.setupId)).toMatchObject({ phase: "install", state: "failed", failure_code: "pr_open_failed" });
      expect(await jobState(r.jobId)).toBe("failed");
      // any other error still throws (a bug is not a failure to record)
      const r2 = await rig();
      const broken = { ...port, ensureLabels: async () => { throw new TypeError("boom"); } };
      await expect(completeSetupInstall({ pool: h.opsPool, port: broken }, await claimOf(r2))).rejects.toThrow("boom");
    });
  });

  describe("the watch on the install pull request", () => {
    const closed = (r: Rig, pr: number, merged: boolean, ref: string = BRANCH, repoId: string = r.who.repoId, accountId: string = r.who.accountId, userId: string = r.who.userId) =>
      withTenant(h.appPool, accountId, userId, async (c) => (await c.query<{ r: string }>("SELECT setup_install_pr_closed($1::uuid, $2::int, $3::boolean, $4) AS r", [repoId, pr, merged, ref])).rows[0]!.r);

    async function opened(): Promise<{ r: Rig; pr: number }> {
      const r = await rig();
      const { repo, port } = github();
      expect(await completeSetupInstall({ pool: h.opsPool, port }, await claimOf(r))).toBe("opened");
      return { r, pr: repo.pulls[0]!.number };
    }

    it("a merged pull request moves the setup to finish (and the number stays); a repeat changes nothing", async () => {
      const { r, pr } = await opened();
      expect(await closed(r, pr, true)).toBe("finished");
      expect(await setup(r.setupId)).toMatchObject({ phase: "finish", sub_step: "pr_merged", state: "ok", failure_code: null, install_pr: pr });
      expect(await closed(r, pr, true)).toBe("none");
    });

    it("a pull request closed unmerged fails the setup pr_closed at await_merge; a repeat changes nothing; a later merge of the reopened one finishes it", async () => {
      const { r, pr } = await opened();
      expect(await closed(r, pr, false)).toBe("failed");
      expect(await setup(r.setupId)).toMatchObject({ phase: "await_merge", state: "failed", failure_code: "pr_closed", install_pr: pr });
      const first = (await h.admin.query<{ failure_at: Date }>("SELECT failure_at FROM project_setups WHERE id = $1", [r.setupId])).rows[0]!.failure_at;
      expect(await closed(r, pr, false)).toBe("failed");
      expect((await h.admin.query<{ failure_at: Date }>("SELECT failure_at FROM project_setups WHERE id = $1", [r.setupId])).rows[0]!.failure_at).toEqual(first);
      expect(await closed(r, pr, true)).toBe("finished");
      expect(await setup(r.setupId)).toMatchObject({ phase: "finish", state: "ok", failure_code: null, install_pr: pr });
    });

    it("moves nothing for another number, another branch, another repository of the same account, another account, or a session with no account", async () => {
      const { r, pr } = await opened();
      const otherRepo = (await h.admin.query<{ id: string }>("INSERT INTO repos (account_id, installation_id, gh_repo_id, product) SELECT account_id, installation_id, gh_repo_id + 1, 'team' FROM repos WHERE id = $1 RETURNING id", [r.who.repoId])).rows[0]!.id;
      const stranger = await seedAccount(h.admin, randomUUID());
      expect(await closed(r, pr + 1, true)).toBe("none");
      expect(await closed(r, pr, true, "fx/engine-install-9.9.9")).toBe("none");
      expect(await closed(r, pr, true, "fx/engine-install-1.2")).toBe("none");
      expect(await closed(r, pr, true, "main")).toBe("none");
      expect(await closed(r, pr, true, BRANCH, otherRepo)).toBe("none");
      expect(await closed(r, pr, true, BRANCH, r.who.repoId, stranger.accountId, stranger.userId)).toBe("none");
      expect((await h.appPool.query<{ r: string }>("SELECT setup_install_pr_closed($1::uuid, $2::int, true, $3) AS r", [r.who.repoId, pr, BRANCH])).rows[0]!.r).toBe("none");
      expect(await setup(r.setupId)).toMatchObject({ phase: "await_merge", state: "ok", install_pr: pr });
    });

    it("only the app login can call it: the platform_ops login is refused, and it is not callable by PUBLIC", async () => {
      const { r, pr } = await opened();
      await expect(h.opsPool.query("SELECT setup_install_pr_closed($1::uuid, $2::int, true, $3)", [r.who.repoId, pr, BRANCH])).rejects.toThrow();
      const acl = (await h.admin.query<{ acl: string | null }>("SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'setup_install_pr_closed'")).rows[0]!.acl ?? "";
      expect(acl).not.toMatch(/(^|,|\{)=X/);
    });

    it("a close or merge between markReady and the record of the number is not lost: the record applies it", async () => {
      for (const merged of [true, false]) {
        const r = await rig();
        const { repo, port } = github();
        const racing = { ...port, markReady: async (i: Parameters<typeof port.markReady>[0]) => {
          await port.markReady(i);
          // the delivery lands here: the setup has no number yet, so it is kept for the record
          expect(await closed(r, i.pullRequest.number, merged)).toBe("recorded");
        } };
        expect(await completeSetupInstall({ pool: h.opsPool, port: racing }, await claimOf(r))).toBe("opened");
        const pr = repo.pulls[0]!.number;
        expect(await setup(r.setupId)).toMatchObject(merged ? { phase: "finish", sub_step: "pr_merged", state: "ok", failure_code: null, install_pr: pr } : { phase: "await_merge", state: "failed", failure_code: "pr_closed", install_pr: pr });
        expect(await jobState(r.jobId)).toBe("done");
        expect(await claimSetupInstall(h.opsPool)).toBeNull();
      }
    });

    it("a delivery kept for one number never settles another: the pull request the step closed itself leaves a later one at await_merge", async () => {
      const r = await rig();
      const c = await claimOf(r);
      // a delivery for number 7 arrives while the setup has none; the step then records 8
      expect(await closed(r, 7, true)).toBe("recorded");
      expect((await h.opsPool.query("SELECT setup_install_pr_record($1::uuid, $2::int, $3, 8) AS ok", [r.setupId, c.attempt, HEAD])).rows[0].ok).toBe(true);
      expect(await setup(r.setupId)).toMatchObject({ phase: "await_merge", state: "ok", install_pr: 8 });
    });

    it("a setup whose own job has another branch, or none delivered, keeps nothing", async () => {
      const r = await rig();
      expect(await closed(r, 5, true, "fx/engine-install-2.0.0")).toBe("none");
      await h.admin.query("UPDATE machine_jobs SET state = 'expired' WHERE id = $1", [r.jobId]);
      expect(await closed(r, 5, true)).toBe("none");
      expect((await h.admin.query("SELECT install_pr_closed_number FROM project_setups WHERE id = $1", [r.setupId])).rows[0].install_pr_closed_number).toBeNull();
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
