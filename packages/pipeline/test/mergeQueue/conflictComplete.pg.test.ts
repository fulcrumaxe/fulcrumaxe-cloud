import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import {
  MERGE_QUEUE_CONFLICT_ROUND_MAX_MINUTES,
  cancelWorkItemEntry,
  completeConflictRound,
  completeDeltaReview,
  createOnConflict,
  enqueueEntry,
  finishWork,
  getEntry,
  listConflictRounds,
  recordRoundRun,
  setPlatformCommitProofForTest,
  startConflictWork,
  type ConflictCompletion,
  type ConflictCompletionPorts,
  type MergeQueueEntry,
  type PlatformPush,
} from "../../src/mergeQueue/index.js";
import type { DeltaReviewInput } from "../../src/review/reviewPrompts.js";
import { startMergeTlsGitHub, type MergeTlsGitHub } from "../review/helpers/fakeGitHubMergeTls.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#519 MQ4-c: the end of a merge-conflict fix round, over real Postgres (a plain `app_user` pool, row security in force) and the strict GitHub fake over
 * real TLS. The runs are rows of `agent_runs`; a cancel is an UPDATE, so "the run's cancel call" is read from the table. What it cannot fake: that a real
 * executor's push is the one merge commit the prompt asks for (staging shows that), and GitHub's own `mergeable` computation.
 */
const T0 = new Date("2026-11-01T10:00:00Z");
const PR = 7;
const FROM = "a".repeat(40);
const TIP = "c".repeat(40);
const MAIN_PARENT = "d".repeat(40);
const TO = "e".repeat(40);
const BOT = "fulcrumaxe-app[bot]";
const pass = { verdict: "pass", findings: [], summary: "ok" };

let open: MergeTlsGitHub[] = [];
/** D#519 C10: the platform's push records, as the one proof source answers them (by new tip). `push()` below records the executor's push. */
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

describe("D#519 MQ4-c conflict round completion [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, accountId, fn);

  /** An entry already in its conflict round (the round row and its executor run exist), the strict fake, and the ports over both. */
  async function setup(o: { roles?: string[]; rounds?: number } = {}) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: PR });
    const created = await tenant(accountId, (c) => enqueueEntry(c, { accountId, repoId, workItemId, prNumber: PR, headSha: FROM, approvedAt: T0 }));
    const g = await startMergeTlsGitHub({
      prNumber: PR,
      headSha: FROM,
      baseTipSha: TIP,
      baseShas: [TIP, MAIN_PARENT],
      conflict: true,
      files: [{ filename: "src/a.ts" }, { filename: "src/other.ts" }],
      commits: { [TO]: { parents: [FROM, MAIN_PARENT], authorLogin: BOT, committerLogin: "web-flow", verified: false, files: [{ filename: "src/a.ts" }] } },
    });
    open.push(g);
    const gh = createGitHubMergeGatePort({ http: g.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, sleep: async () => undefined, mergeablePollLimit: 3 });
    const newRun = async () => {
      const id = randomUUID();
      await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, 'executor', 'production', 'running', $4)`, [id, accountId, workItemId, FROM]);
      return id;
    };
    let runId = await newRun();
    const startRound = async (entryId: string) => {
      const s = await tenant(accountId, (c) => startConflictWork(c, { accountId, entryId, fromSha: FROM, baseSha: TIP, baseRef: "main", conflictFiles: ["src/a.ts"] }));
      if (!s.ok) throw new Error(s.reason);
      return s.round;
    };
    let round = await startRound(created.entry.id);
    await tenant(accountId, (c) => recordRoundRun(c, { accountId, roundId: round.id, runId }));
    for (let n = 1; n < (o.rounds ?? 1); n++) {
      // An earlier round that ended with a clean merge: the entry is queued again on that head, and conflicts again.
      await tenant(accountId, (c) => finishWork(c, { accountId, entryId: created.entry.id }));
      round = await startRound(created.entry.id);
      // Every round's run is recorded in its own start transaction; the latest one is the run this round's push and end belong to.
      runId = await newRun();
      const id = round.id;
      await tenant(accountId, (c) => recordRoundRun(c, { accountId, roundId: id, runId }));
    }

    const events: string[] = [];
    const started: Array<{ role: string; delta: DeltaReviewInput }> = [];
    const refuse = new Set<string>();
    const refuseWith = { reason: "refused_spend" };
    const onConflictFor: string[] = [];
    const plan = { roles: o.roles ?? ["code-reviewer", "acceptance-tester"] };
    const ports: ConflictCompletionPorts = {
      github: gh,
      inTenant: tenant,
      plan: async () => ({ ok: true, roles: plan.roles }),
      runs: async (_e, sha) =>
        (await db.admin.query(`SELECT DISTINCT ON (role) id, role, status FROM agent_runs WHERE account_id = $1 AND head_sha = $2 AND role <> 'executor' ORDER BY role, created_at DESC`, [accountId, sha])).rows.map((r) => ({ role: r.role as string, runId: r.id as string, attempt: 0, reusable: r.status !== "cancelled" })),
      startRole: async ({ role, delta }) => {
        if (refuse.has(role)) return { ok: false, reason: refuseWith.reason };
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
      // The bound one: nothing is read from GitHub before the round count is checked.
      onConflict: async (e) => {
        onConflictFor.push(`${e.state}:${e.headSha}`);
        return createOnConflict({ github: gh, inTenant: tenant, platformCommits: async () => null, startConflictRound: async () => ({ ok: false, reason: "invalid_input" }) })(e);
      },
    };
    const entryId = created.entry.id;
    const row = async () => (await db.admin.query(`SELECT * FROM merge_queue_entries WHERE id = $1`, [entryId])).rows[0] as Record<string, unknown>;
    return {
      accountId, repoId, workItemId, entryId, g, runId, events, started, refuse, refuseWith, onConflictFor, row,
      cancelRun: async (id: string) => ports.cancelRun((await tenant(accountId, (c) => getEntry(c, accountId, entryId)))!, id),
      complete: async (now?: Date): Promise<ConflictCompletion> => completeConflictRound({ ...ports, ...(now ? { now: () => now } : {}) }, (await tenant(accountId, (c) => getEntry(c, accountId, entryId)))!),
      completeDelta: async () => completeDeltaReview(ports, (await tenant(accountId, (c) => getEntry(c, accountId, entryId)))!),
      /**
       * The executor pushes: the head is `sha` (default: the one merge commit), and the branch merges cleanly again. The push goes through the proxy, so it
       * is recorded (old = the head before it, the round's run) unless `record` is false (a person's push) or names another run or old tip.
       */
      push(sha = TO, over: Partial<{ parents: string[]; files: string[]; authorLogin: string; committerLogin: string; verified: boolean; record: false | { runId?: string; oldSha?: string | null } }> = {}) {
        g.world.commits[sha] = { parents: over.parents ?? [FROM, MAIN_PARENT], authorLogin: over.authorLogin ?? BOT, committerLogin: over.committerLogin ?? "web-flow", verified: over.verified ?? false, files: (over.files ?? ["src/a.ts"]).map((filename) => ({ filename })) };
        if (over.record !== false) records.push({ oldSha: over.record?.oldSha === undefined ? g.world.headSha : over.record.oldSha, newSha: sha, startSha: null, runId: over.record?.runId ?? runId });
        g.world.headSha = sha;
        g.world.conflict = false;
      },
      endRun: async (status = "succeeded") => void (await db.admin.query(`UPDATE agent_runs SET status = $2 WHERE id = $1`, [runId, status])),
      finish: async (role: string, envelope: Record<string, unknown>) => void (await db.admin.query(`UPDATE agent_runs SET status = 'succeeded', envelope = $3 WHERE account_id = $1 AND role = $2 AND status = 'running'`, [accountId, role, JSON.stringify(envelope)])),
      statuses: async () => Object.fromEntries((await db.admin.query(`SELECT role, status FROM agent_runs WHERE account_id = $1 ORDER BY created_at`, [accountId])).rows.map((r) => [r.role, r.status])),
      rounds: () => tenant(accountId, (c) => listConflictRounds(c, accountId, workItemId)),
      driverEvents: async () => (await db.admin.query(`SELECT kind, code, reasons, round FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq`, [workItemId])).rows as Array<{ kind: string; code: string; reasons: string[]; round: number }>,
      refreshRows: async () => Number((await db.admin.query(`SELECT count(*)::int AS n FROM head_refreshes WHERE account_id = $1`, [accountId])).rows[0].n),
      putCalls: () => g.world.calls.filter((c) => c.method === "PUT").map((c) => c.path.replace(/^.*\/pulls\/\d+/, "")),
    };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  it("C6-c1: the one merge commit starts a delta review of every gated role that names exactly the commit and its two parents; the passes put the entry back at its original approved_at on the round's head", async () => {
    const s = await setup();
    s.push();
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "delta_started" });
    expect(s.started.map((x) => x.role)).toEqual(["code-reviewer", "acceptance-tester"]);
    for (const x of s.started) expect(x.delta).toMatchObject({ trigger: "conflict_resolution", mergeCommitSha: TO, parents: [FROM, MAIN_PARENT], parentRoles: ["pr_side", "main_side"], changedFiles: ["src/a.ts"] });
    expect(await s.row()).toMatchObject({ state: "awaiting_work", work_kind: "delta_review", slot_holder: null, head_sha: FROM, approved_at: T0 });
    expect((await s.rounds())[0]).toMatchObject({ toSha: TO, outcome: "resolved" });
    // Waiting: nothing changes, and a replay starts no second run.
    expect(await s.completeDelta()).toEqual({ outcome: "waiting" });
    await s.complete();
    expect(s.started).toHaveLength(2);

    await s.finish("code-reviewer", pass);
    await s.finish("acceptance-tester", pass);
    expect(await s.completeDelta()).toEqual({ outcome: "passed" });
    expect(await s.row()).toMatchObject({ state: "queued", slot_holder: null, work_kind: null, head_sha: TO, approved_at: T0 });
    // C6-c6: no head_refreshes row, ever, so the gate has nothing to carry a pass across.
    expect(await s.refreshRows()).toBe(0);
    expect(s.putCalls()).toEqual([]);
  });

  it("a delta review that does not pass sends the entry back to review with approved_at kept (nothing carried)", async () => {
    const s = await setup();
    s.push();
    await s.endRun();
    await s.complete();
    await s.finish("code-reviewer", { verdict: "needs-fix", findings: ["a.ts:1"], summary: "no" });
    expect(await s.completeDelta()).toEqual({ outcome: "not_carried" });
    expect(await s.row()).toMatchObject({ state: "in_review", approved_at: T0 });
    expect(await s.refreshRows()).toBe(0);
  });

  it("the run is still going and the head is unchanged: nothing changes; past the round bound the run is cancelled and the entry stops as merge_conflict (round_timeout)", async () => {
    const s = await setup();
    expect(await s.complete(new Date(Date.now() + 60 * 60_000))).toEqual({ outcome: "waiting" });
    expect(await s.row()).toMatchObject({ state: "awaiting_work", work_kind: "conflict" });
    const late = new Date(Date.now() + (MERGE_QUEUE_CONFLICT_ROUND_MAX_MINUTES + 10) * 60_000);
    expect(await s.complete(late)).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect((await s.statuses()).executor).toBe("cancelled");
    expect(await s.row()).toMatchObject({ state: "stopped", reason: "merge_conflict", slot_holder: null, approved_at: T0 });
    expect((await s.rounds())[0]).toMatchObject({ outcome: "round_timeout" });
    expect(await s.driverEvents()).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["round_timeout"], round: 1 }]);
  });

  it("C6-c7 pushed nothing: the run ended with the head unchanged, so the entry stops at merge_conflict with the attempt count, and is not started again on that tip", async () => {
    const s = await setup();
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(await s.row()).toMatchObject({ state: "stopped", reason: "merge_conflict", conflict_rounds: 1 });
    expect(await s.driverEvents()).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["pushed_nothing"], round: 1 }]);
    expect((await s.rounds())).toHaveLength(1);
    expect(await s.complete()).toEqual({ outcome: "not_waiting" });
  });

  it("C6-c2: a head that is not a descendant of the pre-round head stops the entry as history_rewritten (run cancelled), even while the run goes; nothing is pushed afterwards", async () => {
    const s = await setup();
    s.push();
    s.g.world.compares[`${FROM}...${TO}`] = { status: "diverged", aheadBy: 1, behindBy: 1, mergeBaseSha: TIP, files: [] };
    expect(await s.complete()).toEqual({ outcome: "stopped", reason: "history_rewritten" });
    expect(await s.row()).toMatchObject({ state: "stopped", reason: "history_rewritten", slot_holder: null });
    expect((await s.statuses()).executor).toBe("cancelled");
    expect((await s.rounds())[0]).toMatchObject({ outcome: "history_rewritten" });
    expect(s.started).toEqual([]);
    // Two more looks: a stopped entry is not waiting, and no merge or update-branch call is ever made.
    expect(await s.complete()).toEqual({ outcome: "not_waiting" });
    expect(await s.complete()).toEqual({ outcome: "not_waiting" });
    expect(s.putCalls()).toEqual([]);
  });

  it("review 1: a PERSON's merge commit of exactly the allowed shape (the Resolve conflicts page: author the person, committer web-flow) is no resolution: full review, approved_at kept, run cancelled, no delta review", async () => {
    const s = await setup();
    s.push(TO, { authorLogin: "some-person", committerLogin: "web-flow", verified: true, record: false });
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "returned", reason: "not_a_resolution" });
    expect(s.started).toEqual([]);
    expect(await s.row()).toMatchObject({ state: "in_review", approved_at: T0, slot_holder: null, work_kind: null });
    expect(s.events).toEqual(["not_a_resolution"]);
    expect(await s.refreshRows()).toBe(0);
    // Mid-round too (the run has not ended): the person's push ends the round now.
    const t = await setup();
    t.push(TO, { authorLogin: "some-person", committerLogin: "web-flow", verified: true, record: false });
    expect(await t.complete()).toEqual({ outcome: "returned", reason: "not_a_resolution" });
    expect((await t.statuses()).executor).toBe("cancelled");
    expect(await t.row()).toMatchObject({ state: "in_review", approved_at: T0 });
  });

  it("C10-5: the head must be a push record of the round's own run from from_sha: none, another run's, another old tip, or an unread source fail closed to review", async () => {
    const fail = async (record: false | { runId?: string; oldSha?: string | null }, unread = false) => {
      const s = await setup();
      s.push(TO, { record });
      if (unread) setPlatformCommitProofForTest(null);
      await s.endRun();
      expect(await s.complete()).toEqual({ outcome: "returned", reason: "not_a_resolution" });
      expect(s.started).toEqual([]);
      expect(await s.row()).toMatchObject({ state: "in_review", approved_at: T0 });
      setPlatformCommitProofForTest(fromRecords);
    };
    // No record: the same shape, author our app, committed by web-flow (a spoofed email), and even verified.
    await fail(false);
    // Another run's push (an earlier round, or another item's executor).
    await fail({ runId: randomUUID() });
    // Our run, but not pushed from the round's from_sha (a create, or from some other tip).
    await fail({ oldSha: null });
    await fail({ oldSha: "9".repeat(40) });
    // The source unread.
    await fail({}, true);
    // The round's own run pushed it from from_sha: a resolution.
    const ok = await setup();
    ok.push();
    await ok.endRun();
    expect(await ok.complete()).toEqual({ outcome: "delta_started" });
  });

  it("C10-5: a record of the round's run from from_sha to ANOTHER tip proves nothing about the head, even from a source that does not filter by tip", async () => {
    const s = await setup();
    s.push(TO, { record: false });
    setPlatformCommitProofForTest(async () => ({ appLogin: BOT, pushes: [{ oldSha: FROM, newSha: "9".repeat(40), startSha: null, runId: s.runId }] }));
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "returned", reason: "not_a_resolution" });
  });

  it("C10-5: a person's verified app-looking merge (author our app, committer web-flow, verified) without the run's record is still no resolution", async () => {
    const s = await setup();
    s.push(TO, { verified: true, record: false });
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "returned", reason: "not_a_resolution" });
  });

  it("C10-8: the round end reads the proof for the head only, and makes no GitHub read for it", async () => {
    const asked: string[][] = [];
    setPlatformCommitProofForTest(async (e, shas) => (asked.push([...shas]), fromRecords(e, shas)));
    const s = await setup();
    s.push();
    await s.endRun();
    const before = s.g.world.calls.length;
    expect(await s.complete()).toEqual({ outcome: "delta_started" });
    expect(asked).toEqual([[TO]]);
    const commitReads = s.g.world.calls.slice(before).filter((c) => /\/commits\/[0-9a-f]{40}$/.test(c.path)).map((c) => c.path.slice(-40));
    expect(new Set(commitReads)).toEqual(new Set([TO]));
  });

  it("C6-c5: a merge commit plus one more commit is no resolution: no delta review, back in review, approved_at unchanged", async () => {
    const s = await setup();
    const FIXUP = "f".repeat(40);
    s.g.world.commits[TO] = { parents: [FROM, MAIN_PARENT], authorLogin: BOT, committerLogin: "web-flow", verified: false, files: [{ filename: "src/a.ts" }] };
    s.push(FIXUP, { parents: [TO], files: ["src/a.ts"] });
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "returned", reason: "not_a_resolution" });
    expect(s.started).toEqual([]);
    expect(await s.row()).toMatchObject({ state: "in_review", approved_at: T0, slot_holder: null });
    expect(s.events).toEqual(["not_a_resolution"]);
  });

  it("a merge whose first parent is not the pre-round head, or whose second parent is not on the default branch, is no resolution either", async () => {
    for (const bad of ["first", "second"] as const) {
      const s = await setup();
      s.push(TO, { parents: bad === "first" ? [TIP, MAIN_PARENT] : [FROM, "9".repeat(40)] });
      if (bad === "second") s.g.world.compares[`${"9".repeat(40)}...${TIP}`] = { status: "diverged", aheadBy: 1, behindBy: 1, mergeBaseSha: TIP, files: [] };
      await s.endRun();
      expect(await s.complete()).toEqual({ outcome: "returned", reason: "not_a_resolution" });
      expect(s.started).toEqual([]);
    }
  });

  it("C6-c7 a person pushed mid-round: the run is cancelled and the entry returns to review at its original place", async () => {
    const s = await setup();
    s.push("b".repeat(40), { parents: ["1".repeat(40)] });
    expect(await s.complete()).toEqual({ outcome: "returned", reason: "not_a_resolution" });
    expect((await s.statuses()).executor).toBe("cancelled");
    expect(await s.row()).toMatchObject({ state: "in_review", approved_at: T0 });
  });

  it("the head moved again after the round's own head was recorded (a person pushed): back to review", async () => {
    const s = await setup();
    s.push();
    await s.endRun();
    s.refuse.add("code-reviewer");
    s.refuseWith.reason = "waiting_for_capacity";
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    expect((await s.rounds())[0]).toMatchObject({ toSha: TO, outcome: null });
    s.push("b".repeat(40));
    expect(await s.complete()).toEqual({ outcome: "returned", reason: "head_changed" });
    expect(await s.row()).toMatchObject({ state: "in_review" });
  });

  it("C6-c6 fail closed: a merge commit that touched none of the PR's own files is not carried: back in review, no run, no head_refreshes row", async () => {
    const s = await setup();
    s.push(TO, { files: ["docs/main-only.md"] });
    await s.endRun();
    expect(await s.complete()).toEqual({ outcome: "returned", reason: "main_side_only" });
    expect(s.started).toEqual([]);
    expect(await s.refreshRows()).toBe(0);
    expect(await s.row()).toMatchObject({ state: "in_review", approved_at: T0 });
  });

  it("a delta start refused for spend stops the entry (Needs a person); a capacity wait leaves it waiting and is asked again", async () => {
    const s = await setup();
    s.push();
    await s.endRun();
    s.refuse.add("code-reviewer");
    s.refuseWith.reason = "waiting_for_capacity";
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    expect(await s.row()).toMatchObject({ state: "awaiting_work", work_kind: "conflict" });
    s.refuse.clear();
    expect(await s.complete()).toEqual({ outcome: "delta_started" });

    const t = await setup();
    t.push();
    await t.endRun();
    t.refuse.add("code-reviewer");
    expect(await t.complete()).toEqual({ outcome: "stopped", reason: "refused_spend" });
    expect(await t.row()).toMatchObject({ state: "stopped", reason: "refused_spend", slot_holder: null });
    expect(await t.complete()).toEqual({ outcome: "not_waiting" });
  });

  it("the one shape, but conflicting again against the new tip: the head becomes the entry's head and onConflict decides (a new bounded round)", async () => {
    const s = await setup();
    s.push();
    s.g.world.conflict = true;
    await s.endRun();
    // Round 1 of 2 used: the real (bound) onConflict reads the identity first; with none read it answers no, so the entry stops with the attempt count.
    expect(await s.complete()).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(s.onConflictFor).toEqual([`queued:${TO}`]);
    expect(s.started).toEqual([]);
    expect(await s.row()).toMatchObject({ state: "stopped", reason: "merge_conflict", head_sha: TO });
    expect((await s.rounds())[0]).toMatchObject({ toSha: TO, outcome: "conflicted_again" });
  });

  it("C6-c3: a third conflict after two resolved rounds stops as merge_conflict with attempt count 2 and writes no third round row", async () => {
    const s = await setup({ rounds: 2 });
    expect(await s.row()).toMatchObject({ conflict_rounds: 2 });
    s.push();
    s.g.world.conflict = true;
    await s.endRun();
    // (The first round's run is the one still named by the first row; the second round has no run.)
    expect(await s.complete()).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(await s.rounds()).toHaveLength(2);
    expect(await s.driverEvents()).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["rounds_exhausted"], round: 2 }]);
    expect(await s.row()).toMatchObject({ state: "stopped", reason: "merge_conflict", conflict_rounds: 2 });
  });

  it("C6-c7 closed or merged by a person mid-round: settled, the run is cancelled, nothing is started", async () => {
    const s = await setup();
    s.g.world.state = "closed";
    expect(await s.complete()).toEqual({ outcome: "settled", as: "closed" });
    expect((await s.statuses()).executor).toBe("cancelled");
    expect(await s.row()).toMatchObject({ state: "closed", slot_holder: null });
    const t = await setup();
    t.g.world.state = "closed";
    t.g.world.merged = true;
    expect(await t.complete()).toEqual({ outcome: "settled", as: "merged" });
    expect(await t.row()).toMatchObject({ state: "merged", merged_by: "person" });
    expect((await t.statuses()).executor).toBe("cancelled");
  });

  it("C6-c7 item cancelled mid-round: the entry is cancelled, the open round ends as cancelled, and the round's run is cancelled through the port", async () => {
    const s = await setup();
    await tenant(s.accountId, (c) => cancelWorkItemEntry(c, { accountId: s.accountId, workItemId: s.workItemId }));
    expect(await s.row()).toMatchObject({ state: "cancelled", slot_holder: null });
    const [round] = await s.rounds();
    expect(round).toMatchObject({ outcome: "cancelled", runId: s.runId });
    // The queue's own code does not cancel the run on an item cancel (the item-level cancel does, outside the queue); the port is what it asks.
    expect((await s.statuses()).executor).toBe("running");
    await s.cancelRun(round!.runId!);
    expect((await s.statuses()).executor).toBe("cancelled");
    expect(await s.complete()).toEqual({ outcome: "not_waiting" });
  });

  it("an entry that is not in a conflict round is left alone", async () => {
    const s = await setup();
    s.push();
    await s.endRun();
    await s.complete();
    expect(await s.complete()).toEqual({ outcome: "not_waiting" });
  });

  it("C6-c9 the dead workflow: a finished round is moved to its delta review and back to queued by the sweep's calls alone", async () => {
    const s: Setup = await setup();
    s.push();
    await s.endRun();
    // What the web sweep does for the repo: look at the round, then at the delta review it started, until the entry leaves awaiting_work.
    expect(await s.complete()).toEqual({ outcome: "delta_started" });
    await s.finish("code-reviewer", pass);
    await s.finish("acceptance-tester", pass);
    expect(await s.completeDelta()).toEqual({ outcome: "passed" });
    const entry = (await tenant(s.accountId, (c) => getEntry(c, s.accountId, s.entryId))) as MergeQueueEntry;
    expect(entry).toMatchObject({ state: "queued", headSha: TO });
  });
});
