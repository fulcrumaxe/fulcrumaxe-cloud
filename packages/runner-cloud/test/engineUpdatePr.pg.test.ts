import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { claimEngineUpdate, completeEngineUpdatePr, engineUpdatePullRequestText, issueSystemStarts, type EngineUpdateClaim, type SystemStartDeps } from "../src/index.js";
import { createRunPullRequestPort } from "../src/runPullRequest.js";
import { harness, newKey, registerKey, type Harness } from "./helpers.js";
import { FAKE_APP_LOGIN, FakeGithub, openInstallationKinds, type FakeRepo } from "./helpers/githubFake.js";

const BASE = "a".repeat(40);
const HEAD = "c".repeat(40);
const OTHER = "d".repeat(40);
const BRANCH = "fx/engine-update-1.2.0";

/**
 * [pg] D#845 ON-15c (migration 1109): the engine update's pull request step (the platform_ops login through the real definers, row security forced; GitHub is the real run port over a strict fake), the webhook's watch
 * (`engine_update_pr_closed`, a tenant session), the merge (`engine_update_merged`), and the restart (the system start with the cause `engine_update`). What the fake cannot do: GitHub's branch protection, rate limits and GraphQL validation.
 */
describe("the engine update's pull request, watch and restart [pg]", () => {
  let h: Harness;
  const keys = generateKeyPairSync("ed25519");
  const signer = { keyId: "job-key-1", signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", keys.privateKey) };
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());
  // updates other tests of this database left due are parked, so a claim here is always this test's own
  beforeEach(async () => {
    await h.admin.query("UPDATE engine_updates SET phase = 'failed', state = 'failed', failure_code = 'parked', failure_at = now() WHERE phase = 'push' AND sub_step = 'push' AND state = 'ok' AND head_sha IS NOT NULL AND pr IS NULL");
  });

  interface Rig { who: SeedRefs; runnerId: string; ghRepoId: number; setupId: string; updateId: string }
  /** A fresh account, one installed repo (engine 1.0.0) placed on a machine, a plan of one, operate on (epoch 1), and an update to 1.2.0 whose runner pushed HEAD (phase push, step push ok). */
  async function rig(o: { update?: Partial<{ phase: string; sub_step: string; state: string; head: string | null; pr: number | null }>; operate?: boolean; plan?: number; tick?: boolean } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    const ghRepoId = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, newKey());
    await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.repoId, who.accountId, runnerId]);
    await h.admin.query("UPDATE accounts SET engine_quantity = $2, stripe_subscription_status = 'active' WHERE id = $1", [who.accountId, o.plan ?? 1]);
    await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, $2)", [who.accountId, o.operate !== false]);
    if (o.tick !== false) await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [who.accountId, who.repoId]);
    const setupId = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase, engine_version) VALUES ($1, $2, 'existing', $3, 'done', '1.0.0') RETURNING id", [who.accountId, who.repoId, who.userId])).rows[0]!.id;
    const u = o.update ?? {};
    const updateId = (await h.admin.query<{ id: string }>(
      "INSERT INTO engine_updates (account_id, repo_id, setup_id, from_version, to_version, phase, sub_step, state, attempt, head_sha, pr, created_by) VALUES ($1, $2, $3, '1.0.0', '1.2.0', $4, $5, $6, 1, $7, $8, $9) RETURNING id",
      [who.accountId, who.repoId, setupId, u.phase ?? "push", u.sub_step ?? "push", u.state ?? "ok", u.head === undefined ? HEAD : u.head, u.pr ?? null, who.userId])).rows[0]!.id;
    return { who, runnerId, ghRepoId, setupId, updateId };
  }
  interface Sibling { repoId: string; runnerId: string; ghRepoId: number; setupId: string; updateId: string | null }
  /** A second installed repo (engine 1.0.0) of the same account, on a machine of its own, ticked, with an update of its own at `phase` (none when null). */
  async function sibling(r: Rig, phase: string | null, head: string | null = HEAD): Promise<Sibling> {
    const repoId = randomUUID();
    const ghRepoId = r.ghRepoId + 1000 + Math.floor(Math.random() * 100_000);
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', $4)", [repoId, r.who.accountId, ghRepoId, `s${ghRepoId}`]);
    const runnerId = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
    await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [repoId, r.who.accountId, runnerId]);
    await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [r.who.accountId, repoId]);
    const setupId = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase, engine_version) VALUES ($1, $2, 'existing', $3, 'done', '1.0.0') RETURNING id", [r.who.accountId, repoId, r.who.userId])).rows[0]!.id;
    const updateId = phase === null ? null : (await h.admin.query<{ id: string }>(
      "INSERT INTO engine_updates (account_id, repo_id, setup_id, from_version, to_version, phase, sub_step, state, attempt, head_sha, pr, created_by) VALUES ($1, $2, $3, '1.0.0', '1.2.0', $4, $5, 'ok', 1, $6, $7, $8) RETURNING id",
      [r.who.accountId, repoId, setupId, phase, phase === "push" ? "push" : "pr_open", head, phase === "push" ? null : 9, r.who.userId])).rows[0]!.id;
    return { repoId, runnerId, ghRepoId, setupId, updateId };
  }
  const update = async (id: string) => (await h.admin.query("SELECT phase, sub_step, state, failure_code, pr, head_sha, restarted_at, pr_closed_number, pr_closed_merged FROM engine_updates WHERE id = $1", [id])).rows[0];
  const version = async (setupId: string) => (await h.admin.query<{ engine_version: string }>("SELECT engine_version FROM project_setups WHERE id = $1", [setupId])).rows[0]!.engine_version;
  const tenant = <T,>(r: Rig, fn: (c: import("pg").PoolClient) => Promise<T>, who: SeedRefs = r.who) => withTenant(h.appPool, who.accountId, who.userId, fn);
  const closed = (r: Rig, pr: number, merged: boolean, ref = BRANCH, repoId = r.who.repoId, who: SeedRefs = r.who) =>
    tenant(r, async (c) => (await c.query<{ r: string }>("SELECT engine_update_pr_closed($1::uuid, $2::int, $3::boolean, $4) AS r", [repoId, pr, merged, ref])).rows[0]!.r, who);

  /** acme/widgets with its default branch, the update branch at HEAD whose only parent is BASE, and the given files. */
  function github(o: { files?: string[]; parents?: string[]; branchOid?: string } = {}) {
    const fake = new FakeGithub();
    const repo: FakeRepo = fake.addRepo("acme", "widgets");
    fake.pushBranch(repo, BRANCH, { oid: o.branchOid ?? HEAD, files: (o.files ?? [".fulcrumaxe/engine.json", "scripts/start.sh"]).map((path) => ({ path, changeType: "MODIFIED" })) });
    repo.commits.set(HEAD, o.parents ?? [BASE]);
    const port = createRunPullRequestPort({ open: openInstallationKinds(fake), appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
    return { fake, repo, port };
  }
  const claimOf = async (r: Rig): Promise<EngineUpdateClaim> => {
    const c = await claimEngineUpdate(h.opsPool);
    if (c === null || c === "malformed") throw new Error(`no claim for ${r.updateId}`);
    expect(c.updateId).toBe(r.updateId);
    return c;
  };
  const code = async (p: Promise<unknown>) => p.then((v) => `ok:${String(v)}`, (e: { code?: string; message?: string }) => e.code ?? `error:${e.message}`);

  describe("the pull request step", () => {
    it("holds the commit to the branch, opens the pull request as a draft, reads its files, only then marks it ready, and records the number: phase await_merge", async () => {
      const r = await rig();
      const { fake, repo, port } = github();
      const claim = await claimOf(r);
      expect(claim).toMatchObject({ accountId: r.who.accountId, repoId: r.who.repoId, attempt: 1, headSha: HEAD, from: "1.0.0", to: "1.2.0", owner: "acme", name: "widgets" });
      expect(await completeEngineUpdatePr({ pool: h.opsPool, port }, claim)).toBe("opened");
      const pr = repo.pulls[0]!;
      expect(repo.pulls).toHaveLength(1);
      expect(pr).toMatchObject({ head: BRANCH, base: "main", draft: false, state: "open", title: "Update the engine (v1.0.0 to v1.2.0)" });
      expect(fake.calls.map((c) => c.label)).toEqual(["A2", "A1 RunBranchState", "A1 CommitParents", "A3", "A4", "A1 PullRequestFiles", "A1 MarkReady"]);
      expect(fake.denied).toBe(0);
      expect(await update(r.updateId)).toMatchObject({ phase: "await_merge", sub_step: "pr_open", state: "ok", pr: pr.number, head_sha: HEAD, failure_code: null });
      // the installed version has not moved: only a merge moves it
      expect(await version(r.setupId)).toBe("1.0.0");
      // nothing is due now, and a second record changes nothing
      expect(await claimEngineUpdate(h.opsPool)).toBeNull();
      expect((await h.opsPool.query("SELECT engine_update_pr_record($1::uuid, 1, $2, $3::int) AS ok", [r.updateId, HEAD, pr.number + 1])).rows[0].ok).toBe(false);
      expect(await update(r.updateId)).toMatchObject({ pr: pr.number });
    });

    it("the text is fixed words and the two versions of our own row", () => {
      expect(engineUpdatePullRequestText("1.0.0", "1.2.0").title).toBe("Update the engine (v1.0.0 to v1.2.0)");
      expect(engineUpdatePullRequestText("1.0.0; DROP", "1.2.0").title).toBe("Update the engine");
      expect(engineUpdatePullRequestText("1.0.0", "1.2.0").body).not.toMatch(/\{|\$/);
    });

    it("a branch that is not at the recorded commit, or a commit with two parents, opens nothing and fails the update update_head_changed, freeing the repo", async () => {
      const moved = await rig();
      const a = github({ branchOid: OTHER });
      expect(await completeEngineUpdatePr({ pool: h.opsPool, port: a.port }, await claimOf(moved))).toBe("failed");
      expect(a.repo.pulls).toEqual([]);
      expect(await update(moved.updateId)).toMatchObject({ phase: "failed", state: "failed", failure_code: "update_head_changed", pr: null });
      const merge = await rig();
      const b = github({ parents: [BASE, OTHER] });
      expect(await completeEngineUpdatePr({ pool: h.opsPool, port: b.port }, await claimOf(merge))).toBe("failed");
      expect(b.repo.pulls).toEqual([]);
      expect(await update(merge.updateId)).toMatchObject({ failure_code: "update_head_changed" });
      // the repo's one live slot is free again
      await h.admin.query("INSERT INTO engine_updates (account_id, repo_id, setup_id, from_version, to_version, attempt, created_by) VALUES ($1, $2, $3, '1.0.0', '1.3.0', 2, $4)", [moved.who.accountId, moved.who.repoId, moved.setupId, moved.who.userId]);
    });

    it("a pull request that touches a workflow file or an odd path is closed, never made ready, and the update fails pr_scope_refused", async () => {
      for (const path of [".github/workflows/ci.yml", "a/../b", ".git/config"]) {
        const r = await rig();
        const { repo, port } = github({ files: ["scripts/start.sh", path] });
        expect(await completeEngineUpdatePr({ pool: h.opsPool, port }, await claimOf(r))).toBe("failed");
        expect(repo.pulls[0]).toMatchObject({ state: "closed", draft: true });
        expect(await update(r.updateId)).toMatchObject({ phase: "failed", failure_code: "pr_scope_refused", pr: null });
      }
    });

    it("a GitHub that cannot be asked leaves the update as it was and keeps the lease; a later pass opens it; a refusal no retry fixes fails it pr_open_failed", async () => {
      const r = await rig();
      const { fake, repo, port } = github();
      fake.inject = { label: /^A2$/, reply: { status: 502, body: { message: "Bad Gateway" } } };
      expect(await completeEngineUpdatePr({ pool: h.opsPool, port }, await claimOf(r))).toBe("retry");
      expect(await update(r.updateId)).toMatchObject({ phase: "push", sub_step: "push", state: "ok", pr: null });
      expect(await claimEngineUpdate(h.opsPool)).toBeNull();
      await h.admin.query("UPDATE engine_updates SET pr_claim_at = now() - interval '11 minutes' WHERE id = $1", [r.updateId]);
      expect(await completeEngineUpdatePr({ pool: h.opsPool, port }, await claimOf(r))).toBe("opened");
      expect(repo.pulls).toHaveLength(1);
      const refused = await rig();
      const g = github();
      g.fake.inject = { label: /^A4$/, reply: { status: 403, body: { message: "Resource not accessible by integration" } } };
      expect(await completeEngineUpdatePr({ pool: h.opsPool, port: g.port }, await claimOf(refused))).toBe("failed");
      expect(await update(refused.updateId)).toMatchObject({ phase: "failed", failure_code: "pr_open_failed" });
    });

    it("a FORBIDDEN answer to MarkReady fails the update pr_open_failed and logs the call, the status and the type (FU-317); an already-ready reused pull request does not ask again", async () => {
      const forbidden = { status: 200, body: { data: { markPullRequestReadyForReview: null }, errors: [{ type: "FORBIDDEN", path: ["markPullRequestReadyForReview"], message: "Resource not accessible by integration" }] } };
      const r = await rig();
      const g = github();
      g.fake.inject = { label: /^A1 MarkReady$/, reply: forbidden };
      const lines: string[] = [];
      expect(await completeEngineUpdatePr({ pool: h.opsPool, port: g.port, log: (l) => lines.push(l) }, await claimOf(r))).toBe("failed");
      expect(await update(r.updateId)).toMatchObject({ phase: "failed", failure_code: "pr_open_failed" });
      expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: "runner.setup_pr.failure", step: "engine_update_pr", id: r.updateId, op: "MarkReady", reason: "rejected", status: 200, graphql_types: ["FORBIDDEN"] }]);
      expect(lines.join("")).not.toMatch(/Resource not accessible|acme|widgets|ghs_/);

      const again = await rig();
      const k = github();
      const first = await k.port.openDraft({ repo: { id: "r", owner: "acme", name: "widgets" }, branch: BRANCH, base: "main", text: engineUpdatePullRequestText("1.0.0", "1.2.0") });
      await k.port.markReady({ repo: { id: "r", owner: "acme", name: "widgets" }, pullRequest: first, setup: true });
      k.fake.inject = { label: /^A1 MarkReady$/, reply: forbidden };
      const quiet: string[] = [];
      expect(await completeEngineUpdatePr({ pool: h.opsPool, port: k.port, log: (l) => quiet.push(l) }, await claimOf(again))).toBe("opened");
      expect(quiet).toEqual([]);
    });

    it("lists only what is due: a push not yet ok, no recorded head, an opened update and an inactive account are never claimed; a lease is held ten minutes and a new commit is due at once", async () => {
      await rig({ update: { state: "started" } });
      await rig({ update: { head: null } });
      await rig({ update: { phase: "await_merge", sub_step: "pr_open", pr: 5 } });
      const gone = await rig();
      await h.admin.query("UPDATE accounts SET deleted_at = now() WHERE id = $1", [gone.who.accountId]);
      expect(await claimEngineUpdate(h.opsPool)).toBeNull();
      expect((await h.opsPool.query("SELECT engine_update_pr_pending() AS p")).rows[0].p).toBe(false);
      const r = await rig();
      expect((await h.opsPool.query("SELECT engine_update_pr_pending() AS p")).rows[0].p).toBe(true);
      await claimOf(r);
      expect(await claimEngineUpdate(h.opsPool)).toBeNull();
      await h.admin.query("UPDATE engine_updates SET pr_claim_sha = $2 WHERE id = $1", [r.updateId, OTHER]);
      expect((await claimOf(r)).updateId).toBe(r.updateId);
    });

    it("record and fail change nothing unless the update still says exactly what the claim saw: the same update, attempt and commit, at push ok, with no pull request yet", async () => {
      const r = await rig();
      const other = await rig();
      const record = (id: string, attempt: number, head: string, pr: number) => h.opsPool.query<{ ok: boolean }>("SELECT engine_update_pr_record($1::uuid, $2::int, $3, $4::int) AS ok", [id, attempt, head, pr]).then((x) => x.rows[0]!.ok);
      const fail = (id: string, attempt: number, head: string) => h.opsPool.query<{ ok: boolean }>("SELECT engine_update_pr_fail($1::uuid, $2::int, $3, 'pr_open_failed') AS ok", [id, attempt, head]).then((x) => x.rows[0]!.ok);
      expect([await record(r.updateId, 2, HEAD, 7), await record(r.updateId, 1, OTHER, 7), await record(randomUUID(), 1, HEAD, 7)]).toEqual([false, false, false]);
      expect([await fail(r.updateId, 2, HEAD), await fail(r.updateId, 1, OTHER), await fail(randomUUID(), 1, HEAD)]).toEqual([false, false, false]);
      expect(await update(r.updateId)).toMatchObject({ phase: "push", sub_step: "push", state: "ok", pr: null, failure_code: null });
      // not at push ok: a started push, and an update that already has its number
      await h.admin.query("UPDATE engine_updates SET state = 'started' WHERE id = $1", [other.updateId]);
      expect([await record(other.updateId, 1, HEAD, 7), await fail(other.updateId, 1, HEAD)]).toEqual([false, false]);
      await h.admin.query("UPDATE engine_updates SET state = 'ok', pr = 5 WHERE id = $1", [other.updateId]);
      expect([await record(other.updateId, 1, HEAD, 7), await fail(other.updateId, 1, HEAD)]).toEqual([false, false]);
      expect(await update(other.updateId)).toMatchObject({ phase: "push", pr: 5, failure_code: null });
      // the exact one is taken, and a second answer to the same claim is not
      expect(await record(r.updateId, 1, HEAD, 7)).toBe(true);
      expect([await record(r.updateId, 1, HEAD, 8), await fail(r.updateId, 1, HEAD)]).toEqual([false, false]);
      expect(await update(r.updateId)).toMatchObject({ phase: "await_merge", pr: 7 });
    });

    it("an update whose pushed commit was recorded over six hours ago and never got its pull request is failed pr_not_opened, so it cannot hold the repo for ever", async () => {
      const r = await rig();
      await h.admin.query("UPDATE engine_updates SET updated_at = now() - interval '7 hours' WHERE id = $1", [r.updateId]);
      expect((await h.opsPool.query("SELECT engine_update_pr_pending() AS p")).rows[0].p).toBe(true);
      expect(await claimEngineUpdate(h.opsPool)).toBeNull();
      expect(await update(r.updateId)).toMatchObject({ phase: "failed", state: "failed", failure_code: "pr_not_opened" });
      expect((await h.opsPool.query("SELECT engine_update_pr_pending() AS p")).rows[0].p).toBe(false);
    });

    it("the four step functions are the platform_ops login's alone: a tenant session, a runner session and the superuser's own login are refused and write nothing", async () => {
      const r = await rig();
      const calls = ["engine_update_pr_claim()", "engine_update_pr_pending()", `engine_update_pr_record('${r.updateId}', 1, '${HEAD}', 7)`, `engine_update_pr_fail('${r.updateId}', 1, '${HEAD}', 'pr_open_failed')`];
      for (const call of calls) {
        expect(await code(h.appPool.query(`SELECT ${call}`))).toBe("42501");
        expect(await code(tenant(r, (c) => c.query(`SELECT ${call}`)))).toBe("42501");
        expect(await code(h.adminPool.query(`SELECT ${call}`))).toBe("42501");
      }
      const runnerSession = h.opsPool.connect().then(async (c) => {
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.runner_id', $1, true)", [r.runnerId]);
          return await c.query("SELECT engine_update_pr_pending()");
        } finally {
          await c.query("ROLLBACK").catch((): void => undefined);
          c.release();
        }
      });
      expect(await code(runnerSession)).toBe("42501");
      expect(await update(r.updateId)).toMatchObject({ phase: "push", pr: null, failure_code: null });
      expect((await h.opsPool.query("SELECT engine_update_pr_fail($1::uuid, 1, $2, 'made_up') AS ok", [r.updateId, HEAD]).then(() => "ok", (e: { code?: string }) => e.code))).toBe("22023");
    });
  });

  describe("the watch (a pull request of the update branch closing or merging)", () => {
    const awaiting = (pr = 41) => rig({ update: { phase: "await_merge", sub_step: "pr_open", pr } });

    it("a merge sets the installed version to the update's and the update waits for its restart; a repeat of the delivery changes nothing", async () => {
      const r = await awaiting();
      const sib = await sibling(r, "await_merge");
      expect(await closed(r, 41, true)).toBe("finished");
      expect(await update(r.updateId)).toMatchObject({ phase: "restart", sub_step: "pr_merged", state: "ok", failure_code: null, pr: 41, restarted_at: null });
      expect(await version(r.setupId)).toBe("1.2.0");
      // the account's other installed repo, with an update of its own, is untouched
      expect(await version(sib.setupId)).toBe("1.0.0");
      expect(await update(sib.updateId!)).toMatchObject({ phase: "await_merge" });
      expect(await closed(r, 41, true)).toBe("none");
      expect(await closed(r, 41, false)).toBe("none");
      expect(await version(r.setupId)).toBe("1.2.0");
    });

    it("a close without a merge fails the update pr_closed, leaves the installed version, and frees the repo", async () => {
      const r = await awaiting();
      expect(await closed(r, 41, false)).toBe("failed");
      expect(await update(r.updateId)).toMatchObject({ phase: "failed", state: "failed", failure_code: "pr_closed" });
      expect(await version(r.setupId)).toBe("1.0.0");
      expect(await closed(r, 41, true)).toBe("none");
      expect(await version(r.setupId)).toBe("1.0.0");
      await h.admin.query("INSERT INTO engine_updates (account_id, repo_id, setup_id, from_version, to_version, attempt, created_by) VALUES ($1, $2, $3, '1.0.0', '1.3.0', 2, $4)", [r.who.accountId, r.who.repoId, r.setupId, r.who.userId]);
    });

    it("moves nothing for a pull request that is not this update's: another number, another version's branch, a branch of another shape, another repo of the account, and another account's session", async () => {
      const r = await awaiting();
      const other = await awaiting();
      const second = randomUUID();
      await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team', 'acme', 'gadgets')", [second, r.who.accountId]);
      for (const [pr, merged, ref, repo] of [[42, true, BRANCH, r.who.repoId], [41, true, "fx/engine-update-1.3.0", r.who.repoId], [41, true, "fx/engine-install-1.2.0", r.who.repoId], [41, true, "fx/engine-update-1.2.0-x", r.who.repoId], [41, true, "feature", r.who.repoId], [41, true, BRANCH, second]] as const) {
        expect(await closed(r, pr, merged, ref, repo), `${pr} ${ref}`).toBe("none");
      }
      // the other account's session, naming this account's repo and number, finds no row of its own
      expect(await closed(r, 41, true, BRANCH, r.who.repoId, other.who)).toBe("none");
      expect(await closed(other, 41, true, BRANCH, r.who.repoId)).toBe("none");
      expect(await update(r.updateId)).toMatchObject({ phase: "await_merge", pr: 41 });
      expect(await update(other.updateId)).toMatchObject({ phase: "await_merge", pr: 41 });
      expect([await version(r.setupId), await version(other.setupId)]).toEqual(["1.0.0", "1.0.0"]);
      // a session with no account answers none and writes nothing
      expect((await h.appPool.query("SELECT engine_update_pr_closed($1::uuid, 41, true, $2) AS r", [r.who.repoId, BRANCH])).rows[0].r).toBe("none");
    });

    it("a close or merge that lands before the step recorded the number is kept, and the record honours it only for that number", async () => {
      const merged = await rig();
      expect(await closed(merged, 77, true)).toBe("recorded");
      expect(await update(merged.updateId)).toMatchObject({ phase: "push", pr: null, pr_closed_number: 77, pr_closed_merged: true });
      // another number is recorded as an ordinary pull request
      expect((await h.opsPool.query("SELECT engine_update_pr_record($1::uuid, 1, $2, 78) AS ok", [merged.updateId, HEAD])).rows[0].ok).toBe(true);
      expect(await update(merged.updateId)).toMatchObject({ phase: "await_merge", pr: 78 });
      const racedMerge = await rig();
      expect(await closed(racedMerge, 77, true)).toBe("recorded");
      expect((await h.opsPool.query("SELECT engine_update_pr_record($1::uuid, 1, $2, 77) AS ok", [racedMerge.updateId, HEAD])).rows[0].ok).toBe(true);
      expect(await update(racedMerge.updateId)).toMatchObject({ phase: "restart", pr: 77, state: "ok" });
      expect(await version(racedMerge.setupId)).toBe("1.2.0");
      const racedClose = await rig();
      expect(await closed(racedClose, 77, false)).toBe("recorded");
      expect((await h.opsPool.query("SELECT engine_update_pr_record($1::uuid, 1, $2, 77) AS ok", [racedClose.updateId, HEAD])).rows[0].ok).toBe(true);
      expect(await update(racedClose.updateId)).toMatchObject({ phase: "failed", failure_code: "pr_closed", pr: 77 });
      expect(await version(racedClose.setupId)).toBe("1.0.0");
    });

    it("a delivery that lands before the number is recorded is kept only for this update's own repository and branch", async () => {
      const r = await rig();
      const sib = await sibling(r, null);
      expect(await closed(r, 77, true, BRANCH, sib.repoId)).toBe("none");
      expect(await closed(r, 77, true, "fx/engine-update-1.3.0")).toBe("none");
      expect(await update(r.updateId)).toMatchObject({ pr_closed_number: null, pr_closed_merged: null });
      const other = await rig();
      expect(await closed(r, 77, true, BRANCH, r.who.repoId, other.who)).toBe("none");
      expect(await update(r.updateId)).toMatchObject({ pr_closed_number: null });
    });

    it("the merge function is the definers' alone: a tenant session cannot call it", async () => {
      const r = await awaiting();
      expect(await code(tenant(r, (c) => c.query("SELECT engine_update_merged($1::uuid, $2::uuid)", [r.who.accountId, r.updateId])))).toBe("42501");
      expect(await version(r.setupId)).toBe("1.0.0");
    });
  });

  describe("the restart (the system start with the cause engine_update)", () => {
    const HEAD_SHA = "e".repeat(40);
    const restart = (o: { operate?: boolean; plan?: number } = {}) => rig({ ...o, update: { phase: "restart", sub_step: "pr_merged", pr: 9 } });
    const due = async (accountId: string, pool = h.opsPool) => (await pool.query<{ o_repo: string; o_epoch: number }>("SELECT * FROM engine_update_starts_due($1::uuid, NULL, 500)", [accountId])).rows;
    const jobs = async (accountId: string) => (await h.admin.query<{ repo_id: string }>("SELECT repo_id FROM machine_jobs WHERE account_id = $1 AND kind = 'engine_session_start'", [accountId])).rows;
    const audits = async (accountId: string) => (await h.admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'engine_session.started'", [accountId])).rows;
    async function issue(r: Rig, o: { cause?: string; epoch?: number; repoId?: string; runnerId?: string; ghRepoId?: number; pool?: "ops" | "app" } = {}): Promise<string> {
      const id = randomUUID();
      const issued = new Date();
      const expires = new Date(issued.getTime() + 1_800_000);
      const resume = (await h.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM runner_sandboxes WHERE runner_id = $1", [o.runnerId ?? r.runnerId])).rows[0]!.n > 0;
      const job = signer.signMachineJob({ v: 1, job_id: id, runner_id: o.runnerId ?? r.runnerId, repo_gh_id: o.ghRepoId ?? r.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(),
        kind: "engine_session_start", args: { at_sha: HEAD_SHA, resume, operate_epoch: o.epoch ?? 1 } } as unknown as MachineJob);
      const pool = o.pool === "app" ? h.appPool : h.opsPool;
      return (await pool.query<{ result: string }>("SELECT engine_system_start_issue($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7) AS result", [id, r.who.accountId, o.repoId ?? r.who.repoId, o.cause ?? "engine_update", JSON.stringify(job), issued, expires])).rows[0]!.result;
    }

    it("lists the repo of a merged update, issues the start once with the cause, ends the restart in the same transaction, and answers cause_gone to a replay", async () => {
      const r = await restart();
      expect((await due(r.who.accountId)).map((x) => [x.o_repo, x.o_epoch])).toEqual([[r.who.repoId, 1]]);
      expect(await issue(r)).toBe("issued");
      expect(await update(r.updateId)).toMatchObject({ phase: "done", sub_step: "pr_merged", state: "ok" });
      expect((await update(r.updateId)).restarted_at).not.toBeNull();
      expect((await jobs(r.who.accountId)).map((j) => j.repo_id)).toEqual([r.who.repoId]);
      expect((await audits(r.who.accountId)).map((a) => a.payload.cause)).toEqual(["engine_update"]);
      expect(await due(r.who.accountId)).toEqual([]);
      // a second start for the same cause: the cause is consumed, nothing more is signed
      expect(await issue(r)).toBe("cause_gone");
      expect(await jobs(r.who.accountId)).toHaveLength(1);
    });

    it("has no cause without an update at restart: a push, an await_merge, a failed or a finished update, and a repo with none, all answer cause_gone and sign nothing", async () => {
      for (const phase of ["push", "await_merge", "failed", "done"]) {
        const r = await rig({ update: { phase, sub_step: "pr_open", state: phase === "failed" ? "failed" : "ok", pr: phase === "push" ? null : 3 } });
        if (phase === "failed" || phase === "done") await h.admin.query("UPDATE engine_updates SET failure_code = $2, failure_at = $3 WHERE id = $1", [r.updateId, phase === "failed" ? "pr_closed" : null, phase === "failed" ? new Date() : null]);
        expect(await due(r.who.accountId)).toEqual([]);
        expect(await issue(r), phase).toBe("cause_gone");
        expect(await jobs(r.who.accountId)).toEqual([]);
        expect(await update(r.updateId)).toMatchObject({ phase });
      }
      const noUpdate = await rig({ update: { phase: "failed", state: "failed" } });
      await h.admin.query("DELETE FROM engine_updates WHERE id = $1", [noUpdate.updateId]);
      expect(await issue(noUpdate)).toBe("cause_gone");
    });

    it("the cause is the repo's own and the account's own: another repo of the account, and another account, neither lists nor issues", async () => {
      const a = await restart();
      const b = await restart();
      const second = randomUUID();
      await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team', 'acme', 'gadgets')", [second, a.who.accountId]);
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [second, a.who.accountId, await registerKey(h.admin, a.who.accountId, a.who.userId, newKey())]);
      await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [a.who.accountId, second]);
      expect((await due(a.who.accountId)).map((x) => x.o_repo)).toEqual([a.who.repoId]);
      expect(await due(randomUUID())).toEqual([]);
      // a signed job for the second repo (same account, no update of its own) and one naming a foreign repo get no cause
      expect(await code(issue(a, { repoId: second }))).toMatch(/22023|ok:cause_gone/);
      expect(await update(a.updateId)).toMatchObject({ phase: "restart", restarted_at: null });
      expect(await code(issue({ ...a, who: { ...a.who, accountId: b.who.accountId } }))).not.toBe("ok:issued");
      expect(await update(a.updateId)).toMatchObject({ phase: "restart" });
      expect(await update(b.updateId)).toMatchObject({ phase: "restart" });
      expect(await jobs(a.who.accountId)).toEqual([]);
      expect(await jobs(b.who.accountId)).toEqual([]);
    });

    it("the cause is the repo's own: a sibling repo with no update gets no start, and its start never consumes the sibling's or the first repo's restart", async () => {
      const a = await restart();
      const bare = await sibling(a, null);
      const other = await sibling(a, "restart");
      expect((await due(a.who.accountId)).map((x) => x.o_repo).sort()).toEqual([a.who.repoId, other.repoId].sort());
      expect(await issue(a, { repoId: bare.repoId, runnerId: bare.runnerId, ghRepoId: bare.ghRepoId })).toBe("cause_gone");
      expect(await jobs(a.who.accountId)).toEqual([]);
      expect(await issue(a)).toBe("issued");
      expect(await update(a.updateId)).toMatchObject({ phase: "done" });
      expect(await update(other.updateId!)).toMatchObject({ phase: "restart", restarted_at: null });
      expect((await due(a.who.accountId)).map((x) => x.o_repo)).toEqual([other.repoId]);
    });

    it("a restart that is already stamped is not a cause, and a repo that is not ticked is neither listed nor started", async () => {
      const stamped = await restart();
      await h.admin.query("UPDATE engine_updates SET restarted_at = now() WHERE id = $1", [stamped.updateId]);
      expect(await due(stamped.who.accountId)).toEqual([]);
      expect(await issue(stamped)).toBe("cause_gone");
      expect(await jobs(stamped.who.accountId)).toEqual([]);
      const unticked = await rig({ tick: false, update: { phase: "restart", sub_step: "pr_merged", pr: 9 } });
      expect(await due(unticked.who.accountId)).toEqual([]);
      expect(await issue(unticked)).toBe("cause_gone");
      expect(await update(unticked.updateId)).toMatchObject({ phase: "restart", restarted_at: null });
    });

    it("leaves the cause standing when the start cannot be issued yet: the epoch moved, the plan ended, a start already waiting; and does not list a repo that is not operated", async () => {
      const epoch = await restart();
      expect(await issue(epoch, { epoch: 2 })).toBe("epoch_moved");
      const plan = await restart({ plan: 0 });
      expect(await issue(plan)).toBe("plan");
      const busy = await restart();
      const waiting = randomUUID();
      const at = new Date(Date.now() - 60_000);
      const waitingJob = signer.signMachineJob({ v: 1, job_id: waiting, runner_id: busy.runnerId, repo_gh_id: busy.ghRepoId, requires_engine: "any", issued_at: at.toISOString(), expires_at: new Date(at.getTime() + 1_500_000).toISOString(),
        kind: "engine_session_start", args: { at_sha: HEAD_SHA, resume: false, operate_epoch: 1 } } as unknown as MachineJob);
      await h.admin.query("INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, kind, job, state, issued_at, expires_at) VALUES ($1, $2, $3, $4, 'engine_session_start', $5::jsonb, 'issued', $6, $7)", [waiting, busy.who.accountId, busy.runnerId, busy.who.repoId, JSON.stringify(waitingJob), at, new Date(at.getTime() + 1_500_000)]);
      expect(await issue(busy)).toBe("busy");
      const off = await restart({ operate: false });
      expect(await due(off.who.accountId)).toEqual([]);
      expect(await issue(off)).toBe("epoch_moved");
      for (const x of [epoch, plan, busy, off]) expect(await update(x.updateId)).toMatchObject({ phase: "restart", restarted_at: null });
      expect(await jobs(epoch.who.accountId)).toEqual([]);
      expect(await jobs(plan.who.accountId)).toEqual([]);
      // a later pass, once operate is on again, restarts it
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = true WHERE account_id = $1", [off.who.accountId]);
      const now = (await h.admin.query<{ e: number }>("SELECT operate_epoch AS e FROM engine_bridge_settings WHERE account_id = $1", [off.who.accountId])).rows[0]!.e;
      expect(await issue(off, { epoch: now })).toBe("issued");
      expect(await update(off.updateId)).toMatchObject({ phase: "done" });
    });

    it("the lister and the issuer are the platform_ops login's alone; a start with another cause name is refused and writes nothing", async () => {
      const r = await restart();
      expect(await code(due(r.who.accountId, h.appPool as never))).toBe("42501");
      expect(await code(issue(r, { pool: "app" }))).toBe("42501");
      expect(await code(issue(r, { cause: "restart" }))).toBe("22023");
      expect(await update(r.updateId)).toMatchObject({ phase: "restart", restarted_at: null });
      expect(await jobs(r.who.accountId)).toEqual([]);
    });

    it("the pass in TypeScript, with the cause engine_update, lists the repo, reads the head once and issues one start; the second pass lists nothing", async () => {
      const r = await restart();
      const reports: string[] = [];
      const calls = { defaultBranch: 0 };
      const port = { defaultBranch: async () => (calls.defaultBranch += 1, "main"), branchState: async () => ({ exists: true, headOid: HEAD_SHA, aheadBy: 0, defaultBranch: "main" }) };
      const deps: SystemStartDeps = { pool: h.opsPool, engineCommandSigner: async () => signer, pullRequests: () => port as never, reportError: (_e, c) => void reports.push(c.stage) };
      const pass = await issueSystemStarts(deps, { accountId: r.who.accountId, cause: "engine_update" });
      expect(pass).toMatchObject({ not_configured: false, issued: 1, results: [{ account_id: r.who.accountId, repo_id: r.who.repoId, result: "issued" }] });
      expect(await update(r.updateId)).toMatchObject({ phase: "done" });
      expect((await h.admin.query("SELECT job #>> '{job,args,at_sha}' AS at FROM machine_jobs WHERE account_id = $1", [r.who.accountId])).rows).toEqual([{ at: HEAD_SHA }]);
      expect(await issueSystemStarts(deps, { accountId: r.who.accountId, cause: "engine_update" })).toEqual({ not_configured: false, issued: 0, results: [] });
      expect(calls.defaultBranch).toBe(1);
      expect(reports).toEqual([]);
    });
  });
});
