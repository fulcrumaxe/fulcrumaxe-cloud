import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import { runMergeGate } from "../../src/build/mergeGate.js";
import { createStartDeltaReview, enqueueEntry, runQueueTick, runRefreshStep, takeSlot, type DeltaReviewPorts, type MergeQueueEntry } from "../../src/mergeQueue/index.js";
import type { DeltaReviewInput } from "../../src/review/reviewPrompts.js";
import { startMergeTlsGitHub, type MergeTlsGitHub, type MergeWorld } from "../review/helpers/fakeGitHubMergeTls.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#519 MQ3-b-2a (C4 2.7 tests 5 to 9, with test 6 per the TL ruling that a delta review runs every role the gate requires): the real
 * `startDeltaReview` port over real Postgres (a plain `app_user` pool, row security in force) and the strict GitHub fake over real TLS.
 * The roles' runs are written to `agent_runs` by the fake starter, so "no run row" and "the run's cancel" are read from the tables.
 */
const T0 = new Date("2026-10-27T10:00:00Z");
const HEAD = "a".repeat(40);
const REFRESHED = "b".repeat(40);
const BOT = "fulcrumaxe-app[bot]";
const PR = 7;

let open: MergeTlsGitHub[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

describe("D#519 MQ3-b-2a delta-review port [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, accountId, fn);

  interface Setup {
    accountId: string;
    repoId: string;
    workItemId: string;
    entry: MergeQueueEntry;
    g: MergeTlsGitHub;
    started: Array<{ role: string; delta: DeltaReviewInput }>;
    cancelled: string[];
    skips: string[];
    run(): ReturnType<typeof runRefreshStep>;
    port: ReturnType<typeof createStartDeltaReview>;
  }

  const count = async (accountId: string, table: string) => Number((await db.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE account_id = $1`, [accountId])).rows[0].n);
  const entryRow = async (id: string) => (await db.admin.query(`SELECT * FROM merge_queue_entries WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;

  async function setup(
    world: Partial<MergeWorld> = {},
    o: { roles?: string[]; refuseRole?: string; refuseWith?: string; prFiles?: string[]; planFails?: string; beforeRead?: (g: MergeTlsGitHub) => void } = {},
  ): Promise<Setup> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: PR });
    const created = await tenant(accountId, (c) => enqueueEntry(c, { accountId, repoId, workItemId, prNumber: PR, headSha: HEAD, approvedAt: T0 }));
    const taken = await tenant(accountId, (c) => takeSlot(c, { accountId, repoId, holder: "tick-1", facts: new Map([[created.entry.id, { open: true, draft: false }]]) }));
    const g = await startMergeTlsGitHub({ prNumber: PR, behindBy: 1, classicStrict: true, files: [{ filename: "src/a.ts" }], mainFiles: [{ filename: "src/a.ts" }], ...world });
    open.push(g);
    const gh = createGitHubMergeGatePort({ http: g.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, sleep: async () => undefined, mergeablePollLimit: 3 });
    const started: Setup["started"] = [];
    const cancelled: string[] = [];
    const skips: string[] = [];
    const ports: DeltaReviewPorts = {
      // A second read of the PR's files that disagrees with the first: the refresh step saw an overlap, the port sees none (a race).
      github: {
        ...gh,
        // Something happens on GitHub between the refresh being applied and the review being started: the port's first read sees it.
        getMergeability: async (pr, opts) => (o.beforeRead?.(g), gh.getMergeability(pr, opts)),
        compareToBase: async (pr, sha, opts) => (o.prFiles ? { ...(await gh.compareToBase(pr, sha, opts)), files: o.prFiles } : gh.compareToBase(pr, sha, opts)),
      },
      plan: async () => (o.planFails ? { ok: false, reason: o.planFails } : { ok: true, roles: o.roles ?? ["code-reviewer", "acceptance-tester"] }),
      startRole: async ({ role, delta }) => {
        if (role === o.refuseRole) return { ok: false, reason: o.refuseWith ?? "refused_spend" };
        started.push({ role, delta });
        const id = randomUUID();
        await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, $4, 'production', 'running', $5)`, [id, accountId, workItemId, role, delta.mergeCommitSha]);
        return { ok: true, runId: id };
      },
      cancelRun: async (_e, runId) => {
        cancelled.push(runId);
        await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [runId]);
      },
      runs: async () => [],
      recordEvent: async ({ toSha, code }) => void (code === "main_side_only" && skips.push(toSha)),
    };
    const port = createStartDeltaReview(ports);
    const entry = taken.taken!;
    const deps = { github: gh, inTenant: tenant, ourLogin: BOT, gate: async () => undefined, startDeltaReview: port, sleep: async () => undefined, pollIntervalMs: 0, pollLimit: 4 };
    return { accountId, repoId, workItemId, entry, g, started, cancelled, skips, port, run: () => runRefreshStep(deps, { accountId, entry, holder: "tick-1", pr: { repoId, prNumber: PR } }) };
  }

  describe("5. the binding reads the stored row, never the caller", () => {
    it("a caller-supplied different sha is ignored: the run is for the row's merge commit and parents", async () => {
      const s = await setup();
      expect(await s.run()).toMatchObject({ outcome: "needs_delta_review", toSha: REFRESHED });
      expect(s.started.map((x) => x.delta)).toEqual([
        { mergeCommitSha: REFRESHED, parents: [HEAD, s.g.world.baseTipSha], parentRoles: ["pr_side", "main_side"], changedFiles: ["src/a.ts"], trigger: "refresh_overlap" },
        expect.anything(),
      ]);
      // Called again by hand with lies about the shas: it finds the row by the merge commit and builds everything else from the row.
      await db.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE account_id = $1`, [s.accountId]);
      const lied = await tenant(s.accountId, (c) => s.port(c, { entry: s.entry, fromSha: "1".repeat(40), toSha: REFRESHED, baseSha: "2".repeat(40) }));
      expect(lied).toMatchObject({ started: true });
      expect(s.started[2]!.delta.parents).toEqual([HEAD, s.g.world.baseTipSha]);
      // A merge commit the table has no row for starts nothing, whatever the caller says about its parents.
      const none = await tenant(s.accountId, (c) => s.port(c, { entry: s.entry, fromSha: HEAD, toSha: "3".repeat(40), baseSha: s.g.world.baseTipSha }));
      expect(none).toEqual({ started: false, reason: "invalid_input" });
    });

    it("a head on GitHub that differs from the row (a person pushed): head_changed, the entry is back in review at its original place, and no run exists", async () => {
      const s = await setup({}, { beforeRead: (g) => void (g.world.headSha = "c".repeat(40)) });
      expect(await s.run()).toEqual({ outcome: "delta_not_started", fromSha: HEAD, toSha: REFRESHED, reason: "head_changed" });
      expect(s.started).toEqual([]);
      expect(await count(s.accountId, "agent_runs")).toBe(0);
      expect(await entryRow(s.entry.id)).toMatchObject({ state: "in_review", slot_holder: null, work_kind: null, approved_at: T0 });
    });

    it("a merge commit whose parents are not the row's two: head_changed", async () => {
      const s = await setup({}, { beforeRead: (g) => void (g.world.commits[g.world.refreshedHeadSha]!.parents = [HEAD, "8".repeat(40)]) });
      expect(await s.run()).toMatchObject({ outcome: "delta_not_started", reason: "head_changed" });
      expect(await count(s.accountId, "agent_runs")).toBe(0);
    });
  });

  describe("6. roles: every role the gate requires, no debater here", () => {
    it("a plan without a security reviewer starts the code reviewer and the acceptance tester, once each", async () => {
      const s = await setup({}, { roles: ["code-reviewer", "acceptance-tester"] });
      expect((await s.run()).outcome).toBe("needs_delta_review");
      expect(s.started.map((x) => x.role)).toEqual(["code-reviewer", "acceptance-tester"]);
      expect(await count(s.accountId, "agent_runs")).toBe(2);
    });
    it("a plan with the security reviewer (the gate requires it) starts it too, even when the merge commit's own files are not a security surface", async () => {
      const s = await setup({}, { roles: ["code-reviewer", "acceptance-tester", "security-reviewer"] });
      expect((await s.run()).outcome).toBe("needs_delta_review");
      expect(s.started.map((x) => x.role)).toEqual(["code-reviewer", "acceptance-tester", "security-reviewer"]);
    });
    it("the debater is not started by the port (it follows the others' passes)", async () => {
      const s = await setup({}, { roles: ["code-reviewer", "acceptance-tester", "debater"] });
      await s.run();
      expect(s.started.map((x) => x.role)).not.toContain("debater");
    });
    it("a plan with no code reviewer, or one that cannot be made, starts nothing and sends the entry to review", async () => {
      const a = await setup({}, { roles: ["acceptance-tester"] });
      expect(await a.run()).toMatchObject({ outcome: "delta_not_started", reason: "invalid_input" });
      const b = await setup({}, { planFails: "spec_changed" });
      expect(await b.run()).toMatchObject({ outcome: "delta_not_started", reason: "spec_changed" });
      expect(await count(b.accountId, "agent_runs")).toBe(0);
      expect(await entryRow(b.entry.id)).toMatchObject({ state: "in_review", slot_holder: null });
    });
  });

  describe("7. a merge commit that touches only files from main is skipped", () => {
    it("main_side_only: zero runs, the skip stored on the row and as an event, the entry queued at its original approved_at, and the gate carries the passes", async () => {
      // The refresh step saw an overlap; the port's own read of the PR's files shows none of the merge's files among them.
      const s = await setup({}, { prFiles: ["src/unrelated.ts"] });
      for (const role of ["code-reviewer", "acceptance-tester"]) await db.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, 'production', 'succeeded', '{"verdict":"pass"}', $4)`, [s.accountId, s.workItemId, role, HEAD]);
      const before = await count(s.accountId, "agent_runs");
      expect(await s.run()).toEqual({ outcome: "delta_skipped", fromSha: HEAD, toSha: REFRESHED });
      expect(s.started).toEqual([]);
      expect(await count(s.accountId, "agent_runs")).toBe(before);
      expect(s.skips).toEqual([REFRESHED]);
      expect((await db.admin.query(`SELECT delta_review_skipped FROM head_refreshes WHERE account_id = $1`, [s.accountId])).rows).toEqual([{ delta_review_skipped: "main_side_only" }]);
      expect(await entryRow(s.entry.id)).toMatchObject({ state: "queued", slot_holder: null, work_kind: null, approved_at: T0 });
      // The reviewed head's passes now speak for the refreshed head, so the gate merges it (fresh CI still applies, here green).
      const gh = createGitHubMergeGatePort({ http: s.g.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, sleep: async () => undefined });
      const merged = await runMergeGate(
        { pool: db.runWriterPool, github: gh, isAutoMergeAllowed: async () => true, requestReviews: async () => undefined },
        { accountId: s.accountId, workItemId: s.workItemId, pr: { repoId: s.repoId, prNumber: PR }, tier: "small", securityDiffTriggerFired: false, debaterEnabled: false },
      );
      expect(merged).toEqual({ outcome: "merged", headSha: REFRESHED });
    });

    it("a merge commit with one PR-side file is not skipped", async () => {
      const s = await setup({ mainFiles: [{ filename: "docs/m.md" }, { filename: "src/a.ts" }] }, { prFiles: ["src/a.ts"] });
      expect((await s.run()).outcome).toBe("needs_delta_review");
      expect(s.skips).toEqual([]);
      expect(s.started).toHaveLength(2);
    });

    it("a PR file list cut at GitHub's cap is unknown, never disjoint: the review is started", async () => {
      const many = Array.from({ length: 300 }, (_, i) => ({ filename: `gen/f${i}.ts` }));
      const s = await setup({ files: many, mainFiles: [{ filename: "src/zzz.ts" }] });
      // The refresh step already reads that list as unknown (overlap); the port must not turn it into a skip.
      expect((await s.run()).outcome).toBe("needs_delta_review");
      expect(s.skips).toEqual([]);
    });
  });

  describe("8. a rename on main", () => {
    it("overlapping a PR file by its old name starts a delta review whose file list has both names", async () => {
      const s = await setup({ files: [{ filename: "old/a.ts" }], mainFiles: [{ filename: "new/a.ts", previous_filename: "old/a.ts" }] });
      expect((await s.run()).outcome).toBe("needs_delta_review");
      expect([...s.started[0]!.delta.changedFiles].sort()).toEqual(["new/a.ts", "old/a.ts"]);
    });
  });

  describe("9. spend refused", () => {
    it("refused_spend: the entry needs a person, the slot is not held, and a second tick starts no run", async () => {
      const s = await setup({}, { refuseRole: "code-reviewer" });
      expect(await s.run()).toEqual({ outcome: "refused_spend", fromSha: HEAD, toSha: REFRESHED });
      expect(await entryRow(s.entry.id)).toMatchObject({ state: "stopped", reason: "refused_spend", slot_holder: null, approved_at: T0 });
      expect(await count(s.accountId, "agent_runs")).toBe(0);
      const gh = createGitHubMergeGatePort({ http: s.g.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, sleep: async () => undefined });
      const tick = await runQueueTick({ github: gh, inTenant: tenant, ourLogin: BOT, gate: async () => ({ outcome: "head_moved" }), startDeltaReview: s.port, sleep: async () => undefined }, { accountId: s.accountId, repoId: s.repoId });
      expect(tick.steps).toEqual([{ step: "idle", why: "waiting_mergeability" }]);
      expect(s.started).toEqual([]);
      expect(await count(s.accountId, "agent_runs")).toBe(0);
    });

    it("the second role refused after the first started: the first run is cancelled, nothing is left running, and it is still refused_spend", async () => {
      const s = await setup({}, { refuseRole: "acceptance-tester" });
      expect((await s.run()).outcome).toBe("refused_spend");
      expect(s.started.map((x) => x.role)).toEqual(["code-reviewer"]);
      expect(s.cancelled).toHaveLength(1);
      expect((await db.admin.query(`SELECT status FROM agent_runs WHERE account_id = $1`, [s.accountId])).rows).toEqual([{ status: "cancelled" }]);
    });

    it("C23: a wait for capacity is not spend: nothing started, nothing spent, the entry is NOT stopped and goes back to review to be asked again", async () => {
      const s = await setup({}, { refuseRole: "code-reviewer", refuseWith: "waiting_for_capacity" });
      expect(await s.run()).toMatchObject({ outcome: "delta_not_started", reason: "waiting_for_capacity" });
      expect(await entryRow(s.entry.id)).toMatchObject({ state: "in_review", slot_holder: null, approved_at: T0 });
      expect(await count(s.accountId, "agent_runs")).toBe(0);
    });

    it("a refusal that is not spend (spec changed) returns the entry to review: no stop, no retry loop", async () => {
      const s = await setup({}, { refuseRole: "code-reviewer", refuseWith: "spec_changed" });
      expect(await s.run()).toMatchObject({ outcome: "delta_not_started", reason: "spec_changed" });
      expect(await entryRow(s.entry.id)).toMatchObject({ state: "in_review", slot_holder: null });
    });
  });
});
