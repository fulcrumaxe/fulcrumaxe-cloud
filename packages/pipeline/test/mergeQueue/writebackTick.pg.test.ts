import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { PullFacts } from "@fx/core/src/plan/index.js";
import { createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import { runPlanWriteback, type PlanWritebackDeps } from "../../src/build/planWriteback.js";
import { createWritebackGitHub } from "../../src/build/planWritebackGitHub.js";
import { listWritebackNeedsYou, readAutoMerge, runQueueTick, type QueueTickDeps } from "../../src/mergeQueue/index.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { APP_EMAIL, FakeGitHub, NAME, OWNER } from "../build/helpers/fakeWritebackGitHub.js";
import { PLAN_PATH, planFile, pull } from "../build/helpers/planFixture.js";
import { startMergeTlsGitHub, tlsGitHubHttp, type MergeTlsGitHub } from "../review/helpers/fakeGitHubMergeTls.js";
import { startStrictGithubServer } from "../../../github/test/helpers/localTlsServer.js";
import { ghError, type GhReply } from "../../../github/test/helpers/strictGithub.js";
import type { WritebackHttp } from "../../src/build/planWritebackGitHub.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#598 P5c-b over real Postgres and strict GitHub fakes. The queue tick runs on the agent-run-writer login (the login production ticks with), so the setting read
 * is proven under it. The pull request's own facts (mergeability, checks, the one merge call) come from the strict TLS merge fake; the plan file, the compare and the
 * contents API (with its 1 MB inline limit) from the write-back fake the P5b suite uses, served behind a strict TLS server (real connection path, User-Agent and credential checks). What it cannot fake
 * faithfully: the fake's compare answers one unpaged response.
 */
const HUMAN_MERGE_ONLY = "FX_HUMAN_MERGE_ONLY_REPO_IDS";
const savedLock = process.env[HUMAN_MERGE_ONLY];
afterEach(() => {
  if (savedLock === undefined) delete process.env[HUMAN_MERGE_ONLY];
  else process.env[HUMAN_MERGE_ONLY] = savedLock;
});

describe("D#598 P5c-b plan write-back in the queue tick [pg]", () => {
  const db = pgHarness();
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c()));
  });

  interface World {
    accountId: string;
    repoId: string;
    prNumber: number;
    head: string;
    gh: FakeGitHub;
    g: MergeTlsGitHub;
    pulls: PullFacts[];
    userId: string;
    deltaReviews: number;
    deps: QueueTickDeps;
    nextVersion: number;
    /** Rewrites the strict plan server's compare answer, the way GitHub answers a rename. */
    compareAs: { renamed: boolean };
  }

  const tenant = <T>(w: Pick<World, "accountId">, fn: (c: PoolClient) => Promise<T>) => withTenant(db.runWriterPool, w.accountId, fn);
  const count = async (table: string, accountId: string) => Number((await db.admin.query(`SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [accountId])).rows[0].n);
  const entry = async (w: World) => (await db.admin.query(`SELECT * FROM merge_queue_entries WHERE account_id = $1`, [w.accountId])).rows[0] as Record<string, unknown>;
  const setToggle = async (w: World, autoMerge: boolean) => {
    await db.admin.query(`INSERT INTO plan_writeback_settings (account_id, repo_id, auto_merge, version, changed_by) VALUES ($1, $2, $3, $4, $5)`, [w.accountId, w.repoId, autoMerge, w.nextVersion++, w.userId]);
  };
  const setRepoAutoMerge = (w: World, on: boolean) => db.admin.query(`UPDATE repos SET settings = $2::jsonb WHERE id = $1`, [w.repoId, JSON.stringify(on ? { autoMerge: true } : {})]);
  const mergeCalls = (w: World) => w.g.world.merges.length;

  async function world(): Promise<World> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const userId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await db.admin.query(`UPDATE repos SET gh_owner = $2, gh_name = $3 WHERE id = $1`, [repoId, OWNER, NAME]);
    await db.admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await db.admin.query(`INSERT INTO plan_imports (account_id, repo_id, state, level, source_path, finished_at) VALUES ($1, $2, 'succeeded', 'roadmap_file', $3, now())`, [accountId, repoId, PLAN_PATH]);
    const gh = new FakeGitHub({ [PLAN_PATH]: planFile() });
    // The contents and compare API over real TLS: the strict server checks User-Agent, Accept, API version and bearer credentials like the merge fake does, and the
    // route refuses what GitHub refuses (no credential is 401, a verb the API does not have is 404, an error inside the fake is a 500).
    const compareAs = { renamed: false };
    const plans = await startStrictGithubServer(async (req): Promise<GhReply> => {
      if (!/^(bearer|token) \S+$/i.test(req.headers["authorization"] ?? "")) return ghError(401, "Requires authentication");
      if (req.method !== "GET" && req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH" && req.method !== "DELETE") return ghError(404, "Not Found");
      try {
        const query = req.query ? Object.fromEntries(new URLSearchParams(req.query)) : undefined;
        const res = await gh.http.request({ method: req.method, path: req.path, ...(query ? { query } : {}), ...(req.body ? { body: JSON.parse(req.body) as unknown } : {}) });
        let body = res.body as { files?: Array<Record<string, unknown>> } | null;
        if (compareAs.renamed && req.path.includes("/compare/") && Array.isArray(body?.files)) body = { ...body, files: body.files.map((f) => ({ ...f, status: "renamed", previous_filename: "old/roadmap.json" })) };
        return { status: res.status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) };
      } catch {
        return ghError(500, "Server Error");
      }
    });
    closers.push(() => plans.close());
    const planHttp = tlsGitHubHttp(plans) as unknown as WritebackHttp;
    const pulls: PullFacts[] = [pull(40, "D#9:T1", "merged")];
    const truth = { head: async () => ({ defaultBranch: "main", sha: gh.tip() }), pulls: async () => ({ pulls, truncated: false }) };
    const writer: PlanWritebackDeps = {
      inTenant: (acct, fn) => withTenant(db.pureAppUserPool, acct, fn as (c: PoolClient) => Promise<never>),
      open: () => ({ github: createWritebackGitHub({ http: planHttp, owner: OWNER, name: NAME }), truth }),
      identity: { email: APP_EMAIL },
    };
    const opened = await runPlanWriteback(writer, { accountId, repoId });
    expect(opened.kind).toBe("opened");
    const prNumber = (opened as { prNumber: number }).prNumber;
    const row = (await db.admin.query(`SELECT head_sha FROM plan_writebacks WHERE account_id = $1`, [accountId])).rows[0] as { head_sha: string };
    const g = await startMergeTlsGitHub({ prNumber, headSha: row.head_sha, owner: OWNER, name: NAME, baseTipSha: gh.tip(), baseShas: [gh.tip()] });
    closers.push(() => g.close());
    const port = createGitHubMergeGatePort({ http: g.http, resolveRepo: async () => ({ owner: OWNER, name: NAME }), markReadyForHumanMerge: async () => undefined, sleep: async () => undefined, mergeablePollLimit: 3 });
    // Without the ordered-resource reads, as the older tick suites run (a plan file is no ordered resource).
    const github: QueueTickDeps["github"] = { ...port, listPullRequestAdds: undefined, listDefaultBranchPaths: undefined };
    const w: World = { accountId, repoId, prNumber, head: row.head_sha, gh, g, pulls, userId, deltaReviews: 0, nextVersion: 1, compareAs, deps: undefined as unknown as QueueTickDeps };
    w.deps = {
      github,
      inTenant: (acct, fn) => withTenant(db.runWriterPool, acct, fn),
      ourLogin: "fulcrumaxe-app[bot]",
      gate: async () => {
        throw new Error("the work-item gate must never run for a plan write-back");
      },
      startDeltaReview: async () => {
        w.deltaReviews += 1;
        return { started: false, reason: "worker_unavailable" };
      },
      reviewPlan: async () => ({ ok: true, roles: [] }),
      reviewJudgement: async () => ({ mode: "cloud", flagged: false }),
      sleep: async () => undefined,
      pollIntervalMs: 0,
      pollLimit: 3,
      writeback: {
        open: async () => ({ github: createWritebackGitHub({ http: planHttp, owner: OWNER, name: NAME }), truth }),
        merge: (pr, args) => port.mergePullRequest(pr, args),
      },
    };
    return w;
  }

  const tick = (w: World) => runQueueTick(w.deps, w);
  const needsYou = (w: World) => tenant(w, (c) => listWritebackNeedsYou(c, w));

  describe("P5c-b-8: the setting read under the tick's real login", () => {
    it("reads the current version under the agent-run-writer login; no row is off; another account's tenant reads nothing", async () => {
      const w = await world();
      expect(await tenant(w, (c) => readAutoMerge(c, w.accountId, w.repoId))).toBe(false);
      await setToggle(w, true);
      expect(await tenant(w, (c) => readAutoMerge(c, w.accountId, w.repoId))).toBe(true);
      await setToggle(w, false);
      expect(await tenant(w, (c) => readAutoMerge(c, w.accountId, w.repoId))).toBe(false);
      await setToggle(w, true);
      expect(await tenant(w, (c) => readAutoMerge(c, w.accountId, w.repoId))).toBe(true);
      // A tenant that is not the repo's account, and a session with no tenant at all, see no row: off.
      expect(await withTenant(db.runWriterPool, randomUUID(), (c) => readAutoMerge(c, w.accountId, w.repoId))).toBe(false);
      const bare = await db.runWriterPool.connect();
      try {
        expect(await readAutoMerge(bare, w.accountId, w.repoId)).toBe(false);
      } finally {
        bare.release();
      }
    });
  });

  describe("P5c-b-3: toggle off", () => {
    it("stops 'ready, a person merges' with no merge call; one Needs-you row across repeated ticks; no agent run, work item or delta review", async () => {
      const w = await world();
      await setRepoAutoMerge(w, true);
      const runs = await count("agent_runs", w.accountId);
      const first = await tick(w);
      expect(first.steps[0]).toEqual({ step: "released", entryId: expect.any(String), why: "ready_human_merges" });
      for (let i = 0; i < 3; i++) await tick(w);
      expect(mergeCalls(w)).toBe(0);
      expect(await entry(w)).toMatchObject({ state: "stopped", reason: "ready_human_merges", slot_holder: null });
      expect(await needsYou(w)).toEqual([{ planWritebackId: expect.any(String), prNumber: w.prNumber, headSha: w.head, code: "ready_human_merges" }]);
      expect(await count("agent_runs", w.accountId)).toBe(runs);
      expect(await count("work_items", w.accountId)).toBe(0);
      expect(w.deltaReviews).toBe(0);
    });
  });

  describe("P5c-b-4: toggle on, matching file, green CI", () => {
    it("makes one merge call naming the recorded head and ends merged by the gate", async () => {
      const w = await world();
      await setRepoAutoMerge(w, true);
      await setToggle(w, true);
      const out = await tick(w);
      expect(out.steps[0]).toMatchObject({ step: "merged", prNumber: w.prNumber });
      expect(w.g.world.merges).toEqual([{ sha: w.head, method: "squash" }]);
      expect(await entry(w)).toMatchObject({ state: "merged", merged_by: "gate" });
      expect(await needsYou(w)).toEqual([]);
      expect(await count("work_items", w.accountId)).toBe(0);
      expect(await count("agent_runs", w.accountId)).toBe(0);
      await tick(w);
      expect(mergeCalls(w)).toBe(1);
    });
  });

  describe("P5c-b-5: the toggle turned off between two ticks", () => {
    it("the second tick does not merge, and turning it on again undoes that", async () => {
      const w = await world();
      await setRepoAutoMerge(w, true);
      await setToggle(w, true);
      w.g.world.checkRunsBySha = { [w.head]: [{ name: "build", status: "in_progress", conclusion: null }] };
      expect((await tick(w)).steps[0]).toMatchObject({ step: "parked", why: "ci_pending" });
      await setToggle(w, false);
      w.g.world.checkRunsBySha = {};
      const second = await tick(w);
      expect(second.steps[0]).toMatchObject({ step: "released", why: "ready_human_merges" });
      expect(mergeCalls(w)).toBe(0);
      expect(await entry(w)).toMatchObject({ state: "stopped", reason: "ready_human_merges" });
      // The undo: on again, and the waiting write-back goes back through the queue and merges.
      await setToggle(w, true);
      expect((await tick(w)).steps[0]).toMatchObject({ step: "merged" });
      expect(mergeCalls(w)).toBe(1);
    });
  });

  describe("P5c-b-2: the locks", () => {
    it("the repo's auto-merge off makes no merge call", async () => {
      const w = await world();
      await setToggle(w, true);
      expect((await tick(w)).steps[0]).toMatchObject({ step: "released", why: "ready_human_merges" });
      expect(mergeCalls(w)).toBe(0);
    });
    it("the human-merge-only lock makes no merge call, and a malformed lock locks every repo", async () => {
      const w = await world();
      await setRepoAutoMerge(w, true);
      await setToggle(w, true);
      const gh = (await db.admin.query(`SELECT gh_repo_id FROM repos WHERE id = $1`, [w.repoId])).rows[0].gh_repo_id as string;
      process.env[HUMAN_MERGE_ONLY] = `${gh}`;
      expect((await tick(w)).steps[0]).toMatchObject({ step: "released", why: "ready_human_merges" });
      process.env[HUMAN_MERGE_ONLY] = "12 34";
      await tick(w);
      expect(mergeCalls(w)).toBe(0);
      delete process.env[HUMAN_MERGE_ONLY];
      await tick(w);
      expect(mergeCalls(w)).toBe(1);
    });
  });

  describe("P5c-b-1: a recorded head that is not what the platform computes", () => {
    async function record(w: World, branchEdit: (branch: string) => string): Promise<void> {
      const row = (await db.admin.query(`SELECT branch FROM plan_writebacks WHERE account_id = $1`, [w.accountId])).rows[0] as { branch: string };
      const sha = branchEdit(row.branch);
      // The platform's record names this head, so the tick reaches the comparison instead of the head check.
      await db.admin.query(`UPDATE plan_writebacks SET head_sha = $2 WHERE account_id = $1`, [w.accountId, sha]);
      await db.admin.query(`UPDATE merge_queue_entries SET head_sha = $2 WHERE account_id = $1`, [w.accountId, sha]);
      w.g.world.headSha = sha;
    }
    const onAndReady = async (w: World) => {
      await setRepoAutoMerge(w, true);
      await setToggle(w, true);
    };

    it("valid JSON with a row the writer did not compute is not merged", async () => {
      const w = await world();
      await record(w, (branch) => {
        const doc = JSON.parse(w.gh.file(PLAN_PATH, branch)!);
        doc.task_status["D#9:T3"].status = "not_started";
        return w.gh.pushAs(branch, PLAN_PATH, `${JSON.stringify(doc, null, 2)}\n`);
      });
      await onAndReady(w);
      expect((await tick(w)).steps[0]).toMatchObject({ step: "released", why: "writeback_content_mismatch" });
      expect(mergeCalls(w)).toBe(0);
      expect(await entry(w)).toMatchObject({ state: "stopped", reason: "writeback_content_mismatch" });
    });

    it("a change to any other path is not merged", async () => {
      const w = await world();
      await record(w, (branch) => w.gh.pushAs(branch, "src/other.txt", "hello\n"));
      await onAndReady(w);
      expect((await tick(w)).steps[0]).toMatchObject({ step: "released", why: "writeback_content_mismatch" });
      expect(mergeCalls(w)).toBe(0);
    });

    it("a compare entry that is a rename (status renamed, previous_filename) is not merged, through the real port over TLS", async () => {
      const w = await world();
      await onAndReady(w);
      w.compareAs.renamed = true;
      expect((await tick(w)).steps[0]).toMatchObject({ step: "released", why: "writeback_content_mismatch" });
      expect(mergeCalls(w)).toBe(0);
      expect(await entry(w)).toMatchObject({ state: "stopped", reason: "writeback_content_mismatch" });
    });

    it("an entry whose pull request is not the record's stops with its own code and makes no merge call", async () => {
      const w = await world();
      await onAndReady(w);
      // The table refuses a second pull request number (a trigger), so the record is made to disagree with the entry by switching triggers off for this one statement.
      await db.admin.query("SET session_replication_role = replica");
      try {
        await db.admin.query(`UPDATE plan_writebacks SET pr_number = $2 WHERE account_id = $1`, [w.accountId, w.prNumber + 1000]);
      } finally {
        await db.admin.query("SET session_replication_role = DEFAULT");
      }
      expect((await tick(w)).steps[0]).toMatchObject({ step: "released", why: "writeback_pr_mismatch" });
      expect(mergeCalls(w)).toBe(0);
      expect(await entry(w)).toMatchObject({ state: "stopped", reason: "writeback_pr_mismatch" });
    });

    it("one byte of difference (a trailing space) is not merged", async () => {
      const w = await world();
      await record(w, (branch) => w.gh.pushAs(branch, PLAN_PATH, `${w.gh.file(PLAN_PATH, branch)!.trimEnd()} \n`));
      await onAndReady(w);
      expect((await tick(w)).steps[0]).toMatchObject({ step: "released", why: "writeback_content_mismatch" });
      expect(mergeCalls(w)).toBe(0);
    });

    it("truth that moved on since the write-back was built is a mismatch, not a merge", async () => {
      const w = await world();
      w.pulls.push(pull(41, "D#9:T4", "merged"));
      await onAndReady(w);
      expect((await tick(w)).steps[0]).toMatchObject({ step: "released", why: "writeback_content_mismatch" });
      expect(mergeCalls(w)).toBe(0);
    });

    it("a head GitHub reports that is not the recorded one never reaches the comparison", async () => {
      const w = await world();
      await onAndReady(w);
      w.g.world.headSha = "9".repeat(40);
      expect((await tick(w)).steps[0]).toMatchObject({ step: "idle", why: "nothing_eligible" });
      expect(mergeCalls(w)).toBe(0);
    });
  });

  describe("P5c-b-6: a comparison that cannot finish", () => {
    const cases: Array<[string, (w: World) => void]> = [
      ["a file over the contents API's inline limit", (w) => void (w.gh.inlineLimit = 10)],
      ["a transport failure", (w) => void (w.gh.onRequest = () => { throw new Error("socket hang up"); })],
      ["a contents read that fails", (w) => void (w.gh.onRequest = (req) => { if (req.path.includes("/contents/")) throw new Error("boom"); })],
    ];
    for (const [name, arrange] of cases) {
      it(`${name} stops with its own code and no merge`, async () => {
        const w = await world();
        await setRepoAutoMerge(w, true);
        await setToggle(w, true);
        arrange(w);
        expect((await tick(w)).steps[0]).toMatchObject({ step: "released", why: "writeback_check_unfinished" });
        expect(mergeCalls(w)).toBe(0);
        expect(await entry(w)).toMatchObject({ state: "stopped", reason: "writeback_check_unfinished" });
      });
    }
    it("a refused merge call (GitHub's 405) stops for a person; a moved head (409) goes back to review", async () => {
      const w = await world();
      await setRepoAutoMerge(w, true);
      await setToggle(w, true);
      w.g.world.mergeAnswer = 405;
      expect((await tick(w)).steps[0]).toMatchObject({ step: "released", why: "merge_call_refused" });
      expect(w.g.world.merges).toHaveLength(1);
      const w2 = await world();
      await setRepoAutoMerge(w2, true);
      await setToggle(w2, true);
      w2.g.world.mergeAnswer = 409;
      expect((await tick(w2)).steps[0]).toMatchObject({ step: "released", why: "head_moved" });
    });
  });
});
