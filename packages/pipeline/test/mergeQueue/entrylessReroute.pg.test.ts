import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import {
  MAX_CONFLICT_ROUNDS,
  completeEntrylessRound,
  listConflictRounds,
  setPlatformCommitProofForTest,
  startEntrylessConflict,
  startEntrylessRenumber,
  type ConflictCompletionPorts,
  type ConflictPorts,
  type ConflictSubject,
  type EntrylessRenumberPorts,
  type PlatformPush,
  type RoundStart,
} from "../../src/mergeQueue/index.js";
import type { DeltaReviewInput } from "../../src/review/reviewPrompts.js";
import { startMergeTlsGitHub, type MergeTlsGitHub } from "../review/helpers/fakeGitHubMergeTls.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#483 S5-j2e: the entryless round started after the direct gate's `overlap_unreviewed` (a merge that is clean) or `ordered_resource_out_of_order`, over real Postgres (a plain `app_user`
 * pool, row security in force) and the strict GitHub fake over real TLS. The round's agent run is a row of `agent_runs` that the test ends; its push is a change of the fake's head plus
 * the platform's push record. What it cannot fake: GitHub's own merge computation, and that a real executor renames the files and their references (the staging check shows that).
 */
const PR = 7;
const FROM = "a".repeat(40);
const TIP = "c".repeat(40);
const MERGE_BASE = "b".repeat(40);
const MAIN_PARENT = "d".repeat(40);
const TO = "e".repeat(40);
const BOT = "fulcrumaxe-app[bot]";
const C0 = "1".repeat(40);
const DIR = "packages/db/migrations";
const OLD = `${DIR}/0010_c.sql`;
const NEW = `${DIR}/0011_c.sql`;
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

describe("D#483 S5-j2e rounds for an overlap and an out-of-order number, no queue entry [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, accountId, fn);

  /**
   * A work item with no queue entry whose pull request merges CLEANLY. `overlap`: the tip gained `src/a.ts`, which the pull request also changed. `order`: the pull request adds
   * `0010_c.sql` while the tip holds `0009_a.sql` and `0010_b.sql` (a pull request of ours: one commit, authored by the app).
   */
  async function setup(o: { author?: string; startAnswer?: (round: number) => RoundStart } = {}) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: PR });
    const author = o.author ?? BOT;
    records = records.filter((r) => r.newSha !== C0);
    if (author === BOT) records.push({ oldSha: null, newSha: C0, startSha: null, runId: randomUUID() });
    const g = await startMergeTlsGitHub({
      prNumber: PR,
      headSha: FROM,
      baseTipSha: TIP,
      baseShas: [TIP, MAIN_PARENT],
      conflict: false,
      files: [{ filename: "src/a.ts" }, { filename: OLD }],
      commits: { [C0]: { parents: [MERGE_BASE], authorLogin: author, committerLogin: "web-flow", verified: false, files: [{ filename: "src/a.ts" }, { filename: OLD }] } },
      pullCommits: [{ sha: C0, authorLogin: author, committerLogin: "web-flow" }],
      compares: {
        [`${TIP}...${FROM}`]: { status: "diverged", aheadBy: 1, behindBy: 1, mergeBaseSha: MERGE_BASE, files: [{ filename: "src/a.ts" }, { filename: OLD }] },
        [`${MERGE_BASE}...${TIP}`]: { status: "ahead", aheadBy: 1, behindBy: 0, mergeBaseSha: MERGE_BASE, files: [{ filename: "src/a.ts" }] },
      },
    });
    open.push(g);
    g.world.trees[TIP] = Object.fromEntries([`${DIR}/0009_a.sql`, `${DIR}/0010_b.sql`].map((p) => [p, `100644 blob ${"d".repeat(40)}`]));
    g.world.pullFiles = [{ filename: "src/a.ts", status: "modified" }, { filename: OLD, status: "added" }];
    const gh = createGitHubMergeGatePort({ http: g.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, sleep: async () => undefined, mergeablePollLimit: 3 });
    const subject = (over: Partial<ConflictSubject> = {}): ConflictSubject => ({ id: workItemId, accountId, repoId, workItemId, prNumber: PR, headSha: FROM, entryId: null, roundsUsed: 0, ...over });

    const events: string[] = [];
    const started: Array<{ role: string; delta: DeltaReviewInput }> = [];
    const executors: string[] = [];
    const startRun = async (round: { round: number; fromSha: string }): Promise<RoundStart> => {
      const answer = o.startAnswer?.(round.round) ?? { ok: true as const, runId: randomUUID() };
      if (!answer.ok) return answer;
      await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, 'executor', 'production', 'running', $4)`, [answer.runId, accountId, workItemId, round.fromSha]);
      executors.push(answer.runId);
      return answer;
    };
    const conflict: ConflictPorts<ConflictSubject> = { github: gh, inTenant: tenant, platformCommits: fromRecords, startConflictRound: ({ round }) => startRun(round) };
    const asked: Array<{ resource: string; highest: string; files: readonly string[] }> = [];
    const renumber: EntrylessRenumberPorts = {
      github: gh,
      inTenant: tenant,
      platformCommits: fromRecords,
      startRenumberRound: ({ round, resource, highest }) => (asked.push({ resource, highest, files: round.conflictFiles }), startRun(round)),
    };
    const ports: ConflictCompletionPorts<ConflictSubject> = {
      github: gh,
      inTenant: tenant,
      plan: async () => ({ ok: true, roles: ["code-reviewer", "acceptance-tester"] }),
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
    };
    const rounds = () => tenant(accountId, (c) => listConflictRounds(c, accountId, workItemId));
    return {
      accountId, workItemId, g, events, started, executors, asked, subject, rounds,
      startOverlap: (over: Partial<ConflictSubject> = {}) => startEntrylessConflict(conflict, subject(over), "overlap_unreviewed"),
      startRenumber: (over: Partial<ConflictSubject> = {}, enabled?: boolean) => startEntrylessRenumber(renumber, subject(over), enabled),
      complete: async () => completeEntrylessRound(ports, subject({ roundsUsed: (await rounds()).length })),
      driverEvents: async () => (await db.admin.query(`SELECT kind, code, reasons, round FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq`, [workItemId])).rows as Array<{ kind: string; code: string; reasons: string[]; round: number }>,
      stopDetails: async () => (await db.admin.query(`SELECT e.reasons, d.conflict_files FROM work_item_driver_events e LEFT JOIN work_item_driver_event_details d ON d.driver_event_id = e.id WHERE e.work_item_id = $1 AND e.kind = 'stopped' ORDER BY e.seq`, [workItemId])).rows as Array<{ reasons: string[]; conflict_files: string[] | null }>,
      endRun: async () => void (await db.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE account_id = $1 AND role = 'executor' AND status = 'running'`, [accountId])),
      finish: async (role: string, envelope: Record<string, unknown>) => void (await db.admin.query(`UPDATE agent_runs SET status = 'succeeded', envelope = $3 WHERE account_id = $1 AND role = $2 AND status = 'running'`, [accountId, role, JSON.stringify(envelope)])),
      refreshRows: async () => Number((await db.admin.query(`SELECT count(*)::int AS n FROM head_refreshes WHERE account_id = $1`, [accountId])).rows[0].n),
      setSettings: async (settings: Record<string, unknown>) => void (await db.admin.query(`UPDATE repos SET settings = $2 WHERE id = $1`, [repoId, JSON.stringify(settings)])),
      /** The agent merges the default branch: one merge commit on the round's head, a record of the round's own run. */
      pushMerge() {
        g.world.commits[TO] = { parents: [FROM, MAIN_PARENT], authorLogin: BOT, committerLogin: "web-flow", verified: false, files: [{ filename: "src/a.ts" }] };
        records.push({ oldSha: g.world.headSha, newSha: TO, startSha: null, runId: executors[executors.length - 1]! });
        g.world.headSha = TO;
      },
      /** The agent renames the file and moves the head by one plain commit on the round's head. */
      pushRenamed(o: { record?: boolean } = {}) {
        g.world.commits[TO] = { parents: [FROM], authorLogin: BOT, committerLogin: "web-flow", verified: false, files: [{ filename: NEW }, { filename: OLD }] };
        if (o.record !== false) records.push({ oldSha: FROM, newSha: TO, startSha: null, runId: executors[executors.length - 1]! });
        g.world.headSha = TO;
        g.world.pullFiles = [{ filename: "src/a.ts", status: "modified" }, { filename: NEW, status: "added" }];
        g.world.compares[`${FROM}...${TO}`] = { status: "ahead", aheadBy: 1, behindBy: 0, mergeBaseSha: FROM, files: [{ filename: NEW, previous_filename: OLD }] };
      },
    };
  }

  it("overlap: a merge that is clean still gets exactly one round (entry_id null), from the live head, with the files both sides changed; a replay opens no second", async () => {
    const s = await setup();
    expect(await s.startOverlap()).toEqual({ outcome: "started" });
    const rows = await s.rounds();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ round: 1, kind: "conflict", entryId: null, fromSha: FROM, baseSha: TIP, baseRef: "main", conflictFiles: ["src/a.ts"], outcome: null });
    expect(await s.startOverlap()).toEqual({ outcome: "running" });
    expect(await s.rounds()).toHaveLength(1);
    expect(s.executors).toHaveLength(1);
    expect(s.g.world.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("overlap, C34 D5 with a round: the merge commit is judged by the existing delta review (trigger conflict_resolution), the passes re-enter the gate, and no head_refreshes row carries a pass", async () => {
    const s = await setup();
    await s.startOverlap();
    s.pushMerge();
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "delta_started" });
    for (const x of s.started) expect(x.delta).toMatchObject({ trigger: "conflict_resolution", mergeCommitSha: TO, parents: [FROM, MAIN_PARENT], changedFiles: ["src/a.ts"] });
    expect(s.started.map((x) => x.role)).toEqual(["code-reviewer", "acceptance-tester"]);
    await s.finish("code-reviewer", pass);
    await s.finish("acceptance-tester", pass);
    expect(await s.complete()).toEqual({ outcome: "passed" });
    expect(await s.refreshRows()).toBe(0);
    expect(s.g.world.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("overlap: a head that moves while the delta review runs is reviewed afresh (the round returns the item to review), and the new head carries no pass", async () => {
    const s = await setup();
    await s.startOverlap();
    s.pushMerge();
    await s.endRun();
    await s.complete();
    s.g.world.headSha = "f".repeat(40);
    expect(await s.complete()).toEqual({ outcome: "returned", reason: "head_changed" });
    expect(s.events).toEqual(["head_changed"]);
    expect(await s.refreshRows()).toBe(0);
  });

  it("overlap: every stop holds and is recorded under the gate's own code, never as a conflict (foreign commit, rounds spent, refused spend)", async () => {
    const foreign = await setup({ author: "mallory" });
    expect(await foreign.startOverlap()).toEqual({ outcome: "stopped", reason: "overlap_unreviewed" });
    expect(await foreign.rounds()).toEqual([]);
    expect(foreign.executors).toEqual([]);
    expect(await foreign.driverEvents()).toEqual([{ kind: "stopped", code: "overlap_unreviewed", reasons: ["foreign_commits"], round: 0 }]);

    const spent = await setup();
    expect(await spent.startOverlap({ roundsUsed: MAX_CONFLICT_ROUNDS })).toEqual({ outcome: "stopped", reason: "overlap_unreviewed" });
    expect(await spent.rounds()).toEqual([]);
    expect((await spent.driverEvents()).map((e) => [e.code, e.reasons])).toEqual([["overlap_unreviewed", ["rounds_exhausted"]]]);

    const refused = await setup({ startAnswer: () => ({ ok: false, reason: "refused_spend" }) });
    expect(await refused.startOverlap()).toEqual({ outcome: "stopped", reason: "refused_spend" });
    expect(await refused.rounds()).toEqual([]);

    const waiting = await setup({ startAnswer: () => ({ ok: false, reason: "waiting_for_capacity" }) });
    expect(await waiting.startOverlap()).toEqual({ outcome: "waiting" });
    expect(await waiting.rounds()).toEqual([]);
  });

  it("the conflict round keeps its own word: the default code is still merge_conflict", async () => {
    const s = await setup({ author: "mallory" });
    expect(await startEntrylessConflict({ github: createGitHubMergeGatePort({ http: s.g.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, sleep: async () => undefined }), inTenant: tenant, platformCommits: fromRecords, startConflictRound: async () => ({ ok: false, reason: "invalid_input" }) }, s.subject())).toEqual({ outcome: "stopped", reason: "merge_conflict" });
  });

  it("out of order: the round is a renumber round with no entry, asked the resource, the highest key and the files; a replay opens no second", async () => {
    const s = await setup();
    expect(await s.startRenumber()).toEqual({ outcome: "started" });
    const rows = await s.rounds();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ round: 1, kind: "renumber", entryId: null, fromSha: FROM, baseSha: TIP, baseRef: "main", conflictFiles: [OLD], outcome: null });
    expect(s.asked).toEqual([{ resource: "migrations", highest: "0010", files: [OLD] }]);
    expect(await s.startRenumber()).toEqual({ outcome: "running" });
    expect(s.executors).toHaveLength(1);
    expect(s.g.world.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("out of order, renamed by the round and then through the delta review (trigger renumber): the passes re-enter the gate; no head_refreshes row", async () => {
    const s = await setup();
    await s.startRenumber();
    s.pushRenamed();
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "delta_started" });
    for (const x of s.started) expect(x.delta).toMatchObject({ trigger: "renumber", mergeCommitSha: TO });
    await s.finish("code-reviewer", pass);
    await s.finish("acceptance-tester", pass);
    expect(await s.complete()).toEqual({ outcome: "passed" });
    expect((await s.rounds())[0]).toMatchObject({ kind: "renumber", toSha: TO, outcome: "resolved" });
    expect(await s.refreshRows()).toBe(0);
  });

  it("out of order: a push the round's own run did not make stops foreign_commits (nothing is carried); pushing nothing stops too", async () => {
    const s = await setup();
    await s.startRenumber();
    s.pushRenamed({ record: false });
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "stopped", reason: "ordered_resource_out_of_order" });
    expect(s.started).toEqual([]);
    expect((await s.rounds())[0]).toMatchObject({ outcome: "foreign_commits" });

    const none = await setup();
    await none.startRenumber();
    await none.endRun();
    expect(await none.complete()).toEqual({ outcome: "stopped", reason: "ordered_resource_out_of_order" });
    expect((await none.rounds())[0]).toMatchObject({ outcome: "pushed_nothing" });
  });

  it("out of order: every stop holds under the gate's code and starts no run (autoRenumber off, rounds spent, foreign commit, refused spend)", async () => {
    const off = await setup();
    await off.setSettings({ autoRenumber: false });
    expect(await off.startRenumber()).toEqual({ outcome: "stopped", reason: "ordered_resource_out_of_order" });
    expect(await off.rounds()).toEqual([]);
    expect(off.executors).toEqual([]);
    expect((await off.driverEvents()).map((e) => [e.kind, e.code, e.reasons])).toEqual([["stopped", "ordered_resource_out_of_order", ["auto_renumber_off"]]]);

    const spent = await setup();
    expect(await spent.startRenumber({ roundsUsed: MAX_CONFLICT_ROUNDS })).toEqual({ outcome: "stopped", reason: "ordered_resource_out_of_order" });
    expect((await spent.driverEvents()).map((e) => e.reasons)).toEqual([["rounds_exhausted"]]);
    expect(spent.executors).toEqual([]);

    const foreign = await setup({ author: "mallory" });
    expect(await foreign.startRenumber()).toEqual({ outcome: "stopped", reason: "ordered_resource_out_of_order" });
    expect((await foreign.driverEvents()).map((e) => e.reasons)).toEqual([["foreign_commits"]]);
    expect(foreign.executors).toEqual([]);

    const refused = await setup({ startAnswer: () => ({ ok: false, reason: "refused_spend" }) });
    expect(await refused.startRenumber()).toEqual({ outcome: "stopped", reason: "refused_spend" });
    expect(await refused.rounds()).toEqual([]);
  });

  it("out of order: a foreign_commits stop records the files the check found, as the conflict start does", async () => {
    const foreign = await setup({ author: "mallory" });
    expect(await foreign.startRenumber()).toEqual({ outcome: "stopped", reason: "ordered_resource_out_of_order" });
    const [stop] = await foreign.stopDetails();
    expect(stop).toMatchObject({ reasons: ["foreign_commits"], conflict_files: [OLD] });
    expect(foreign.executors).toEqual([]);
  });

  it("out of order: the insert counts the item's rows itself, so spent rounds (of either kind) stop a renumber even when the caller's count is stale", async () => {
    const s = await setup();
    for (let n = 1; n <= MAX_CONFLICT_ROUNDS; n++) {
      expect(await s.startOverlap({ roundsUsed: n - 1 })).toEqual({ outcome: "started" });
      await db.admin.query(`UPDATE merge_conflict_rounds SET outcome = 'conflicted_again', ended_at = now() WHERE work_item_id = $1 AND outcome IS NULL`, [s.workItemId]);
    }
    expect(await s.startRenumber({ roundsUsed: 0 })).toEqual({ outcome: "stopped", reason: "ordered_resource_out_of_order" });
    expect(await s.rounds()).toHaveLength(MAX_CONFLICT_ROUNDS);
    expect(s.executors).toHaveLength(MAX_CONFLICT_ROUNDS);
  });

  it("out of order: nothing to renumber now (in order, or the start is off) leaves the gate's stop as it was: not_applicable, no write", async () => {
    const inOrder = await setup();
    inOrder.g.world.pullFiles = [{ filename: NEW, status: "added" }];
    expect(await inOrder.startRenumber()).toEqual({ outcome: "not_applicable" });
    expect(await inOrder.rounds()).toEqual([]);
    expect(await inOrder.driverEvents()).toEqual([]);

    const off = await setup();
    expect(await off.startRenumber({}, false)).toEqual({ outcome: "not_applicable" });
    expect(await off.rounds()).toEqual([]);
    expect(off.g.world.calls).toEqual([]);

    const unreadable = await setup();
    unreadable.g.world.treeStatus = 500;
    expect(await unreadable.startRenumber()).toEqual({ outcome: "not_applicable" });
    expect(await unreadable.rounds()).toEqual([]);
  });
});
