import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import {
  completeConflictRound,
  completeDeltaReview,
  createOnRenumber,
  getEntry,
  listConflictRounds,
  releaseForWork,
  runQueueTick,
  setPlatformCommitProofForTest,
  type ConflictCompletionPorts,
  type MergeQueueEntry,
  type PlatformPush,
  type RenumberPorts,
} from "../../src/mergeQueue/index.js";
import type { DeltaReviewInput } from "../../src/review/reviewPrompts.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { BOT, T0, shaOf, startQueueRepo, type QueueItem, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#519 MQ5-b2 over real Postgres and the strict GitHub fake served over real TLS: the END of a renumber round, through the real queue tick (the start), the real round-end
 * judge, the real delta review on a plain diff and the real tick again (the merge). The model is never called; the executor's run is a row of `agent_runs` that the test ends,
 * and its push is a change of the fake's head plus the platform's push record. What cannot be faked: that a real executor renames the files and their references (staging shows
 * it) and which pushes the proxy really records (the proof is an injected log shaped like the reader's answer, as in the conflict suites).
 */
const DIR = "packages/db/migrations";
const key = (k: number) => String(k).padStart(4, "0");
const mig = (...keys: number[]) => keys.map((k) => `${DIR}/${key(k)}_m.sql`);
const added = (...paths: string[]) => paths.map((filename) => ({ filename, status: "added" }));
const REF = "packages/db/src/schemaIndex.ts";
const ORIGIN_RUN = "22222222-2222-4222-8222-222222222222";
const NEWTIP = `${"f".repeat(38)}08`;
const MIN = 60_000;
const reverse = (s: string) => [...s].reverse().join("");
const commitSha = (pr: number, i: number) => `${pr.toString(16).padStart(2, "0")}${i.toString(16).padStart(2, "0")}`.repeat(10).slice(0, 40);
const pass = { verdict: "pass", findings: [], summary: "ok" };

let records: PlatformPush[] = [];
let repos: QueueRepo[] = [];
beforeEach(() => {
  records = [];
  setPlatformCommitProofForTest(async (_e, shas) => ({ appLogin: BOT, pushes: records.filter((p) => shas.includes(p.newSha)) }));
});
afterEach(async () => {
  setPlatformCommitProofForTest(null);
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("D#519 MQ5-b2 renumber round end [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, accountId, fn);
  const start = async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    return r;
  };

  /** A queued pull request that adds `adds` (all written by the platform) on a default branch whose tip holds `tip`. */
  async function queued(r: QueueRepo, pr: number, adds: string[], tip: string[], approvedAt = T0): Promise<QueueItem> {
    const world = {
      pullFiles: added(...adds),
      commits: { [commitSha(pr, 0)]: { parents: [shaOf(pr, "fresh")], authorLogin: BOT, committerLogin: "web-flow", verified: false, files: adds.map((filename) => ({ filename })) } },
      pullCommits: [{ sha: commitSha(pr, 0), authorLogin: BOT, committerLogin: "web-flow" }],
    };
    const a = await r.addItem(pr, { world, approvedAt });
    // The router sends a read that names only a commit to the first pull request, so every world knows every pull request's authored commit.
    for (const it of r.items.values()) Object.assign(it.g.world.commits, world.commits);
    r.setTip(pr, shaOf(pr, "tip"), tip);
    records.push({ oldSha: null, newSha: commitSha(pr, 0), startSha: null, runId: ORIGIN_RUN });
    return a;
  }

  /** The real `onRenumber` over the repo's real port. The run start inserts the executor's run row; `autoRenumber` is the repo's setting. */
  const startPorts = (r: QueueRepo): RenumberPorts => ({
    github: r.deps().github as unknown as RenumberPorts["github"],
    inTenant: tenant,
    platformCommits: async (_e, shas) => ({ appLogin: BOT, pushes: records.filter((p) => shas.includes(p.newSha)) }),
    async startRenumberRound({ entry }) {
      const id = randomUUID();
      await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, 'executor', 'production', 'running', $4)`, [id, r.accountId, entry.workItemId, entry.headSha]);
      return { ok: true, runId: id };
    },
  });
  const tickDeps = (r: QueueRepo) => r.deps({ ordered: true, onRenumber: createOnRenumber(startPorts(r)) });
  const rounds = (r: QueueRepo, a: QueueItem) => tenant(r.accountId, (c) => listConflictRounds(c, r.accountId, a.workItemId));
  const events = async (r: QueueRepo, a: QueueItem) => (await db.admin.query(`SELECT kind, code, reasons, round FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'stopped' ORDER BY seq`, [r.accountId, a.workItemId])).rows;
  const runStatus = async (id: string) => (await db.admin.query("SELECT status FROM agent_runs WHERE id = $1", [id])).rows[0].status as string;

  /** What the executor's push looks like to GitHub: the head is `to` (a one-parent commit on `from`), the diff `from..to` and the pull request's own files. */
  function push(a: QueueItem, round: { fromSha: string; baseSha: string; runId: string | null }, o: { old: string[]; neu: string[]; changed?: string[]; prFiles?: string[]; to?: string; parents?: string[]; record?: false | { runId?: string; oldSha?: string }; status?: "ahead" | "diverged" } = { old: [], neu: [] }) {
    const w = a.g.world;
    const to = o.to ?? reverse(a.head);
    const changed = o.changed ?? [...o.neu, ...o.old, REF];
    w.commits[to] = { parents: o.parents ?? [round.fromSha], authorLogin: BOT, committerLogin: "web-flow", verified: false, files: changed.map((filename) => ({ filename })) };
    if (o.record !== false) records.push({ oldSha: o.record?.oldSha ?? round.fromSha, newSha: to, startSha: null, runId: o.record?.runId ?? round.runId! });
    w.headSha = to;
    w.conflict = false;
    w.pullFiles = added(...o.neu);
    // `rename` entries: the fake lists both names for a file with a previous name.
    const diff = o.changed ? o.changed.map((filename) => ({ filename })) : [...o.neu.map((filename, i) => ({ filename, previous_filename: o.old[i]! })), { filename: REF }];
    w.compares[`${round.fromSha}...${to}`] = { status: o.status ?? "ahead", aheadBy: 1, behindBy: 0, mergeBaseSha: round.fromSha, files: diff };
    w.compares[`${round.baseSha}...${round.fromSha}`] = { status: "ahead", aheadBy: 1, behindBy: 0, mergeBaseSha: round.baseSha, files: (o.prFiles ?? [...o.old, REF, "docs/notes.md"]).map((filename) => ({ filename })) };
    return to;
  }

  /** The round's end: the ports over the real port and the agent_runs table. */
  function completion(r: QueueRepo, a: QueueItem) {
    const log: string[] = [];
    const started: Array<{ role: string; delta: DeltaReviewInput }> = [];
    const ports: ConflictCompletionPorts = {
      github: r.deps({ ordered: true }).github as unknown as ConflictCompletionPorts["github"],
      inTenant: tenant,
      plan: async () => ({ ok: true, roles: ["code-reviewer", "acceptance-tester"] }),
      runs: async (_e, sha) =>
        (await db.admin.query(`SELECT DISTINCT ON (role) id, role, status FROM agent_runs WHERE account_id = $1 AND head_sha = $2 AND role <> 'executor' ORDER BY role, created_at DESC`, [r.accountId, sha])).rows.map((x) => ({ role: x.role as string, runId: x.id as string, attempt: 0, reusable: x.status !== "cancelled" })),
      startRole: async ({ role, delta }) => {
        started.push({ role, delta });
        const id = randomUUID();
        await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, $4, 'production', 'running', $5)`, [id, r.accountId, a.workItemId, role, delta.mergeCommitSha]);
        return { ok: true, runId: id };
      },
      cancelRun: async (_e, id) => void (await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1 AND status = 'running'`, [id])),
      recordEvent: async ({ code }) => void log.push(code),
      outcome: async (_e, id) => {
        const x = (await db.admin.query(`SELECT status, envelope FROM agent_runs WHERE id = $1`, [id])).rows[0];
        const done = x.status !== "running";
        const verdict = typeof x.envelope?.verdict === "string" ? (x.envelope.verdict as string) : "fail";
        return { done, verdict, securityNeeded: false, noVerdict: done && typeof x.envelope?.verdict !== "string" };
      },
      roundRunEnded: async (_e, id) => (await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [id])).rows[0].status !== "running",
    };
    const entry = async (): Promise<MergeQueueEntry> => (await tenant(r.accountId, (c) => getEntry(c, r.accountId, a.entryId)))!;
    return {
      log,
      started,
      complete: async (now?: Date) => completeConflictRound({ ...ports, ...(now ? { now: () => now } : {}) }, await entry()),
      completeDelta: async () => completeDeltaReview(ports, await entry()),
      endRun: async (id: string, status = "succeeded") => void (await db.admin.query(`UPDATE agent_runs SET status = $2 WHERE id = $1`, [id, status])),
      finishReviews: async () => void (await db.admin.query(`UPDATE agent_runs SET status = 'succeeded', envelope = $2 WHERE account_id = $1 AND role <> 'executor' AND status = 'running'`, [r.accountId, JSON.stringify(pass)])),
    };
  }

  /** A pull request adding 0710 on a default branch holding 0711 and 0712, taken by the tick: a round is running. */
  async function running(o: { pr?: number; adds?: number[]; tip?: number[]; settings?: unknown } = {}) {
    const r = await start();
    const pr = o.pr ?? 7;
    const a = await queued(r, pr, mig(...(o.adds ?? [710])), mig(...(o.tip ?? [711, 712])));
    if (o.settings !== undefined) await db.admin.query("UPDATE repos SET settings = $2::jsonb WHERE id = $1", [r.repoId, JSON.stringify(o.settings)]);
    const out = await runQueueTick(tickDeps(r), r);
    expect(out.steps[0]).toEqual({ step: "released", entryId: a.entryId, why: "ordered_resource_renumbering" });
    const [round] = await rounds(r, a);
    expect(round).toMatchObject({ kind: "renumber", outcome: null });
    return { r, a, round: round!, s: completion(r, a) };
  }

  it("MQ5-b2-1 (item 27): the round renumbers 0710 to 0713, the delta review runs on the plain diff with trigger `renumber`, fresh CI and the tick merge it at its original place", async () => {
    const { r, a, round, s } = await running();
    expect(await r.entry(7)).toMatchObject({ state: "awaiting_work", workKind: "renumber", approvedAt: T0 });
    // The run is still going and the head is unchanged: nothing moves.
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    const to = push(a, round, { old: mig(710), neu: mig(713) });
    // The head moved but the run has not ended: still waiting; nothing is believed until it has.
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    expect(s.started).toEqual([]);
    await s.endRun(round.runId!);
    expect(await s.complete()).toEqual({ outcome: "delta_started" });
    expect(s.started.map((x) => x.role)).toEqual(["code-reviewer", "acceptance-tester"]);
    for (const x of s.started) expect(x.delta).toEqual({ trigger: "renumber", mergeCommitSha: to, parents: [round.fromSha], parentRoles: ["pr_side"], changedFiles: [...mig(713), ...mig(710), REF] });
    expect(await r.entry(7)).toMatchObject({ state: "awaiting_work", workKind: "delta_review", slotHolder: null, headSha: a.head, approvedAt: T0 });
    expect((await rounds(r, a))[0]).toMatchObject({ kind: "renumber", toSha: to, outcome: "resolved" });
    // Waiting for the reviewers: a replay starts no second run.
    expect(await s.completeDelta()).toEqual({ outcome: "waiting" });
    await s.complete();
    expect(s.started).toHaveLength(2);
    await s.finishReviews();
    expect(await s.completeDelta()).toEqual({ outcome: "passed" });
    expect(await r.entry(7)).toMatchObject({ state: "queued", workKind: null, slotHolder: null, headSha: to, approvedAt: T0, conflictRounds: 1 });
    expect((await db.admin.query("SELECT count(*)::int AS n FROM head_refreshes WHERE account_id = $1", [r.accountId])).rows[0].n).toBe(0);
    // The tick checks the keys again from current reads (0713 is above 0712) and merges.
    const out = await runQueueTick(tickDeps(r), r);
    expect(out.steps[0]).toMatchObject({ step: "merged", prNumber: 7 });
    expect(r.mergeCalls()).toEqual([7]);
  });

  it("MQ5-b2 follow-up: a finished renumber round is not the source of a LATER refresh's delta review", async () => {
    const { r, a, round, s } = await running();
    const to = push(a, round, { old: mig(710), neu: mig(713) });
    await s.endRun(round.runId!);
    await s.complete();
    await s.finishReviews();
    expect(await s.completeDelta()).toEqual({ outcome: "passed" });
    // Later the branch is refreshed on top of the round's result, and that refresh is what is reviewed now.
    const next = `${"e".repeat(38)}07`;
    await db.admin.query(`INSERT INTO head_refreshes (account_id, repo_id, work_item_id, entry_id, from_sha, to_sha, base_sha, files_overlap) VALUES ($1, $2, $3, $4, $5, $6, $7, true)`, [r.accountId, r.repoId, a.workItemId, a.entryId, to, next, round.baseSha]);
    await db.admin.query(`UPDATE merge_queue_entries SET state = 'in_flight', slot_holder = 'h', lease_until = now() + interval '5 minutes', slot_taken_at = now(), phase = 'refresh' WHERE id = $1`, [a.entryId]);
    expect((await tenant(r.accountId, (c) => releaseForWork(c, { accountId: r.accountId, entryId: a.entryId, holder: "h", kind: "delta_review" }))).ok).toBe(true);
    for (const role of ["code-reviewer", "acceptance-tester"]) {
      await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha, envelope) VALUES ($1, $2, $3, $4, 'production', 'succeeded', $5, $6::jsonb)`, [randomUUID(), r.accountId, a.workItemId, role, next, JSON.stringify(pass)]);
    }
    a.g.world.headSha = next;
    // Matched to the old round, the source would be `to` and the moved head would read as head_changed; the refresh is the source, so the reviews at `next` count.
    expect(await s.completeDelta()).toEqual({ outcome: "passed" });
    expect(await r.entry(7)).toMatchObject({ state: "queued", headSha: to });
  });

  describe("item 28: two queued pull requests add the same next number", () => {
    async function twoPulls(settings?: unknown) {
      const r = await start();
      await queued(r, 7, mig(713), mig(711, 712));
      const b = await queued(r, 8, mig(713), mig(711, 712), new Date(T0.getTime() + MIN));
      if (settings !== undefined) await db.admin.query("UPDATE repos SET settings = $2::jsonb WHERE id = $1", [r.repoId, JSON.stringify(settings)]);
      const base = tickDeps(r);
      // The first merge moves main: the next read of the default branch holds 0713.
      const moving = {
        ...base,
        gate: async (args: Parameters<typeof base.gate>[0]) => {
          const out = await base.gate(args);
          if (out.outcome === "merged") for (const pr of [7, 8]) r.setTip(pr, NEWTIP, mig(711, 712, 713));
          return out;
        },
      };
      return { r, b, out: await runQueueTick(moving, r) };
    }

    it("autoRenumber on: the second is renumbered to 0714 after the first merged, reviewed, and merges with a unique key", async () => {
      const { r, b, out } = await twoPulls();
      expect(out.steps.slice(0, 2)).toEqual([{ step: "merged", entryId: expect.any(String), prNumber: 7 }, { step: "released", entryId: b.entryId, why: "ordered_resource_renumbering" }]);
      expect(r.mergeCalls()).toEqual([7]);
      const [round] = await rounds(r, b);
      expect(round).toMatchObject({ kind: "renumber", baseSha: NEWTIP, conflictFiles: mig(713) });
      const s = completion(r, b);
      push(b, round!, { old: mig(713), neu: mig(714) });
      await s.endRun(round!.runId!);
      expect(await s.complete()).toEqual({ outcome: "delta_started" });
      await s.finishReviews();
      expect(await s.completeDelta()).toEqual({ outcome: "passed" });
      expect((await runQueueTick(tickDeps(r), r)).steps[0]).toMatchObject({ step: "merged", prNumber: 8 });
      expect(r.mergeCalls()).toEqual([7, 8]);
      expect(b.g.world.pullFiles.map((f) => f.filename)).toEqual(mig(714));
    });

    it("autoRenumber off: the second stops `ordered_resource_out_of_order`, starts no round and never merges", async () => {
      const { r, b, out } = await twoPulls({ autoRenumber: false });
      expect(out.steps[1]).toEqual({ step: "released", entryId: b.entryId, why: "ordered_resource_out_of_order" });
      expect(await r.entry(8)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order", workKind: null, conflictRounds: 0 });
      expect(await rounds(r, b)).toEqual([]);
      expect(r.mergeCalls()).toEqual([7]);
    });
  });

  describe("MQ5-b2-2: a round that changes a path outside the renamed files and their references stops", () => {
    const old = mig(710);
    const neu = mig(713);
    it.each([
      ["a path the pull request never changed", { changed: [...neu, ...old, REF, "src/unrelated.ts"] }],
      ["a workflow file", { changed: [...neu, ...old, REF, ".github/workflows/ci.yml"] }],
      ["an extra resource file", { changed: [...neu, ...old, REF, ...mig(714)] }],
      ["the old file left in place", { changed: [...neu, REF] }],
      ["no new file", { changed: [...old, REF] }],
    ])("%s: `renumber_out_of_scope`, the round ends with it, no review is paid for and nothing merges", async (_name, over) => {
      const { r, a, round, s } = await running();
      push(a, round, { old, neu, ...over });
      await s.endRun(round.runId!);
      expect(await s.complete()).toEqual({ outcome: "stopped", reason: "renumber_out_of_scope" });
      expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "renumber_out_of_scope", slotHolder: null, approvedAt: T0 });
      expect((await rounds(r, a))[0]).toMatchObject({ outcome: "renumber_out_of_scope", toSha: null });
      expect(await events(r, a)).toEqual([{ kind: "stopped", code: "renumber_out_of_scope", reasons: ["renumber_out_of_scope"], round: 1 }]);
      expect(s.started).toEqual([]);
      expect(await s.complete()).toEqual({ outcome: "not_waiting" });
      expect((await runQueueTick(tickDeps(r), r)).steps.map((x) => x.step)).toEqual(["idle"]);
      expect(r.mergeCalls()).toEqual([]);
    });
  });

  describe("MQ5-b2-3: a commit that is not the round's own, or a history that is not a descent, stops the round with no carry", () => {
    const old = mig(710);
    const neu = mig(713);
    const refused = async (c: Awaited<ReturnType<typeof running>>, outcome: string, reason: string) => {
      expect(await c.s.complete()).toEqual({ outcome: "stopped", reason });
      expect(await c.r.entry(7)).toMatchObject({ state: "stopped", reason, approvedAt: T0 });
      expect((await rounds(c.r, c.a))[0]).toMatchObject({ outcome, toSha: null });
      expect(c.s.started).toEqual([]);
      expect(r_mergeCalls(c.r)).toEqual([]);
    };
    const r_mergeCalls = (r: QueueRepo) => r.mergeCalls();

    it("a head no push record of the platform covers (a person pushed it)", async () => {
      const c = await running();
      push(c.a, c.round, { old, neu, record: false });
      await c.s.endRun(c.round.runId!);
      await refused(c, "foreign_commits", "ordered_resource_out_of_order");
    });

    it("a record of another run is no cover", async () => {
      const c = await running();
      push(c.a, c.round, { old, neu, record: { runId: randomUUID() } });
      await c.s.endRun(c.round.runId!);
      await refused(c, "foreign_commits", "ordered_resource_out_of_order");
    });

    it("a person's commit between from_sha and the platform's push breaks the chain", async () => {
      const c = await running();
      const person = reverse(c.a.head).replace(/^./, "9");
      push(c.a, c.round, { old, neu, record: { oldSha: person }, parents: [person] });
      await c.s.endRun(c.round.runId!);
      await refused(c, "foreign_commits", "ordered_resource_out_of_order");
    });

    it("two pushes of the round's own run chain back to from_sha and pass", async () => {
      const c = await running();
      const mid = reverse(shaOf(7, "fresh"));
      records.push({ oldSha: c.round.fromSha, newSha: mid, startSha: null, runId: c.round.runId! });
      push(c.a, c.round, { old, neu, record: { oldSha: mid }, parents: [mid] });
      await c.s.endRun(c.round.runId!);
      expect(await c.s.complete()).toEqual({ outcome: "delta_started" });
    });

    it("a head that is not a descendant of from_sha (a rewritten history) stops as history_rewritten, even while the run goes", async () => {
      const c = await running();
      push(c.a, c.round, { old, neu, status: "diverged" });
      await refused(c, "history_rewritten", "history_rewritten");
      expect(await runStatus(c.round.runId!)).toBe("cancelled");
    });

    it("a platform proof that cannot be read sends the entry to review (never a pass, never a merge)", async () => {
      const c = await running();
      push(c.a, c.round, { old, neu });
      await c.s.endRun(c.round.runId!);
      setPlatformCommitProofForTest(async () => null);
      expect(await c.s.complete()).toEqual({ outcome: "returned", reason: "identity_unread" });
      expect(await c.r.entry(7)).toMatchObject({ state: "in_review", approvedAt: T0 });
      expect(c.s.started).toEqual([]);
      expect(c.s.log).toEqual(["identity_unread"]);
    });
  });

  describe("MQ5-b2-4: the keys are read again at the round's end", () => {
    it.each([
      ["below the highest", 711],
      ["equal to the highest", 712],
    ])("a key still %s with the default branch unmoved is the round's own mistake: a stop", async (_name, k) => {
      const { r, a, round, s } = await running();
      push(a, round, { old: mig(710), neu: mig(k) });
      await s.endRun(round.runId!);
      expect(await s.complete()).toEqual({ outcome: "stopped", reason: "ordered_resource_out_of_order" });
      expect((await rounds(r, a))[0]).toMatchObject({ outcome: "ordered_resource_out_of_order" });
      expect(s.started).toEqual([]);
      expect(r.mergeCalls()).toEqual([]);
    });

    it("two new keys that collide are a stop too", async () => {
      const { r, a, round, s } = await running({ adds: [710, 711], tip: [709, 712] });
      push(a, round, { old: mig(710, 711), neu: mig(713, 713).map((p, i) => (i === 0 ? p : p.replace("_m.sql", "_n.sql"))) });
      await s.endRun(round.runId!);
      expect(await s.complete()).toEqual({ outcome: "stopped", reason: "ordered_resource_out_of_order" });
      expect(await r.entry(7)).toMatchObject({ state: "stopped" });
    });

    it("the default branch moved during the round: a refresh, not a failed round. The diff is still reviewed, and the next take starts the next round at the new highest", async () => {
      const { r, a, round, s } = await running();
      push(a, round, { old: mig(710), neu: mig(713) });
      // Another pull request took 0713 meanwhile.
      r.setTip(7, NEWTIP, mig(711, 712, 713));
      await s.endRun(round.runId!);
      expect(await s.complete()).toEqual({ outcome: "delta_started" });
      await s.finishReviews();
      expect(await s.completeDelta()).toEqual({ outcome: "passed" });
      expect(await r.entry(7)).toMatchObject({ state: "queued", approvedAt: T0, conflictRounds: 1 });
      const out = await runQueueTick(tickDeps(r), r);
      expect(out.steps[0]).toEqual({ step: "released", entryId: a.entryId, why: "ordered_resource_renumbering" });
      expect(await r.entry(7)).toMatchObject({ state: "awaiting_work", workKind: "renumber", conflictRounds: 2, approvedAt: T0 });
      expect((await rounds(r, a)).map((x) => [x.round, x.kind, x.outcome])).toEqual([[1, "renumber", "resolved"], [2, "renumber", null]]);
      expect(r.mergeCalls()).toEqual([]);
    });
  });

  it("MQ5-b2-5: a merge commit as the head is the wrong shape: refused, back to review, no review run", async () => {
    const { r, a, round, s } = await running();
    push(a, round, { old: mig(710), neu: mig(713), parents: [round.fromSha, shaOf(7, "tip")] });
    await s.endRun(round.runId!);
    expect(await s.complete()).toEqual({ outcome: "returned", reason: "not_a_renumber" });
    expect(await r.entry(7)).toMatchObject({ state: "in_review", approvedAt: T0 });
    expect(s.started).toEqual([]);
    expect(s.log).toEqual(["not_a_renumber"]);
    expect((await rounds(r, a))[0]).toMatchObject({ outcome: "not_a_renumber" });
  });

  describe("MQ5-b2-6: the round's bound and start decisions hold after the flip", () => {
    it("the run never pushed anything: stopped once it has ended, with the bound spent", async () => {
      const { r, a, round, s } = await running();
      await s.endRun(round.runId!);
      expect(await s.complete()).toEqual({ outcome: "stopped", reason: "ordered_resource_out_of_order" });
      expect((await rounds(r, a))[0]).toMatchObject({ outcome: "pushed_nothing" });
      expect(await r.entry(7)).toMatchObject({ conflictRounds: 1 });
    });

    it("a run that never ends is stopped at the round's bound", async () => {
      const { r, s } = await running();
      expect(await s.complete(new Date(Date.now() + 10 * 24 * 60 * MIN))).toEqual({ outcome: "stopped", reason: "ordered_resource_out_of_order" });
      expect(await r.entry(7)).toMatchObject({ state: "stopped" });
    });

    it("an entry that used both rounds on conflicts gets no renumber round (the bound is shared)", async () => {
      const r = await start();
      const a = await queued(r, 7, mig(710), mig(711, 712));
      await db.admin.query("UPDATE merge_queue_entries SET conflict_rounds = 2 WHERE account_id = $1 AND id = $2", [r.accountId, a.entryId]);
      await runQueueTick(tickDeps(r), r);
      expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "ordered_resource_out_of_order", conflictRounds: 2 });
      expect(await rounds(r, a)).toEqual([]);
    });

    it("a stopped-for-ordering entry is not touched by the completion (it is not waiting)", async () => {
      const { a, round, s } = await running();
      push(a, round, { old: mig(710), neu: mig(713), changed: [...mig(713), ...mig(710), "src/unrelated.ts"] });
      await s.endRun(round.runId!);
      await s.complete();
      expect(await s.complete()).toEqual({ outcome: "not_waiting" });
    });
  });
});
