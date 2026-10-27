import { afterEach, describe, expect, it } from "vitest";
import { runQueueTick } from "../../src/mergeQueue/index.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { T0, startQueueRepo, type QueueRepo, type RepoCall } from "./helpers/queueRepo.js";

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
afterEach(async () => {
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
      "GET compare #7",
      "GET pull #7",
      "GET check-runs #7",
      "GET pull #7",
      "GET check-runs #7",
      "PUT merge #7",
      "RECHECK 8,9",
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
});
