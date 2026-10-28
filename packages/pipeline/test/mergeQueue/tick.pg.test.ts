import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import { classifyCi, expectedSignalNames, greenSignalNames, missingExpectedSignals, runMergeGate, type CiSnapshot } from "../../src/build/mergeGate.js";
import { MERGE_QUEUE_CI_WAIT_MINUTES, finishWork, requeueCiStopped, runQueueTick, sweepMergeQueue, type MergeQueueEntry } from "../../src/mergeQueue/index.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { T0, startQueueRepo, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#519 MQ3-b: the queue tick over real Postgres (a plain `app_user` pool, row security in force) and strict GitHub fakes served over
 * real TLS. What it pins: the recheck of every queued entry at once (unknown is WAIT, never a conflict), the newest-run CI rule and the
 * expected-signal rule (acceptance 16), a red slot holder releasing the slot, a pending one parking it (bounded by 60 minutes), the
 * serial merge against a freshly compared main, and that two ticks end with one merge call.
 */
const MIN = 60_000;
let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("D#519 MQ3-b queue tick [pg]", () => {
  const db = pgHarness();
  const start = async (opts: Parameters<typeof startQueueRepo>[1] = {}) => {
    const r = await startQueueRepo(db, opts);
    repos.push(r);
    return r;
  };
  const states = async (r: QueueRepo) => Object.fromEntries(await Promise.all([...r.items.keys()].map(async (pr) => [pr, (await r.entry(pr)).state])));
  const tenant = <T>(r: QueueRepo, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, r.accountId, fn);
  const reviewed = [{ name: "build", status: "completed" as const, conclusion: "success" }, { name: "lint", status: "completed" as const, conclusion: "success" }];

  it("a clean, up-to-date entry merges once, on the reviewed head, and the gate's merge is recorded as the gate's", async () => {
    const r = await start();
    const a = await r.addItem(7);
    const out = await runQueueTick(r.deps(), r);
    expect(out.steps.map((s) => s.step)).toEqual(["merged", "idle"]);
    expect(a.g.world.merges).toEqual([{ sha: a.head, method: "squash" }]);
    const e = await r.entry(7);
    expect(e.state).toBe("merged");
    expect(e.mergedBy).toBe("gate");
    expect(e.slotHolder).toBeNull();
  });

  describe("unknown mergeability is WAIT (TL lesson 1)", () => {
    it("a PR whose mergeable flag is still null is not a conflict, is not stopped, does not block the entries behind it, and merges once GitHub answers", async () => {
      const r = await start();
      const slow = await r.addItem(7, { approvedAt: T0, world: { neverComputes: true } });
      await r.addItem(8, { approvedAt: new Date(T0.getTime() + MIN) });
      const first = await runQueueTick(r.deps(), r);
      expect(first.waiting).toEqual([slow.entryId]);
      expect(first.conflicted).toEqual([]);
      expect(r.mergeCalls()).toEqual([8]);
      expect(await states(r)).toEqual({ 7: "queued", 8: "merged" });
      expect((await r.entry(7)).reason).toBeNull();

      slow.g.world.neverComputes = false;
      const second = await runQueueTick(r.deps(), r);
      expect(second.waiting).toEqual([]);
      expect(r.mergeCalls()).toEqual([8, 7]);
    });

    it("a read that throws leaves that one entry waiting; the others still go", async () => {
      const r = await start();
      const bad = await r.addItem(7, { approvedAt: T0 });
      await r.addItem(8, { approvedAt: new Date(T0.getTime() + MIN) });
      const flaky = r.deps();
      const real = flaky.github.getMergeability.bind(flaky.github);
      flaky.github = { ...flaky.github, getMergeability: async (pr, o) => (pr.prNumber === 7 ? Promise.reject(new Error("socket hang up")) : real(pr, o)) };
      const out = await runQueueTick(flaky, r);
      expect(out.waiting).toContain(bad.entryId);
      expect(r.mergeCalls()).toEqual([8]);
      expect((await r.entry(7)).state).toBe("queued");
    });
  });

  describe("after a merge every queued entry is rechecked at once (TL lesson 4)", () => {
    it("a conflict is seen on the recheck BEFORE the first merge call, without waiting to reach the head of the queue", async () => {
      const r = await start();
      await r.addItem(7, { approvedAt: T0 });
      await r.addItem(9, { approvedAt: new Date(T0.getTime() + 2 * MIN), world: { conflict: true } });
      const seen: number[] = [];
      const out = await runQueueTick(r.deps({ onConflict: async () => (seen.push(r.mergeCalls().length), false) }), r);
      expect(out.conflicted).toEqual([r.items.get(9)!.entryId]);
      expect(seen).toEqual([0]); // handed to MQ4's port before any merge
      expect(r.mergeCalls()).toEqual([7]);
      const nine = await r.entry(9);
      expect(nine.state).toBe("stopped");
      expect(nine.reason).toBe("merge_conflict");
    });

    it("MQ4's port that starts a fix round takes the entry itself; the tick stops nothing", async () => {
      const r = await start();
      await r.addItem(9, { world: { conflict: true } });
      await runQueueTick(r.deps({ onConflict: async () => true }), r);
      expect((await r.entry(9)).state).toBe("queued");
    });

    it("the recheck runs again after each merge: a PR that conflicts only once main moved is caught before it takes the slot", async () => {
      const r = await start();
      const a = await r.addItem(7, { approvedAt: T0 });
      const b = await r.addItem(8, { approvedAt: new Date(T0.getTime() + MIN) });
      a.g.world.onMerge = () => {
        b.g.world.conflict = true; // 8 now conflicts with what 7 brought
      };
      const seen: Array<{ pr: number; at: number }> = [];
      const out = await runQueueTick(r.deps({ onConflict: async (e) => (seen.push({ pr: e.prNumber, at: r.mergeCalls().length }), false) }), r);
      expect(seen).toEqual([{ pr: 8, at: 1 }]);
      expect(out.conflicted).toEqual([b.entryId]);
      expect(r.mergeCalls()).toEqual([7]); // 8 never reached a merge call
      expect((await r.entry(8)).reason).toBe("merge_conflict");
    });
  });

  describe("acceptance 16: stale green (the expected-signal rule)", () => {
    const statuses = { "fulcrumaxe/review": "success" as const };
    it("only our own review status is green on the refreshed head while a check that was green on the reviewed head has not posted: no merge; it merges once that check posts green", async () => {
      const r = await start();
      const a = await r.addItem(7, { world: { behindBy: 1, statuses, checkRunsBySha: {} } });
      a.g.world.checkRunsBySha = { [a.head]: reviewed, [a.fresh]: [] };
      const first = await runQueueTick(r.deps(), r);
      expect(first.steps.map((s) => s.step)).toEqual(["parked"]);
      expect(a.g.world.updates).toEqual([{ expected: a.head }]);
      expect(a.g.world.merges).toEqual([]);
      const held = await r.entry(7);
      expect(held.state).toBe("in_flight");
      expect(held.phase).toBe("parked");

      // `build` posts, `lint` has not: still no merge.
      a.g.world.checkRunsBySha[a.fresh] = [reviewed[0]!];
      const second = await runQueueTick(r.deps(), r);
      expect(second.steps.map((s) => s.step)).toEqual(["parked"]);
      expect(a.g.world.merges).toEqual([]);

      a.g.world.checkRunsBySha[a.fresh] = reviewed;
      const third = await runQueueTick(r.deps(), r);
      expect(third.steps.map((s) => s.step)).toEqual(["merged", "idle"]);
      expect(a.g.world.merges).toEqual([{ sha: a.fresh, method: expect.anything() }]);
    });

    it("the gate itself refuses the same head when it is handed the expected signals (a caller that skipped the tick's wait)", async () => {
      const r = await start();
      const a = await r.addItem(7, { world: { statuses, checkRunsBySha: {} } });
      a.g.world.checkRunsBySha = { [a.head]: [] };
      const out = await runMergeGate(
        { pool: db.runWriterPool, github: r.deps().github as never, isAutoMergeAllowed: async () => true, requestReviews: async () => undefined },
        { accountId: r.accountId, workItemId: a.workItemId, pr: { repoId: r.repoId, prNumber: 7 }, tier: "small", securityDiffTriggerFired: false, debaterEnabled: false, expectedSignals: ["build"] },
      );
      expect(out).toMatchObject({ outcome: "ready_human_merges", reasons: ["ci_not_green"] });
      expect(a.g.world.merges).toEqual([]);
    });
  });

  describe("review fixes: the expected set cannot shrink, and the gate is pinned to the head CI was checked on", () => {
    it("a check that was green on the reviewed head and is being re-run there still has to run on the refreshed head (the set is every name present, not the ones green now)", async () => {
      const r = await start();
      const a = await r.addItem(7, { world: { behindBy: 1 } });
      a.g.world.checkRunsBySha = {
        [a.head]: [{ name: "build", status: "completed", conclusion: "success" }, { name: "build", status: "in_progress", conclusion: null }, { name: "lint", status: "completed", conclusion: "success" }],
        [a.fresh]: [{ name: "lint", status: "completed", conclusion: "success" }],
      };
      const out = await runQueueTick(r.deps(), r);
      expect(out.steps.map((s) => s.step)).toEqual(["parked"]);
      expect(a.g.world.merges).toEqual([]);
      // Once `build` has run green on the refreshed head, it merges.
      a.g.world.checkRunsBySha[a.fresh] = [{ name: "build", status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: "success" }];
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["merged", "idle"]);
    });

    it("a force-push back to the reviewed head after the tick checked CI on the refreshed head: the gate answers head_moved, nothing is merged, and the entry goes back to review", async () => {
      const r = await start();
      const a = await r.addItem(7, { world: { behindBy: 1 } });
      const base = r.deps();
      const out = await runQueueTick(
        {
          ...base,
          gate: async (args) => {
            expect(args.headSha).toBe(a.fresh);
            a.g.world.headSha = a.head; // both heads are green; the branch is put back inside the gate call
            return base.gate(args);
          },
        },
        r,
      );
      expect(out.steps.map((s) => s.step)).toEqual(["released", "idle"]);
      expect(a.g.world.merges).toEqual([]);
      expect((await r.entry(7)).state).toBe("in_review");
    });

    it("control: the gauge reads 2 for two merge calls that really overlap, so a 1 for the queue means something", async () => {
      const r = await start();
      const gauge = { now: 0, max: 0 };
      await r.addItem(7, { world: { mergeGauge: gauge, mergeDelayMs: 25 } });
      await r.addItem(8, { world: { mergeGauge: gauge, mergeDelayMs: 25 } });
      const port = createGitHubMergeGatePort({ http: r.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, mergeMethod: "squash" });
      const shaOf7 = r.items.get(7)!.head;
      const shaOf8 = r.items.get(8)!.head;
      await Promise.all([port.mergePullRequest({ repoId: r.repoId, prNumber: 7 }, { sha: shaOf7 }), port.mergePullRequest({ repoId: r.repoId, prNumber: 8 }, { sha: shaOf8 })]);
      expect(gauge.max).toBe(2);
    });
  });

  describe("only the newest run at the head counts (TL lesson 2)", () => {
    it("a green run followed by a re-run still in progress is not green: the older green run is never used", async () => {
      const r = await start();
      const a = await r.addItem(7);
      a.g.world.checkRunsBySha = { [a.head]: [{ name: "build", status: "completed", conclusion: "success" }, { name: "build", status: "in_progress", conclusion: null }] };
      const out = await runQueueTick(r.deps(), r);
      expect(out.steps.map((s) => s.step)).toEqual(["parked"]);
      expect(a.g.world.merges).toEqual([]);
      // The head's CI is read as the newest run of each check; the default branch's tip (the guard) is read with every run of it.
      const listed = r.calls.filter((c) => c.path.endsWith("/check-runs") && c.path.includes(a.head));
      expect(listed.length).toBeGreaterThan(0);
      expect(listed.every((c) => c.query?.includes('"filter":"latest"'))).toBe(true);
    });

    it("an older green run followed by a newer FAILED one is red, not green", async () => {
      const r = await start();
      const a = await r.addItem(7);
      a.g.world.checkRunsBySha = { [a.head]: [{ name: "build", status: "completed", conclusion: "success" }, { name: "build", status: "completed", conclusion: "failure" }] };
      await runQueueTick(r.deps(), r);
      expect(a.g.world.merges).toEqual([]);
      expect((await r.entry(7)).reason).toBe("ci_not_green");
    });
  });

  describe("a red slot holder releases the slot (TL lesson 3)", () => {
    it("fresh CI red on the holder: it stops with ci_not_green and the next eligible entry merges in the same tick", async () => {
      const r = await start();
      const red = await r.addItem(7, { approvedAt: T0 });
      red.g.world.checkRunsBySha = { [red.head]: [{ name: "build", status: "completed", conclusion: "failure" }] };
      await r.addItem(8, { approvedAt: new Date(T0.getTime() + MIN) });
      const out = await runQueueTick(r.deps(), r);
      expect(out.steps.map((s) => s.step)).toEqual(["released", "merged", "idle"]);
      expect(r.mergeCalls()).toEqual([8]);
      expect(await states(r)).toEqual({ 7: "stopped", 8: "merged" });
      expect((await r.entry(7)).reason).toBe("ci_not_green");
    });

    it("the red entry comes back at its original place when a check finishes on its head or its pull request, and any other stop stays", async () => {
      const r = await start();
      const red = await r.addItem(7, { approvedAt: T0 });
      red.g.world.checkRunsBySha = { [red.head]: [{ name: "build", status: "completed", conclusion: "failure" }] };
      const conflicted = await r.addItem(9, { world: { conflict: true } });
      await runQueueTick(r.deps(), r);
      expect(await states(r)).toEqual({ 7: "stopped", 9: "stopped" });

      red.g.world.checkRunsBySha = {}; // re-run, green
      const back = await tenant(r, (c) => requeueCiStopped(c, { accountId: r.accountId, repoId: r.repoId, headSha: red.head }));
      expect(back.map((e) => e.prNumber)).toEqual([7]);
      expect(back[0]!.approvedAt).toEqual(T0);
      expect((await r.entry(9)).reason).toBe("merge_conflict");
      expect(conflicted.entryId).toBe((await r.entry(9)).id);
      await runQueueTick(r.deps(), r);
      expect(r.mergeCalls()).toEqual([7]);

      // By pull request number, and a head it was refreshed to.
      expect(await tenant(r, (c) => requeueCiStopped(c, { accountId: r.accountId, repoId: r.repoId, prNumbers: [9] }))).toEqual([]);
    });
  });

  describe("pending CI parks the slot, bounded by the CI wait (acceptance 4b)", () => {
    it("a pending holder keeps the slot, so nothing behind it overtakes; the next tick adopts it and merges when CI is green", async () => {
      const r = await start();
      const slow = await r.addItem(7, { approvedAt: T0 });
      slow.g.world.checkRunsBySha = { [slow.head]: [{ name: "build", status: "in_progress", conclusion: null }] };
      await r.addItem(8, { approvedAt: new Date(T0.getTime() + MIN) });
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["parked"]);
      expect(await states(r)).toEqual({ 7: "in_flight", 8: "queued" });
      expect(r.mergeCalls()).toEqual([]);
      // Still pending: the same holder is adopted again (one holder throughout), still nothing.
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["parked"]);

      slow.g.world.checkRunsBySha = {};
      const out = await runQueueTick(r.deps(), r);
      expect(out.steps.map((s) => s.step)).toEqual(["merged", "merged", "idle"]);
      expect(r.mergeCalls()).toEqual([7, 8]);
    });

    it(`after ${MERGE_QUEUE_CI_WAIT_MINUTES} minutes from the refresh the holder releases the slot with ci_not_green and the next entry goes`, async () => {
      const r = await start();
      const slow = await r.addItem(7, { approvedAt: T0, world: { behindBy: 1 } });
      slow.g.world.checkRunsBySha = { [slow.head]: reviewed, [slow.fresh]: [{ name: "build", status: "in_progress", conclusion: null }] };
      await r.addItem(8, { approvedAt: new Date(T0.getTime() + MIN) });
      expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["parked"]);
      // 59 minutes on: still waiting. 61 minutes on: released.
      const at = (m: number) => () => new Date(Date.now() + m * MIN);
      expect((await runQueueTick(r.deps({ now: at(MERGE_QUEUE_CI_WAIT_MINUTES - 1) }), r)).steps.map((s) => s.step)[0]).toBe("parked");
      const late = await runQueueTick(r.deps({ now: at(MERGE_QUEUE_CI_WAIT_MINUTES + 1) }), r);
      expect(late.steps.map((s) => s.step)).toEqual(["released", "merged", "idle"]);
      expect((await r.entry(7)).reason).toBe("ci_not_green");
      expect(r.mergeCalls()).toEqual([8]);
    });
  });

  describe("serial merges (TL lesson 5) and a safe concurrent tick", () => {
    it("two ticks at the same time make exactly one merge call per pull request, and never two in flight", async () => {
      const r = await start();
      const gauge = { now: 0, max: 0 };
      for (const pr of [7, 8]) {
        const it = await r.addItem(pr, { approvedAt: new Date(T0.getTime() + pr * MIN), world: { mergeGauge: gauge, mergeDelayMs: 25 } });
        expect(it.pr).toBe(pr);
      }
      await Promise.all([runQueueTick(r.deps(), r), runQueueTick(r.deps(), r)]);
      expect([...r.mergeCalls()].sort()).toEqual([7, 8]);
      expect(gauge.max).toBe(1);
      expect(await states(r)).toEqual({ 7: "merged", 8: "merged" });
    });

    it("the sweep drives the same tick: a repo with a lapsed lease gets its entry back and merged", async () => {
      const r = await start();
      await r.addItem(7);
      const deps = r.deps();
      await runQueueTick({ ...deps, gate: async () => { throw new Error("crashed mid-step"); } }, r).catch(() => undefined);
      expect((await r.entry(7)).state).toBe("in_flight");
      const later = new Date(Date.now() + 10 * MIN);
      const swept = await sweepMergeQueue({
        listTargets: async () => [{ accountId: r.accountId, repoId: r.repoId }],
        inTenant: deps.inTenant,
        tick: async (t) => void (await runQueueTick({ ...deps, now: () => later }, t)),
        now: later,
      });
      expect(swept).toMatchObject({ reclaimed: 1, ticked: 1, failed: 0 });
      expect((await r.entry(7)).state).toBe("merged");
    });
  });

  describe("refresh outcomes (MQ3-a) through the tick", () => {
    const overlap = { files: [{ filename: "src/a.ts" }], mainFiles: [{ filename: "src/a.ts" }] };

    it("overlapping files release the slot for a delta review and the next entry merges; the first returns at its original approved_at", async () => {
      const starts: Array<{ pr: number; slotAtStart: string | null }> = [];
      const r = await start({
        onDeltaReview: async (c, a) => {
          starts.push({ pr: a.entry.prNumber, slotAtStart: (await c.query(`SELECT slot_holder FROM merge_queue_entries WHERE id = $1`, [a.entry.id])).rows[0].slot_holder });
          return { started: true, runId: null };
        },
      });
      const first = await r.addItem(7, { approvedAt: T0, world: { behindBy: 1, ...overlap } });
      await r.addItem(8, { approvedAt: new Date(T0.getTime() + MIN) });
      const out = await runQueueTick(r.deps(), r);
      expect(out.steps.map((s) => s.step)).toEqual(["released", "merged", "idle"]);
      expect(starts).toEqual([{ pr: 7, slotAtStart: null }]);
      expect(r.mergeCalls()).toEqual([8]);
      const waiting = await r.entry(7);
      expect(waiting).toMatchObject({ state: "awaiting_work", workKind: "delta_review" });

      // The delta review passed: the entry is back in the queue at its original place, so it is picked before anything approved later.
      const late = await r.addItem(9, { approvedAt: new Date(T0.getTime() + 5 * MIN) });
      const back = await tenant(r, (c) => finishWork(c, { accountId: r.accountId, entryId: first.entryId, headSha: first.fresh }));
      expect(back?.approvedAt).toEqual(T0);
      expect(back?.state).toBe("queued");
      expect(late.pr).toBe(9);
      const queue = await r.queue();
      expect(queue.filter((e) => e.state === "queued").map((e) => e.prNumber)).toEqual([7, 9]);
    });

    it("a delta review refused for spend stops that entry only (refused_spend) and the queue goes on", async () => {
      const r = await start({ onDeltaReview: async () => ({ started: false, reason: "refused_spend" }) });
      await r.addItem(7, { approvedAt: T0, world: { behindBy: 1, ...overlap } });
      await r.addItem(8, { approvedAt: new Date(T0.getTime() + MIN) });
      await runQueueTick(r.deps(), r);
      expect((await r.entry(7)).reason).toBe("refused_spend");
      expect(r.mergeCalls()).toEqual([8]);
    });

    it("a head that is not our platform refresh sends the entry back to review and releases the slot", async () => {
      const r = await start();
      await r.addItem(7, { approvedAt: T0, world: { behindBy: 1, refreshAuthorLogin: "someone-else" } });
      await r.addItem(8, { approvedAt: new Date(T0.getTime() + MIN) });
      await runQueueTick(r.deps(), r);
      expect((await r.entry(7)).state).toBe("in_review");
      expect(r.mergeCalls()).toEqual([8]);
    });

    it("update-branch refusing on a conflict goes to the conflict port, then the next entry goes", async () => {
      const r = await start();
      // Not dirty on the recheck (mergeable is true), but update-branch answers 422 with an unmoved head and the PR then reads mergeable:false.
      const a = await r.addItem(7, { approvedAt: T0, world: { behindBy: 1 } });
      a.g.world.updateAnswer = undefined;
      const held: string[] = [];
      let reads = 0;
      const deps = r.deps({ onConflict: async (e) => (held.push(String(e.prNumber)), false) });
      const real = deps.github.getMergeability.bind(deps.github);
      deps.github = { ...deps.github, getMergeability: async (pr, o) => ((await real(pr, o)), ++reads <= 1 ? real(pr, o) : (a.g.world.conflict = true, real(pr, o))) };
      await r.addItem(8, { approvedAt: new Date(T0.getTime() + MIN) });
      await runQueueTick(deps, r);
      expect(held).toContain("7");
      expect(r.mergeCalls()).toEqual([8]);
    });
  });

  describe("the gate refuses for a reason that needs a person", () => {
    it("auto-merge off: the entry stops with that code, the slot is free, nothing merged", async () => {
      const r = await start();
      await r.addItem(7);
      const out = await runQueueTick(r.deps({ autoMerge: false }), r);
      expect(out.steps.map((s) => s.step)).toEqual(["released", "idle"]);
      expect(r.mergeCalls()).toEqual([]);
      expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "auto_merge_not_allowed", slotHolder: null });
    });

    it("a head that moved under the gate sends the entry back to review", async () => {
      const r = await start();
      const a = await r.addItem(7);
      const deps = r.deps();
      await runQueueTick({ ...deps, gate: async () => ({ outcome: "head_moved" }) }, r);
      expect((await r.entry(7)).state).toBe("in_review");
      expect(a.g.world.merges).toEqual([]);
    });
  });
});

describe("D#519 MQ3-b CI classification (no database)", () => {
  const snap = (over: Partial<CiSnapshot> = {}): CiSnapshot => ({ headSha: "a".repeat(40), checkRuns: [], checkRunsTotalCount: 0, statuses: [], statusesTotalCount: 0, requiredContexts: [], requiredAppChecks: [], ...over });
  const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });
  const head = "a".repeat(40);
  const withRuns = (runs: ReturnType<typeof run>[], statuses: Array<{ context: string; state: string }> = []) => snap({ checkRuns: runs, checkRunsTotalCount: runs.length, statuses, statusesTotalCount: statuses.length });

  it("green, red and pending are told apart; an incomplete or foreign snapshot waits", () => {
    expect(classifyCi(withRuns([run("build", "completed", "success")]), head)).toBe("green");
    expect(classifyCi(withRuns([run("build", "completed", "failure")]), head)).toBe("red");
    expect(classifyCi(withRuns([run("build", "completed", "success"), run("e2e", "in_progress", null)]), head)).toBe("pending");
    expect(classifyCi(withRuns([], [{ context: "ci", state: "failure" }]), head)).toBe("red");
    expect(classifyCi(withRuns([], [{ context: "ci", state: "pending" }]), head)).toBe("pending");
    expect(classifyCi(withRuns([]), head)).toBe("pending"); // no signal at all is not proven
    expect(classifyCi(withRuns([run("build", "completed", "success")]), "b".repeat(40))).toBe("pending"); // for another sha
    expect(classifyCi({ ...withRuns([run("build", "completed", "success")]), checkRunsTotalCount: 2 }, head)).toBe("pending"); // cut at a page
    expect(classifyCi({ ...withRuns([run("build", "completed", "success")]), protectionUnreadable: true }, head)).toBe("pending");
  });

  it("the expected signals must all be present and green; our own review status is not one of them", () => {
    const reviewed = withRuns([run("build", "completed", "success"), run("lint", "completed", "skipped")], [{ context: "fulcrumaxe/review", state: "success" }, { context: "ci/legacy", state: "success" }]);
    expect(greenSignalNames(reviewed).sort()).toEqual(["build", "ci/legacy", "lint"]);
    // The set a refreshed head must show is every name present, in any state, except our own status.
    const rerun = withRuns([run("build", "in_progress", null), run("lint", "completed", "failure")], [{ context: "fulcrumaxe/review", state: "success" }, { context: "ci/legacy", state: "pending" }]);
    expect(expectedSignalNames(rerun).sort()).toEqual(["build", "ci/legacy", "lint"]);
    const fresh = withRuns([run("build", "completed", "success")], [{ context: "fulcrumaxe/review", state: "success" }]);
    expect(missingExpectedSignals(fresh, ["build", "lint", "ci/legacy"])).toEqual(["lint", "ci/legacy"]);
    expect(classifyCi(fresh, head, ["build", "lint"])).toBe("pending");
    expect(classifyCi(withRuns([run("build", "completed", "success"), run("lint", "queued", null)]), head, ["build", "lint"])).toBe("pending");
    expect(classifyCi(withRuns([run("build", "completed", "success"), run("lint", "completed", "success")]), head, ["build", "lint"])).toBe("green");
  });
});

export type { MergeQueueEntry };
