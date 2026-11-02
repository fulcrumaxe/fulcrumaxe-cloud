import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { completeConflictRound, completeDeltaReview, createOnConflict, createStartDeltaReview, readPlatformCommitProof, runQueueTick, setPlatformCommitProofForTest, type ConflictCompletionPorts, type ConflictPorts, type DeltaCompletionPorts, type MergeQueueEntry, type PlatformPush } from "../../src/mergeQueue/index.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { T0, shaOf, startQueueRepo, type QueueRepo, type RepoCall } from "./helpers/queueRepo.js";

/**
 * D#519 acceptance 20, the three-item end-to-end: items A, B and C on one repository are approved in the order A, B, C and their
 * reviews finish in the order C, A, B. All three merge, one at a time, in `approved_at` order. B and C each fall behind the default
 * branch when the one before them merges, are refreshed with no agent run, wait for fresh CI on the new head and merge on it. The
 * test pins the exact sequence of GitHub calls the strict fake saw.
 *
 * It runs the real tick over real Postgres and real TLS (the same pieces production wires; the only stand-ins are the gate's
 * reviewer-run lookup, which is the real `runMergeGate` over seeded passing rows, and GitHub itself, whose three-way merge result is
 * given per scenario). The workflow wrapper around the tick (enqueue, then a durable wait on the entry) is covered in
 * apps/web/workflows, not here.
 */
const MIN = 60_000;
const A = 7;
const B = 8;
const C = 9;

let repos: QueueRepo[] = [];
// D#519 C10: the platform commit proof is the one module-level source, unread until a test sets it. `records` are the platform's pushes (the conflict case below).
let records: PlatformPush[] = [];
beforeEach(() => {
  records = [];
  setPlatformCommitProofForTest(async (_e, shas) => ({ appLogin: "fulcrumaxe-app[bot]", pushes: records.filter((x) => shas.includes(x.newSha)) }));
});
afterEach(async () => {
  setPlatformCommitProofForTest(null);
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

/**
 * The calls that decide something, one short line each. A run of pull reads of several pull requests is the recheck, which reads them in
 * parallel, so it is one line naming the set. Consecutive repeats (a poll, a second read of the same CI) say nothing more.
 */
function trace(calls: readonly RepoCall[]): string[] {
  const out: string[] = [];
  let reads = new Set<number>();
  const flush = () => {
    if (reads.size > 1) out.push(`RECHECK ${[...reads].sort().join(",")}`);
    else if (reads.size === 1) out.push(`GET pull #${[...reads][0]}`);
    reads = new Set();
  };
  for (const c of calls) {
    if (c.method === "GET" && /\/pulls\/\d+$/.test(c.path)) {
      reads.add(c.pr!);
      continue;
    }
    let line: string | null = null;
    if (c.method === "PUT" && c.path.endsWith("/update-branch")) line = `PUT update-branch #${c.pr}`;
    else if (c.method === "PUT" && c.path.endsWith("/merge")) line = `PUT merge #${c.pr}`;
    // MQ-MAIN-RED-GUARD: the default branch's tip is read once per slot taken (the ref, then every run of that sha, `filter=all`); one line stands for both.
    else if (c.path.includes("/git/ref/heads/")) line = "GUARD main tip";
    else if (c.path.endsWith("/check-runs") && c.query?.includes('"filter":"all"')) continue;
    else if (c.path.endsWith("/check-runs")) line = `GET check-runs #${c.pr}`;
    else if (c.path.includes("/compare/main...")) line = `GET compare #${c.pr}`;
    if (line === null) continue;
    flush();
    out.push(line);
  }
  flush();
  return out.filter((l, i) => l !== out[i - 1]);
}

describe("D#519 MQ3-b three items end to end [pg]", () => {
  const db = pgHarness();

  it("A, B, C approved in that order, reviewed C, A, B: one merge at a time in approved_at order, B and C refreshed after the merge before them", async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    // Review completion order = enqueue order: C first, then A, then B. Their approved_at stamps say A < B < C.
    const c = await r.addItem(C, { approvedAt: new Date(T0.getTime() + 2 * MIN) });
    const a = await r.addItem(A, { approvedAt: T0 });
    const b = await r.addItem(B, { approvedAt: new Date(T0.getTime() + MIN) });

    // Each merge moves the default branch under every pull request still open, and the merges never overlap.
    // Each merge reply is held open for real time and the open requests are counted across all three pull requests, so two overlapping
    // merge calls would read 2. (The control test in tick.pg.test.ts shows the gauge does read 2 for calls that really overlap.)
    const gauge = { now: 0, max: 0 };
    for (const it of [a, b, c]) {
      it.g.world.mergeGauge = gauge;
      it.g.world.mergeDelayMs = 15;
      it.g.world.onMerge = () => r.mainMoved(it.pr);
    }

    const runsBefore = Number((await db.admin.query(`SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1`, [r.accountId])).rows[0].n);
    const out = await runQueueTick(r.deps(), r);

    // All three merged, in approved_at order, by the gate.
    expect(r.mergeCalls()).toEqual([A, B, C]);
    expect(out.steps.map((s) => s.step)).toEqual(["merged", "merged", "merged", "idle"]);
    expect(gauge.max).toBe(1);
    for (const pr of [A, B, C]) expect(await r.entry(pr)).toMatchObject({ state: "merged", mergedBy: "gate", slotHolder: null });

    // A went on its reviewed head. B and C were each refreshed once, with no agent run, and merged on the NEW head.
    expect(a.g.world.merges.map((m) => m.sha)).toEqual([a.head]);
    expect(a.g.world.updates).toEqual([]);
    expect(b.g.world.updates).toEqual([{ expected: b.head }]);
    expect(c.g.world.updates).toEqual([{ expected: c.head }]);
    expect(b.g.world.merges.map((m) => m.sha)).toEqual([b.fresh]);
    expect(c.g.world.merges.map((m) => m.sha)).toEqual([c.fresh]);
    expect(Number((await db.admin.query(`SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1`, [r.accountId])).rows[0].n)).toBe(runsBefore);
    const rows = (await db.admin.query(`SELECT from_sha, to_sha FROM head_refreshes WHERE account_id = $1 ORDER BY created_at`, [r.accountId])).rows;
    expect(rows).toEqual([
      { from_sha: b.head, to_sha: b.fresh },
      { from_sha: c.head, to_sha: c.fresh },
    ]);

    // The exact calls, in order. Every pass starts with the recheck: all queued pull requests read at once, before anything is taken. A
    // pull request that is not behind is gated on its reviewed head (the tick reads its CI, then the gate reads it again and merges).
    // After a merge the rest are rechecked BEFORE the next one is refreshed. A behind one is compared, refreshed with update-branch
    // (202, applied on a later read), its new head read and verified, and its CI read for the new head before the merge call.
    expect(trace(r.calls)).toEqual([
      "RECHECK 7,8,9",
      "GUARD main tip",
      "GET pull #7",
      "GET compare #7",
      "GET pull #7",
      "GET check-runs #7",
      "GET pull #7",
      "GET check-runs #7",
      "PUT merge #7",
      "RECHECK 8,9",
      "GUARD main tip",
      "GET pull #8",
      "GET compare #8",
      "GET pull #8",
      "PUT update-branch #8",
      "GET pull #8",
      "GET compare #8",
      "GET pull #8",
      "GET compare #8",
      "GET pull #8",
      "GET check-runs #8",
      "GET pull #8",
      "GET check-runs #8",
      "GET pull #8",
      "GET check-runs #8",
      "PUT merge #8",
      "GET pull #9",
      "GUARD main tip",
      "GET pull #9",
      "GET compare #9",
      "GET pull #9",
      "PUT update-branch #9",
      "GET pull #9",
      "GET compare #9",
      "GET pull #9",
      "GET compare #9",
      "GET pull #9",
      "GET check-runs #9",
      "GET pull #9",
      "GET check-runs #9",
      "GET pull #9",
      "GET check-runs #9",
      "PUT merge #9",
    ]);
  });
  it("B overlaps what A changed: it gets a delta review of the merge commit (every gated role), keeps its approved_at, and still merges before C, which was approved after it", async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    const a = await r.addItem(A, { approvedAt: T0 });
    const b = await r.addItem(B, { approvedAt: new Date(T0.getTime() + MIN), world: { files: [{ filename: "src/b.ts" }], mainFiles: [{ filename: "src/b.ts" }] } });
    const gauge = { now: 0, max: 0 };
    for (const it of [a, b]) {
      it.g.world.mergeGauge = gauge;
      it.g.world.mergeDelayMs = 15;
      it.g.world.onMerge = () => r.mainMoved(it.pr);
    }
    // The delta review's runs are rows of agent_runs: started `running` on the merge commit by the port, ended by the test.
    const started: Array<{ role: string; sha: string; files: readonly string[] }> = [];
    const live = async (entry: MergeQueueEntry, sha: string) =>
      (await db.admin.query(`SELECT DISTINCT ON (role) id, role, status FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND head_sha = $3 ORDER BY role, created_at DESC`, [r.accountId, entry.workItemId, sha])).rows;
    const base = r.deps();
    const ports = (): DeltaCompletionPorts => ({
      github: base.github,
      inTenant: base.inTenant,
      plan: async () => ({ ok: true, roles: ["code-reviewer", "acceptance-tester"] }),
      runs: async (entry, sha) => (await live(entry, sha)).map((x) => ({ role: x.role as string, runId: x.id as string, attempt: 0, reusable: x.status !== "cancelled" })),
      startRole: async ({ entry, role, delta }) => {
        started.push({ role, sha: delta.mergeCommitSha, files: delta.changedFiles });
        const id = randomUUID();
        await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, $4, 'production', 'running', $5)`, [id, r.accountId, entry.workItemId, role, delta.mergeCommitSha]);
        return { ok: true, runId: id };
      },
      cancelRun: async () => undefined,
      recordEvent: async () => undefined,
      outcome: async (_e, runId) => {
        const x = (await db.admin.query(`SELECT status, envelope FROM agent_runs WHERE id = $1`, [runId])).rows[0];
        return { done: x.status !== "running", verdict: x.envelope?.verdict ?? "fail", securityNeeded: false, noVerdict: x.status !== "running" && !x.envelope?.verdict };
      },
    });
    const deps = r.deps({ startDeltaReview: createStartDeltaReview(ports()) });

    // Pass 1: A merges on its reviewed head; B is behind and overlaps, so B is refreshed and released for its delta review, which runs
    // while the slot is free.
    const first = await runQueueTick(deps, r);
    expect(first.steps.map((s) => s.step)).toEqual(["merged", "released", "idle"]);
    expect(first.steps[1]).toMatchObject({ why: "needs_delta_review" });
    expect(r.mergeCalls()).toEqual([A]);
    expect(await r.entry(B)).toMatchObject({ state: "awaiting_work", workKind: "delta_review", slotHolder: null, approvedAt: new Date(T0.getTime() + MIN) });
    // Exactly the gated roles, on the merge commit only.
    expect(started).toEqual([
      { role: "code-reviewer", sha: b.fresh, files: ["src/b.ts"] },
      { role: "acceptance-tester", sha: b.fresh, files: ["src/b.ts"] },
    ]);
    // A never got a run: the only runs besides the seeded passes are B's two.
    expect(Number((await db.admin.query(`SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1 AND head_sha <> ALL($2)`, [r.accountId, [a.head, b.head]])).rows[0].n)).toBe(2);

    // C is approved after B while B is in review. B's runs have not ended: nothing changes for B.
    const c = await r.addItem(C, { approvedAt: new Date(T0.getTime() + 2 * MIN) });
    c.g.world.behindBy = 1;
    c.g.world.mergeGauge = gauge;
    c.g.world.mergeDelayMs = 15;
    c.g.world.onMerge = () => r.mainMoved(c.pr);
    expect(await completeDeltaReview(ports(), await r.entry(B))).toEqual({ outcome: "waiting" });

    // Both reviewers pass: B returns to the queue at its ORIGINAL position, ahead of C, and fresh CI is still required of it.
    await db.admin.query(`UPDATE agent_runs SET status = 'succeeded', envelope = '{"verdict":"pass"}' WHERE account_id = $1 AND head_sha = $2`, [r.accountId, b.fresh]);
    expect(await completeDeltaReview(ports(), await r.entry(B))).toEqual({ outcome: "passed" });
    expect(await r.entry(B)).toMatchObject({ state: "queued", approvedAt: new Date(T0.getTime() + MIN) });

    const before = r.calls.length;
    const second = await runQueueTick(deps, r);
    expect(second.steps.map((s) => s.step)).toEqual(["merged", "merged", "idle"]);
    expect(r.mergeCalls()).toEqual([A, B, C]);
    expect(gauge.max).toBe(1);
    // B merged on the merge commit the delta review judged, C on its own refreshed head.
    expect(b.g.world.merges.map((m) => m.sha)).toEqual([b.fresh]);
    expect(c.g.world.merges.map((m) => m.sha)).toEqual([c.fresh]);
    // B was refreshed once (before its review), never again.
    expect(b.g.world.updates).toEqual([{ expected: b.head }]);
    // The exact calls. Pass 1: A merges; B is compared, refreshed (update-branch), its new head read and verified, and the slot is released for the
    // delta review (no CI read, no merge call for B). Pass 2: B is gated on the merge commit with fresh CI and merges, then C is refreshed and merges.
    expect(trace(r.calls.slice(0, before))).toEqual([
      "RECHECK 7,8", "GUARD main tip", "GET pull #7", "GET compare #7", "GET pull #7", "GET check-runs #7", "GET pull #7", "GET check-runs #7", "PUT merge #7",
      "GET pull #8", "GUARD main tip", "GET pull #8", "GET compare #8", "GET pull #8", "PUT update-branch #8", "GET pull #8", "GET compare #8", "GET pull #8",
      "GET compare #8", "GET pull #8", "GET compare #8", "GET pull #8",
    ]);
    expect(trace(r.calls.slice(before))).toEqual([
      "RECHECK 8,9", "GUARD main tip", "GET pull #8", "GET compare #8", "GET pull #8", "GET check-runs #8", "GET pull #8", "GET check-runs #8", "GET pull #8",
      "GET check-runs #8", "PUT merge #8", "GET pull #9", "GUARD main tip", "GET pull #9", "GET compare #9", "GET pull #9", "PUT update-branch #9", "GET pull #9",
      "GET compare #9", "GET pull #9", "GET compare #9", "GET pull #9", "GET check-runs #9", "GET pull #9", "GET check-runs #9", "GET pull #9", "GET check-runs #9",
      "PUT merge #9",
    ]);
    for (const pr of [A, B, C]) expect(await r.entry(pr)).toMatchObject({ state: "merged", mergedBy: "gate", slotHolder: null });
  });

  it("C6-c8 and C6-c4: A and B conflict on a platform-authored file after A merges: B gets one round, a delta review and fresh CI (a check green on the old head must post on the new one), and merges after A", async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    const BOT = "fulcrumaxe-app[bot]";
    const MAIN_PARENT = "d".repeat(40);
    // The fake sends a request that names no pull request (the default branch ref) to the FIRST item added, so B is added first: it is the item under test, and
    // approved_at (not the order added) puts A ahead of it.
    const mergeBase = shaOf(B, "fresh").replace(/b/g, "d");
    const tip = shaOf(B, "tip");
    const bHead = shaOf(B, "head");
    const bFresh = shaOf(B, "fresh");
    const commitSha = (i: number) => `${B.toString(16).padStart(2, "0")}${i.toString(16).padStart(2, "0")}`.repeat(10).slice(0, 40);
    const b = await r.addItem(B, {
      approvedAt: new Date(T0.getTime() + MIN),
      world: {
        files: [{ filename: "src/a.ts" }, { filename: "src/other.ts" }],
        commits: { [commitSha(0)]: { parents: [mergeBase], authorLogin: BOT, committerLogin: "web-flow", verified: false, files: [{ filename: "src/a.ts" }] } },
        pullCommits: [{ sha: commitSha(0), authorLogin: BOT, committerLogin: "web-flow" }],
        compares: {
          [`${tip}...${bHead}`]: { status: "diverged", aheadBy: 1, behindBy: 1, mergeBaseSha: mergeBase, files: [{ filename: "src/a.ts" }, { filename: "src/other.ts" }] },
          [`${mergeBase}...${tip}`]: { status: "ahead", aheadBy: 1, behindBy: 0, mergeBaseSha: mergeBase, files: [{ filename: "src/a.ts" }] },
        },
        // What was green on the old head. The round's head will show only `build` at first.
        checkRunsBySha: { [bHead]: [{ name: "build", status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: "success" }] },
      },
    });
    // The executor's build pushed B's one commit through the proxy: the record that proves it ours.
    records.push({ oldSha: null, newSha: commitSha(0), startSha: null, runId: randomUUID() });
    const a = await r.addItem(A, { approvedAt: T0 });
    const gauge = { now: 0, max: 0 };
    for (const it of [a, b]) {
      it.g.world.mergeGauge = gauge;
      it.g.world.mergeDelayMs = 15;
      it.g.world.onMerge = () => r.mainMoved(it.pr);
    }
    // A's merge is what makes B conflict.
    a.g.world.onMerge = () => {
      r.mainMoved(A);
      b.g.world.conflict = true;
    };

    // The platform's own conflict decision, over the same strict GitHub port; the round's run is an `agent_runs` row the test ends.
    const base = r.deps();
    const roundRuns: string[] = [];
    const onConflict = createOnConflict({
      github: base.github as unknown as ConflictPorts["github"],
      inTenant: base.inTenant,
      platformCommits: async (entry, shas) => (await readPlatformCommitProof()?.(entry, shas)) ?? null,
      startConflictRound: async ({ entry }) => {
        const id = randomUUID();
        await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, 'executor', 'production', 'running', $4)`, [id, r.accountId, entry.workItemId, entry.headSha]);
        roundRuns.push(id);
        return { ok: true, runId: id };
      },
    });
    const first = await runQueueTick(r.deps({ onConflict }), r);
    expect(r.mergeCalls()).toEqual([A]);
    expect(first.conflicted).toEqual([b.entryId]);
    expect(await r.entry(B)).toMatchObject({ state: "awaiting_work", workKind: "conflict", conflictRounds: 1, slotHolder: null, approvedAt: new Date(T0.getTime() + MIN) });
    expect(b.g.world.updates).toEqual([]);

    // The executor merges the default branch into the branch and pushes one merge commit; the run ends.
    b.g.world.commits[bFresh] = { parents: [bHead, MAIN_PARENT], authorLogin: BOT, committerLogin: "web-flow", verified: false, files: [{ filename: "src/a.ts" }] };
    b.g.world.headSha = bFresh;
    records.push({ oldSha: bHead, newSha: bFresh, startSha: null, runId: roundRuns[0]! });
    b.g.world.conflict = false;
    b.g.world.behindBy = 0;
    await db.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE id = $1`, [roundRuns[0]]);

    const live = async (entry: MergeQueueEntry, sha: string) =>
      (await db.admin.query(`SELECT DISTINCT ON (role) id, role, status FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND head_sha = $3 AND role <> 'executor' ORDER BY role, created_at DESC`, [r.accountId, entry.workItemId, sha])).rows;
    const startedRoles: string[] = [];
    const ports: ConflictCompletionPorts = {
      github: base.github as unknown as ConflictCompletionPorts["github"],
      inTenant: base.inTenant,
      plan: async () => ({ ok: true, roles: ["code-reviewer", "acceptance-tester"] }),
      runs: async (entry, sha) => (await live(entry, sha)).map((x) => ({ role: x.role as string, runId: x.id as string, attempt: 0, reusable: x.status !== "cancelled" })),
      startRole: async ({ entry, role, delta }) => {
        startedRoles.push(`${role}:${delta.trigger}`);
        const id = randomUUID();
        await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, $4, 'production', 'running', $5)`, [id, r.accountId, entry.workItemId, role, delta.mergeCommitSha]);
        return { ok: true, runId: id };
      },
      cancelRun: async () => undefined,
      recordEvent: async () => undefined,
      outcome: async (_e, runId) => {
        const x = (await db.admin.query(`SELECT status, envelope FROM agent_runs WHERE id = $1`, [runId])).rows[0];
        return { done: x.status !== "running", verdict: x.envelope?.verdict ?? "fail", securityNeeded: false, noVerdict: x.status !== "running" && !x.envelope?.verdict };
      },
      roundRunEnded: async (_e, runId) => (await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId])).rows[0].status !== "running",
      onConflict,
    };
    expect(await completeConflictRound(ports, await r.entry(B))).toEqual({ outcome: "delta_started" });
    expect(startedRoles).toEqual(["code-reviewer:conflict_resolution", "acceptance-tester:conflict_resolution"]);
    await db.admin.query(`UPDATE agent_runs SET status = 'succeeded', envelope = '{"verdict":"pass"}' WHERE account_id = $1 AND head_sha = $2 AND role <> 'executor'`, [r.accountId, bFresh]);
    expect(await completeDeltaReview(ports, await r.entry(B))).toEqual({ outcome: "passed" });
    expect(await r.entry(B)).toMatchObject({ state: "queued", headSha: bFresh, approvedAt: new Date(T0.getTime() + MIN), slotHolder: null });
    expect(Number((await db.admin.query(`SELECT count(*)::int AS n FROM head_refreshes WHERE account_id = $1`, [r.accountId])).rows[0].n)).toBe(0);

    // C6-c4 stale green: the new head shows only `build` (and the review status); `lint` was green on the old head and has not posted. No merge.
    b.g.world.checkRunsBySha![bFresh] = [{ name: "build", status: "completed", conclusion: "success" }];
    b.g.world.statuses = { "fulcrumaxe/review": "success" };
    const second = await runQueueTick(r.deps({ onConflict }), r);
    expect(second.steps.map((s) => s.step)).toEqual(["parked"]);
    expect(r.mergeCalls()).toEqual([A]);
    // Once `lint` is green on the new head, it merges there, and nothing ever updated the branch.
    b.g.world.checkRunsBySha![bFresh] = [{ name: "build", status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: "success" }];
    const third = await runQueueTick(r.deps({ onConflict }), r);
    expect(third.steps.map((s) => s.step)).toEqual(["merged", "idle"]);
    expect(r.mergeCalls()).toEqual([A, B]);
    expect(b.g.world.merges.map((m) => m.sha)).toEqual([bFresh]);
    expect(b.g.world.updates).toEqual([]);
    expect(gauge.max).toBe(1);
    // The exact merge-side calls, in order: one conflict round, no update-branch for B, and two merge calls, never overlapping.
    expect(trace(r.calls).filter((l) => l.startsWith("PUT"))).toEqual(["PUT merge #7", "PUT merge #8"]);
    for (const pr of [A, B]) expect(await r.entry(pr)).toMatchObject({ state: "merged", mergedBy: "gate", slotHolder: null });
    expect(roundRuns).toHaveLength(1);
  });
});
