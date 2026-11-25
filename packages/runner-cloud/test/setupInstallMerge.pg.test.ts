import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MACHINE_JOB_CLAIM_PATH, setupProgressPath } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { classTwo, presetDisposition } from "@fx/db/src/dialPreset.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { HELLO_PATH, machineJobClaimRun, runnerHello, setupProgressRun } from "../src/index.js";
import { installMergeRun, installSummaryRun } from "../src/setupInstallMerge.js";
import { claimSetupInstall, completeSetupInstall, type SetupInstallClaim } from "../src/setupInstallPr.js";
import { createRunPullRequestPort, type SetupInstallPort } from "../src/runPullRequest.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";
import { issueTestJob } from "./helpers/machineJobIssuer.js";
import { FAKE_APP_LOGIN, FakeGithub, openInstallationKinds, type FakeRepo } from "./helpers/githubFake.js";

const BASE = "a".repeat(40);
const HEAD = "c".repeat(40);
const BRANCH = "fx/engine-install-1.2.3";
const FILES = [
  { path: "docs/PRD.md", changeType: "ADDED", additions: 30, deletions: 0 },
  { path: ".autonomous-team/roadmap.json", changeType: "ADDED", additions: 20, deletions: 0 },
  { path: "epics/01-a.md", changeType: "ADDED", additions: 5, deletions: 0 },
  { path: "epics/02-b.md", changeType: "ADDED", additions: 5, deletions: 0 },
  { path: "hooks/sandbox.py", changeType: "ADDED", additions: 50, deletions: 0 },
  { path: ".claude/agents/executor.md", changeType: "ADDED", additions: 40, deletions: 0 },
  { path: ".claude/commands/start-the-day.md", changeType: "ADDED", additions: 10, deletions: 0 },
  { path: "scripts/start.sh", changeType: "ADDED", additions: 100, deletions: 0 },
  { path: ".autonomous-team/project.json", changeType: "ADDED", additions: 8, deletions: 0 },
  { path: "CLAUDE.md", changeType: "MODIFIED", additions: 5, deletions: 2 },
  { path: "package.json", changeType: "MODIFIED", additions: 1, deletions: 1 },
];

/**
 * [pg] D#845 ON-20a: the install summary and "Merge and continue". The cloud side is real (row security forced, the definers of migrations 1072, 1073 and 1088, the audit function); the GitHub side is the real
 * run port over the strict fake of GitHub (its own table, written without the production allowlist; the merge goes through the `merge_gate` kind's path rule). What the fake cannot do: GitHub's own branch
 * protection and required-review rules (a 405 is injected as `mergeBlocked`), and its rate limits.
 */
describe("the install summary and merge [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.admin.query("UPDATE project_setups SET updated_at = now() - interval '7 hours'");
  });

  interface Rig { who: SeedRefs; setupId: string; fake: FakeGithub; repo: FakeRepo; port: SetupInstallPort; number: number; runner: { key: TestKey; id: string }; names: string[] }
  /** A machine's install taken all the way through the real steps (job, push report, the install pull request step) to `await_merge`. */
  async function rig(o: { files?: typeof FILES; who?: SeedRefs; fake?: FakeGithub; name?: string; runner?: Rig["runner"]; repoId?: string } = {}): Promise<Rig> {
    const who = o.who ?? (await seedAccount(h.admin, randomUUID()));
    const name = o.name ?? "widgets";
    const repoId = o.repoId ?? who.repoId;
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = $2 WHERE id = $1", [repoId, name]);
    let runner = o.runner;
    if (runner === undefined) {
      const key = newKey();
      runner = { key, id: await registerKey(h.admin, who.accountId, who.userId, key) };
      const hello = await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, { protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: ["project_setup_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" } })));
      expect(hello.status).toBe(200);
    }
    const { key, id: runnerId } = runner;
    const setupId = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase, engine_version) VALUES ($1, $2, 'existing', $3, 'install', '1.2.3') RETURNING id", [who.accountId, repoId, who.userId])).rows[0]!.id;
    const issued = await issueTestJob(h.appPool, h.admin, { accountId: who.accountId, userId: who.userId, runnerId, repoId, setupId, args: { base_sha: BASE } });
    expect((await respond(() => machineJobClaimRun(h.deps(), signed(key, MACHINE_JOB_CLAIM_PATH, {})))).status).toBe(200);
    let seq = 0;
    const report = (body: Record<string, unknown>) => respond(() => setupProgressRun(h.deps(), signed(key, setupProgressPath(setupId), { job_id: issued.id, seq: seq++, ...body }), setupId));
    expect((await report({ sub_step: "push", state: "started" })).status).toBe(200);
    expect((await report({ sub_step: "push", state: "ok", head_sha: HEAD })).status).toBe(200);
    const fake = o.fake ?? new FakeGithub();
    const repo = fake.addRepo("acme", name, { id: o.fake === undefined ? 1234567 : 7654321 });
    fake.pushBranch(repo, BRANCH, { oid: HEAD, files: [...(o.files ?? FILES)] });
    repo.commits.set(HEAD, [BASE]);
    // the port, with the name of every method that is called on it kept
    const real = createRunPullRequestPort({ open: openInstallationKinds(fake), appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
    const names: string[] = [];
    const port = new Proxy(real, { get: (t, k) => (typeof t[k as keyof SetupInstallPort] === "function" ? (...a: unknown[]) => (names.push(String(k)), (t[k as keyof SetupInstallPort] as (...x: unknown[]) => unknown)(...a)) : t[k as keyof SetupInstallPort]) });
    const claim = (await claimSetupInstall(h.opsPool)) as SetupInstallClaim;
    expect(claim.setupId).toBe(setupId);
    expect(await completeSetupInstall({ pool: h.opsPool, port }, claim)).toBe("opened");
    const number = repo.pulls.find((p) => p.head === BRANCH)!.number;
    return { who, setupId, fake, repo, port, number, runner, names };
  }
  const depsFor = (r: Rig, over: Record<string, unknown> = {}) => h.deps({ setupInstall: r.port, ...over });
  const as = (r: Rig, userId = r.who.userId) => ({ accountId: r.who.accountId, userId });
  const refusal = async (p: Promise<unknown>) => p.then(() => ({ status: 0, code: "none" }), (e: { status: number; code: string }) => ({ status: e.status, code: e.code }));
  const person = async (accountId: string, role: "owner" | "admin" | "member") => {
    const id = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, id, role]);
    return id;
  };
  const audit = async (accountId: string) => (await h.admin.query<{ actor: string; payload: Record<string, unknown> }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'project.install_merged'", [accountId])).rows;
  const merges = (r: Rig) => r.fake.calls.filter((c) => c.label === "A10").length;
  const setup = async (id: string) => (await h.admin.query("SELECT phase, sub_step, state, install_pr FROM project_setups WHERE id = $1", [id])).rows[0];

  describe("the summary", () => {
    it("counts the pull request's files by fixed category, with lines added and deleted, for any member, and reads only", async () => {
      const r = await rig();
      const member = await person(r.who.accountId, "member");
      const res = await installSummaryRun(depsFor(r), as(r, member), r.setupId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        setup_id: r.setupId, pr_number: r.number, head_sha: HEAD, merged: false, pr_url: `https://github.com/acme/widgets/pull/${r.number}`,
        totals: { files: 11, added_files: 9, changed_files: 2, additions: 274, deletions: 3 },
        categories: [
          { id: "plan", label: "Your project plan (`docs/PRD.md`, roadmap, 2 epics)", files: 4, added_files: 4, changed_files: 0, additions: 60, deletions: 0 },
          { id: "team", label: "The team's settings (`.autonomous-team/`)", files: 1, added_files: 1, changed_files: 0, additions: 8, deletions: 0 },
          { id: "scripts", label: "1 helper scripts (`scripts/`)", files: 1, added_files: 1, changed_files: 0, additions: 100, deletions: 0 },
          { id: "agents", label: "The agents' instructions (`CLAUDE.md`, `.claude/`)", files: 3, added_files: 2, changed_files: 1, additions: 55, deletions: 2 },
          { id: "hook", label: "The sandbox hook", files: 1, added_files: 1, changed_files: 0, additions: 50, deletions: 0 },
          { id: "other", label: "1 other files", files: 1, added_files: 0, changed_files: 1, additions: 1, deletions: 1 },
        ],
        paths: [".autonomous-team/project.json", ".autonomous-team/roadmap.json", ".claude/agents/executor.md", ".claude/commands/start-the-day.md", "CLAUDE.md", "docs/PRD.md", "epics/01-a.md", "epics/02-b.md", "hooks/sandbox.py", "package.json", "scripts/start.sh"],
      });
      expect(r.fake.calls.map((c) => c.label).slice(-2)).toEqual(["A1 InstallPullRequest", "A1 CommitParents"]);
      expect(merges(r)).toBe(0);
      expect(r.fake.denied).toBe(0);
    });

    it("is refused for another account's setup, a setup with no pull request, a name that is no id, and while GitHub cannot be asked", async () => {
      const r = await rig();
      const other = await rig();
      expect(await refusal(installSummaryRun(depsFor(r), as(other), r.setupId))).toEqual({ status: 404, code: "not_found" });
      expect(await refusal(installSummaryRun(depsFor(r), as(r), "not-an-id"))).toEqual({ status: 404, code: "not_found" });
      expect(await refusal(installSummaryRun(h.deps(), as(r), r.setupId))).toEqual({ status: 503, code: "not_configured" });
      const elsewhere = (await h.admin.query<{ id: string }>("INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, 3, 'team') RETURNING id", [r.who.accountId, r.who.installationId])).rows[0]!.id;
      const fresh = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, 'existing', $3, 'plan') RETURNING id", [r.who.accountId, elsewhere, r.who.userId])).rows[0]!.id;
      expect(await refusal(installSummaryRun(depsFor(r), as(r), fresh))).toEqual({ status: 409, code: "setup_phase" });
      r.fake.inject = { label: /A1 InstallPullRequest/, reply: { status: 502, body: {} } };
      expect(await refusal(installSummaryRun(depsFor(r), as(r), r.setupId))).toEqual({ status: 503, code: "github_unavailable" });
    });
  });

  describe("the merge", () => {
    it("an owner's click merges at exactly the pushed commit and writes who, which setup, which pull request and which commit, in the same transaction", async () => {
      const r = await rig();
      const res = await installMergeRun(depsFor(r), as(r), r.setupId);
      expect(res).toMatchObject({ status: 200, body: { setup_id: r.setupId, pr_number: r.number, merged: true, already: false } });
      expect(r.repo.pulls[0]).toMatchObject({ state: "closed", merged: true });
      expect(merges(r)).toBe(1);
      expect(r.fake.denied).toBe(0);
      expect(await audit(r.who.accountId)).toEqual([{ actor: r.who.userId, payload: { actor: r.who.userId, setup_id: r.setupId, pr_number: r.number, head_sha: HEAD } }]);
    });

    it("an admin may merge; a member may not, and then nothing is asked of GitHub's merge and nothing is written", async () => {
      const r = await rig();
      const member = await person(r.who.accountId, "member");
      expect(await refusal(installMergeRun(depsFor(r), as(r, member), r.setupId))).toEqual({ status: 403, code: "forbidden" });
      expect(merges(r)).toBe(0);
      expect(r.repo.pulls[0]).toMatchObject({ state: "open" });
      expect(await audit(r.who.accountId)).toEqual([]);
      const admin = await person(r.who.accountId, "admin");
      expect((await installMergeRun(depsFor(r), as(r, admin), r.setupId)).status).toBe(200);
      expect((await audit(r.who.accountId))[0]!.actor).toBe(admin);
    });

    it("a second click is the same answer and does nothing more: no second merge call and no second audit row; a merge a person made on GitHub counts the same", async () => {
      const r = await rig();
      await installMergeRun(depsFor(r), as(r), r.setupId);
      expect(await installMergeRun(depsFor(r), as(r), r.setupId)).toMatchObject({ status: 200, body: { merged: true, already: true } });
      expect(merges(r)).toBe(1);
      expect(await audit(r.who.accountId)).toHaveLength(1);
      const byHand = await rig();
      byHand.repo.pulls[0]!.state = "closed";
      byHand.repo.pulls[0]!.merged = true;
      byHand.repo.pulls[0]!.mergedBy = { login: "octocat", type: "User" };
      expect(await installMergeRun(depsFor(byHand), as(byHand), byHand.setupId)).toMatchObject({ status: 200, body: { already: true } });
      expect(merges(byHand)).toBe(0);
      expect(await audit(byHand.who.accountId)).toEqual([]);
    });

    /** The merge GitHub made whose answer was lost: the next click records it, once, for the person who clicked. */
    it("a merge GitHub made whose answer was lost is recorded by the next click, exactly once, whatever step the setup is at", async () => {
      const lost = await rig();
      lost.fake.loseReply = /A10/;
      expect(await refusal(installMergeRun(depsFor(lost), as(lost), lost.setupId))).toEqual({ status: 503, code: "github_unavailable" });
      expect(lost.repo.pulls[0]).toMatchObject({ merged: true });
      expect(await audit(lost.who.accountId)).toEqual([]);
      const admin = await person(lost.who.accountId, "admin");
      expect(await installMergeRun(depsFor(lost), as(lost, admin), lost.setupId)).toMatchObject({ status: 200, body: { already: true } });
      expect(await audit(lost.who.accountId)).toEqual([{ actor: admin, payload: { actor: admin, setup_id: lost.setupId, pr_number: lost.number, head_sha: HEAD } }]);
      // a further click writes nothing, and asks GitHub nothing
      const before = lost.fake.calls.length;
      expect(await installMergeRun(depsFor(lost), as(lost), lost.setupId)).toMatchObject({ body: { already: true } });
      expect(await audit(lost.who.accountId)).toHaveLength(1);
      expect(lost.fake.calls.length).toBe(before);
      // the same when the watch has already moved the setup to finish
      const later = await rig();
      later.fake.loseReply = /A10/;
      await refusal(installMergeRun(depsFor(later), as(later), later.setupId));
      await h.admin.query("UPDATE project_setups SET phase = 'finish', sub_step = 'pr_merged' WHERE id = $1", [later.setupId]);
      expect(await installMergeRun(depsFor(later), as(later), later.setupId)).toMatchObject({ status: 200, body: { already: true } });
      expect(await audit(later.who.accountId)).toEqual([{ actor: later.who.userId, payload: { actor: later.who.userId, setup_id: later.setupId, pr_number: later.number, head_sha: HEAD } }]);
      expect(await installMergeRun(depsFor(later), as(later), later.setupId)).toMatchObject({ body: { already: true } });
      expect(await audit(later.who.accountId)).toHaveLength(1);
    });

    it("a merge a person made on GitHub is recorded as nobody's click, at either step; so is a merge with no merger on record", async () => {
      for (const mergedBy of [{ login: "octocat", type: "User" as const }, { login: "someone-elses-app", type: "Bot" as const }, undefined]) {
        const hand = await rig();
        hand.repo.pulls[0]!.state = "closed";
        hand.repo.pulls[0]!.merged = true;
        if (mergedBy !== undefined) hand.repo.pulls[0]!.mergedBy = mergedBy;
        expect((await installMergeRun(depsFor(hand), as(hand), hand.setupId)).body).toMatchObject({ already: true });
        await h.admin.query("UPDATE project_setups SET phase = 'finish', sub_step = 'pr_merged' WHERE id = $1", [hand.setupId]);
        expect((await installMergeRun(depsFor(hand), as(hand), hand.setupId)).body).toMatchObject({ already: true });
        expect(await audit(hand.who.accountId)).toEqual([]);
      }
      // a finish whose pull request is not merged (a direct-mode-like or odd row) records nothing either
      const open = await rig();
      await h.admin.query("UPDATE project_setups SET phase = 'finish', sub_step = 'pr_merged' WHERE id = $1", [open.setupId]);
      expect((await installMergeRun(depsFor(open), as(open), open.setupId)).body).toMatchObject({ already: true });
      expect(await audit(open.who.accountId)).toEqual([]);
    });

    it("two clicks at once merge once", async () => {
      const r = await rig();
      const results = await Promise.all([refusal(installMergeRun(depsFor(r), as(r), r.setupId)), refusal(installMergeRun(depsFor(r), as(r), r.setupId))]);
      expect(results.map((x) => x.status)).toEqual([0, 0]);
      expect(merges(r)).toBe(1);
      expect(await audit(r.who.accountId)).toHaveLength(1);
    });

    it("a head somebody pushed to since the runner's push is 409 install_pr_changed (the UI rebuilds the summary on it), in the merge and in the summary: no merge, no audit", async () => {
      const moved = await rig();
      moved.repo.branches.get(BRANCH)!.oid = "d".repeat(40);
      expect(await refusal(installMergeRun(depsFor(moved), as(moved), moved.setupId))).toEqual({ status: 409, code: "install_pr_changed" });
      expect(await refusal(installSummaryRun(depsFor(moved), as(moved), moved.setupId))).toEqual({ status: 409, code: "install_pr_changed" });
      expect(merges(moved)).toBe(0);
      expect(await audit(moved.who.accountId)).toEqual([]);
    });

    it("refuses a pull request whose commit sits on another parent, whose list is not whole or holds a workflow file: 409 install_pr_files_differ, no merge, no audit", async () => {
      const parent = await rig();
      parent.repo.commits.set(HEAD, ["e".repeat(40)]);
      const twoParents = await rig();
      twoParents.repo.commits.set(HEAD, [BASE, "e".repeat(40)]);
      const workflow = await rig();
      workflow.repo.branches.get(BRANCH)!.files.push({ path: ".github/workflows/ci.yml", changeType: "ADDED" });
      const partial = await rig();
      partial.fake.inject = { label: /A1 InstallPullRequest/, reply: { status: 200, body: { data: { repository: { pullRequest: { number: partial.number, state: "OPEN", merged: false, headRefOid: HEAD, files: { totalCount: 9, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ path: "a", changeType: "ADDED", additions: 1, deletions: 0 }] } } } } } } };
      for (const r of [parent, twoParents, workflow, partial]) {
        expect(await refusal(installMergeRun(depsFor(r), as(r), r.setupId))).toEqual({ status: 409, code: "install_pr_files_differ" });
        expect(merges(r)).toBe(0);
        expect(await audit(r.who.accountId)).toEqual([]);
      }
      expect(await refusal(installSummaryRun(depsFor(parent), as(parent), parent.setupId))).toEqual({ status: 409, code: "install_pr_files_differ" });
    });

    it("refuses a pull request somebody closed, and one GitHub moved between our read and the merge (409 install_pr_changed, and the audit row goes with it)", async () => {
      const closed = await rig();
      closed.repo.pulls[0]!.state = "closed";
      expect(await refusal(installMergeRun(depsFor(closed), as(closed), closed.setupId))).toEqual({ status: 409, code: "install_pr_changed" });
      const raced = await rig();
      raced.fake.before = (req) => {
        if (req.method === "PUT") raced.repo.branches.get(BRANCH)!.oid = "d".repeat(40);
      };
      expect(await refusal(installMergeRun(depsFor(raced), as(raced), raced.setupId))).toEqual({ status: 409, code: "install_pr_changed" });
      expect(await audit(raced.who.accountId)).toEqual([]);
      expect(raced.repo.pulls[0]).toMatchObject({ state: "open" });
    });

    it("a required check or review that is not met is 409 install_pr_blocked, the audit row rolled back, and a later click merges", async () => {
      const r = await rig();
      r.repo.mergeBlocked = true;
      expect(await refusal(installMergeRun(depsFor(r), as(r), r.setupId))).toEqual({ status: 409, code: "install_pr_blocked" });
      expect(await audit(r.who.accountId)).toEqual([]);
      r.repo.mergeBlocked = false;
      expect((await installMergeRun(depsFor(r), as(r), r.setupId)).status).toBe(200);
      expect(await audit(r.who.accountId)).toHaveLength(1);
    });

    it("a setup at another step, a failed one and a name that is no id are refused; another account's setup is 404 and GitHub is never asked", async () => {
      const r = await rig();
      const other = await rig();
      const before = r.fake.calls.length;
      expect(await refusal(installMergeRun(depsFor(r), as(other), r.setupId))).toEqual({ status: 404, code: "not_found" });
      expect(r.fake.calls.length).toBe(before);
      expect(await refusal(installMergeRun(depsFor(r), as(r), "nope"))).toEqual({ status: 404, code: "not_found" });
      await h.admin.query("UPDATE project_setups SET state = 'failed', failure_code = 'pr_closed', failure_at = now() WHERE id = $1", [r.setupId]);
      expect(await refusal(installMergeRun(depsFor(r), as(r), r.setupId))).toEqual({ status: 409, code: "install_pr_changed" });
      await h.admin.query("UPDATE project_setups SET phase = 'install', state = 'started' WHERE id = $1", [r.setupId]);
      expect(await refusal(installMergeRun(depsFor(r), as(r), r.setupId))).toEqual({ status: 409, code: "setup_phase" });
      expect(merges(r)).toBe(0);
    });

    it("answers for ITS repository only: the same account's second repository, with its own install pull request, is never touched", async () => {
      const a = await rig();
      const second = (await h.admin.query<{ id: string }>("INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, 2, 'team') RETURNING id", [a.who.accountId, a.who.installationId])).rows[0]!.id;
      const b = await rig({ who: a.who, fake: a.fake, name: "gadgets", repoId: second, runner: a.runner });
      expect(b.repo).not.toBe(a.repo);
      const numberA = a.repo.pulls[0]!.number;
      const numberB = b.repo.pulls[0]!.number;
      expect(numberA).not.toBe(numberB);
      expect((await installMergeRun(depsFor(a), as(a), a.setupId)).body).toMatchObject({ pr_number: numberA });
      expect(a.repo.pulls[0]).toMatchObject({ merged: true });
      expect(b.repo.pulls[0]).toMatchObject({ state: "open" });
      expect(await setup(b.setupId)).toMatchObject({ phase: "await_merge", install_pr: numberB });
      expect((await audit(a.who.accountId)).map((x) => x.payload.pr_number)).toEqual([numberA]);
      const summary = await installSummaryRun(depsFor(b), as(b), b.setupId);
      expect(summary.body).toMatchObject({ setup_id: b.setupId, pr_number: numberB, pr_url: `https://github.com/acme/gadgets/pull/${numberB}` });
    });

    it("reads nothing across accounts even through the row-security-free login: a foreign account id finds no setup, and the definer answers it no base", async () => {
      const victim = await rig();
      const stranger = await seedAccount(h.admin, randomUUID());
      const before = victim.fake.calls.length;
      expect(await refusal(installMergeRun(depsFor(victim, { appUserPool: h.adminPool }), { accountId: stranger.accountId, userId: stranger.userId }, victim.setupId))).toEqual({ status: 404, code: "not_found" });
      expect(await refusal(installSummaryRun(depsFor(victim, { appUserPool: h.adminPool }), { accountId: stranger.accountId, userId: stranger.userId }, victim.setupId))).toEqual({ status: 404, code: "not_found" });
      expect(victim.fake.calls.length).toBe(before);
      const base = await withTenant(h.appPool, stranger.accountId, stranger.userId, async (c) => (await c.query<{ b: string | null }>("SELECT setup_install_base($1) AS b", [victim.setupId])).rows[0]!.b);
      expect(base).toBeNull();
      const own = await withTenant(h.appPool, victim.who.accountId, victim.who.userId, async (c) => (await c.query<{ b: string | null }>("SELECT setup_install_base($1) AS b", [victim.setupId])).rows[0]!.b);
      expect(own).toBe(BASE);
    });
  });

  /** Ruling 95: the install pull request never merges by itself under any preset; only a person's click does, and the click is recorded. */
  describe.each(["cautious", "balanced", "autonomous"] as const)("under the %s preset", (preset) => {
    async function setPreset(r: Rig) {
      for (const entry of classTwo()) {
        await h.admin.query(
          "INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, $3, $4, $5, 1, $6) ON CONFLICT DO NOTHING",
          [r.who.accountId, r.who.repoId, entry.id, presetDisposition(entry, preset), preset, r.who.userId],
        );
      }
    }

    it("nothing merges the pull request without the click: the install step, the watch and a repeat of the step leave it open", async () => {
      const r = await rig();
      await setPreset(r);
      // the real install step ran (it opened and published the pull request) and called these port methods, merge not among them; nothing is due now, so no pass of the reconcile job would call any
      expect(r.names).toContain("markReady");
      expect(r.names).not.toContain("mergeInstall");
      expect(await claimSetupInstall(h.opsPool)).toBeNull();
      expect(merges(r)).toBe(0);
      expect(r.repo.pulls[0]).toMatchObject({ state: "open" });
      expect(await setup(r.setupId)).toMatchObject({ phase: "await_merge", state: "ok" });
      expect(await audit(r.who.accountId)).toEqual([]);
    });

    it("an owner's click merges and records it; a member's, and a click on a setup of another account, do not", async () => {
      const r = await rig();
      await setPreset(r);
      const member = await person(r.who.accountId, "member");
      expect(await refusal(installMergeRun(depsFor(r), as(r, member), r.setupId))).toEqual({ status: 403, code: "forbidden" });
      expect(merges(r)).toBe(0);
      expect((await installMergeRun(depsFor(r), as(r), r.setupId)).status).toBe(200);
      expect(r.repo.pulls[0]).toMatchObject({ merged: true });
      expect((await audit(r.who.accountId))[0]).toMatchObject({ actor: r.who.userId, payload: { setup_id: r.setupId, pr_number: r.number, head_sha: HEAD } });
    });
  });
});
