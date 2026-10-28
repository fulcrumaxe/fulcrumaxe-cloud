import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import { completeDeltaReview, createStartDeltaReview, enqueueEntry, getEntry, runRefreshStep, sweepMergeQueue, takeSlot, type DeltaCompletion, type DeltaCompletionPorts, type MergeQueueEntry } from "../../src/mergeQueue/index.js";
import type { DeltaReviewInput } from "../../src/review/reviewPrompts.js";
import { startMergeTlsGitHub, type MergeTlsGitHub } from "../review/helpers/fakeGitHubMergeTls.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#519 MQ3-b-2b (C4 2.5 and test 10, C5 ruling 1): what happens when a delta review's runs end, over real Postgres (a plain `app_user` pool,
 * row security in force) and the strict GitHub fake over real TLS. The runs are rows of `agent_runs`; a cancel is an UPDATE to `cancelled`, so
 * "the run's cancel call" and "nothing left running" are read from the table, not from a mock.
 */
const T0 = new Date("2026-10-27T10:00:00Z");
const HEAD = "a".repeat(40);
const BOT = "fulcrumaxe-app[bot]";
const PR = 7;

let open: MergeTlsGitHub[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

describe("D#519 MQ3-b-2b delta-review completion [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, accountId, fn);

  interface Setup {
    accountId: string;
    repoId: string;
    workItemId: string;
    entry: MergeQueueEntry;
    g: MergeTlsGitHub;
    events: string[];
    started: string[];
    refuse: Set<string>;
    plan: { roles: string[]; flaggedRoles: string[] };
    complete(now?: Date): Promise<DeltaCompletion>;
    finish(role: string, envelope: Record<string, unknown>, status?: string): Promise<void>;
    statuses(): Promise<Record<string, string>>;
    row(): Promise<Record<string, unknown>>;
  }

  async function setup(o: { roles?: string[]; flaggedRoles?: string[] } = {}): Promise<Setup> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: PR });
    const created = await tenant(accountId, (c) => enqueueEntry(c, { accountId, repoId, workItemId, prNumber: PR, headSha: HEAD, approvedAt: T0 }));
    const taken = await tenant(accountId, (c) => takeSlot(c, { accountId, repoId, holder: "tick-1", facts: new Map([[created.entry.id, { open: true, draft: false }]]) }));
    const g = await startMergeTlsGitHub({ prNumber: PR, behindBy: 1, classicStrict: true, files: [{ filename: "src/a.ts" }], mainFiles: [{ filename: "src/a.ts" }] });
    open.push(g);
    const gh = createGitHubMergeGatePort({ http: g.http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, sleep: async () => undefined, mergeablePollLimit: 3 });
    const events: string[] = [];
    const started: string[] = [];
    const refuse = new Set<string>();
    const plan = { roles: o.roles ?? ["code-reviewer", "acceptance-tester"], flaggedRoles: o.flaggedRoles ?? [] };
    const toSha = () => g.world.refreshedHeadSha;
    const ports: DeltaCompletionPorts = {
      github: gh,
      inTenant: tenant,
      plan: async ({ flagged }) => ({ ok: true, roles: flagged ? [...plan.roles, ...plan.flaggedRoles] : plan.roles }),
      runs: async (_e, sha) =>
        (await db.admin.query(`SELECT DISTINCT ON (role) id, role, status FROM agent_runs WHERE account_id = $1 AND head_sha = $2 ORDER BY role, created_at DESC`, [accountId, sha])).rows.map((r) => ({ role: r.role as string, runId: r.id as string, attempt: 0, reusable: r.status !== "cancelled" })),
      startRole: async ({ role, delta }: { role: string; delta: DeltaReviewInput }) => {
        if (refuse.has(role)) return { ok: false, reason: "refused_spend" };
        started.push(role);
        const id = randomUUID();
        await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, $4, 'production', 'running', $5)`, [id, accountId, workItemId, role, delta.mergeCommitSha]);
        return { ok: true, runId: id };
      },
      cancelRun: async (_e, runId) => void (await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1 AND status = 'running'`, [runId])),
      recordEvent: async ({ code }) => void events.push(code),
      outcome: async (_e, runId) => {
        const r = (await db.admin.query(`SELECT status, envelope FROM agent_runs WHERE id = $1`, [runId])).rows[0];
        const done = r.status !== "running";
        const verdict = typeof r.envelope?.verdict === "string" ? (r.envelope.verdict as string) : "fail";
        return { done, verdict, securityNeeded: r.envelope?.security_review_needed === true, noVerdict: done && typeof r.envelope?.verdict !== "string" };
      },
    };
    const entry = taken.taken!;
    const start = createStartDeltaReview(ports);
    const refreshed = await runRefreshStep(
      { github: gh, inTenant: tenant, ourLogin: BOT, gate: async () => undefined, startDeltaReview: start, sleep: async () => undefined, pollIntervalMs: 0, pollLimit: 4 },
      { accountId, entry, holder: "tick-1", pr: { repoId, prNumber: PR } },
    );
    expect(refreshed.outcome).toBe("needs_delta_review");
    started.length = 0;
    const row = async () => (await db.admin.query(`SELECT * FROM merge_queue_entries WHERE id = $1`, [entry.id])).rows[0] as Record<string, unknown>;
    return {
      accountId, repoId, workItemId, entry, g, events, started, refuse, plan,
      complete: async (now) => completeDeltaReview({ ...ports, ...(now ? { now: () => now } : {}) }, (await tenant(accountId, (c) => getEntry(c, accountId, entry.id)))!),
      finish: async (role, envelope, status = "succeeded") => void (await db.admin.query(`UPDATE agent_runs SET status = $3, envelope = $4 WHERE account_id = $1 AND role = $2 AND head_sha = $5 AND status = 'running'`, [accountId, role, status, JSON.stringify(envelope), toSha()])),
      statuses: async () => Object.fromEntries((await db.admin.query(`SELECT role, status FROM agent_runs WHERE account_id = $1 ORDER BY created_at`, [accountId])).rows.map((r) => [r.role, r.status])),
      row,
    };
  }

  const pass = { verdict: "pass", findings: [], summary: "ok" };

  it("a run still going changes nothing", async () => {
    const s = await setup();
    await s.finish("code-reviewer", pass);
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    expect(await s.row()).toMatchObject({ state: "awaiting_work", work_kind: "delta_review" });
  });

  it("every started role passed: the entry is queued again at its ORIGINAL approved_at, with no slot", async () => {
    const s = await setup();
    await s.finish("code-reviewer", pass);
    await s.finish("acceptance-tester", pass);
    expect(await s.complete()).toEqual({ outcome: "passed" });
    expect(await s.row()).toMatchObject({ state: "queued", slot_holder: null, work_kind: null, approved_at: T0 });
    // A replay finds the entry already moved.
    expect(await s.complete()).toEqual({ outcome: "not_waiting" });
  });

  it("needs-fix: the other run is cancelled, the refresh is recorded not_carried and the entry is back in review at its original place", async () => {
    const s = await setup();
    await s.finish("code-reviewer", { verdict: "needs-fix", findings: ["a.ts:1 bug"], summary: "no" });
    expect(await s.complete()).toEqual({ outcome: "not_carried" });
    expect(s.events).toEqual(["not_carried"]);
    expect(await s.statuses()).toEqual({ "code-reviewer": "succeeded", "acceptance-tester": "cancelled" });
    expect(await s.row()).toMatchObject({ state: "in_review", slot_holder: null, approved_at: T0 });
  });

  it("a run that ended with no verdict is not a pass", async () => {
    const s = await setup();
    await s.finish("code-reviewer", {}, "failed");
    expect(await s.complete()).toEqual({ outcome: "not_carried" });
    expect(await s.row()).toMatchObject({ state: "in_review" });
  });

  it("the debater (where enabled) starts only AFTER the other roles passed, in delta mode, and the entry waits for it", async () => {
    const s = await setup({ roles: ["code-reviewer", "acceptance-tester", "debater"] });
    await s.finish("code-reviewer", pass);
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    expect(s.started).toEqual([]);
    await s.finish("acceptance-tester", pass);
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    expect(s.started).toEqual(["debater"]);
    expect(await s.row()).toMatchObject({ state: "awaiting_work" });
    // A replay while it runs starts nothing more; its pass finishes the review.
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    expect(s.started).toEqual(["debater"]);
    await s.finish("debater", pass);
    expect(await s.complete()).toEqual({ outcome: "passed" });
    expect(await s.row()).toMatchObject({ state: "queued", approved_at: T0 });
  });

  it("a debater that does not pass sends the entry back to review", async () => {
    const s = await setup({ roles: ["code-reviewer", "acceptance-tester", "debater"] });
    await s.finish("code-reviewer", pass);
    await s.finish("acceptance-tester", pass);
    await s.complete();
    await s.finish("debater", { verdict: "needs-fix", findings: ["x"], summary: "refuted" });
    expect(await s.complete()).toEqual({ outcome: "not_carried" });
    expect(await s.row()).toMatchObject({ state: "in_review" });
  });

  it("the delta code reviewer flags security: the security reviewer starts, and the entry waits for it before it is queued", async () => {
    const s = await setup({ flaggedRoles: ["security-reviewer"] });
    await s.finish("code-reviewer", { ...pass, security_review_needed: true });
    await s.finish("acceptance-tester", pass);
    expect(await s.complete()).toEqual({ outcome: "waiting" });
    expect(s.started).toEqual(["security-reviewer"]);
    expect(await s.row()).toMatchObject({ state: "awaiting_work" });
    await s.finish("security-reviewer", pass);
    expect(await s.complete()).toEqual({ outcome: "passed" });
  });

  it("a follow-up start refused for spend stops the entry (Needs a person) and does not retry", async () => {
    const s = await setup({ roles: ["code-reviewer", "acceptance-tester", "debater"] });
    s.refuse.add("debater");
    await s.finish("code-reviewer", pass);
    await s.finish("acceptance-tester", pass);
    expect(await s.complete()).toEqual({ outcome: "refused_spend" });
    expect(await s.row()).toMatchObject({ state: "stopped", reason: "refused_spend", slot_holder: null, approved_at: T0 });
    expect(await s.complete()).toEqual({ outcome: "not_waiting" });
  });

  it("the head moved before the verdicts (a person pushed): head_changed, runs cancelled, back in review with approved_at kept", async () => {
    const s = await setup();
    s.g.world.headSha = "d".repeat(40);
    expect(await s.complete()).toEqual({ outcome: "returned", reason: "head_changed" });
    expect(s.events).toEqual(["head_changed"]);
    expect(await s.statuses()).toEqual({ "code-reviewer": "cancelled", "acceptance-tester": "cancelled" });
    expect(await s.row()).toMatchObject({ state: "in_review", slot_holder: null, approved_at: T0 });
  });

  it("closed by a person while it runs: the entry is closed, the runs are cancelled, a verdict that arrives is ignored", async () => {
    const s = await setup();
    await s.finish("code-reviewer", pass);
    s.g.world.state = "closed";
    expect(await s.complete()).toEqual({ outcome: "settled", as: "closed" });
    expect(await s.statuses()).toEqual({ "code-reviewer": "succeeded", "acceptance-tester": "cancelled" });
    expect(await s.row()).toMatchObject({ state: "closed", slot_holder: null });
  });

  it("merged by a person while it runs: the entry is merged by a person and the runs are cancelled", async () => {
    const s = await setup();
    s.g.world.state = "closed";
    s.g.world.merged = true;
    expect(await s.complete()).toEqual({ outcome: "settled", as: "merged" });
    expect(await s.row()).toMatchObject({ state: "merged", merged_by: "person" });
    expect((await s.statuses())["code-reviewer"]).toBe("cancelled");
  });

  it("a review that never ends is reclaimed after the bound: runs cancelled, back in review with the fixed code delta_review_timeout", async () => {
    const s = await setup();
    const early = new Date(Date.now() + 60 * 60_000);
    expect(await s.complete(early)).toEqual({ outcome: "waiting" });
    const late = new Date(Date.now() + 3 * 60 * 60_000);
    expect(await s.complete(late)).toEqual({ outcome: "returned", reason: "delta_review_timeout" });
    expect(s.events).toEqual(["delta_review_timeout"]);
    expect(await s.statuses()).toEqual({ "code-reviewer": "cancelled", "acceptance-tester": "cancelled" });
    expect(await s.row()).toMatchObject({ state: "in_review", approved_at: T0 });
  });

  it("a review that never ends is reclaimed after the bound: runs cancelled, back in review with the fixed code delta_review_timeout", async () => {
    const s = await setup();
    const early = new Date(Date.now() + 60 * 60_000);
    expect(await s.complete(early)).toEqual({ outcome: "waiting" });
    const late = new Date(Date.now() + 3 * 60 * 60_000);
    expect(await s.complete(late)).toEqual({ outcome: "returned", reason: "delta_review_timeout" });
    expect(s.events).toEqual(["delta_review_timeout"]);
    expect(await s.statuses()).toEqual({ "code-reviewer": "cancelled", "acceptance-tester": "cancelled" });
    expect(await s.row()).toMatchObject({ state: "in_review", approved_at: T0 });
  });

  it("the cron sweep reclaims a stranded awaiting_work entry (its workflow died): the database function lists its repo and the timeout path returns it to review", async () => {
    const s = await setup();
    expect(await s.row()).toMatchObject({ state: "awaiting_work", work_kind: "delta_review" });
    // The database function, as the sweep calls it. The shared cluster holds other tests' repos (and the list is capped), so the rest are set aside
    // inside a transaction that is rolled back.
    const listed = async (): Promise<Array<{ accountId: string; repoId: string }>> => {
      await db.admin.query("BEGIN");
      try {
        await db.admin.query("SET LOCAL session_replication_role = replica");
        await db.admin.query("DELETE FROM merge_queue_entries WHERE account_id <> $1", [s.accountId]);
        return (await db.admin.query('SELECT account_id AS "accountId", repo_id AS "repoId" FROM merge_queue_sweep_targets(now(), 200)')).rows;
      } finally {
        await db.admin.query("ROLLBACK");
      }
    };
    // An awaiting_work entry alone is enough to be listed: no lapsed lease, nothing queued.
    expect(await listed()).toEqual([{ accountId: s.accountId, repoId: s.repoId }]);

    const late = new Date(Date.now() + 3 * 60 * 60_000);
    const swept = await sweepMergeQueue({
      listTargets: listed,
      inTenant: tenant,
      // What the web sweep does for the repo before its tick: look at each delta review that is waiting.
      tick: async (t) => {
        const waiting = (await tenant(t.accountId, (c) => c.query(`SELECT id FROM merge_queue_entries WHERE repo_id = $1 AND state = 'awaiting_work'`, [t.repoId]))).rows;
        expect(waiting).toHaveLength(1);
        expect(await s.complete(late)).toEqual({ outcome: "returned", reason: "delta_review_timeout" });
      },
      now: late,
    });
    expect(swept).toMatchObject({ listed: 1, ticked: 1, failed: 0 });
    expect(s.events).toEqual(["delta_review_timeout"]);
    expect(await s.row()).toMatchObject({ state: "in_review", approved_at: T0 });
    // Once it left awaiting_work (and nothing is queued) the repo is no longer listed.
    expect(await listed()).toEqual([]);
  });


  it("an entry that is not waiting for a delta review is left alone", async () => {
    const s = await setup();
    await s.finish("code-reviewer", pass);
    await s.finish("acceptance-tester", pass);
    await s.complete();
    const queued = (await tenant(s.accountId, (c) => getEntry(c, s.accountId, s.entry.id)))!;
    expect(queued.state).toBe("queued");
  });
});
