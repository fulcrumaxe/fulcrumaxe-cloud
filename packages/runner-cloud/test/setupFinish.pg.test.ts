import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { claimSetupFinish, completeSetupFinish, pickSeedCategory, seedDiscussionText, teamLogText, type SetupFinishClaim } from "../src/setupFinish.js";
import { createRunPullRequestPort } from "../src/runPullRequest.js";
import { harness, type Harness } from "./helpers.js";
import { FAKE_APP_LOGIN, FakeGithub, openInstallationKinds, type FakeRepo } from "./helpers/githubFake.js";

interface Row { row_key: string; title: string; summary: string; size: "S" | "M" | "L"; depends_on: string[]; keep: boolean }
const ROWS: Row[] = [
  { row_key: "A1", title: "Set up CI", summary: "Run lint and tests on every push.", size: "S", depends_on: [], keep: true },
  { row_key: "A2", title: "Write the README", summary: "", size: "S", depends_on: ["A1"], keep: true },
  { row_key: "A3", title: "First feature", summary: "The thinnest useful slice.", size: "M", depends_on: ["A1", "A2"], keep: true },
  { row_key: "A4", title: "A dropped idea", summary: "Not wanted.", size: "L", depends_on: [], keep: false },
];

/**
 * [pg] D#845 ON-13a4: the finish phase. The cloud side runs as the platform_ops login through the real definers (migration 1085) with row security forced; the GitHub side is the real finish port, behind the real
 * `localOnlyGithub` fence, over a strict fake of GitHub (its own table, written without the production allowlist). What the fake cannot do: GitHub's rate limits, the real wording of its errors, and whether our
 * three Discussion documents are valid against GitHub's GraphQL schema (nothing in the repository checks that; a live run is the first check).
 */
describe("the finish phase [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());
  // setups other tests of this database left at finish are parked, so a claim here is always this test's own
  beforeEach(async () => {
    await h.admin.query("UPDATE project_setups SET phase = 'done' WHERE phase = 'finish'");
  });

  interface Rig { who: SeedRefs; setupId: string; repoId: string }
  async function repoFor(who: SeedRefs, name: string): Promise<string> {
    const repoId = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, gh_repo_id + 7, product, 'acme', $3 FROM repos WHERE id = $2", [repoId, who.repoId, name]);
    return repoId;
  }
  async function setupOn(who: SeedRefs, repoId: string, o: { rows?: Row[]; phase?: string; state?: string } = {}): Promise<string> {
    const setupId = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase, state, sub_step, engine_version) VALUES ($1, $2, 'existing', $3, $4, $5, 'pr_merged', '1.2.3') RETURNING id", [who.accountId, repoId, who.userId, o.phase ?? "finish", o.state ?? "ok"])).rows[0]!.id;
    await h.admin.query("INSERT INTO project_drafts (account_id, repo_id, setup_id, source, roadmap, version, status, approved_by, approved_at, final_at) VALUES ($1, $2, $3, 'survey', $4::jsonb, 1, 'approved', $5, now(), now())", [who.accountId, repoId, setupId, JSON.stringify(o.rows ?? ROWS), who.userId]);
    return setupId;
  }
  async function rig(o: { rows?: Row[]; operate?: "on" | "watch_only" | "unticked" | "none" } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const setupId = await setupOn(who, who.repoId, o.rows === undefined ? {} : { rows: o.rows });
    const mode = o.operate ?? "on";
    if (mode !== "none") {
      await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, $2)", [who.accountId, mode !== "watch_only"]);
      if (mode !== "unticked") await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [who.accountId, who.repoId]);
    }
    return { who, setupId, repoId: who.repoId };
  }
  function github(o: { discussionsEnabled?: boolean; categories?: string[] } = {}) {
    const fake = new FakeGithub();
    const repo: FakeRepo = fake.addRepo("acme", "widgets", { ...(o.discussionsEnabled === undefined ? {} : { discussionsEnabled: o.discussionsEnabled }), ...(o.categories === undefined ? {} : { categories: o.categories }) });
    const port = createRunPullRequestPort({ open: openInstallationKinds(fake), appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
    return { fake, repo, port };
  }
  const claimOf = async (r: Rig): Promise<SetupFinishClaim> => {
    const c = await claimSetupFinish(h.opsPool);
    if (c === null || c === "malformed") throw new Error(`no claim for ${r.setupId}`);
    expect(c.setupId).toBe(r.setupId);
    return c;
  };
  const setup = async (id: string) => (await h.admin.query("SELECT phase, sub_step, state, failure_code, finish_tries, team_log_issue, start_pending FROM project_setups WHERE id = $1", [id])).rows[0];
  const seeded = async (id: string) => (await h.admin.query<{ row_key: string; discussion_number: number }>("SELECT row_key, discussion_number FROM project_seeded_rows WHERE setup_id = $1 ORDER BY row_key", [id])).rows;
  const SEED_CALLS = (n: number) => ["A1 SeedTarget", "A1 SeedDiscussions", ...Array.from({ length: n }, () => "A1 SeedCreateDiscussion")];

  describe("the happy path", () => {
    it("seeds one Discussion per kept row in the Ideas category, makes the team-log issue, records start_pending for an operated repo, and ends at done", async () => {
      const r = await rig();
      const { fake, repo, port } = github();
      const claim = await claimOf(r);
      expect(claim).toMatchObject({ accountId: r.who.accountId, repoId: r.repoId, owner: "acme", name: "widgets" });
      expect(claim.roadmap.map((x) => x.rowKey)).toEqual(["A1", "A2", "A3"]);
      expect(await completeSetupFinish({ pool: h.opsPool, port, now: () => new Date("2026-11-24T10:00:00Z") }, claim)).toBe("done");
      const ideas = repo.categories.find((c) => c.name === "Ideas")!.id;
      expect(repo.discussions.map((d) => [d.title, d.categoryId])).toEqual([["Set up CI", ideas], ["Write the README", ideas], ["First feature", ideas]]);
      for (const d of repo.discussions) expect(d.body).toMatch(new RegExp(`<!-- fx-seed:${r.setupId}:A[123] -->$`));
      expect(repo.discussions[2]!.body).toBe(`The thinnest useful slice.\n\nSize: M\n\nDepends on: A1, A2\n\n<!-- fx-seed:${r.setupId}:A3 -->`);
      expect(repo.issues).toHaveLength(1);
      expect(repo.issues[0]).toMatchObject({ title: "Team Activity Log 2026-11-24", labels: ["team-log"], state: "open" });
      expect(repo.issues[0]!.body).toContain(`<!-- fx-team-log:${r.setupId} -->`);
      expect(fake.calls.map((c) => c.label)).toEqual([...SEED_CALLS(3), "A28", "A29"]);
      expect(fake.denied).toBe(0);
      expect(await seeded(r.setupId)).toEqual(repo.discussions.map((d, i) => ({ row_key: `A${i + 1}`, discussion_number: d.number })));
      expect(await setup(r.setupId)).toMatchObject({ phase: "done", sub_step: "finish", state: "ok", failure_code: null, team_log_issue: repo.issues[0]!.number, start_pending: true });
      // nothing is due now, and a second completion of the same claim changes nothing
      expect(await claimSetupFinish(h.opsPool)).toBeNull();
      expect(await completeSetupFinish({ pool: h.opsPool, port }, claim)).toBe("skipped");
      expect(repo.discussions).toHaveLength(3);
      expect(repo.issues).toHaveLength(1);
    });

    it("never seeds a row the plan dropped, and a plan with no kept row seeds nothing and still makes the issue", async () => {
      const r = await rig({ rows: ROWS.map((x) => ({ ...x, keep: false })) });
      const { repo, port, fake } = github();
      expect(await completeSetupFinish({ pool: h.opsPool, port }, await claimOf(r))).toBe("done");
      expect(repo.discussions).toEqual([]);
      expect(repo.issues).toHaveLength(1);
      expect(fake.calls.map((c) => c.label)).toEqual(["A28", "A29"]);
    });

    it("records start_pending only for an operated repo (item 9: watch AND operate AND the repo ticked)", async () => {
      for (const [operate, expected] of [["on", true], ["watch_only", false], ["unticked", false], ["none", false]] as const) {
        const r = await rig({ operate });
        // the same account ticking ANOTHER repo is not this repo being ticked
        if (operate === "unticked") await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [r.who.accountId, await repoFor(r.who, "gadgets")]);
        const { port } = github();
        expect(await completeSetupFinish({ pool: h.opsPool, port }, await claimOf(r))).toBe("done");
        expect((await setup(r.setupId)).start_pending, operate).toBe(expected);
        expect((await setup(r.setupId)).phase).toBe("done");
      }
    });

    it("issues no engine start and borrows no person: it writes no machine job", async () => {
      const r = await rig();
      const { port } = github();
      await completeSetupFinish({ pool: h.opsPool, port }, await claimOf(r));
      expect((await h.admin.query("SELECT 1 FROM machine_jobs WHERE account_id = $1 AND kind = 'engine_session_start'", [r.who.accountId])).rowCount).toBe(0);
    });
  });

  describe("the category rule (the engine's seed-backlog.py: the row's own, else Ideas, else the first)", () => {
    const cats = (...names: string[]) => names.map((name, i) => ({ id: `C${i}`, name }));
    it("takes the wanted category, else Ideas, else the first, else none", () => {
      expect(pickSeedCategory(cats("General", "Ideas", "Q&A"))?.name).toBe("Ideas");
      expect(pickSeedCategory(cats("General", "Ideas", "Q&A"), "Q&A")?.name).toBe("Q&A");
      expect(pickSeedCategory(cats("General", "Ideas"), "Polls")?.name).toBe("Ideas");
      expect(pickSeedCategory(cats("Q&A", "General"))?.name).toBe("Q&A");
      expect(pickSeedCategory([])).toBeNull();
    });
    it("a repository with no Ideas category gets its first one, and one with Ideas gets Ideas, whatever else it has", async () => {
      const r = await rig();
      const first = github({ categories: ["Q&A", "General"] });
      expect(await completeSetupFinish({ pool: h.opsPool, port: first.port }, await claimOf(r))).toBe("done");
      expect(new Set(first.repo.discussions.map((d) => d.categoryId))).toEqual(new Set([first.repo.categories[0]!.id]));
    });
  });

  describe("idempotency across retries", () => {
    it("a pass that died after some creates and before the issue is finished by the next one: no Discussion twice, one issue", async () => {
      const r = await rig();
      const { fake, repo, port } = github();
      // the team-log create fails the first time: the Discussions are made and recorded, the setup stays at finish
      fake.inject = { label: /^A29$/, reply: { status: 502, body: {} } };
      expect(await completeSetupFinish({ pool: h.opsPool, port }, await claimOf(r))).toBe("retry");
      expect(repo.discussions).toHaveLength(3);
      expect((await seeded(r.setupId)).length).toBe(3);
      expect(await setup(r.setupId)).toMatchObject({ phase: "finish", state: "ok", failure_code: null });
      // the lease lapses; the next pass skips what is recorded and makes the issue
      await h.admin.query("UPDATE project_setups SET finish_claim_at = now() - interval '11 minutes' WHERE id = $1", [r.setupId]);
      const again = await claimOf(r);
      expect([...again.seeded.keys()]).toEqual(["A1", "A2", "A3"]);
      fake.calls.length = 0;
      expect(await completeSetupFinish({ pool: h.opsPool, port }, again)).toBe("done");
      expect(repo.discussions).toHaveLength(3);
      expect(repo.issues).toHaveLength(1);
      expect(fake.calls.map((c) => c.label)).toEqual(["A28", "A29"]);
    });

    it("a Discussion created but never recorded (a crash between the create and the record) is found by its marker and recorded, not created again", async () => {
      const r = await rig();
      const { fake, repo, port } = github();
      const text = seedDiscussionText(r.setupId, { rowKey: "A2", title: "Write the README", summary: "", size: "S", dependsOn: ["A1"] });
      repo.discussions.push({ number: 77, title: text.title, body: text.body, categoryId: repo.categories[2]!.id });
      expect(await completeSetupFinish({ pool: h.opsPool, port }, await claimOf(r))).toBe("done");
      expect(repo.discussions.filter((d) => d.title === "Write the README")).toHaveLength(1);
      expect(repo.discussions).toHaveLength(3);
      expect((await seeded(r.setupId)).find((x) => x.row_key === "A2")!.discussion_number).toBe(77);
      expect(fake.calls.filter((c) => c.label === "A1 SeedCreateDiscussion")).toHaveLength(2);
    });

    it("a marker of ANOTHER setup (or a person's lookalike title) does not stand in for this setup's row", async () => {
      const r = await rig();
      const { repo, port } = github();
      const other = seedDiscussionText(randomUUID(), { rowKey: "A1", title: "Set up CI", summary: "", size: "S", dependsOn: [] });
      const quoted = seedDiscussionText(r.setupId, { rowKey: "A3", title: "First feature", summary: "", size: "M", dependsOn: [] });
      repo.discussions.push({ number: 4, title: "a person quoting us", body: `${quoted.body}\n\nand then some words`, categoryId: repo.categories[2]!.id });
      repo.discussions.push({ number: 5, title: "Set up CI", body: other.body, categoryId: repo.categories[2]!.id }, { number: 6, title: "Set up CI", body: "no marker here", categoryId: repo.categories[2]!.id });
      expect(await completeSetupFinish({ pool: h.opsPool, port }, await claimOf(r))).toBe("done");
      expect((await seeded(r.setupId)).find((x) => x.row_key === "A1")!.discussion_number).not.toBe(5);
      expect((await seeded(r.setupId)).find((x) => x.row_key === "A3")!.discussion_number).not.toBe(4);
      expect(repo.discussions).toHaveLength(6);
    });

    it("a marker typed by a person, or by another App, is not ours: the row is created, and the same holds for a team-log issue a person opened", async () => {
      const r = await rig();
      const { repo, port } = github();
      const forged = seedDiscussionText(r.setupId, { rowKey: "A1", title: "Set up CI", summary: "", size: "S", dependsOn: [] });
      const forgedToo = seedDiscussionText(r.setupId, { rowKey: "A2", title: "Write the README", summary: "", size: "S", dependsOn: ["A1"] });
      repo.discussions.push({ number: 301, title: "x", body: forged.body, categoryId: repo.categories[2]!.id, author: { login: "octocat", type: "User" } });
      // a Bot, but another App's: also not ours (the slug is compared, with or without the [bot] suffix)
      repo.discussions.push({ number: 302, title: "x", body: forgedToo.body, categoryId: repo.categories[2]!.id, author: { login: "other-app[bot]", type: "Bot" } });
      // a person whose login is our App's slug is still a person: only a Bot counts
      repo.discussions.push({ number: 303, title: "x", body: forged.body, categoryId: repo.categories[2]!.id, author: { login: "fulcrumaxe-runner", type: "User" } });
      repo.issues.push({ number: 450, title: "mine, by hand", body: "", labels: ["team-log"], state: "open", author: { login: "octocat", type: "User" } });
      repo.issues.push({ number: 451, title: "another App's", body: "", labels: ["team-log"], state: "open", author: { login: "other-app[bot]", type: "Bot" } });
      repo.issues.push({ number: 452, title: "a person named like us", body: "", labels: ["team-log"], state: "open", author: { login: "fulcrumaxe-runner[bot]", type: "User" } });
      expect(await completeSetupFinish({ pool: h.opsPool, port }, await claimOf(r))).toBe("done");
      const rows = await seeded(r.setupId);
      expect(rows.map((x) => x.row_key)).toEqual(["A1", "A2", "A3"]);
      expect(rows.some((x) => [301, 302, 303].includes(x.discussion_number))).toBe(false);
      expect(repo.discussions.filter((d) => d.author === undefined)).toHaveLength(3);
      expect([450, 451, 452]).not.toContain((await setup(r.setupId)).team_log_issue);
      expect(repo.issues.filter((i) => i.author === undefined)).toHaveLength(1);
    });

    it("an open team-log issue that is already there is reused (as the engine's bootstrap does), and a pull request carrying the label is not one", async () => {
      const r = await rig();
      const { repo, port } = github();
      repo.issues.push({ number: 412, title: "Team Activity Log", body: "", labels: ["team-log"], state: "open" });
      repo.issues.push({ number: 413, title: "a pull request", body: "", labels: ["team-log"], state: "open", pull_request: true });
      expect(await completeSetupFinish({ pool: h.opsPool, port }, await claimOf(r))).toBe("done");
      expect(repo.issues).toHaveLength(2);
      expect((await setup(r.setupId)).team_log_issue).toBe(412);
      const r2 = await rig();
      const g2 = github();
      g2.repo.issues.push({ number: 413, title: "a pull request", body: "", labels: ["team-log"], state: "open", pull_request: true });
      expect(await completeSetupFinish({ pool: h.opsPool, port: g2.port }, await claimOf(r2))).toBe("done");
      expect(g2.repo.issues.filter((i) => i.pull_request !== true)).toHaveLength(1);
    });

    it("a failure is recorded only for the attempt and phase the claim saw", async () => {
      const r = await rig();
      const claim = await claimOf(r);
      const fail = async (attempt: number) => (await h.opsPool.query("SELECT setup_finish_fail($1::uuid, $2::int, 'seed_failed') AS ok", [r.setupId, attempt])).rows[0].ok;
      for (const row of claim.roadmap) await h.opsPool.query("SELECT setup_finish_seed_record($1::uuid, $2::int, $3, 40)", [r.setupId, claim.attempt, row.rowKey]);
      const complete = async (attempt: number) => (await h.opsPool.query("SELECT setup_finish_complete($1::uuid, $2::int, 5) AS r", [r.setupId, attempt])).rows[0].r;
      expect(await complete(claim.attempt + 1)).toBe("skipped");
      expect((await setup(r.setupId)).phase).toBe("finish");
      expect(await fail(claim.attempt + 1)).toBe(false);
      expect((await setup(r.setupId)).state).toBe("ok");
      expect(await fail(claim.attempt)).toBe(true);
      await h.admin.query("UPDATE project_setups SET phase = 'done' WHERE id = $1", [r.setupId]);
      expect(await fail(claim.attempt)).toBe(false);
    });

    it("the definers hold the record: a row key the plan does not keep is refused, a different number for a recorded row is refused, a stale attempt changes nothing", async () => {
      const r = await rig();
      const claim = await claimOf(r);
      const rec = async (key: string, n: number, attempt = claim.attempt) => (await h.opsPool.query("SELECT setup_finish_seed_record($1::uuid, $2::int, $3, $4::int) AS ok", [r.setupId, attempt, key, n])).rows[0].ok;
      expect(await rec("A4", 9)).toBe(false);
      expect(await rec("ZZ", 9)).toBe(false);
      expect(await rec("A1", 9)).toBe(true);
      expect(await rec("A1", 9)).toBe(true);
      expect(await rec("A1", 10)).toBe(false);
      expect(await rec("A2", 11, claim.attempt + 1)).toBe(false);
      expect(await seeded(r.setupId)).toEqual([{ row_key: "A1", discussion_number: 9 }]);
      // complete refuses until every kept row is recorded
      expect((await h.opsPool.query("SELECT setup_finish_complete($1::uuid, $2::int, 5) AS r", [r.setupId, claim.attempt])).rows[0].r).toBe("not_ready");
      expect((await setup(r.setupId)).phase).toBe("finish");
    });
  });

  describe("failures", () => {
    it("Discussions off is seed_failed: the setup stays at finish, creates nothing, and is looked at again after fifteen minutes (and a success clears it)", async () => {
      const r = await rig();
      const off = github({ discussionsEnabled: false });
      expect(await completeSetupFinish({ pool: h.opsPool, port: off.port }, await claimOf(r))).toBe("failed");
      expect(off.repo.discussions).toEqual([]);
      expect(off.repo.issues).toEqual([]);
      expect(await setup(r.setupId)).toMatchObject({ phase: "finish", sub_step: "seed", state: "failed", failure_code: "seed_failed", finish_tries: 1 });
      // not before fifteen minutes
      expect(await claimSetupFinish(h.opsPool)).toBeNull();
      await h.admin.query("UPDATE project_setups SET failure_at = now() - interval '16 minutes' WHERE id = $1", [r.setupId]);
      const on = github();
      expect(await completeSetupFinish({ pool: h.opsPool, port: on.port }, await claimOf(r))).toBe("done");
      expect(await setup(r.setupId)).toMatchObject({ phase: "done", state: "ok", failure_code: null, finish_tries: 1 });
    });

    it("Discussions off with categories still listed is seed_failed, and nothing is created", async () => {
      const r = await rig();
      const off = github({ discussionsEnabled: false, categories: ["General", "Ideas"] });
      expect(await completeSetupFinish({ pool: h.opsPool, port: off.port }, await claimOf(r))).toBe("failed");
      expect(off.fake.calls.map((c) => c.label)).toEqual(["A1 SeedTarget"]);
    });

    it("a repository with Discussions on but no category is seed_failed too", async () => {
      const r = await rig();
      const none = github({ categories: [] });
      expect(await completeSetupFinish({ pool: h.opsPool, port: none.port }, await claimOf(r))).toBe("failed");
      expect((await setup(r.setupId)).failure_code).toBe("seed_failed");
    });

    it("a create GitHub refuses for good (the App may not write Discussions) is seed_failed; one it cannot answer is a retry that records nothing", async () => {
      const r = await rig();
      const g = github();
      g.fake.inject = { label: /SeedCreateDiscussion/, reply: { status: 200, body: { data: { createDiscussion: null }, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] } } };
      expect(await completeSetupFinish({ pool: h.opsPool, port: g.port }, await claimOf(r))).toBe("failed");
      const r2 = await rig();
      const g2 = github();
      g2.fake.inject = { label: /SeedCreateDiscussion/, reply: { status: 502, body: {} } };
      expect(await completeSetupFinish({ pool: h.opsPool, port: g2.port }, await claimOf(r2))).toBe("retry");
      expect(await setup(r2.setupId)).toMatchObject({ phase: "finish", state: "ok", failure_code: null, finish_tries: 0 });
      const r3 = await rig();
      const g3 = github();
      g3.fake.inject = { label: /SeedCreateDiscussion/, reply: { status: 200, body: { data: { createDiscussion: null }, errors: [{ type: "RATE_LIMITED", message: "slow down" }] } } };
      expect(await completeSetupFinish({ pool: h.opsPool, port: g3.port }, await claimOf(r3))).toBe("retry");
    });

    it("a GitHub that never answers is a retry 23 times, and the 24th is seed_failed, so a failure that never ends shows; a success in between does not count and a later success clears it", async () => {
      const r = await rig();
      const g = github();
      const stuck = () => { g.fake.inject = { label: /SeedTarget/, reply: { status: 502, body: {} } }; };
      const pass = async (): Promise<string> => {
        await h.admin.query("UPDATE project_setups SET finish_claim_at = NULL WHERE id = $1", [r.setupId]);
        stuck();
        return completeSetupFinish({ pool: h.opsPool, port: g.port }, await claimOf(r));
      };
      for (let i = 1; i < 24; i++) expect(await pass(), `pass ${i}`).toBe("retry");
      expect(await setup(r.setupId)).toMatchObject({ phase: "finish", state: "ok", failure_code: null, finish_tries: 0 });
      expect((await h.admin.query("SELECT finish_retries FROM project_setups WHERE id = $1", [r.setupId])).rows[0].finish_retries).toBe(23);
      expect(await pass()).toBe("failed");
      expect(await setup(r.setupId)).toMatchObject({ phase: "finish", sub_step: "seed", state: "failed", failure_code: "seed_failed", finish_tries: 1 });
      expect((await h.admin.query("SELECT finish_retries FROM project_setups WHERE id = $1", [r.setupId])).rows[0].finish_retries).toBe(0);
      // fifteen minutes later GitHub answers: the setup finishes and the failure is gone
      await h.admin.query("UPDATE project_setups SET failure_at = now() - interval '16 minutes' WHERE id = $1", [r.setupId]);
      expect(await completeSetupFinish({ pool: h.opsPool, port: github().port }, await claimOf(r))).toBe("done");
      expect(await setup(r.setupId)).toMatchObject({ phase: "done", state: "ok", failure_code: null });
    });

    it("the retry count is the definer's: a stale attempt or a setup that moved on is not counted, and only platform_ops may call it", async () => {
      const r = await rig();
      const claim = await claimOf(r);
      const retry = async (attempt: number) => (await h.opsPool.query("SELECT setup_finish_retry($1::uuid, $2::int) AS r", [r.setupId, attempt])).rows[0].r;
      expect(await retry(claim.attempt + 1)).toBe("skipped");
      expect(await retry(claim.attempt)).toBe("retry");
      await h.admin.query("UPDATE project_setups SET phase = 'done' WHERE id = $1", [r.setupId]);
      expect(await retry(claim.attempt)).toBe("skipped");
      await expect(withTenant(h.appPool, r.who.accountId, r.who.userId, (c) => c.query("SELECT setup_finish_retry($1, 1)", [r.setupId]))).rejects.toMatchObject({ code: "42501" });
    });

    it("gives up after 96 failed passes", async () => {
      const r = await rig();
      await h.admin.query("UPDATE project_setups SET state = 'failed', failure_code = 'seed_failed', failure_at = now() - interval '1 hour', finish_tries = 96 WHERE id = $1", [r.setupId]);
      expect(await claimSetupFinish(h.opsPool)).toBeNull();
      expect((await h.opsPool.query("SELECT setup_finish_pending() AS p")).rows[0].p).toBe(false);
    });

    it("a setup whose plan words hold control characters or an HTML comment is cleaned before it reaches GitHub (the fence would refuse it otherwise)", async () => {
      const rows: Row[] = [{ row_key: "A1", title: "Set up\u0007 CI", summary: "see <!-- hidden --> text", size: "S", depends_on: [], keep: true }];
      const r = await rig({ rows });
      const { repo, port, fake } = github();
      expect(await completeSetupFinish({ pool: h.opsPool, port }, await claimOf(r))).toBe("done");
      expect(repo.discussions[0]!.title).toBe("Set up  CI");
      expect(repo.discussions[0]!.body).not.toContain("<!-- hidden");
      expect(fake.denied).toBe(0);
    });

    it("the finish phase's text is fixed words and ids of our own rows", () => {
      expect(teamLogText("0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", new Date("2026-11-24T10:00:00Z")).body).toBe("Team activity log. Created 2026-11-24T10:00:00Z.\n\n<!-- fx-team-log:0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e -->");
    });
  });

  describe("the tenant rule", () => {
    it("the same account's SECOND repo and setup never leak into the first: the claim, the recorded rows and the seeded numbers are the setup's own", async () => {
      const a = await rig();
      // a second repo of the same account, its own setup at finish, one row already recorded
      const repo2 = await repoFor(a.who, "gadgets");
      const setup2 = await setupOn(a.who, repo2, { rows: [{ row_key: "B1", title: "Other repo row", summary: "", size: "S", depends_on: [], keep: true }] });
      await h.admin.query("INSERT INTO project_seeded_rows (account_id, setup_id, row_key, discussion_number) VALUES ($1, $2, 'B1', 900)", [a.who.accountId, setup2]);
      await h.admin.query("UPDATE project_setups SET updated_at = now() + interval '1 hour' WHERE id = $1", [setup2]);
      // the same repo also holds a NEWER approved draft of no setup, and a newer unapproved draft of this setup: neither is the plan
      const other = JSON.stringify([{ row_key: "ZZ", title: "Not the plan", summary: "", size: "S", depends_on: [], keep: true }]);
      await h.admin.query("INSERT INTO project_drafts (account_id, repo_id, setup_id, source, roadmap, version, status, approved_by, approved_at, final_at) VALUES ($1, $2, NULL, 'survey', $3::jsonb, 2, 'approved', $4, now(), now())", [a.who.accountId, a.repoId, other, a.who.userId]);
      await h.admin.query("INSERT INTO project_drafts (account_id, repo_id, setup_id, source, roadmap, version, status) VALUES ($1, $2, $3, 'survey', $4::jsonb, 3, 'draft')", [a.who.accountId, a.repoId, a.setupId, other]);
      const claim = await claimOf(a);
      expect(claim.roadmap.map((x) => x.rowKey)).toEqual(["A1", "A2", "A3"]);
      expect([...claim.seeded.keys()]).toEqual([]);
      // a claim is a lease: nothing else is handed over while it lasts (the other setup was pushed back in time to come second)
      const next = await claimSetupFinish(h.opsPool);
      expect(next !== null && next !== "malformed" && next.setupId === setup2).toBe(true);
      await h.admin.query("UPDATE project_setups SET finish_claim_at = NULL WHERE id = $1", [setup2]);
      expect(claim.name).toBe("widgets");
      const { repo, port } = github();
      expect(await completeSetupFinish({ pool: h.opsPool, port }, claim)).toBe("done");
      expect((await seeded(a.setupId)).map((x) => x.row_key)).toEqual(["A1", "A2", "A3"]);
      expect(await seeded(setup2)).toEqual([{ row_key: "B1", discussion_number: 900 }]);
      expect(repo.discussions.some((d) => d.title === "Other repo row")).toBe(false);
      // the second setup is untouched and still due
      expect((await setup(setup2)).phase).toBe("finish");
      const second = await claimSetupFinish(h.opsPool);
      expect(await claimSetupFinish(h.opsPool)).toBeNull();
      expect(second !== null && second !== "malformed" && second.setupId === setup2 && second.name === "gadgets" && second.seeded.get("B1") === 900 && second.roadmap.length === 1).toBe(true);
    });

    it("another account's rows are invisible: the app role sees only its own tenant's seeded rows, and a read through the RLS-bypassing client with a foreign account id finds none", async () => {
      const a = await rig();
      const b = await rig();
      const { port } = github();
      expect(await completeSetupFinish({ pool: h.opsPool, port }, await claimOf(a))).toBe("done");
      expect(await completeSetupFinish({ pool: h.opsPool, port: github().port }, await claimOf(b))).toBe("done");
      const own = await withTenant(h.appPool, a.who.accountId, a.who.userId, (c) => c.query("SELECT setup_id, row_key FROM project_seeded_rows"));
      expect(own.rows.length).toBe(3);
      expect(own.rows.every((x: { setup_id: string }) => x.setup_id === a.setupId)).toBe(true);
      const foreign = await withTenant(h.appPool, b.who.accountId, b.who.userId, (c) => c.query("SELECT setup_id FROM project_seeded_rows WHERE setup_id = $1", [a.setupId]));
      expect(foreign.rows).toEqual([]);
      // the admin client has no row security; the account id in the predicate is what keeps a foreign account's rows out
      const viaAdmin = await h.admin.query("SELECT 1 FROM project_seeded_rows WHERE account_id = $1 AND setup_id = $2", [b.who.accountId, a.setupId]);
      expect(viaAdmin.rowCount).toBe(0);
      // and a row cannot be recorded under one account for another's setup (the composite key)
      await expect(h.admin.query("INSERT INTO project_seeded_rows (account_id, setup_id, row_key, discussion_number) VALUES ($1, $2, 'ZZ', 1)", [b.who.accountId, a.setupId])).rejects.toMatchObject({ code: "23503" });
    });

    it("the app role can neither write the table nor run any definer; only platform_ops runs them", async () => {
      const a = await rig();
      await expect(withTenant(h.appPool, a.who.accountId, a.who.userId, (c) => c.query("INSERT INTO project_seeded_rows (account_id, setup_id, row_key, discussion_number) VALUES ($1, $2, 'A1', 1)", [a.who.accountId, a.setupId]))).rejects.toMatchObject({ code: "42501" });
      for (const sql of ["SELECT * FROM setup_finish_claim()", "SELECT setup_finish_pending()", `SELECT setup_finish_seed_record('${a.setupId}', 1, 'A1', 1)`, `SELECT setup_finish_complete('${a.setupId}', 1, 1)`, `SELECT setup_finish_fail('${a.setupId}', 1, 'seed_failed')`, `SELECT setup_finish_kept_rows('${a.who.accountId}', '${a.repoId}', '${a.setupId}')`]) {
        await expect(withTenant(h.appPool, a.who.accountId, a.who.userId, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: "42501" });
      }
      await expect(h.opsPool.query("SELECT setup_finish_kept_rows($1, $2, $3)", [a.who.accountId, a.repoId, a.setupId])).rejects.toMatchObject({ code: "42501" });
      await expect(h.opsPool.query("SELECT setup_finish_fail($1, 1, 'other_code')", [a.setupId])).rejects.toMatchObject({ code: "22023" });
    });

    it("a setup of a deleted account is not claimed", async () => {
      const a = await rig();
      await h.admin.query("UPDATE accounts SET deleted_at = now() WHERE id = $1", [a.who.accountId]);
      expect(await claimSetupFinish(h.opsPool)).toBeNull();
    });
  });

  describe("only a setup at phase finish is touched", () => {
    it("a setup still at install or await_merge is not claimed, and a recorded one that moved on is not completed", async () => {
      const who = await seedAccount(h.admin, randomUUID());
      await setupOn(who, who.repoId, { phase: "await_merge" });
      expect(await claimSetupFinish(h.opsPool)).toBeNull();
      expect((await h.opsPool.query("SELECT setup_finish_pending() AS p")).rows[0].p).toBe(false);
    });
  });
});
