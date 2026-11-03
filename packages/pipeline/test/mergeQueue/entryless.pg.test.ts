import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import {
  MAX_CONFLICT_ROUNDS,
  MERGE_QUEUE_CONFLICT_ROUND_MAX_MINUTES,
  cancelWorkItemEntry,
  completeEntrylessRound,
  decideConflict,
  enqueueEntry,
  listConflictRounds,
  listOpenEntrylessRounds,
  setPlatformCommitProofForTest,
  startEntrylessConflict,
  startEntrylessConflictRound,
  subjectOf,
  type ConflictCompletionPorts,
  type ConflictPorts,
  type ConflictSubject,
  type PlatformPush,
  type RoundStart,
} from "../../src/mergeQueue/index.js";
import type { DeltaReviewInput } from "../../src/review/reviewPrompts.js";
import { startMergeTlsGitHub, type MergeTlsGitHub } from "../review/helpers/fakeGitHubMergeTls.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#519 MQ4-e1-a: a merge-conflict fix round for a work item with NO queue entry (the direct gate), over real Postgres (a plain `app_user` pool, row security in force) and the
 * strict GitHub fake over real TLS. The runs are rows of `agent_runs`; the round's agent run itself is a stub that answers like the worker's start (no model is called).
 * What it cannot fake: GitHub's own `mergeable` computation, and that a real executor's push is the one merge commit the prompt asks for.
 */
const PR = 7;
const FROM = "a".repeat(40);
const TIP = "c".repeat(40);
const MERGE_BASE = "b".repeat(40);
const MAIN_PARENT = "d".repeat(40);
const TO = "e".repeat(40);
const BOT = "fulcrumaxe-app[bot]";
const C0 = "1".repeat(40);
const pass = { verdict: "pass", findings: [], summary: "ok" };

let open: MergeTlsGitHub[] = [];
let records: PlatformPush[] = [];
const fromRecords = async (_e: unknown, shas: readonly string[]) => ({ appLogin: BOT, pushes: records.filter((r) => shas.includes(r.newSha)) });
beforeEach(() => {
  records = [];
  setPlatformCommitProofForTest(fromRecords);
});
afterEach(async () => {
  setPlatformCommitProofForTest(null);
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

describe("D#519 MQ4-e1-a conflict round for an item with no queue entry [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, accountId, fn);

  /** A work item with no queue entry, whose pull request conflicts on `src/a.ts` (one commit of ours touches it), and the ports over the strict fake. */
  async function setup(o: { author?: string; mainFiles?: string[]; startAnswer?: (round: number) => RoundStart; roles?: string[] } = {}) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: PR });
    const author = o.author ?? BOT;
    if (author === BOT) records.push({ oldSha: null, newSha: C0, startSha: null, runId: randomUUID() });
    const g = await startMergeTlsGitHub({
      prNumber: PR,
      headSha: FROM,
      baseTipSha: TIP,
      baseShas: [TIP, MAIN_PARENT],
      conflict: true,
      files: [{ filename: "src/a.ts" }, { filename: "src/other.ts" }],
      commits: { [C0]: { parents: [MERGE_BASE], authorLogin: author, committerLogin: "web-flow", verified: false, files: [{ filename: "src/a.ts" }] } },
      pullCommits: [{ sha: C0, authorLogin: author, committerLogin: "web-flow" }],
      compares: {
        [`${TIP}...${FROM}`]: { status: "diverged", aheadBy: 1, behindBy: 1, mergeBaseSha: MERGE_BASE, files: [{ filename: "src/a.ts" }, { filename: "src/other.ts" }] },
        [`${MERGE_BASE}...${TIP}`]: { status: "ahead", aheadBy: 1, behindBy: 0, mergeBaseSha: MERGE_BASE, files: (o.mainFiles ?? ["src/a.ts"]).map((filename) => ({ filename })) },
      },
    });
    open.push(g);
    const gh = createGitHubMergeGatePort({ http: g.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, sleep: async () => undefined, mergeablePollLimit: 3 });
    const subject = (over: Partial<ConflictSubject> = {}): ConflictSubject => ({ id: workItemId, accountId, repoId, workItemId, prNumber: PR, headSha: FROM, entryId: null, roundsUsed: 0, ...over });

    const events: string[] = [];
    const started: Array<{ role: string; delta: DeltaReviewInput }> = [];
    const roundStarts: Array<{ round: number; entryId: string | null; from: string; files: readonly string[] }> = [];
    const executors: string[] = [];
    const conflict: ConflictPorts<ConflictSubject> = {
      github: gh,
      inTenant: tenant,
      platformCommits: fromRecords,
      async startConflictRound({ entry, round }) {
        roundStarts.push({ round: round.round, entryId: round.entryId, from: round.fromSha, files: round.conflictFiles });
        expect(subjectOf(entry)).toMatchObject({ entryId: null, workItemId });
        const answer = o.startAnswer?.(round.round) ?? { ok: true as const, runId: randomUUID() };
        if (!answer.ok) return answer;
        await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, 'executor', 'production', 'running', $4)`, [answer.runId, accountId, workItemId, round.fromSha]);
        executors.push(answer.runId);
        return answer;
      },
    };
    const ports: ConflictCompletionPorts<ConflictSubject> = {
      github: gh,
      inTenant: tenant,
      plan: async () => ({ ok: true, roles: o.roles ?? ["code-reviewer", "acceptance-tester"] }),
      runs: async (_e, sha) =>
        (await db.admin.query(`SELECT DISTINCT ON (role) id, role, status FROM agent_runs WHERE account_id = $1 AND head_sha = $2 AND role <> 'executor' ORDER BY role, created_at DESC`, [accountId, sha])).rows.map((r) => ({ role: r.role as string, runId: r.id as string, attempt: 0, reusable: r.status !== "cancelled" })),
      startRole: async ({ role, delta }) => {
        started.push({ role, delta });
        const id = randomUUID();
        await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, $4, 'production', 'running', $5)`, [id, accountId, workItemId, role, delta.mergeCommitSha]);
        return { ok: true, runId: id };
      },
      cancelRun: async (_e, id) => void (await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1 AND status = 'running'`, [id])),
      recordEvent: async ({ code }) => void events.push(code),
      outcome: async (_e, id) => {
        const r = (await db.admin.query(`SELECT status, envelope FROM agent_runs WHERE id = $1`, [id])).rows[0];
        const done = r.status !== "running";
        const verdict = typeof r.envelope?.verdict === "string" ? (r.envelope.verdict as string) : "fail";
        return { done, verdict, securityNeeded: false, noVerdict: done && typeof r.envelope?.verdict !== "string" };
      },
      roundRunEnded: async (_e, id) => (await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [id])).rows[0].status !== "running",
      startEntryless: (s) => startEntrylessConflict(conflict, s),
    };
    const rounds = () => tenant(accountId, (c) => listConflictRounds(c, accountId, workItemId));
    return {
      accountId, repoId, workItemId, g, events, started, roundStarts, executors, conflict, ports, subject, rounds,
      start: (over: Partial<ConflictSubject> = {}) => startEntrylessConflict(conflict, subject(over)),
      complete: async (now?: Date) => completeEntrylessRound({ ...ports, ...(now ? { now: () => now } : {}) }, subject({ roundsUsed: (await rounds()).length })),
      driverEvents: async () => (await db.admin.query(`SELECT kind, code, reasons, round FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq`, [workItemId])).rows as Array<{ kind: string; code: string; reasons: string[]; round: number }>,
      details: async () => (await db.admin.query(`SELECT e.code, e.reasons, d.conflict_files FROM work_item_driver_event_details d JOIN work_item_driver_events e ON e.id = d.driver_event_id WHERE e.work_item_id = $1 ORDER BY e.seq`, [workItemId])).rows,
      endRun: async () => void (await db.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE account_id = $1 AND role = 'executor' AND status = 'running'`, [accountId])),
      finish: async (role: string, envelope: Record<string, unknown>) => void (await db.admin.query(`UPDATE agent_runs SET status = 'succeeded', envelope = $3 WHERE account_id = $1 AND role = $2 AND status = 'running'`, [accountId, role, JSON.stringify(envelope)])),
      statuses: async () => Object.fromEntries((await db.admin.query(`SELECT role, status FROM agent_runs WHERE account_id = $1 ORDER BY created_at`, [accountId])).rows.map((r) => [r.role, r.status])),
      refreshRows: async () => Number((await db.admin.query(`SELECT count(*)::int AS n FROM head_refreshes WHERE account_id = $1`, [accountId])).rows[0].n),
      itemStage: async () => (await db.admin.query(`SELECT * FROM work_items WHERE id = $1`, [workItemId])).rows[0] as Record<string, unknown>,
      /** The executor pushes the one merge commit (a record of the round's own run, from the round's head), and the branch merges cleanly again. */
      async push(over: Partial<{ sha: string; parents: string[]; files: string[]; author: string; record: false | { runId?: string } }> = {}) {
        const run = executors[executors.length - 1]!;
        const sha = over.sha ?? TO;
        g.world.commits[sha] = { parents: over.parents ?? [FROM, MAIN_PARENT], authorLogin: over.author ?? BOT, committerLogin: "web-flow", verified: false, files: (over.files ?? ["src/a.ts"]).map((filename) => ({ filename })) };
        if (over.record !== false) records.push({ oldSha: g.world.headSha, newSha: sha, startSha: null, runId: over.record?.runId ?? run });
        g.world.headSha = sha;
        g.world.conflict = false;
      },
    };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  it("C12-e1a-1: a dirty item with no entry gets exactly one round (entry_id null, one agent run), and a replayed start opens no second", async () => {
    const s = await setup();
    expect(await s.start()).toEqual({ outcome: "started" });
    const rows = await s.rounds();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ round: 1, entryId: null, fromSha: FROM, baseSha: TIP, baseRef: "main", conflictFiles: ["src/a.ts"], outcome: null });
    expect(rows[0]!.runId).toBe(s.executors[0]);
    expect(s.executors).toHaveLength(1);
    // C13-3: the retry while the newest round has no outcome opens nothing and starts no run.
    expect(await s.start()).toEqual({ outcome: "running" });
    expect(await s.rounds()).toHaveLength(1);
    expect(s.executors).toHaveLength(1);
    // No merge call and no update of the branch while the round runs.
    expect(s.g.world.calls.filter((c) => c.method === "PUT")).toEqual([]);
    expect((await listOpenEntrylessRounds(db.admin, s.accountId, s.repoId)).map((r) => r.id)).toEqual([rows[0]!.id]);
  });

  it("C13-3: the start refuses while the item has a live queue entry, and starts once that entry is cancelled", async () => {
    const s = await setup();
    await tenant(s.accountId, (c) => enqueueEntry(c, { accountId: s.accountId, repoId: s.repoId, workItemId: s.workItemId, prNumber: PR, headSha: FROM, approvedAt: new Date() }));
    expect(await s.start()).toEqual({ outcome: "running" });
    expect(await s.rounds()).toEqual([]);
    expect(s.executors).toEqual([]);
    await tenant(s.accountId, (c) => cancelWorkItemEntry(c, { accountId: s.accountId, workItemId: s.workItemId }));
    expect(await s.start()).toEqual({ outcome: "started" });
    expect(await s.rounds()).toHaveLength(1);
  });

  it("C12-e1a-3 (item 22): a foreign commit on a conflict file stops at foreign_commits with the files recorded; no round, no run", async () => {
    const s = await setup({ author: "mallory" });
    expect(await s.start()).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(await s.rounds()).toEqual([]);
    expect(s.executors).toEqual([]);
    expect(await s.driverEvents()).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["foreign_commits"], round: 0 }]);
    expect(await s.details()).toEqual([{ code: "merge_conflict", reasons: ["foreign_commits"], conflict_files: ["src/a.ts"] }]);
  });

  it("C12-e1a-3 (item 24): the bound counts the item's rows: a third round is never started, by the decision or by the insert", async () => {
    const s = await setup();
    for (let n = 1; n <= MAX_CONFLICT_ROUNDS; n++) {
      expect(await s.start({ roundsUsed: n - 1 })).toEqual({ outcome: "started" });
      await db.admin.query(`UPDATE merge_conflict_rounds SET outcome = 'conflicted_again', ended_at = now() WHERE work_item_id = $1 AND outcome IS NULL`, [s.workItemId]);
    }
    // The decision answers from the count it is given; the insert counts the rows itself, so a caller with a stale count still cannot open a third.
    expect(await s.start({ roundsUsed: 0 })).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(await s.rounds()).toHaveLength(MAX_CONFLICT_ROUNDS);
    expect(await s.start({ roundsUsed: MAX_CONFLICT_ROUNDS })).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(await s.rounds()).toHaveLength(MAX_CONFLICT_ROUNDS);
    expect(s.executors).toHaveLength(MAX_CONFLICT_ROUNDS);
    expect((await s.driverEvents()).map((e) => e.reasons[0])).toEqual(["rounds_exhausted", "rounds_exhausted"]);
    // The table has no DELETE grant for the writing login, so the bound cannot be reset by removing a row.
    await expect(tenant(s.accountId, (c) => c.query(`DELETE FROM merge_conflict_rounds WHERE work_item_id = $1`, [s.workItemId]))).rejects.toMatchObject({ code: "42501" });
  });

  it("C12-e1a-3 (item 26): a refused spend is Needs a person with no retry, no round row and nothing held; a capacity wait is asked again and leaves no row", async () => {
    const s = await setup({ startAnswer: () => ({ ok: false, reason: "refused_spend" }) });
    expect(await s.start()).toEqual({ outcome: "stopped", reason: "refused_spend" });
    expect(await s.rounds()).toEqual([]);
    expect(await s.driverEvents()).toEqual([{ kind: "stopped", code: "refused_spend", reasons: ["refused_spend"], round: 0 }]);
    const w = await setup({ startAnswer: () => ({ ok: false, reason: "waiting_for_capacity" }) });
    expect(await w.start()).toEqual({ outcome: "waiting" });
    expect(await w.rounds()).toEqual([]);
    expect(await w.driverEvents()).toEqual([]);
  });

  it("C12-e1a-7: the decision reads what the queue's decision reads (default tip, two compares, the commit list, each commit) and nothing new; the proof is asked before any read", async () => {
    const s = await setup();
    const asked: number[] = [];
    const ports: ConflictPorts<ConflictSubject> = { ...s.conflict, platformCommits: async (e, shas) => (asked.push(s.g.world.calls.length), fromRecords(e, shas)) };
    const decision = await decideConflict(ports, s.subject());
    expect(decision).toMatchObject({ go: true, files: ["src/a.ts"], baseSha: TIP, baseRef: "main" });
    expect(asked[0]).toBe(0);
    const paths = s.g.world.calls.map((c) => `${c.method} ${c.path.replace(/^.*\/repos\/[^/]+\/[^/]+/, "")}`);
    expect(paths.filter((p) => p.includes("/compare/"))).toHaveLength(2);
    expect(paths.filter((p) => /\/commits\/[0-9a-f]{40}$/.test(p))).toEqual([`GET /commits/${C0}`]);
    expect(paths.every((p) => p.startsWith("GET "))).toBe(true);
    // The queue's adapter decides the same from the same facts.
    const fromEntry = await decideConflict({ ...s.conflict } as unknown as ConflictPorts, subjectOfFake(s));
    expect(fromEntry).toEqual(decision);
  });

  /** A queue-entry-shaped value for the same item, to show the adapter gives the same decision. */
  const subjectOfFake = (s: Setup) =>
    ({ id: randomUUID(), accountId: s.accountId, repoId: s.repoId, entryKind: "work_item", workItemId: s.workItemId, planWritebackId: null, prNumber: PR, headSha: FROM, conflictRounds: 0 }) as never;

  it("C12-e1a-4 (item 23): a head that is not a descendant of the pre-round head stops history_rewritten, cancels the run, and the round ends with that outcome; no push afterwards", async () => {
    const s = await setup();
    await s.start();
    await s.push();
    s.g.world.compares[`${FROM}...${TO}`] = { status: "diverged", aheadBy: 1, behindBy: 1, mergeBaseSha: TIP, files: [] };
    expect(await s.complete()).toEqual({ outcome: "stopped", reason: "history_rewritten" });
    expect((await s.rounds())[0]).toMatchObject({ outcome: "history_rewritten" });
    expect((await s.statuses()).executor).toBe("cancelled");
    expect(await s.driverEvents()).toEqual([{ kind: "stopped", code: "history_rewritten", reasons: ["history_rewritten"], round: 1 }]);
    expect(s.started).toEqual([]);
    expect(await s.complete()).toEqual({ outcome: "not_waiting" });
    expect(s.g.world.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("C12-e1a-4 (C10 item 2): a head the round's own run did not push (none, another run's) is no resolution, even in the allowed shape: back to review, no delta review", async () => {
    for (const record of [false, { runId: randomUUID() }] as const) {
      const s = await setup();
      await s.start();
      await s.push({ record, author: "some-person" });
      await s.endRun();
      expect(await s.complete()).toEqual({ outcome: "returned", reason: "not_a_resolution" });
      expect(s.started).toEqual([]);
      expect(s.events).toEqual(["not_a_resolution"]);
      expect((await s.rounds())[0]).toMatchObject({ outcome: "not_a_resolution" });
    }
  });

  it("C12-e1a-5: a resolved round starts the delta review of every gated role on the merge commit; the passes re-enter the gate (passed); no head_refreshes row and no pass carried", async () => {
    const s = await setup();
    await s.start();
    await s.push();
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "delta_started" });
    expect(s.started.map((x) => x.role)).toEqual(["code-reviewer", "acceptance-tester"]);
    for (const x of s.started) expect(x.delta).toMatchObject({ trigger: "conflict_resolution", mergeCommitSha: TO, parents: [FROM, MAIN_PARENT], parentRoles: ["pr_side", "main_side"], changedFiles: ["src/a.ts"] });
    expect((await s.rounds())[0]).toMatchObject({ toSha: TO, outcome: "resolved" });
    // Waiting: nothing changes and a replay starts no second run.
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    expect(s.started).toHaveLength(2);
    await s.finish("code-reviewer", pass);
    await s.finish("acceptance-tester", pass);
    expect(await s.complete()).toEqual({ outcome: "passed" });
    expect(await s.complete()).toEqual({ outcome: "passed" });
    expect(await s.refreshRows()).toBe(0);
    expect(s.g.world.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it("C12-e1a-5: a delta review that does not pass returns the item to review (nothing carried), with a fixed event", async () => {
    const s = await setup();
    await s.start();
    await s.push();
    await s.endRun();
    await s.complete();
    await s.finish("code-reviewer", { verdict: "needs-fix", findings: ["a.ts:1"], summary: "no" });
    expect(await s.complete()).toEqual({ outcome: "returned", reason: "not_carried" });
    expect(s.events).toEqual(["not_carried"]);
    expect(await s.refreshRows()).toBe(0);
  });

  it("the run is still going and the head is unchanged: it waits; past the round bound the run is cancelled and the item stops as merge_conflict (round_timeout)", async () => {
    const s = await setup();
    await s.start();
    expect(await s.complete(new Date(Date.now() + 60 * 60_000))).toEqual({ outcome: "waiting" });
    expect(await s.complete(new Date(Date.now() + (MERGE_QUEUE_CONFLICT_ROUND_MAX_MINUTES + 10) * 60_000))).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect((await s.statuses()).executor).toBe("cancelled");
    expect((await s.rounds())[0]).toMatchObject({ outcome: "round_timeout" });
    expect(await s.driverEvents()).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["round_timeout"], round: 1 }]);
  });

  it("pushed nothing: the run ended with the head unchanged, so the item stops (merge_conflict) and a replay finds nothing to do", async () => {
    const s = await setup();
    await s.start();
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(await s.driverEvents()).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["pushed_nothing"], round: 1 }]);
    expect(await s.complete()).toEqual({ outcome: "not_waiting" });
  });

  it("the one shape but conflicting again: the round ends conflicted_again and the same bounded start opens round 2 from the new head; a third never opens", async () => {
    const s = await setup();
    await s.start();
    await s.push();
    s.g.world.conflict = true;
    s.g.world.compares[`${TIP}...${TO}`] = { status: "diverged", aheadBy: 2, behindBy: 1, mergeBaseSha: MERGE_BASE, files: [{ filename: "src/a.ts" }, { filename: "src/other.ts" }] };
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "new_round" });
    const rows = await s.rounds();
    expect(rows.map((r) => [r.round, r.entryId, r.fromSha, r.toSha, r.outcome])).toEqual([[1, null, FROM, TO, "conflicted_again"], [2, null, TO, null, null]]);
    expect(s.executors).toHaveLength(2);
    // Round 2 pushes nothing: it stops, and the bound (two rows) lets no third start.
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(await s.start({ roundsUsed: 2 })).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(await s.rounds()).toHaveLength(2);
  });

  describe("D#483: a chain of conflict rounds is reviewed from the head last reviewed", () => {
    const M1 = "7".repeat(40);
    const OTHER = "9".repeat(40);
    const file = (filename: string) => ({ filename });
    /** Round 1 pushes M1 (its resolution plus an edit outside the conflict) and the branch conflicts again; round 2 pushes TO on M1 and merges cleanly. */
    async function twoRounds(s: Setup, second: Partial<{ parents: string[]; record: false }> = {}) {
      await s.start();
      await s.push({ sha: M1, files: ["src/a.ts", "src/extra.ts"] });
      s.g.world.conflict = true;
      s.g.world.compares[`${TIP}...${M1}`] = { status: "diverged", aheadBy: 2, behindBy: 1, mergeBaseSha: MERGE_BASE, files: [file("src/a.ts"), file("src/other.ts")] };
      await s.endRun();
      expect(await s.complete()).toEqual({ outcome: "new_round" });
      await s.push({ sha: TO, parents: [M1, MAIN_PARENT], files: ["src/a.ts"], ...second });
      s.g.world.compares[`${FROM}...${TO}`] = { status: "ahead", aheadBy: 3, behindBy: 0, mergeBaseSha: FROM, files: [file("src/a.ts"), file("src/extra.ts"), file("src/other.ts")] };
      await s.endRun();
    }

    it("the delta review of round 2 reads everything since the head the chain began at (the pre-round-1 head), so round 1's edit outside the conflict is in its input; no pass on it, no pass for the item", async () => {
      const s = await setup({ roles: ["code-reviewer", "debater"] });
      await twoRounds(s);
      expect(await s.complete()).toEqual({ outcome: "delta_started" });
      const want = { trigger: "conflict_resolution", mergeCommitSha: TO, parents: [FROM, MAIN_PARENT], parentRoles: ["pr_side", "main_side"], changedFiles: ["src/a.ts", "src/extra.ts", "src/other.ts"] };
      expect(s.started.map((x) => x.role)).toEqual(["code-reviewer"]);
      expect(s.started[0]!.delta).toMatchObject(want);
      // The follow-up role (started when the first passes) reads the same chain.
      await s.finish("code-reviewer", pass);
      expect(await s.complete()).toEqual({ outcome: "waiting" });
      expect(s.started.map((x) => x.role)).toEqual(["code-reviewer", "debater"]);
      expect(s.started[1]!.delta).toMatchObject(want);
      // Nothing passes until every started role has; one that does not pass returns the item to review.
      expect(await s.complete()).toEqual({ outcome: "waiting" });
      await s.finish("debater", { verdict: "needs-fix", findings: ["src/extra.ts:1"], summary: "no" });
      expect(await s.complete()).toEqual({ outcome: "returned", reason: "not_carried" });
      expect(s.events).toEqual(["not_carried"]);
    });

    it("a foreign commit between round 1's head and round 2's head is no resolution: back to review, no delta review", async () => {
      const s = await setup();
      await twoRounds(s, { parents: [OTHER, MAIN_PARENT] });
      expect(await s.complete()).toEqual({ outcome: "returned", reason: "not_a_resolution" });
      expect(s.started).toEqual([]);
    });

    it("a link of the chain whose first parent is no longer the earlier head stops the delta review (head_changed), as the single round's own parents do", async () => {
      const s = await setup();
      await twoRounds(s);
      s.g.world.commits[M1]!.parents = [OTHER, MAIN_PARENT];
      expect(await s.complete()).toEqual({ outcome: "returned", reason: "head_changed" });
      expect(s.started).toEqual([]);
    });
  });

  it("the pull request merged or closed by a person mid-round: settled, the run is cancelled, the round ends", async () => {
    const s = await setup();
    await s.start();
    s.g.world.merged = true;
    expect(await s.complete()).toEqual({ outcome: "settled", as: "merged" });
    expect((await s.statuses()).executor).toBe("cancelled");
    expect((await s.rounds())[0]).toMatchObject({ outcome: "pr_merged" });
  });

  it.each([["merged", "pr_merged"], ["closed", "pr_closed"]] as const)("a pull request a person %s mid-round: the round ends %s, its run is cancelled, and the repository leaves the sweep's list", async (how, outcome) => {
    const s = await setup();
    await s.start();
    const listed = async () => (await db.runWriterPool.query(`SELECT account_id FROM merge_queue_sweep_targets(now(), 200)`)).rows.filter((r) => r.account_id === s.accountId);
    expect(await listed()).toHaveLength(1);
    if (how === "merged") s.g.world.merged = true;
    else s.g.world.state = "closed";
    expect(await s.complete()).toEqual({ outcome: "settled", as: how });
    expect((await s.rounds())[0]).toMatchObject({ outcome });
    expect((await s.statuses()).executor).toBe("cancelled");
    expect(await listed()).toEqual([]);
    // Nothing is left to follow, and a replay does nothing.
    expect(await s.complete()).toEqual({ outcome: "not_waiting" });
  });

  it("the insert is confined to its own item: a second item of the same account gets no row, and starts its own round independently", async () => {
    const s = await setup();
    const other = randomUUID();
    await seedWorkItem(db.admin, s.accountId, other, s.repoId, { ghNumber: PR + 1 });
    await s.start();
    expect((await db.admin.query(`SELECT work_item_id FROM merge_conflict_rounds WHERE account_id = $1`, [s.accountId])).rows).toEqual([{ work_item_id: s.workItemId }]);
    expect(await tenant(s.accountId, (c) => listConflictRounds(c, s.accountId, other))).toEqual([]);
    // The other item's own newest round does not block this one, and this one's open round does not block the other.
    const r = await tenant(s.accountId, (c) => startEntrylessConflictRound(c, { accountId: s.accountId, workItemId: other, fromSha: FROM, baseSha: TIP, baseRef: "main", conflictFiles: ["src/a.ts"] }));
    expect(r).toMatchObject({ ok: true, round: { round: 1, workItemId: other, entryId: null } });
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM merge_conflict_rounds WHERE account_id = $1`, [s.accountId])).rows[0].n).toBe(2);
  });

  it("the decision's own bound: at MAX_CONFLICT_ROUNDS it answers rounds_exhausted before it asks for the proof or reads GitHub", async () => {
    const s = await setup();
    const asked: number[] = [];
    const ports: ConflictPorts<ConflictSubject> = { ...s.conflict, platformCommits: async (e, shas) => (asked.push(1), fromRecords(e, shas)) };
    expect(await decideConflict(ports, s.subject({ roundsUsed: MAX_CONFLICT_ROUNDS }))).toEqual({ go: false, code: "rounds_exhausted", files: [] });
    expect(asked).toEqual([]);
    expect(s.g.world.calls).toEqual([]);
    expect(await decideConflict(ports, s.subject({ roundsUsed: MAX_CONFLICT_ROUNDS - 1 }))).toMatchObject({ go: true });
  });

  it("the item cancelled mid-round: the open round ends as cancelled through the existing cancel", async () => {
    const s = await setup();
    await s.start();
    await tenant(s.accountId, (c) => cancelWorkItemEntry(c, { accountId: s.accountId, workItemId: s.workItemId }));
    expect((await s.rounds())[0]).toMatchObject({ outcome: "cancelled" });
    expect(await s.start()).toEqual({ outcome: "started" });
  });

  it("the sweep's lister (migration 0964): a repo whose only open round has no entry is listed, until the round ends; the definer reads only the four columns", async () => {
    const s = await setup();
    const listed = async () => (await db.runWriterPool.query(`SELECT account_id, repo_id FROM merge_queue_sweep_targets(now(), 200)`)).rows.filter((r) => r.account_id === s.accountId);
    expect(await listed()).toEqual([]);
    await s.start();
    expect(await listed()).toEqual([{ account_id: s.accountId, repo_id: s.repoId }]);
    await db.admin.query(`UPDATE merge_conflict_rounds SET outcome = 'cancelled', ended_at = now() WHERE work_item_id = $1`, [s.workItemId]);
    expect(await listed()).toEqual([]);
    const grants = (await db.admin.query(`SELECT column_name FROM information_schema.column_privileges WHERE table_name = 'merge_conflict_rounds' AND grantee = 'merge_queue_sweep_definer' AND privilege_type = 'SELECT' ORDER BY column_name`)).rows.map((r) => r.column_name);
    expect(grants).toEqual(["account_id", "entry_id", "outcome", "repo_id"]);
  });

  it("the sweep's backstop finishes a round whose workflow is gone: the open round is found by the repository and ended by the same completion", async () => {
    const s = await setup();
    await s.start();
    await s.endRun();
    const open = await listOpenEntrylessRounds(db.admin, s.accountId, s.repoId);
    expect(open).toHaveLength(1);
    expect(await s.complete()).toMatchObject({ outcome: "stopped" });
    expect(await listOpenEntrylessRounds(db.admin, s.accountId, s.repoId)).toEqual([]);
  });

  // D#519 MQ4-e1-b: the two mappings of a paired item's public copy (the conflict path only).
  describe("MQ4-e1-b: a paired item's public copy", () => {
    it("C11-e1-4b (before the round): the start refused because the public branch is not where the platform left it stops foreign_commits with the files; no round, no run, no public ref written", async () => {
      const s = await setup({ startAnswer: () => ({ ok: false, reason: "public_branch_moved" }) });
      expect(await s.start()).toEqual({ outcome: "stopped", reason: "merge_conflict" });
      expect(await s.rounds()).toEqual([]);
      expect(await s.driverEvents()).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["foreign_commits"], round: 0 }]);
      expect(await s.details()).toEqual([{ code: "merge_conflict", reasons: ["foreign_commits"], conflict_files: ["src/a.ts"] }]);
      expect(s.g.world.calls.filter((c) => c.method !== "GET")).toEqual([]);
      // Any other refusal keeps the generic word.
      const other = await setup({ startAnswer: () => ({ ok: false, reason: "republish_failed" }) });
      expect(await other.start()).toEqual({ outcome: "stopped", reason: "merge_conflict" });
      expect((await other.driverEvents()).map((e) => e.reasons)).toEqual([["round_not_started"]]);
    });

    it("C12-e1b-1: after GitHub's queue removed the head for a conflict, the conflicted pull request gets its round and nothing is enqueued or merged for that head", async () => {
      const s = await setup();
      await db.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, reasons, head_sha, pr_number, dedupe_key) VALUES ($1, $2, 'merge_dequeued', 'merge_conflict', ARRAY['actor_app'], $3, $4, 'dequeued:one')`, [s.accountId, s.workItemId, FROM, PR]);
      expect(await s.start()).toEqual({ outcome: "started" });
      expect((await s.rounds())[0]).toMatchObject({ entryId: null, fromSha: FROM, outcome: null });
      expect(s.executors).toHaveLength(1);
      // The strict fake saw reads only: no enqueue (a GraphQL mutation), no merge, no update of the branch.
      expect(s.g.world.calls.filter((c) => c.method !== "GET")).toEqual([]);
      expect((await db.admin.query(`SELECT kind FROM work_item_driver_events WHERE work_item_id = $1 AND kind IN ('merge_enqueued', 'merged_by_gate')`, [s.workItemId])).rows).toEqual([]);
    });

    async function resolved(publicOutcome: NonNullable<ConflictCompletionPorts<ConflictSubject>["publicOutcome"]>) {
      const s = await setup();
      await s.start();
      await s.push();
      await s.endRun();
      s.ports.publicOutcome = publicOutcome;
      return s;
    }

    it("C11-e1-4b (in the publish): a lease refusal ends the round foreign_commits with the files; no delta review starts, no pass is carried, no public ref moves", async () => {
      const s = await resolved(async () => "branch_moved");
      expect(await s.complete()).toEqual({ outcome: "stopped", reason: "merge_conflict" });
      expect((await s.rounds())[0]).toMatchObject({ outcome: "foreign_commits" });
      expect(await s.details()).toEqual([{ code: "merge_conflict", reasons: ["foreign_commits"], conflict_files: ["src/a.ts"] }]);
      expect(s.started).toEqual([]);
      expect(await s.refreshRows()).toBe(0);
      expect(s.g.world.calls.filter((c) => c.method !== "GET")).toEqual([]);
    });

    it("C11-e1-4c: a republish that is not one commit on the main tip ends history_rewritten; nothing is started", async () => {
      const s = await resolved(async () => "history_rewritten");
      expect(await s.complete()).toEqual({ outcome: "stopped", reason: "history_rewritten" });
      expect((await s.rounds())[0]).toMatchObject({ outcome: "history_rewritten" });
      expect((await s.driverEvents()).map((e) => [e.code, e.reasons])).toEqual([["history_rewritten", ["history_rewritten"]]]);
      expect(s.started).toEqual([]);
    });

    it("a republish that did not update the public copy (scan refusal, unreachable repository, crashed hook, copy taken over or closed) ends the round republish_failed: the round has an outcome, no delta review starts, a replay finds nothing to do", async () => {
      const s = await resolved(async () => "failed");
      expect(await s.complete()).toEqual({ outcome: "stopped", reason: "merge_conflict" });
      expect((await s.rounds())[0]).toMatchObject({ outcome: "republish_failed" });
      expect(s.started).toEqual([]);
      expect(await s.refreshRows()).toBe(0);
      expect(await s.complete()).toEqual({ outcome: "not_waiting" });
      expect(await listOpenEntrylessRounds(db.admin, s.accountId, s.repoId)).toEqual([]);
    });

    it("C11-e1-4a: a republish still going waits (the round bound applies); a finished one goes to the delta review of every gated role", async () => {
      let state: "pending" | "done" = "pending";
      const s = await resolved(async () => state);
      expect(await s.complete()).toEqual({ outcome: "waiting" });
      expect(s.started).toEqual([]);
      state = "done";
      expect(await s.complete()).toEqual({ outcome: "delta_started" });
      expect(s.started.map((x) => x.role)).toEqual(["code-reviewer", "acceptance-tester"]);
    });
  });
});
