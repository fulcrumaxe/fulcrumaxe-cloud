import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import { runMergeGate, type MergeGateResult } from "../../src/build/mergeGate.js";
import {
  MAX_REFRESHES,
  enqueueEntry,
  finishWork,
  getEntry,
  recordHeadRefresh,
  runRefreshStep,
  takeSlot,
  type MergeQueueEntry,
  type RefreshOutcome,
  type StartDeltaReview,
} from "../../src/mergeQueue/index.js";
import { startMergeTlsGitHub, type FakeCommit, type MergeTlsGitHub, type MergeWorld } from "../review/helpers/fakeGitHubMergeTls.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#519 MQ3-a, acceptance 14, 15, 17, 18 and 19: the refresh half of the slot step, over real Postgres (a plain `app_user` pool, row
 * security in force) and a strict GitHub fake served over real TLS. The step's boundary is asserted here: what it returns, what it
 * wrote, what it called. That the workflow then merges or re-reviews end to end is MQ3-b's item 20.
 */
const T0 = new Date("2026-10-15T10:00:00Z");
const HEAD = "a".repeat(40);
const REFRESHED = "b".repeat(40);
const BOT = "fulcrumaxe-app[bot]";
const PR_NUMBER = 7;

let open: MergeTlsGitHub[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

describe("D#519 MQ3-a refresh and carry-forward [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, accountId, fn);

  interface Setup {
    accountId: string;
    repoId: string;
    workItemId: string;
    entry: MergeQueueEntry;
    g: MergeTlsGitHub;
    gateCalls: string[];
    deltaStarts: Array<{ toSha: string; slotHolderSeen: string | null; stateSeen: string | null; workKindSeen: string | null; inFlightSeen: number }>;
    requested: string[];
    deps: Parameters<typeof runRefreshStep<MergeGateResult>>[0];
  }

  async function agentRunCount(accountId: string): Promise<number> {
    return Number((await db.admin.query(`SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1`, [accountId])).rows[0].n);
  }
  const refreshRows = async (accountId: string) =>
    (await db.admin.query(`SELECT from_sha, to_sha, base_sha, files_overlap FROM head_refreshes WHERE account_id = $1 ORDER BY created_at`, [accountId])).rows as Array<{ from_sha: string; to_sha: string; base_sha: string; files_overlap: boolean }>;
  const entryRow = async (id: string) => (await db.admin.query(`SELECT * FROM merge_queue_entries WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;

  async function addPassingRuns(accountId: string, workItemId: string, sha: string, roles = ["code-reviewer", "acceptance-tester"]) {
    for (const role of roles) {
      await db.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, 'production', 'succeeded', '{"verdict":"pass"}', $4)`, [accountId, workItemId, role, sha]);
    }
  }

  /** An approved, reviewed entry that holds the repo's merge slot, a fake GitHub for its PR, and the step's dependencies. */
  async function setup(world: Partial<MergeWorld> = {}, opts: { startDeltaReview?: StartDeltaReview; prNumber?: number } = {}): Promise<Setup> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    const prNumber = opts.prNumber ?? PR_NUMBER;
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: prNumber });
    await addPassingRuns(accountId, workItemId, HEAD);
    const created = await tenant(accountId, (c) => enqueueEntry(c, { accountId, repoId, workItemId, prNumber, headSha: HEAD, approvedAt: T0 }));
    const taken = await tenant(accountId, (c) =>
      takeSlot(c, { accountId, repoId, holder: "tick-1", facts: new Map([[created.entry.id, { open: true, draft: false }]]) }),
    );
    expect(taken.taken?.id).toBe(created.entry.id);

    const g = await startMergeTlsGitHub({ prNumber, ...world });
    open.push(g);
    const port = createGitHubMergeGatePort({
      http: g.http,
      resolveRepo: async () => ({ owner: "acme", name: "widgets" }),
      markReadyForHumanMerge: async () => undefined,
      sleep: async () => undefined,
      mergeablePollLimit: 3,
    });
    const gateCalls: string[] = [];
    const requested: string[] = [];
    const deltaStarts: Setup["deltaStarts"] = [];
    const startDeltaReview: StartDeltaReview =
      opts.startDeltaReview ??
      (async (client, args) => {
        // Read the slot from INSIDE the transaction, after the round was recorded and before any run exists: it is already gone.
        const own = (await client.query(`SELECT state, slot_holder, work_kind FROM merge_queue_entries WHERE id = $1`, [args.entry.id])).rows[0] as { state: string; slot_holder: string | null; work_kind: string | null };
        const held = (await client.query(`SELECT count(*)::int AS n FROM merge_queue_entries WHERE account_id = $1 AND repo_id = $2 AND state = 'in_flight'`, [accountId, repoId])).rows[0] as { n: number };
        deltaStarts.push({ toSha: args.toSha, slotHolderSeen: own.slot_holder, stateSeen: own.state, workKindSeen: own.work_kind, inFlightSeen: held.n });
        return { started: true, runId: randomUUID() };
      });
    const pr = { repoId, prNumber };
    const deps: Setup["deps"] = {
      github: port,
      inTenant: tenant,
      ourLogin: BOT,
      gate: async ({ headSha }) => {
        gateCalls.push(headSha);
        return runMergeGate(
          { pool: db.runWriterPool, github: port, isAutoMergeAllowed: async () => true, requestReviews: async (_pr, sha) => void requested.push(sha) },
          { accountId, workItemId, pr, tier: "small", securityDiffTriggerFired: false, debaterEnabled: false },
        );
      },
      startDeltaReview,
      sleep: async () => undefined,
      pollIntervalMs: 0,
      pollLimit: 4,
    };
    return { accountId, repoId, workItemId, entry: taken.taken!, g, gateCalls, deltaStarts, requested, deps };
  }

  const step = (s: Setup, entry: MergeQueueEntry = s.entry) =>
    runRefreshStep(s.deps, { accountId: s.accountId, entry, holder: "tick-1", pr: { repoId: s.repoId, prNumber: entry.prNumber } });
  const gateNow = (s: Setup) =>
    runMergeGate(
      { pool: db.runWriterPool, github: createGitHubMergeGatePort({ http: s.g.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, sleep: async () => undefined }), isAutoMergeAllowed: async () => true, requestReviews: async (_pr, sha) => void s.requested.push(sha) },
      { accountId: s.accountId, workItemId: s.workItemId, pr: { repoId: s.repoId, prNumber: PR_NUMBER }, tier: "small", securityDiffTriggerFired: false, debaterEnabled: false },
    );

  describe("14. behind on a repo that requires up-to-date branches", () => {
    it("calls update-branch once, verifies the new head, writes the head_refresh row and starts no agent run", async () => {
      const s = await setup({ behindBy: 2, classicStrict: true });
      const runsBefore = await agentRunCount(s.accountId);
      const out = await step(s);
      expect(out).toEqual({ outcome: "refreshed", fromSha: HEAD, toSha: REFRESHED, baseSha: s.g.world.baseTipSha, why: "required" });
      expect(s.g.world.updates).toEqual([{ expected: HEAD }]);
      expect(await refreshRows(s.accountId)).toEqual([{ from_sha: HEAD, to_sha: REFRESHED, base_sha: s.g.world.baseTipSha, files_overlap: false }]);
      expect(await agentRunCount(s.accountId)).toBe(runsBefore);
      const e = await entryRow(s.entry.id);
      expect(e.refresh_count).toBe(1);
      expect(e.state).toBe("in_flight");
      expect(s.gateCalls).toEqual([]);
    });

    it("the gate then merges the refreshed head on the reviewers' passes carried through the row, requesting no review", async () => {
      const s = await setup({ behindBy: 2, classicStrict: true });
      expect((await step(s)).outcome).toBe("refreshed");
      const result = await gateNow(s);
      expect(result).toEqual({ outcome: "merged", headSha: REFRESHED });
      expect(s.requested).toEqual([]);
      expect(s.g.world.merges).toEqual([{ sha: REFRESHED, method: "squash" }]);
      expect(await agentRunCount(s.accountId)).toBe(2);
    });

    it("update-branch is never sent without expected_head_sha, and a 202 alone is not a refresh (no row until the head changed)", async () => {
      const s = await setup({ behindBy: 2, classicStrict: true, refreshAfterReads: 50 });
      const out = await step(s);
      expect(out).toEqual({ outcome: "refresh_pending" });
      expect(s.g.world.updates).toEqual([{ expected: HEAD }]);
      expect(await refreshRows(s.accountId)).toEqual([]);
      expect((await entryRow(s.entry.id)).refresh_count).toBe(0);
    });

    it("a second refresh chains from the first: the passes on the original head still speak for the newest one", async () => {
      const s = await setup({ behindBy: 1, classicStrict: true });
      expect((await step(s)).outcome).toBe("refreshed");
      // The default branch moves again.
      s.g.world.behindBy = 1;
      s.g.world.refreshedHeadSha = "c".repeat(40);
      const second = await step(s);
      expect(second).toMatchObject({ outcome: "refreshed", fromSha: REFRESHED, toSha: "c".repeat(40) });
      expect(s.g.world.updates).toEqual([{ expected: HEAD }, { expected: REFRESHED }]);
      expect((await entryRow(s.entry.id)).refresh_count).toBe(2);
      expect(await gateNow(s)).toEqual({ outcome: "merged", headSha: "c".repeat(40) });
    });

    it("a conflict from update-branch is reported as such, with nothing recorded", async () => {
      const s = await setup({ behindBy: 2, classicStrict: true, conflict: true });
      expect(await step(s)).toEqual({ outcome: "conflict", headSha: HEAD });
      expect(await refreshRows(s.accountId)).toEqual([]);
      expect((await entryRow(s.entry.id)).state).toBe("in_flight");
    });
  });

  describe("15. repos that do not require up-to-date branches", () => {
    it("behind: the refresh happens (why: stale_green), not only on strict repos", async () => {
      const s = await setup({ behindBy: 3 });
      const out = await step(s);
      expect(out).toMatchObject({ outcome: "refreshed", why: "stale_green", toSha: REFRESHED });
      expect(s.g.world.updates).toHaveLength(1);
    });

    it("not behind: no update-branch call, the gate port is called with the reviewed head, and the merge happens on it", async () => {
      const s = await setup({ behindBy: 0 });
      const out = (await step(s)) as Extract<RefreshOutcome<MergeGateResult>, { outcome: "not_behind" }>;
      expect(out.outcome).toBe("not_behind");
      expect(out.headSha).toBe(HEAD);
      expect(s.gateCalls).toEqual([HEAD]);
      expect(s.g.world.updates).toEqual([]);
      expect(out.gate).toEqual({ outcome: "merged", headSha: HEAD });
      expect(s.g.world.merges).toEqual([{ sha: HEAD, method: "squash" }]);
      expect(await refreshRows(s.accountId)).toEqual([]);
    });

    it("an unreadable protection rule throws instead of being read as 'not required'", async () => {
      const s = await setup({ behindBy: 2, protectionStatus: 403 });
      await expect(step(s)).rejects.toThrow(/branch protection/);
      expect(s.g.world.updates).toEqual([]);
    });
  });

  describe("17. a new head that is not our platform's refresh", () => {
    const PERSON = "d".repeat(40);
    const cases: Array<[string, Omit<FakeCommit, "files">, string]> = [
      ["a person's merge of the default branch (the right parents, signed, authored by them)", { parents: [HEAD, "9".repeat(40)], authorLogin: "alice", verified: true }, "author_not_our_app"],
      ["a commit that names our App but is unsigned", { parents: [HEAD, "9".repeat(40)], authorLogin: BOT, verified: false }, "not_signed_by_github"],
      ["a commit authored as our App but committed (and signed, verified) by a contributor", { parents: [HEAD, "9".repeat(40)], authorLogin: BOT, committerLogin: "mallory", verified: true }, "committer_not_github"],
      ["a commit committed by web-flow whose signature reason is not valid", { parents: [HEAD, "9".repeat(40)], authorLogin: BOT, verified: true, verificationReason: "unknown_key" }, "not_signed_by_github"],
      ["a parent that is not the previous head", { parents: ["e".repeat(40), "9".repeat(40)], authorLogin: BOT, verified: true }, "first_parent_not_previous_head"],
      ["a single parent (an ordinary commit)", { parents: [HEAD], authorLogin: BOT, verified: true }, "not_two_parents"],
      ["a second parent that is not on the default branch", { parents: [HEAD, "7".repeat(40)], authorLogin: BOT, verified: true }, "second_parent_not_on_default"],
    ];

    it.each(cases)("%s: no row, no verdict carried, the entry goes back to review", async (_name, commit, reason) => {
      const s = await setup({ behindBy: 2, classicStrict: true });
      s.g.world.commits["7".repeat(40)] = { parents: [HEAD], authorLogin: "mallory", verified: true, files: [] };
      s.g.world.commits[PERSON] = { files: [], ...commit };
      s.g.world.headSha = PERSON;
      // The request is on record, so it is the identity and the parents that refuse the head, not the missing request.
      await db.admin.query(`UPDATE merge_queue_entries SET refresh_requested_from = $2 WHERE id = $1`, [s.entry.id, HEAD]);
      const out = await step(s);
      expect(out).toEqual({ outcome: "foreign_head", headSha: PERSON, reason });
      expect(await refreshRows(s.accountId)).toEqual([]);
      const e = await entryRow(s.entry.id);
      expect(e.state).toBe("in_review");
      expect(e.slot_holder).toBeNull();
      expect(e.refresh_count).toBe(0);
      expect(s.g.world.updates).toEqual([]);
      // Nothing carries: the gate sees a head without reviews, asks for them, and does not merge.
      const result = await gateNow(s);
      expect(result.outcome).toBe("ready_human_merges");
      expect(result).toMatchObject({ reasons: expect.arrayContaining(["missing_run_code_reviewer", "missing_run_acceptance_tester"]) });
      expect(s.requested).toEqual([PERSON]);
      expect(s.g.world.merged).toBe(false);
    });

    it("MUST 1+2 end to end: a spoofed identity AND a forged tree with the right parents: foreign_head, no row, no pass carries", async () => {
      const s = await setup({ behindBy: 2, classicStrict: true, files: [{ filename: "src/a.ts" }], mainFiles: [{ filename: "docs/m.md" }] });
      const blob = (c: string) => `100644 blob ${c.repeat(40)}`;
      s.g.world.trees = { [s.g.world.mergeBaseSha]: { "src/a.ts": blob("1") }, [HEAD]: { "src/a.ts": blob("2") }, [s.g.world.baseTipSha]: { "src/a.ts": blob("1"), "docs/m.md": blob("3") } };
      // The injected file lies outside both file lists, so the overlap check alone would carry every pass onto it.
      s.g.world.trees[PERSON] = { "src/a.ts": blob("2"), "docs/m.md": blob("3"), "src/injected.ts": blob("6") };
      s.g.world.commits[PERSON] = { parents: [HEAD, s.g.world.baseTipSha], authorLogin: BOT, committerLogin: "web-flow", verified: true, files: [{ filename: "docs/m.md" }] };
      s.g.world.headSha = PERSON;
      expect(await step(s)).toEqual({ outcome: "foreign_head", headSha: PERSON, reason: "no_refresh_requested" });
      // With the request on record the identity and parents pass and the TREE is what refuses it.
      await db.admin.query(`UPDATE merge_queue_entries SET refresh_requested_from = $2 WHERE id = $1`, [s.entry.id, HEAD]);
      await db.admin.query(`UPDATE merge_queue_entries SET state = 'queued', phase = NULL, slot_holder = NULL, lease_until = NULL, slot_taken_at = NULL WHERE id = $1`, [s.entry.id]);
      const retaken = await tenant(s.accountId, (c) => takeSlot(c, { accountId: s.accountId, repoId: s.repoId, holder: "tick-1", facts: new Map([[s.entry.id, { open: true, draft: false }]]) }));
      expect(retaken.taken?.id).toBe(s.entry.id);
      expect(await step(s, retaken.taken!)).toEqual({ outcome: "foreign_head", headSha: PERSON, reason: "tree_not_verified" });
      expect(await refreshRows(s.accountId)).toEqual([]);
      expect((await entryRow(s.entry.id)).state).toBe("in_review");
      const result = await gateNow(s);
      expect(result.outcome).toBe("ready_human_merges");
      expect(s.g.world.merged).toBe(false);
    });

    it("the person-made merge case stays in review whatever happens next: the carry-forward is for platform refreshes only", async () => {
      // The same shape as a platform refresh, except the author. A re-run of the step on it must not record anything either.
      const s = await setup({ behindBy: 2, classicStrict: true });
      s.g.world.commits[PERSON] = { parents: [HEAD, "9".repeat(40)], authorLogin: "alice", verified: true, files: [{ filename: "docs/a.md" }] };
      s.g.world.headSha = PERSON;
      await step(s);
      const e = await tenant(s.accountId, (c) => getEntry(c, s.accountId, s.entry.id));
      expect(e?.state).toBe("in_review");
      expect(await refreshRows(s.accountId)).toEqual([]);
      expect(await db.admin.query(`SELECT 1 FROM head_refreshes WHERE account_id = $1`, [s.accountId])).toMatchObject({ rowCount: 0 });
    });

    it("a head that was already refreshed by us before a crashed step is recognised and recorded once (recovered)", async () => {
      const s = await setup({ behindBy: 2, classicStrict: true });
      // GitHub applied the update, but the step that asked for it died before it recorded anything. It had recorded the request.
      await db.admin.query(`UPDATE merge_queue_entries SET refresh_requested_from = $2 WHERE id = $1`, [s.entry.id, HEAD]);
      s.g.world.commits[REFRESHED] = { parents: [HEAD, s.g.world.baseTipSha], authorLogin: BOT, committerLogin: "web-flow", verified: true, files: s.g.world.mainFiles };
      s.g.world.headSha = REFRESHED;
      s.g.world.behindBy = 0;
      const first = await step(s);
      expect(first).toMatchObject({ outcome: "refreshed", why: "recovered", fromSha: HEAD, toSha: REFRESHED });
      const second = await step(s);
      expect(second).toMatchObject({ outcome: "not_behind", headSha: REFRESHED });
      expect(await refreshRows(s.accountId)).toHaveLength(1);
      expect((await entryRow(s.entry.id)).refresh_count).toBe(1);
    });
  });

  describe("the recovered path needs a recorded request", () => {
    const platformCommit = (s: Setup): FakeCommit => ({ parents: [HEAD, s.g.world.baseTipSha], authorLogin: BOT, committerLogin: "web-flow", verified: true, files: s.g.world.mainFiles });

    it("a changed head that looks exactly like our refresh, but this entry never asked for one, is not verified and not recorded", async () => {
      const s = await setup({ behindBy: 2, classicStrict: true });
      s.g.world.commits[REFRESHED] = platformCommit(s);
      s.g.world.headSha = REFRESHED;
      s.g.world.behindBy = 0;
      expect(await step(s)).toEqual({ outcome: "foreign_head", headSha: REFRESHED, reason: "no_refresh_requested" });
      expect(await refreshRows(s.accountId)).toEqual([]);
      expect((await entryRow(s.entry.id)).state).toBe("in_review");
      // The head was never read: no commit read was made for it.
      expect(s.g.world.calls.some((c) => c.path.endsWith(`/commits/${REFRESHED}`))).toBe(false);
    });

    it("a request made from some OTHER head does not vouch for this one", async () => {
      const s = await setup({ behindBy: 2, classicStrict: true });
      await db.admin.query(`UPDATE merge_queue_entries SET refresh_requested_from = $2 WHERE id = $1`, [s.entry.id, "c".repeat(40)]);
      s.g.world.commits[REFRESHED] = platformCommit(s);
      s.g.world.headSha = REFRESHED;
      expect(await step(s)).toMatchObject({ outcome: "foreign_head", reason: "no_refresh_requested" });
    });

    it("the step records its request BEFORE calling update-branch, and a refused request is withdrawn", async () => {
      const s = await setup({ behindBy: 2, classicStrict: true });
      let seenAtCall: unknown = "unset";
      const real = s.deps.github.updateBranch.bind(s.deps.github);
      s.deps.github = Object.assign(Object.create(s.deps.github), {
        updateBranch: async (pr: { repoId: string; prNumber: number }, a: { expectedHeadSha: string }) => {
          seenAtCall = (await entryRow(s.entry.id)).refresh_requested_from;
          return real(pr, a);
        },
      });
      expect((await step(s)).outcome).toBe("refreshed");
      expect(seenAtCall).toBe(HEAD);

      const c = await setup({ behindBy: 2, classicStrict: true, conflict: true });
      expect(await step(c)).toEqual({ outcome: "conflict", headSha: HEAD });
      expect((await entryRow(c.entry.id)).refresh_requested_from).toBeNull();
    });
  });

  describe("18. Q1(b): overlapping files get a delta review with the slot released, disjoint files get none", () => {
    it("disjoint: no review run is started, and the row says the files did not overlap", async () => {
      const s = await setup({ behindBy: 1, classicStrict: true, files: [{ filename: "src/a.ts" }], mainFiles: [{ filename: "docs/other.md" }] });
      const out = await step(s);
      expect(out.outcome).toBe("refreshed");
      expect(s.deltaStarts).toEqual([]);
      expect(await agentRunCount(s.accountId)).toBe(2);
      expect((await refreshRows(s.accountId))[0]!.files_overlap).toBe(false);
    });

    it("overlap: one delta review of the merge commit, started after the slot was released in the same transaction", async () => {
      const s = await setup({ behindBy: 1, classicStrict: true, files: [{ filename: "src/a.ts" }], mainFiles: [{ filename: "src/a.ts" }] });
      const out = await step(s);
      expect(out).toMatchObject({ outcome: "needs_delta_review", fromSha: HEAD, toSha: REFRESHED, baseSha: s.g.world.baseTipSha, reason: "files_overlap" });
      expect(s.deltaStarts).toEqual([{ toSha: REFRESHED, slotHolderSeen: null, stateSeen: "awaiting_work", workKindSeen: "delta_review", inFlightSeen: 0 }]);
      const e = await entryRow(s.entry.id);
      expect(e).toMatchObject({ state: "awaiting_work", work_kind: "delta_review", slot_holder: null, lease_until: null, conflict_rounds: 0, refresh_count: 1 });
      expect(e.work_run_id).toEqual(expect.any(String));
      expect((await refreshRows(s.accountId))[0]!.files_overlap).toBe(true);
      expect(s.gateCalls).toEqual([]);
    });

    it("a rename overlaps on either name, from either side", async () => {
      const prRenames = await setup({ behindBy: 1, classicStrict: true, files: [{ filename: "new/a.ts", previous_filename: "old/a.ts" }], mainFiles: [{ filename: "old/a.ts" }] });
      expect((await step(prRenames)).outcome).toBe("needs_delta_review");
      const mainRenames = await setup({ behindBy: 1, classicStrict: true, files: [{ filename: "old/a.ts" }], mainFiles: [{ filename: "new/a.ts", previous_filename: "old/a.ts" }] });
      expect((await step(mainRenames)).outcome).toBe("needs_delta_review");
      const unrelated = await setup({ behindBy: 1, classicStrict: true, files: [{ filename: "new/a.ts", previous_filename: "old/a.ts" }], mainFiles: [{ filename: "elsewhere.ts" }] });
      expect((await step(unrelated)).outcome).toBe("refreshed");
    });

    it("a file list cut at GitHub's cap is unknown, not disjoint", async () => {
      const many = Array.from({ length: 300 }, (_, i) => ({ filename: `gen/f${i}.ts` }));
      const s = await setup({ behindBy: 1, classicStrict: true, files: [{ filename: "src/a.ts" }], mainFiles: many });
      expect(await step(s)).toMatchObject({ outcome: "needs_delta_review", reason: "files_unknown" });
    });

    it("a refused start (spend) stops the entry with a fixed code, holds no slot and is not retried", async () => {
      const calls: number[] = [];
      const s = await setup({ behindBy: 1, classicStrict: true, files: [{ filename: "a" }], mainFiles: [{ filename: "a" }] }, { startDeltaReview: async () => (calls.push(1), { started: false, reason: "refused_spend" }) });
      expect(await step(s)).toEqual({ outcome: "refused_spend", fromSha: HEAD, toSha: REFRESHED });
      expect(calls).toHaveLength(1);
      expect(await entryRow(s.entry.id)).toMatchObject({ state: "stopped", reason: "refused_spend", slot_holder: null });
      expect(await agentRunCount(s.accountId)).toBe(2);
    });

    it("a start that throws leaves nothing recorded: the row, the release and the run roll back together", async () => {
      const s = await setup({ behindBy: 1, classicStrict: true, files: [{ filename: "a" }], mainFiles: [{ filename: "a" }] }, { startDeltaReview: async () => { throw new Error("runner down"); } });
      await expect(step(s)).rejects.toThrow("runner down");
      expect(await refreshRows(s.accountId)).toEqual([]);
      expect(await entryRow(s.entry.id)).toMatchObject({ state: "in_flight", slot_holder: "tick-1", refresh_count: 0 });
    });

    it("MUST 3: across an overlapping hop NO pass carries; the delta review has to supply every one the gate needs", async () => {
      const s = await setup({ behindBy: 1, classicStrict: true, files: [{ filename: "a" }], mainFiles: [{ filename: "a" }] });
      expect((await step(s)).outcome).toBe("needs_delta_review");
      await tenant(s.accountId, (c) => finishWork(c, { accountId: s.accountId, entryId: s.entry.id }));
      const blocked = await gateNow(s);
      expect(blocked).toMatchObject({ outcome: "ready_human_merges", reasons: expect.arrayContaining(["missing_run_code_reviewer", "missing_run_acceptance_tester"]) });
      expect((blocked as { reasons: string[] }).reasons).toHaveLength(2);
      // The code reviewer alone is not enough: the acceptance tester's old pass does not carry across the overlap either.
      await addPassingRuns(s.accountId, s.workItemId, REFRESHED, ["code-reviewer"]);
      expect(await gateNow(s)).toMatchObject({ outcome: "ready_human_merges", reasons: ["missing_run_acceptance_tester"] });
      await addPassingRuns(s.accountId, s.workItemId, REFRESHED, ["acceptance-tester"]);
      expect(await gateNow(s)).toEqual({ outcome: "merged", headSha: REFRESHED });
    });

    it("a delta review that rejects blocks the merge, whatever the older pass said", async () => {
      const s = await setup({ behindBy: 1, classicStrict: true, files: [{ filename: "a" }], mainFiles: [{ filename: "a" }] });
      await step(s);
      await db.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', '{"verdict":"needs-fix"}', $3)`, [s.accountId, s.workItemId, REFRESHED]);
      expect(await gateNow(s)).toMatchObject({ outcome: "ready_human_merges", reasons: expect.arrayContaining(["verdict_not_pass_code_reviewer"]) });
    });

    it("queue fairness: the entry leaves the slot without blocking the one behind it, and returns at its original place", async () => {
      const s = await setup({ behindBy: 1, classicStrict: true, files: [{ filename: "a" }], mainFiles: [{ filename: "a" }] });
      // A later-approved entry in the same repo.
      const otherItem = randomUUID();
      await seedWorkItem(db.admin, s.accountId, otherItem, s.repoId, { ghNumber: 8 });
      const later = await tenant(s.accountId, (c) =>
        enqueueEntry(c, { accountId: s.accountId, repoId: s.repoId, workItemId: otherItem, prNumber: 8, headSha: "c".repeat(40), approvedAt: new Date(T0.getTime() + 60_000) }),
      );
      await step(s);
      const facts = new Map([[s.entry.id, { open: true, draft: false }], [later.entry.id, { open: true, draft: false }]]);
      // The waiting entry (awaiting_work) is not eligible; the later one takes the slot at once.
      const next = await tenant(s.accountId, (c) => takeSlot(c, { accountId: s.accountId, repoId: s.repoId, holder: "tick-2", facts }));
      expect(next.taken?.id).toBe(later.entry.id);
      // The delta review ends and CI is done: the original entry is back with the SAME approved_at, ahead of any later entry.
      await tenant(s.accountId, (c) => finishWork(c, { accountId: s.accountId, entryId: s.entry.id }));
      const back = await tenant(s.accountId, (c) => getEntry(c, s.accountId, s.entry.id));
      expect(back?.approvedAt.getTime()).toBe(T0.getTime());
      expect(back?.state).toBe("queued");
    });
  });

  describe("19. the refresh bound", () => {
    it(`the ${MAX_REFRESHES + 1}th refresh without a merge stops at branch_behind, and makes no update-branch call`, async () => {
      const s = await setup({ behindBy: 1, classicStrict: true });
      await db.admin.query(`UPDATE merge_queue_entries SET refresh_count = $2 WHERE id = $1`, [s.entry.id, MAX_REFRESHES]);
      const out = await step(s);
      expect(out).toEqual({ outcome: "branch_behind" });
      expect(s.g.world.updates).toEqual([]);
      expect(await entryRow(s.entry.id)).toMatchObject({ state: "stopped", reason: "branch_behind", slot_holder: null });
    });

    it(`the ${MAX_REFRESHES}th refresh still happens`, async () => {
      const s = await setup({ behindBy: 1, classicStrict: true });
      await db.admin.query(`UPDATE merge_queue_entries SET refresh_count = $2 WHERE id = $1`, [s.entry.id, MAX_REFRESHES - 1]);
      expect((await step(s)).outcome).toBe("refreshed");
      expect((await entryRow(s.entry.id)).refresh_count).toBe(MAX_REFRESHES);
    });

    it("recording the same refresh twice counts once", async () => {
      const s = await setup({ behindBy: 1, classicStrict: true });
      await step(s);
      const again = await tenant(s.accountId, (c) =>
        recordHeadRefresh(c, { accountId: s.accountId, entryId: s.entry.id, holder: "tick-1", fromSha: HEAD, toSha: REFRESHED, baseSha: s.g.world.baseTipSha, filesOverlap: false }),
      );
      expect(again).toEqual({ recorded: false, reason: "duplicate" });
      expect((await entryRow(s.entry.id)).refresh_count).toBe(1);
    });
  });

  describe("the slot", () => {
    it("a lapsed lease ends the step before any GitHub call", async () => {
      const s = await setup({ behindBy: 1, classicStrict: true });
      await db.admin.query(`UPDATE merge_queue_entries SET lease_until = now() - interval '1 minute' WHERE id = $1`, [s.entry.id]);
      expect(await step(s)).toEqual({ outcome: "slot_lost" });
      expect(s.g.world.calls).toEqual([]);
    });

    it("a closed pull request is reported and nothing is called on it", async () => {
      const s = await setup({ behindBy: 1, classicStrict: true, state: "closed" });
      expect(await step(s)).toEqual({ outcome: "pr_not_open" });
      expect(s.g.world.updates).toEqual([]);
    });
  });
});
