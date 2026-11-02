import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import { classifyCi, expectedSignalNames } from "../../src/build/mergeGate.js";
import {
  MAX_CONFLICT_ROUNDS,
  completeEntrylessRound,
  createRoundGitHub,
  listConflictRounds,
  startEntrylessFromRunnerFacts,
  type ConflictCompletionPorts,
  type ConflictSubject,
  type RoundAttestation,
  type RoundFence,
  type RoundStart,
} from "../../src/mergeQueue/index.js";
import type { DeltaReviewInput } from "../../src/review/reviewPrompts.js";
import { fakeGitHubLocalTls } from "../review/helpers/fakeGitHubLocalTls.js";
import { freshRepo } from "../review/helpers/fakeGitHubRest.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#519 MQ4-e2-c3 (C18-12 to C18-16): a `runner_local` conflict round from its start to a delta review that passed and the CI of the judged merge commit, over real Postgres (a plain
 * `app_user` pool, row security in force). The fence is the real `localOnlyGithub` wrapper over the strict local fake (the pull request list A3 and `CommitChecks` A9 run through it;
 * `RunBranchState` and `PullRequestFiles` are hand fakes, as in the adapter's own tests). The runner's attestation is the stored event's payload; the model is never called.
 * What none of this can show: that the customer's machine tells the truth inside a well-formed attestation (C10 residual 1), and that GitHub's schema accepts the CommitChecks
 * document as written (a live run is the first check).
 */
const PR = 7;
const FROM = "a".repeat(40);
const BASE = "d".repeat(40);
const HEAD = "e".repeat(40);
const pass = { verdict: "pass", findings: [], summary: "ok" };
const FACTS = { verdict: "conflict_platform" as const, baseSha: BASE, baseRef: "main", files: ["src/a.ts"] };

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

describe("D#519 MQ4-e2-c3 the end of a runner_local conflict round [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, accountId, fn);

  async function setup(o: { startAnswer?: () => RoundStart; unreachable?: boolean } = {}) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await db.admin.query(`UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1`, [repoId]);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: PR });
    const repo = freshRepo({ owner: "acme", name: "widgets", prNumber: PR, headSha: FROM, runBranch: "fx/run-g1", files: [{ filename: "src/a.ts", patch: "@@ -1 +1 @@\n+x", changes: 1 }] } as never);
    const fake = await fakeGitHubLocalTls(repo as never);
    open.push(fake);
    const merge = createGitHubMergeGatePort({ http: fake.http, local: { http: fake.http, recordedBranch: async () => "fx/run-g1" }, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined });
    const fence: RoundFence = {
      getMergeability: (pr, opts) => merge.getMergeability(pr, opts),
      defaultBranchTip: async () => ({ branch: "main", sha: BASE }),
      prFiles: async () => ["src/a.ts", "src/b.ts"],
    };
    const subject = (over: Partial<ConflictSubject> = {}): ConflictSubject => ({ id: workItemId, accountId, repoId, workItemId, prNumber: PR, headSha: FROM, entryId: null, roundsUsed: 0, ...over });
    const events: string[] = [];
    const started: Array<{ role: string; delta: DeltaReviewInput }> = [];
    const executors: string[] = [];
    let roundStarts = 0;
    const startPorts = {
      inTenant: tenant,
      async startConflictRound({ round }: { round: { round: number; fromSha: string } }): Promise<RoundStart> {
        roundStarts += 1;
        const answer = o.startAnswer?.() ?? { ok: true as const, runId: randomUUID() };
        if (!answer.ok) return answer;
        await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, 'executor', 'runner', 'running', $4)`, [answer.runId, accountId, workItemId, round.fromSha]);
        executors.push(answer.runId);
        return answer;
      },
    };
    const ports = (stored: unknown, round: Awaited<ReturnType<typeof rounds>>[number] | undefined): ConflictCompletionPorts<ConflictSubject> => {
      const adapter = createRoundGitHub(fence, round, stored, async () => o.unreachable === true);
      return {
        github: adapter.github,
        platformCommits: adapter.platformCommits,
        runnerFed: adapter.runnerFed,
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
        // The next round, as the web wiring starts it: from the default tip the fence reads now.
        startEntryless: async (s) => startEntrylessFromRunnerFacts(startPorts, s, { ...FACTS, baseSha: (await fence.defaultBranchTip({ repoId, prNumber: PR })).sha }),
      };
    };
    const rounds = () => tenant(accountId, (c) => listConflictRounds(c, accountId, workItemId));
    let stored: unknown = null;
    const att = (over: Partial<RoundAttestation> = {}): RoundAttestation => ({ head: HEAD, parents: [FROM, BASE], from_sha: FROM, base_sha: BASE, history: "descendant", pushed_by_round: true, second_parent_on_default: true, still_conflicting: "no", touched_paths: ["src/a.ts"], truncated: false, ...over });
    return {
      accountId, repoId, workItemId, fake, merge, events, started, executors, att, rounds, subject,
      roundStartCalls: () => roundStarts,
      attest: (a: unknown) => void (stored = a),
      start: (over: Partial<ConflictSubject> = {}) => startEntrylessFromRunnerFacts(startPorts, subject(over), FACTS),
      complete: async () => {
        const all = await rounds();
        return completeEntrylessRound(ports(stored, all[all.length - 1]), subject({ roundsUsed: all.length }));
      },
      /** The runner pushes the merge commit and the run ends. */
      async push() {
        repo.headSha = HEAD;
        await db.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE account_id = $1 AND role = 'executor' AND status = 'running'`, [accountId]);
      },
      finish: async (role: string, envelope: Record<string, unknown>) => void (await db.admin.query(`UPDATE agent_runs SET status = 'succeeded', envelope = $3 WHERE account_id = $1 AND role = $2 AND status = 'running'`, [accountId, role, JSON.stringify(envelope)])),
      driverEvents: async () => (await db.admin.query(`SELECT kind, code, reasons, round FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq`, [workItemId])).rows as Array<{ kind: string; code: string; reasons: string[]; round: number }>,
      statuses: async () => Object.fromEntries((await db.admin.query(`SELECT role, status FROM agent_runs WHERE account_id = $1 ORDER BY created_at`, [accountId])).rows.map((r) => [r.role, r.status])),
      checks: (names: Array<{ name: string; conclusion: string | null; status?: string }>) => void (repo.checks[HEAD] = names.map((n) => ({ name: n.name, status: n.status ?? "completed", conclusion: n.conclusion }))),
    };
  }

  it("C18-12: a clean attestation passes the judge, every gated role reviews the merge commit from the attested paths, the passes re-enter the gate, and CI is read on the judged head through the fence", async () => {
    const s = await setup();
    expect(await s.start()).toEqual({ outcome: "started" });
    expect((await s.rounds())[0]).toMatchObject({ round: 1, entryId: null, fromSha: FROM, baseSha: BASE, baseRef: "main", conflictFiles: ["src/a.ts"], outcome: null });
    // The run is going and has sent nothing: the round waits (an offline runner is not a stop).
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    await s.push();
    s.attest(s.att());
    expect(await s.complete()).toEqual({ outcome: "delta_started" });
    expect((await s.rounds())[0]).toMatchObject({ toSha: HEAD, outcome: "resolved" });
    expect(s.started.map((x) => x.role)).toEqual(["code-reviewer", "acceptance-tester"]);
    for (const x of s.started) expect(x.delta).toMatchObject({ trigger: "conflict_resolution", mergeCommitSha: HEAD, parents: [FROM, BASE], parentRoles: ["pr_side", "main_side"], changedFiles: ["src/a.ts"] });
    // No earlier pass is carried: waiting starts nothing new, and only the new reviewers' passes count.
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    expect(s.started).toHaveLength(2);
    await s.finish("code-reviewer", pass);
    await s.finish("acceptance-tester", pass);
    expect(await s.complete()).toEqual({ outcome: "passed" });
    expect(await s.complete()).toEqual({ outcome: "passed" });
    // Fresh CI on the judged head, read through the fence's CommitChecks (A9): no signal yet is never green; a running one waits; a failed one is red; all green is green.
    const pr = { repoId: s.repoId, prNumber: PR };
    const none = await s.merge.getCiSnapshot(pr, HEAD);
    expect(none.headSha).toBe(HEAD);
    expect(expectedSignalNames(none)).toEqual([]);
    s.checks([{ name: "ci/test", conclusion: null, status: "in_progress" }]);
    const running = await s.merge.getCiSnapshot(pr, HEAD);
    expect(expectedSignalNames(running)).toEqual(["ci/test"]);
    expect(classifyCi(running, HEAD, expectedSignalNames(running))).toBe("pending");
    s.checks([{ name: "ci/test", conclusion: "failure" }]);
    expect(classifyCi(await s.merge.getCiSnapshot(pr, HEAD), HEAD, ["ci/test"])).toBe("red");
    s.checks([{ name: "ci/test", conclusion: "success" }]);
    const green = await s.merge.getCiSnapshot(pr, HEAD);
    expect(classifyCi(green, HEAD, expectedSignalNames(green))).toBe("green");
    // Only the fence's documents were used: nothing refused, nothing denied, nothing written (no merge, no post).
    expect(s.fake.denied).toEqual([]);
    expect(s.fake.refused).toEqual([]);
    expect(s.fake.server.seen.length).toBeGreaterThan(0);
    expect(s.fake.server.seen.every((r) => r.headers["user-agent"] === "fulcrumaxe-cloud" && r.servername === "api.github.com")).toBe(true);
    expect(s.fake.calls.filter((c) => c.method !== "GET" && c.op !== "CommitChecks")).toEqual([]);
    expect(s.events).toEqual([]);
    // R-519-C15-7: the whole round ran on the runner target. The only executor run is a runner run, the start was asked once, and no sandbox (hosted) executor run exists.
    expect(s.roundStartCalls()).toBe(1);
    expect(Number((await db.admin.query(`SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1 AND role = 'executor' AND runtime <> 'runner'`, [s.accountId])).rows[0].n)).toBe(0);
    // C18-12 (approved_at): a runner_local item has no queue entry, so there is no approved_at to keep or restamp; the round creates none.
    expect(Number((await db.admin.query(`SELECT count(*)::int AS n FROM merge_queue_entries WHERE account_id = $1`, [s.accountId])).rows[0].n)).toBe(0);
  });

  it("C18-12: a delta review that does not pass returns the item to review with nothing carried", async () => {
    const s = await setup();
    await s.start();
    await s.push();
    s.attest(s.att());
    await s.complete();
    await s.finish("code-reviewer", { verdict: "needs-fix", findings: ["a.ts:1"], summary: "no" });
    expect(await s.complete()).toEqual({ outcome: "returned", reason: "not_carried" });
    expect(s.events).toEqual(["not_carried"]);
  });

  it("C18-13: the bound is the item's own count, shared with every round; a replayed start opens no second; a spent bound stops with the rounds_exhausted sentence", async () => {
    const s = await setup();
    expect(await s.start()).toEqual({ outcome: "started" });
    expect(await s.start()).toEqual({ outcome: "running" });
    expect(await s.rounds()).toHaveLength(1);
    expect(s.executors).toHaveLength(1);
    for (let n = 2; n <= MAX_CONFLICT_ROUNDS; n++) {
      await db.admin.query(`UPDATE merge_conflict_rounds SET outcome = 'conflicted_again', ended_at = now() WHERE work_item_id = $1 AND outcome IS NULL`, [s.workItemId]);
      expect(await s.start({ roundsUsed: n - 1 })).toEqual({ outcome: "started" });
    }
    await db.admin.query(`UPDATE merge_conflict_rounds SET outcome = 'conflicted_again', ended_at = now() WHERE work_item_id = $1 AND outcome IS NULL`, [s.workItemId]);
    expect(await s.start({ roundsUsed: MAX_CONFLICT_ROUNDS })).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(await s.rounds()).toHaveLength(MAX_CONFLICT_ROUNDS);
    expect((await s.driverEvents()).map((e) => e.reasons[0])).toEqual(["rounds_exhausted"]);
  });

  it("C18-13: a head that conflicts again starts the next round from the default tip the fence reads now, through the same bound", async () => {
    const s = await setup();
    await s.start();
    await s.push();
    s.attest(s.att({ still_conflicting: "yes" }));
    expect(await s.complete()).toEqual({ outcome: "new_round" });
    expect((await s.rounds()).map((r) => [r.round, r.fromSha, r.toSha, r.outcome])).toEqual([[1, FROM, HEAD, "conflicted_again"], [2, HEAD, null, null]]);
    expect(s.executors).toHaveLength(2);
  });

  it("C18-13 (item 26): a spend refusal is Needs a person with no retry, no round row and nothing held", async () => {
    const s = await setup({ startAnswer: () => ({ ok: false, reason: "refused_spend" }) });
    expect(await s.start()).toEqual({ outcome: "stopped", reason: "refused_spend" });
    expect(await s.rounds()).toEqual([]);
    expect(s.executors).toEqual([]);
    expect(await s.driverEvents()).toEqual([{ kind: "stopped", code: "refused_spend", reasons: ["refused_spend"], round: 0 }]);
  });

  it("C18-3, C18-16: no runner can ever take the run: the round stops at once, the run is cancelled, and it is the one 'cannot be followed' sentence", async () => {
    const s = await setup({ unreachable: true });
    await s.start();
    expect(await s.complete()).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect((await s.rounds())[0]).toMatchObject({ outcome: "conflict_round_unreadable" });
    expect(await s.driverEvents()).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["conflict_round_unreadable"], round: 1 }]);
    expect((await s.statuses()).executor).toBe("cancelled");
    expect(await s.complete()).toEqual({ outcome: "not_waiting" });
  });

  it("C18-3, C18-16: a run that ended with no attestation stops the same way; every other state (a runner offline or slow) is only waited on", async () => {
    const s = await setup();
    await s.start();
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    expect((await s.rounds())[0]).toMatchObject({ outcome: null });
    await s.push();
    expect(await s.complete()).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(await s.driverEvents()).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["conflict_round_unreadable"], round: 1 }]);
  });
});
