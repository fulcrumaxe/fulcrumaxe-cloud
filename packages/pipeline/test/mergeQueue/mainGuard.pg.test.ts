import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { MAIN_RED_SENTENCE, MERGE_QUEUE_CI_WAIT_MINUTES, applyQueueEvent, cancelRepoEntries, readMainGuard, runQueueTick } from "../../src/mergeQueue/index.js";
import { createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { T0, shaOf, startQueueRepo, type QueueItem, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#519 MQ-MAIN-RED-GUARD (correction C4 section 3, acceptance 1 to 5), over real Postgres and the strict GitHub fake served over real TLS.
 * The fake models a rerun the way GitHub does: a rerun is a NEW check run with the same name on the same sha (`filter=latest` lists only the
 * newest of them, `filter=all` every one), a status context keeps only its latest state, and a sha is its own commit.
 */
const MIN = 60_000;
type Run = { name: string; status: "queued" | "in_progress" | "completed"; conclusion: string | null };
const ok = (name = "build"): Run => ({ name, status: "completed", conclusion: "success" });
const failed = (name = "build"): Run => ({ name, status: "completed", conclusion: "failure" });
const going = (name = "build"): Run => ({ name, status: "in_progress", conclusion: null });

let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("D#519 MQ-MAIN-RED-GUARD [pg]", () => {
  const db = pgHarness();
  const start = async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    return r;
  };
  const TIP = shaOf(7, "tip");
  const tipRuns = (a: QueueItem, runs: Run[]) => void (a.g.world.checkRunsBySha = { ...a.g.world.checkRunsBySha, [TIP]: runs });
  const events = async (r: QueueRepo) =>
    (await db.admin.query(`SELECT code, reasons, pr_number, dedupe_key FROM work_item_driver_events WHERE account_id = $1 AND kind = 'main_guard' ORDER BY created_at, id`, [r.accountId])).rows;
  const refReads = (r: QueueRepo) => r.calls.filter((c) => c.path.includes("/git/ref/heads/")).length;
  const noRefresh = (r: QueueRepo) => r.calls.filter((c) => c.path.includes("/compare/") || c.path.endsWith("/update-branch") || c.path.endsWith("/merge"));

  describe("1. a failed result on the tip", () => {
    it("a failed check run: no merge call, no refresh, the entry stays queued at its approved_at with the slot free, and the event names the check and the run", async () => {
      const r = await start();
      const a = await r.addItem(7, { approvedAt: T0 });
      tipRuns(a, [ok("lint"), failed("build")]);
      const out = await runQueueTick(r.deps(), r);
      expect(out.steps).toEqual([{ step: "released", entryId: a.entryId, why: "main_red" }]);
      expect(r.mergeCalls()).toEqual([]);
      expect(a.g.world.merges).toEqual([]);
      expect(noRefresh(r)).toEqual([]);
      expect(refReads(r)).toBe(1);
      expect(await r.entry(7)).toMatchObject({ state: "queued", approvedAt: T0, slotHolder: null, reason: null });
      // The fake numbers runs in the order listed: build is the second one. Plain codes only.
      expect(await events(r)).toEqual([{ code: "main_red", reasons: ["build", "check_run_2"], pr_number: 7, dedupe_key: `${TIP}:main_red` }]);
    });

    it("a failed status context is red too, named by its context", async () => {
      const r = await start();
      const a = await r.addItem(7);
      tipRuns(a, [ok()]);
      a.g.world.statuses = { "ci/external": "failure" };
      const out = await runQueueTick(r.deps(), r);
      expect(out.steps.map((s) => s.step)).toEqual(["released"]);
      expect(r.mergeCalls()).toEqual([]);
      expect((await events(r))[0]).toMatchObject({ code: "main_red", reasons: ["ci_external"] });
    });

    it("a red tip ends the call: every entry would meet the same answer, so the second entry is not taken and the tip is read once", async () => {
      const r = await start();
      const a = await r.addItem(7, { approvedAt: T0 });
      await r.addItem(8, { approvedAt: new Date(T0.getTime() + MIN) });
      tipRuns(a, [failed()]);
      const out = await runQueueTick(r.deps(), r);
      expect(out.steps.length).toBe(1);
      expect(refReads(r)).toBe(1);
      expect(r.mergeCalls()).toEqual([]);
    });
  });

  describe("2. a rerun after a failure is red until it passes", () => {
    it("the newest run is in progress and an earlier run of the same check on the sha failed: red; it completes green and the next tick merges", async () => {
      const r = await start();
      const a = await r.addItem(7);
      tipRuns(a, [failed(), going()]);
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["released"]);
      expect(r.mergeCalls()).toEqual([]);
      expect((await events(r))[0]).toMatchObject({ code: "main_red", reasons: ["build", "check_run_1"], dedupe_key: `${TIP}:main_red:rerun` });

      // Still going: still red. The queued rerun is the same.
      tipRuns(a, [failed(), { name: "build", status: "queued", conclusion: null }]);
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["released"]);
      expect(r.mergeCalls()).toEqual([]);

      // The rerun completes green: the failure is replaced by a pass, and the first tick after that merges.
      tipRuns(a, [failed(), ok()]);
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["merged", "idle"]);
      expect(r.mergeCalls()).toEqual([7]);
    });

    it("a rerun that completes red stays red", async () => {
      const r = await start();
      const a = await r.addItem(7);
      tipRuns(a, [failed(), failed()]);
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["released"]);
      expect(r.mergeCalls()).toEqual([]);
    });

    it("the last completed green run is never used while a rerun is going after a failure (a pass in between does not clear the earlier failure)", async () => {
      const r = await start();
      const a = await r.addItem(7);
      tipRuns(a, [failed(), ok(), going()]);
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["released"]);
      expect(r.mergeCalls()).toEqual([]);
      // The same snapshot through the reader itself: red, a rerun, and it names the earlier failed run's check.
      const port = createGitHubMergeGatePort({ http: r.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined });
      expect(await readMainGuard(port, { repoId: r.repoId, prNumber: 7 })).toMatchObject({ verdict: "red", rerun: true, check: { name: "build" } });
    });

    it("a run still going with no failure before it is not red and not green: it waits", async () => {
      const r = await start();
      const a = await r.addItem(7);
      tipRuns(a, [ok(), going()]);
      const out = await runQueueTick(r.deps(), r);
      expect(out.steps).toEqual([{ step: "parked", entryId: a.entryId, why: "main_ci_unknown" }]);
      expect(r.mergeCalls()).toEqual([]);
      expect(await events(r)).toEqual([]);
    });
  });

  describe("3. the newest result on the exact tip sha", () => {
    const OLD = "d".repeat(40);
    const NEW = "e".repeat(40);
    const move = (a: QueueItem, from: string, to: string) => {
      a.g.world.baseTipSha = to;
      a.g.world.baseShas = [to, from];
    };

    it("a red run on a sha that is no longer the tip does not block", async () => {
      const r = await start();
      const a = await r.addItem(7);
      move(a, OLD, NEW);
      a.g.world.checkRunsBySha = { [OLD]: [failed()], [NEW]: [ok()] };
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["merged", "idle"]);
    });

    it("a green run for an older sha does not clear a red tip", async () => {
      const r = await start();
      const a = await r.addItem(7);
      move(a, OLD, NEW);
      a.g.world.checkRunsBySha = { [OLD]: [ok()], [NEW]: [failed()] };
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["released"]);
      expect(r.mergeCalls()).toEqual([]);
    });

    it("no CI result at all for the tip: it waits, bounded by the CI wait, then main_ci_unknown; it is never read as green", async () => {
      const r = await start();
      const a = await r.addItem(7, { approvedAt: T0 });
      tipRuns(a, []);
      const at = (m: number) => () => new Date(Date.now() + m * MIN);
      expect((await runQueueTick(r.deps(), r)).steps).toEqual([{ step: "parked", entryId: a.entryId, why: "main_ci_unknown" }]);
      expect(await r.entry(7)).toMatchObject({ state: "in_flight" });
      expect((await runQueueTick(r.deps({ now: at(MERGE_QUEUE_CI_WAIT_MINUTES - 1) }), r)).steps.map((s) => s.step)).toEqual(["parked"]);
      const late = await runQueueTick(r.deps({ now: at(MERGE_QUEUE_CI_WAIT_MINUTES + 1) }), r);
      expect(late.steps).toEqual([{ step: "released", entryId: a.entryId, why: "main_ci_unknown" }]);
      expect(r.mergeCalls()).toEqual([]);
      expect(await r.entry(7)).toMatchObject({ state: "queued", approvedAt: T0, slotHolder: null });
      expect(await events(r)).toEqual([{ code: "main_ci_unknown", reasons: [], pr_number: 7, dedupe_key: `${TIP}:main_ci_unknown` }]);
    });

    it("an incomplete listing (fewer runs than the API's own count) is unknown, never green", async () => {
      const r = await start();
      const a = await r.addItem(7);
      tipRuns(a, [ok()]);
      const base = r.http;
      const lying = { request: async (req: Parameters<typeof base.request>[0]) => {
        const res = await base.request(req);
        return req.path.endsWith(`/commits/${TIP}/check-runs`) && res.body && typeof res.body === "object" ? { ...res, body: { ...(res.body as object), total_count: 2 } } : res;
      } };
      const port = createGitHubMergeGatePort({ http: lying, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined });
      expect((await readMainGuard(port, { repoId: r.repoId, prNumber: 7 })).verdict).toBe("unknown");
    });
  });

  describe("4. wake-up and copy", () => {
    it("a check_run completing on the tip wakes the queue (a live entry), and the entry merges on the first tick after the tip turns green", async () => {
      const r = await start();
      const a = await r.addItem(7);
      tipRuns(a, [failed(), going()]);
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["released"]);
      tipRuns(a, [failed(), ok()]);
      const woke = await withTenant(db.pureAppUserPool, r.accountId, (c: PoolClient) =>
        applyQueueEvent(c, { accountId: r.accountId, repoId: r.repoId, eventName: "check_run", payload: { action: "completed", check_run: { head_sha: TIP, pull_requests: [] } } }),
      );
      expect(woke).toBe(true);
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["merged", "idle"]);
    });

    it("the Pipeline app's sentence is fixed copy", () => {
      expect(MAIN_RED_SENTENCE).toBe("The main branch is failing its checks. Merging resumes when it passes.");
    });
  });

  describe("5. undo and states", () => {
    it("a fix (or a revert) pushed to the default branch changes the tip, and the guard reads the new one", async () => {
      const r = await start();
      const a = await r.addItem(7, { approvedAt: T0 });
      tipRuns(a, [failed()]);
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["released"]);
      const FIX = "f".repeat(40);
      a.g.world.baseTipSha = FIX;
      a.g.world.baseShas = [FIX, TIP];
      a.g.world.checkRunsBySha = { [TIP]: [failed()], [FIX]: [ok()] };
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["merged", "idle"]);
      expect(await r.entry(7)).toMatchObject({ state: "merged", approvedAt: T0 });
    });

    it("the same event is not written twice for one tip and code, so a stuck red main does not grow the log", async () => {
      const r = await start();
      const a = await r.addItem(7);
      tipRuns(a, [failed()]);
      await runQueueTick(r.deps(), r);
      await runQueueTick(r.deps(), r);
      expect((await events(r)).length).toBe(1);
    });

    it("auto-merge off is unchanged: a red main waits, and a green one ends where it always did (stopped, a person merges)", async () => {
      const r = await start();
      const a = await r.addItem(7);
      tipRuns(a, [failed()]);
      expect((await runQueueTick(r.deps({ autoMerge: false }), r)).steps.map((s) => s.step)).toEqual(["released"]);
      expect(await r.entry(7)).toMatchObject({ state: "queued" });
      tipRuns(a, [ok()]);
      await runQueueTick(r.deps({ autoMerge: false }), r);
      expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "auto_merge_not_allowed" });
      expect(r.mergeCalls()).toEqual([]);
    });

    it("a disconnected repo's entries are cancelled and the guard reads nothing", async () => {
      const r = await start();
      const a = await r.addItem(7);
      tipRuns(a, [failed()]);
      await withTenant(db.pureAppUserPool, r.accountId, (c: PoolClient) => cancelRepoEntries(c, { accountId: r.accountId, repoId: r.repoId }));
      const before = r.calls.length;
      const out = await runQueueTick(r.deps(), r);
      expect(out.steps.map((s) => s.step)).toEqual(["idle"]);
      expect(r.calls.length).toBe(before);
      expect((await r.entry(7)).state).toBe("cancelled");
    });
  });

  describe("the tip read", () => {
    it("asks for the default branch's own ref and every run of the tip's sha, once each", async () => {
      const r = await start();
      const a = await r.addItem(7);
      tipRuns(a, [failed()]);
      await runQueueTick(r.deps(), r);
      const refs = r.calls.filter((c) => c.path.includes("/git/ref/"));
      expect(refs.map((c) => c.path)).toEqual(["/repos/acme/widgets/git/ref/heads/main"]);
      const tipRead = r.calls.filter((c) => c.path.endsWith(`/commits/${TIP}/check-runs`));
      expect(tipRead.map((c) => JSON.parse(c.query ?? "{}").filter)).toEqual(["all"]);
    });
  });
});
