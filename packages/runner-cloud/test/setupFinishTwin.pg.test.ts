import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { claimSetupFinish, completeSetupFinish, type SetupFinishClaim } from "../src/setupFinish.js";
import { createRunPullRequestPort } from "../src/runPullRequest.js";
import { harness, type Harness } from "./helpers.js";
import { FAKE_APP_LOGIN, FakeGithub, openInstallationKinds, type FakeChangeType, type FakeRepo } from "./helpers/githubFake.js";

const HEAD = "c".repeat(40);
const BRANCH = "fx/engine-install-1.2.3";
const PR = 7;
const FILES: Array<{ path: string; changeType: FakeChangeType }> = [
  { path: "docs/PRD.md", changeType: "ADDED" },
  { path: ".autonomous-team/roadmap.json", changeType: "ADDED" },
  { path: "scripts/start.sh", changeType: "ADDED" },
  { path: "CLAUDE.md", changeType: "MODIFIED" },
  { path: "package.json", changeType: "MODIFIED" },
  { path: "old/name.md", changeType: "RENAMED" },
  { path: "gone.md", changeType: "DELETED" },
];
const ADDED = ["docs/PRD.md", ".autonomous-team/roadmap.json", "scripts/start.sh"].sort();

/**
 * [pg] D#845 FU-289/FU-292 (Ruling 109): a private twin's install files are recorded when its install pull request merges. The cloud side is the real platform_ops login through the real definers (migrations 1085 and 1107)
 * with row security forced; the GitHub side is the real finish port behind the real fence, over a strict fake of GitHub. The fake cannot show GitHub's own wording or a file list past its page limit.
 */
describe("a private twin's install files at the finish [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());
  // setups other tests of this database left at finish are parked, so a claim here is always this test's own
  beforeEach(async () => {
    await h.admin.query("UPDATE project_setups SET phase = 'done' WHERE phase = 'finish'");
  });

  interface Rig { who: SeedRefs; setupId: string; privateRepoId: string; publicRepoId: string; twinId: string; fake: FakeGithub; repo: FakeRepo; port: ReturnType<typeof createRunPullRequestPort> }
  async function repoFor(who: SeedRefs, name: string, n: number): Promise<string> {
    const repoId = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, gh_repo_id + $4, product, 'acme', $3 FROM repos WHERE id = $2", [repoId, who.repoId, name, n]);
    return repoId;
  }
  async function twinOn(who: SeedRefs, publicRepoId: string, privateRepoId: string | null, o: { state?: string; paths?: string[]; n?: number } = {}): Promise<string> {
    const state = o.state ?? "ready";
    return (await h.admin.query<{ id: string }>(
      "INSERT INTO repo_twins (account_id, public_repo_id, private_repo_id, private_name, state, install_paths, removed_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'removed' THEN now() END, $7) RETURNING id",
      [who.accountId, publicRepoId, privateRepoId, `twin-${randomUUID().slice(0, 8)}`, state, o.paths ?? [], who.userId],
    )).rows[0]!.id;
  }
  async function rig(o: { twin?: "live" | "removed" | "none"; paths?: string[]; files?: Array<{ path: string; changeType: FakeChangeType }>; phase?: string; setupOn?: "public" } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets-public' WHERE id = $1", [who.repoId]);
    const privateRepoId = await repoFor(who, "widgets", 11);
    const mode = o.twin ?? "live";
    const twinId = mode === "none" ? randomUUID() : await twinOn(who, who.repoId, privateRepoId, { state: mode === "removed" ? "removed" : "ready", paths: o.paths ?? [] });
    const setupId = (await h.admin.query<{ id: string }>(
      "INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase, state, sub_step, engine_version, install_pr, install_head_sha) VALUES ($1, $2, 'existing', $3, $4, 'ok', 'pr_merged', '1.2.3', $5, $6) RETURNING id",
      [who.accountId, o.setupOn === "public" ? who.repoId : privateRepoId, who.userId, o.phase ?? "finish", PR, HEAD],
    )).rows[0]!.id;
    // an approved plan with no kept rows: the finish has nothing to seed, so only the twin step and the team log are in play
    await h.admin.query("INSERT INTO project_drafts (account_id, repo_id, setup_id, source, roadmap, version, status, approved_by, approved_at, final_at) VALUES ($1, $2, $3, 'survey', '[]'::jsonb, 1, 'approved', $4, now(), now())", [who.accountId, o.setupOn === "public" ? who.repoId : privateRepoId, setupId, who.userId]);
    const fake = new FakeGithub();
    const repo = fake.addRepo("acme", "widgets");
    fake.pushBranch(repo, BRANCH, { oid: HEAD, files: (o.files ?? FILES).map((f) => ({ ...f })) });
    repo.pulls.push({ number: PR, nodeId: "PR_node", head: BRANCH, base: "main", state: "closed", draft: false, title: "Add the engine", body: "", author: { login: FAKE_APP_LOGIN, type: "Bot" }, merged: true, mergedBy: { login: "octocat", type: "User" } });
    const port = createRunPullRequestPort({ open: openInstallationKinds(fake), appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
    return { who, setupId, privateRepoId, publicRepoId: who.repoId, twinId, fake, repo, port };
  }
  const claimOf = async (r: Rig): Promise<SetupFinishClaim> => {
    const c = await claimSetupFinish(h.opsPool);
    if (c === null || c === "malformed") throw new Error(`no claim for ${r.setupId}`);
    expect(c.setupId).toBe(r.setupId);
    return c;
  };
  const paths = async (twinId: string) => (await h.admin.query<{ install_paths: string[] }>("SELECT install_paths FROM repo_twins WHERE id = $1", [twinId])).rows[0]!.install_paths;
  const audits = async (accountId: string) => (await h.admin.query<{ actor: string; payload: Record<string, unknown> }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'twin.install_paths_added'", [accountId])).rows;
  const phase = async (id: string) => (await h.admin.query<{ phase: string }>("SELECT phase FROM project_setups WHERE id = $1", [id])).rows[0]!.phase;
  const readsOf = (r: Rig) => r.fake.calls.filter((c) => c.label === "A30").length;

  it("hands the claim the install pull request, its head and the live twin", async () => {
    const r = await rig();
    expect(await claimOf(r)).toMatchObject({ installPr: PR, installHeadSha: HEAD, twinId: r.twinId });
  });

  it("records exactly the files the merged install pull request ADDED, once, with one audit row of counts", async () => {
    const r = await rig();
    const reports: string[] = [];
    expect(await completeSetupFinish({ pool: h.opsPool, port: r.port, report: (m) => reports.push(m) }, await claimOf(r))).toBe("done");
    expect(await paths(r.twinId)).toEqual(ADDED);
    expect(await phase(r.setupId)).toBe("done");
    expect(reports).toEqual([]);
    expect(await audits(r.who.accountId)).toEqual([{ actor: "system", payload: { twin_id: r.twinId, added: 3, total: 3 } }]);
  });

  it("keeps the paths the twin already had and adds only the new ones; a second pass changes nothing and writes no second audit row", async () => {
    const r = await rig({ paths: ["keep/me.md", "docs/PRD.md"] });
    expect(await completeSetupFinish({ pool: h.opsPool, port: r.port }, await claimOf(r))).toBe("done");
    expect(await paths(r.twinId)).toEqual([...new Set(["keep/me.md", ...ADDED])].sort());
    expect((await audits(r.who.accountId))[0]!.payload).toMatchObject({ added: 2, total: 4 });
    // the same union again, through the definer: nothing added, no audit row
    await h.admin.query("UPDATE project_setups SET phase = 'finish' WHERE id = $1", [r.setupId]);
    const again = await h.opsPool.query("SELECT * FROM setup_finish_twin_install_paths($1::uuid, 1, $2::text[])", [r.setupId, ADDED]);
    expect(again.rows[0]).toMatchObject({ o_result: "ok", o_count: 4 });
    expect(await audits(r.who.accountId)).toHaveLength(1);
  });

  it("writes nothing for a repo that is no twin's private repo, and does not read the pull request", async () => {
    const r = await rig({ twin: "none" });
    // another twin in the same account, on a second repo, must not be touched
    const other = await repoFor(r.who, "other", 12);
    const otherTwin = await twinOn(r.who, other, await repoFor(r.who, "other-private", 13));
    const claim = await claimOf(r);
    expect(claim.twinId).toBeNull();
    expect(await completeSetupFinish({ pool: h.opsPool, port: r.port }, claim)).toBe("done");
    expect(await paths(otherTwin)).toEqual([]);
    expect(await audits(r.who.accountId)).toEqual([]);
    expect(readsOf(r)).toBe(0);
  });

  it("writes nothing for a removed twin", async () => {
    const r = await rig({ twin: "removed" });
    const claim = await claimOf(r);
    expect(claim.twinId).toBeNull();
    expect(await completeSetupFinish({ pool: h.opsPool, port: r.port }, claim)).toBe("done");
    expect(await paths(r.twinId)).toEqual([]);
    const direct = await h.opsPool.query("SELECT * FROM setup_finish_twin_install_paths($1::uuid, 1, $2::text[])", [r.setupId, ADDED]);
    expect(direct.rows[0]).toMatchObject({ o_result: "skipped" });
  });

  it("is the twin of the SETUP'S repo that is written: the public repo's own twin row and a second repo's twin are never touched", async () => {
    const r = await rig();
    const second = await repoFor(r.who, "second-public", 21);
    const secondTwin = await twinOn(r.who, second, await repoFor(r.who, "second-private", 22), { paths: ["x.md"] });
    expect(await completeSetupFinish({ pool: h.opsPool, port: r.port }, await claimOf(r))).toBe("done");
    expect(await paths(secondTwin)).toEqual(["x.md"]);
    expect(await paths(r.twinId)).toEqual(ADDED);
  });

  describe("the definer refuses", () => {
    it("a setup that is not at phase finish, and an attempt that is not the setup's, and writes nothing", async () => {
      const r = await rig();
      const call = (setup: string, attempt: number) => h.opsPool.query("SELECT * FROM setup_finish_twin_install_paths($1::uuid, $2::int, $3::text[])", [setup, attempt, ADDED]);
      expect((await call(r.setupId, 2)).rows[0]).toMatchObject({ o_result: "skipped", o_count: null });
      expect((await call(randomUUID(), 1)).rows[0]).toMatchObject({ o_result: "skipped" });
      await h.admin.query("UPDATE project_setups SET phase = 'install' WHERE id = $1", [r.setupId]);
      expect((await call(r.setupId, 1)).rows[0]).toMatchObject({ o_result: "skipped" });
      await h.admin.query("UPDATE project_setups SET phase = 'done' WHERE id = $1", [r.setupId]);
      expect((await call(r.setupId, 1)).rows[0]).toMatchObject({ o_result: "skipped" });
      expect(await paths(r.twinId)).toEqual([]);
      expect(await audits(r.who.accountId)).toEqual([]);
    });

    it("a setup AT finish at its own attempt whose repo is no live twin's private repo: not_twin, the list unchanged, no audit row", async () => {
      const direct = (setup: string) => h.opsPool.query("SELECT * FROM setup_finish_twin_install_paths($1::uuid, 1, $2::text[])", [setup, ADDED]);
      // (a) the repo's twin is removed
      const removed = await rig({ twin: "removed", paths: ["keep/me.md"] });
      expect((await direct(removed.setupId)).rows[0]).toEqual({ o_result: "not_twin", o_count: null });
      expect(await paths(removed.twinId)).toEqual(["keep/me.md"]);
      expect(await audits(removed.who.accountId)).toEqual([]);
      // (b) the repo is no twin's private repo, while a live twin of another repo of the same account exists
      const none = await rig({ twin: "none" });
      const other = await twinOn(none.who, await repoFor(none.who, "other", 12), await repoFor(none.who, "other-private", 13), { paths: ["x.md"] });
      expect((await direct(none.setupId)).rows[0]).toEqual({ o_result: "not_twin", o_count: null });
      expect(await paths(other)).toEqual(["x.md"]);
      expect(await audits(none.who.accountId)).toEqual([]);
      // (c) the setup is on the live twin's PUBLIC repo, not its private one
      const pub = await rig({ paths: ["keep/me.md"], setupOn: "public" });
      expect((await direct(pub.setupId)).rows[0]).toEqual({ o_result: "not_twin", o_count: null });
      expect(await paths(pub.twinId)).toEqual(["keep/me.md"]);
      expect(await audits(pub.who.accountId)).toEqual([]);
    });

    it("a path outside the list's shape, by raising, and writes nothing", async () => {
      const r = await rig();
      for (const bad of ["../x", "/abs", "a//b", "has space", "a/../b", ""]) {
        await expect(h.opsPool.query("SELECT * FROM setup_finish_twin_install_paths($1::uuid, 1, $2::text[])", [r.setupId, [bad]])).rejects.toThrow(/invalid argument/);
      }
      expect(await paths(r.twinId)).toEqual([]);
    });

    it("a caller that is not platform_ops: app_user cannot run it or the claim, PUBLIC holds no EXECUTE, and the admin login is refused by the function's own check", async () => {
      const r = await rig();
      await expect(h.appPool.query("SELECT * FROM setup_finish_twin_install_paths($1::uuid, 1, $2::text[])", [r.setupId, ADDED])).rejects.toThrow(/permission denied/);
      await expect(h.appPool.query("SELECT * FROM setup_finish_claim()")).rejects.toThrow(/permission denied/);
      const acl = await h.admin.query<{ app: boolean; ops: boolean; pub: boolean }>(
        "SELECT has_function_privilege('app_user', 'setup_finish_twin_install_paths(uuid, integer, text[])', 'EXECUTE') AS app, has_function_privilege('platform_ops', 'setup_finish_twin_install_paths(uuid, integer, text[])', 'EXECUTE') AS ops, (SELECT count(*) > 0 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = 'setup_finish_twin_install_paths' AND a.grantee = 0) AS pub",
      );
      expect(acl.rows[0]).toEqual({ app: false, ops: true, pub: false });
      await expect(h.admin.query("SELECT * FROM setup_finish_twin_install_paths($1::uuid, 1, $2::text[])", [r.setupId, ADDED])).rejects.toThrow(/platform_ops only/);
      expect(await paths(r.twinId)).toEqual([]);
    });

    it("a list that would pass 5,000: the cap refusal is reported, nothing is written, and the finish still completes", async () => {
      const full = Array.from({ length: 4999 }, (_, i) => `gen/f${String(i).padStart(5, "0")}.md`);
      const r = await rig({ paths: full });
      const reports: string[] = [];
      expect(await completeSetupFinish({ pool: h.opsPool, port: r.port, report: (m) => reports.push(m) }, await claimOf(r))).toBe("done");
      expect(await phase(r.setupId)).toBe("done");
      expect(await paths(r.twinId)).toEqual(full);
      expect(reports).toEqual(["twin install files not recorded: the list would pass the 5000 limit"]);
      expect(await audits(r.who.accountId)).toEqual([]);
    });
  });

  it("records the paths it can and reports a count for an ADDED file the list cannot hold, never its name", async () => {
    const r = await rig({ files: [{ path: "docs/PRD.md", changeType: "ADDED" }, { path: "my notes/secret plan.md", changeType: "ADDED" }] });
    const reports: string[] = [];
    expect(await completeSetupFinish({ pool: h.opsPool, port: r.port, report: (m) => reports.push(m) }, await claimOf(r))).toBe("done");
    expect(await paths(r.twinId)).toEqual(["docs/PRD.md"]);
    expect(reports).toEqual(["twin install files: 1 added file(s) have a path the list cannot hold and are not recorded"]);
  });

  it("does not record a pull request GitHub does not show as merged, and still completes", async () => {
    const r = await rig();
    r.repo.pulls[0]!.merged = false;
    r.repo.pulls[0]!.state = "open";
    const reports: string[] = [];
    expect(await completeSetupFinish({ pool: h.opsPool, port: r.port, report: (m) => reports.push(m) }, await claimOf(r))).toBe("done");
    expect(await paths(r.twinId)).toEqual([]);
    expect(reports).toEqual(["twin install files not recorded: the install pull request is not merged on GitHub"]);
  });
});
