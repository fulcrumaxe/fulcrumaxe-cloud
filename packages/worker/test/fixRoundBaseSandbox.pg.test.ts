import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { applyMappedEvent, type ApplyEventCtx, type BranchSyncOutcome } from "@fx/github";
import { withTenant } from "@fx/db/src/withTenant.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { BASE_SYNC_CONFLICT_SENTENCE, BASE_SYNC_UNAVAILABLE_SENTENCE, REPUBLISH_STACKED_UNSUPPORTED_SENTENCE, REPUBLISH_STACK_PARENT_ENDED_SENTENCE, REPUBLISH_STACK_PARENT_CLOSED_SENTENCE, REPUBLISH_STACK_PARENT_OPEN_SENTENCE, REPUBLISH_STACK_PARENT_OFF_MAIN_SENTENCE, REPUBLISH_STACK_PARENT_NO_PULL_REQUEST_SENTENCE } from "@fx/core/src/work-items/baseSync.js";
import { createStackBasePort, type StackParentFacts } from "@fx/pipeline";
import { getWorkItemActivity } from "@fx/core/src/work-items/activity.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceReviewDeps } from "../src/advance.js";
import { BASE_SYNCED_STAGE, FIX_BASE_EVENT } from "../src/fixRoundBase.js";
import type { FixRoundHeadPorts } from "../src/fixRoundHeads.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * [pg] FIXROUND-BASE-SYNC-SANDBOX: a review fix round on the sandbox side brings the base into the private branch with the same `syncRunBranch` the runner side
 * uses, with the same outcomes and the same facts. The GitHub port is a stand-in with the contract of the real one (204 / 201 with parents / 409 / a throw), whose
 * own calls are exercised over TLS in fixRoundHeads.pg.test.ts. The resume is the pipeline's as a stand-in that writes the keyed run row the real one writes.
 */
describe("FIXROUND-BASE-SYNC-SANDBOX: the sandbox side gets the same base sync [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  const SEAT: SeatResult = {
    ok: true,
    seat: {
      repoId: "unused",
      product: "team",
      roleCard: "card",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
      limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 },
      timeoutMs: 40 * 60_000,
      maxExtensions: 3,
    } as never,
  };
  const ASKED = "a".repeat(40);
  const LIVE = "c".repeat(40);
  const BASE = "f".repeat(40);
  const MERGE = "9".repeat(40);
  const PR = 41;
  let nextNumber = 9700;
  let nextDiscussion = 970;
  const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;
  const upToDate = async (): Promise<BranchSyncOutcome> => ({ kind: "up_to_date", baseSha: "f".repeat(40), baseRef: "main", stacked: false });
  const merged = (over: Partial<Extract<BranchSyncOutcome, { kind: "merged" }>> = {}): BranchSyncOutcome => ({ kind: "merged", sha: MERGE, parents: [ASKED, BASE], baseSha: BASE, baseRef: "main", stacked: false, ...over });
  const conflict = async (): Promise<BranchSyncOutcome> => ({ kind: "conflict", baseSha: BASE, baseRef: "main", stacked: false });

  function harness(heads: FixRoundHeadPorts | null, seatResult: SeatResult | { ok: false; reason: string } = SEAT) {
    const resumed: StartAgentRunInput[] = [];
    const resume = vi.fn(async (_pool: Pool, _registry: ExecutionTargetRegistry, input: StartAgentRunInput) => {
      resumed.push(input);
      const { id } = await insertAgentRun(writerPool, {
        id: randomUUID(), accountId: input.accountId, workItemId: input.workItemId, parentRunId: input.parentRunId, role: "executor", runtime: "production",
        executionMode: "sandbox", dispatchRepoId: input.repoId, dispatchPrNumber: input.pr ?? null, idempotency: input.idempotency,
        // The real resume passes this on to the run's create transaction.
        inCreateTransaction: input.inCreateTransaction,
      });
      await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
      return { id, status: "running" };
    });
    const review: AdvanceReviewDeps = { load: vi.fn(), recordRound: vi.fn(), resume, mergeGate: vi.fn() } as never;
    const starter: RunStarter = { async start() { throw new Error("a same-side round never starts a fresh session"); } };
    const deps: AdvanceModuleDeps = { starter, resolveRunSeat: vi.fn(async () => seatResult as SeatResult), startAdvance: async () => undefined, triage: null, registry, review, ...(heads ? { fixHeads: { publicHead: async () => "d".repeat(40), ...heads } } : {}) };
    return { module: createAdvanceModule(writerPool, deps), resume, resumed };
  }

  /** An item at `pr_opened` whose build ended and reported its pull request: in the sandbox (the sandbox build's envelope) or on a runner (its `done` record). */
  async function item(side: "sandbox" | "runner"): Promise<{ a: SeedRefs; w: string; n: number; branch: string }> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = $2 WHERE id = $1", [a.repoId, side === "runner" ? "runner_local" : "sandbox"]);
    await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE account_id = $1", [a.accountId]);
    const w = randomUUID();
    const n = nextNumber++;
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'pr_opened', $4)", [w, a.accountId, a.repoId, n]);
    const d = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')", [d, a.accountId, nextDiscussion++, w]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, w]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);
    const spec = (await admin.query<{ id: string }>("SELECT id FROM spec_versions WHERE work_item_id = $1", [w])).rows[0]!.id;
    const runner = side === "runner";
    const { id: build } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId: w, specVersionId: spec, role: "executor", runtime: runner ? "runner" : "production", executionMode: runner ? "runner_local" : "sandbox", dispatchRepoId: a.repoId, dispatchPrNumber: n });
    const branch = runner ? `fx/${build}-g1` : `fx/issue-${n}`;
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: build, from: "pending", to: "running" });
    await writeRunStatus(writerPool, {
      accountId: a.accountId, runId: build, from: "running", to: "succeeded",
      result: { sessionId: "cc-session-1", envelope: { summary: "built" } },
      ...(runner ? { runnerDone: { prNumber: PR, branch } } : {}),
    });
    return { a, w, n, branch };
  }
  /** The item's pairing, and the record of what the platform pushed to the public repo for it (an open public pull request). */
  async function publicCopy(t: { a: SeedRefs; w: string }, over: { managed?: boolean } = {}): Promise<void> {
    await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', $3) ON CONFLICT (repo_id) DO NOTHING", [t.a.repoId, t.a.accountId, ["private/**"]]);
    await admin.query(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state, managed_by_person_at)
       VALUES ($1, $2, $3, 'acme/widgets-public', $4, $5, $6, 7, 'https://github.com/acme/widgets-public/pull/7', 'pr_opened', $7)`,
      [t.a.accountId, t.w, t.a.repoId, "f".repeat(64), "d".repeat(40), "e".repeat(40), over.managed ? new Date() : null],
    );
  }
  const who = (t: { a: SeedRefs; w: string }) => ({ accountId: t.a.accountId, userId: t.a.userId, workItemId: t.w, haltEpoch: 0 });
  /** What the review step sends: for a sandbox round, the pull request it just found on GitHub by the item's issue branch (never the agent's own report). */
  const fixReq = (t: { n: number; branch: string }, over: { pr?: false } = {}) => ({
    issue: t.n, headSha: ASKED, prompt: "fix it", round: 1, actionId: randomUUID(), reviewer: "code" as const, failingRunId: randomUUID(),
    ...(t.branch === `fx/issue-${t.n}` && over.pr !== false ? { pr: { number: PR, branch: t.branch } } : {}),
  });
  const facts = async (w: string) =>
    (await admin.query<{ kind: string; code: string | null; head_sha: string | null; pr_number: number | null }>("SELECT kind, code, head_sha, pr_number FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq", [w])).rows;
  const syncFacts = async (w: string) => (await facts(w)).filter((f) => f.kind !== "fix_round_refused" && ["base_synced", "base_sync_conflict", "base_sync_unavailable"].includes(f.code ?? ""));
  const stages = async (runId: string) => (await admin.query<{ stage: string }>("SELECT payload->>'stage' AS stage FROM run_events WHERE run_id = $1 AND kind = 'run.stage'", [runId])).rows.map((r) => r.stage);
  const stageOf = async (w: string) => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [w])).rows[0]!.stage;
  const runs = async (w: string) => (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1", [w])).rows[0]!.n;
  const noticeOf = async (t: { a: SeedRefs; w: string }) => (await getWorkItemActivity({ pool: adminPool, principal: { accountId: t.a.accountId, userId: t.a.userId } }, t.w)).notice;

  it("main moved (201): one merge on the item's issue branch, one fact, the base_synced line; a replay writes nothing more", async () => {
    const t = await item("sandbox");
    const syncBase = vi.fn(async () => merged());
    const h = harness({ privateHead: async () => ASKED, syncBase });
    const req = fixReq(t);
    const out = await h.module.advanceStartFix(who(t), req);
    expect(out.ok).toBe(true);
    expect(syncBase).toHaveBeenCalledWith({ repo: { id: t.a.repoId, owner: "acme", name: "widgets" }, branch: t.branch, prNumber: PR });
    expect(await syncFacts(t.w)).toEqual([{ kind: "pr_head_pushed", code: "base_synced", head_sha: MERGE, pr_number: PR }]);
    expect(await stages((out as { runId: string }).runId)).toEqual([BASE_SYNCED_STAGE]);
    expect(await h.module.advanceStartFix(who(t), req)).toEqual(out);
    expect(syncBase).toHaveBeenCalledTimes(1);
    expect(await syncFacts(t.w)).toHaveLength(1);
  });

  it("a push between the head read and the merge is recorded as observed, as on the runner side", async () => {
    const t = await item("sandbox");
    const h = harness({ privateHead: async () => ASKED, syncBase: async () => merged({ parents: [LIVE, BASE] }) });
    expect((await h.module.advanceStartFix(who(t), fixReq(t))).ok).toBe(true);
    expect((await facts(t.w)).filter((f) => f.kind === "pr_head_pushed")).toEqual([
      { kind: "pr_head_pushed", code: "observed", head_sha: LIVE, pr_number: PR },
      { kind: "pr_head_pushed", code: "base_synced", head_sha: MERGE, pr_number: PR },
    ]);
  });

  it("main did not move (204): no fact, no line, the round starts", async () => {
    const t = await item("sandbox");
    const h = harness({ privateHead: async () => ASKED, syncBase: upToDate });
    const out = await h.module.advanceStartFix(who(t), fixReq(t));
    expect(out.ok).toBe(true);
    expect(await syncFacts(t.w)).toEqual([]);
    expect(await stages((out as { runId: string }).runId)).toEqual([]);
  });

  it("a conflict (409): no run, the item in Needs a person with the sentence, the escalation recorded", async () => {
    const t = await item("sandbox");
    const h = harness({ privateHead: async () => ASKED, syncBase: conflict });
    const before = await runs(t.w);
    expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "base_sync_conflict" });
    expect(h.resume).not.toHaveBeenCalled();
    expect(await runs(t.w)).toBe(before);
    expect(await stageOf(t.w)).toBe("needs_human");
    expect(await syncFacts(t.w)).toEqual([{ kind: "escalated", code: "base_sync_conflict", head_sha: ASKED, pr_number: PR }]);
    expect(await noticeOf(t)).toEqual({ kind: "needs_human", reason: BASE_SYNC_CONFLICT_SENTENCE });
  });

  it("anything else refuses base_sync_unavailable and never falls back to the stale base", async () => {
    const bad: Array<FixRoundHeadPorts["syncBase"]> = [
      async () => { throw new Error("connect ECONNREFUSED"); },
      async () => merged({ parents: [ASKED, "e".repeat(40)] }),
      async () => merged({ parents: [BASE, ASKED] }),
      async () => merged({ sha: "main" }),
      undefined,
    ];
    for (const syncBase of bad) {
      const t = await item("sandbox");
      const h = harness({ privateHead: async () => ASKED, syncBase: syncBase as never });
      const before = await runs(t.w);
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "base_sync_unavailable" });
      expect(h.resume).not.toHaveBeenCalled();
      expect(await runs(t.w)).toBe(before);
      expect(await stageOf(t.w)).toBe("pr_opened");
      expect((await syncFacts(t.w)).map((f) => [f.kind, f.code])).toEqual([["stopped", "base_sync_unavailable"]]);
    }
  });

  it("a branch GitHub does not have refuses the round by the head check's own code, as on the runner side", async () => {
    const t = await item("sandbox");
    const syncBase = vi.fn(upToDate);
    const h = harness({ privateHead: async () => null, syncBase });
    expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "pr_branch_missing" });
    expect(syncBase).not.toHaveBeenCalled();
  });

  it("the cheap refusals come first: a seat refusal means GitHub is never asked", async () => {
    const t = await item("sandbox");
    const syncBase = vi.fn(async () => merged());
    const h = harness({ privateHead: async () => ASKED, syncBase }, { ok: false, reason: "no_model" });
    expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "no_model" });
    expect(syncBase).not.toHaveBeenCalled();
    expect(await syncFacts(t.w)).toEqual([]);
  });

  it("a sandbox round with no known pull request is refused base_sync_unavailable, the card shows the sentence, and it never starts unsynced", async () => {
    const t = await item("sandbox");
    const syncBase = vi.fn(async () => merged());
    const h = harness({ privateHead: async () => ASKED, syncBase });
    const before = await runs(t.w);
    expect(await h.module.advanceStartFix(who(t), fixReq(t, { pr: false }))).toEqual({ ok: false, reason: "base_sync_unavailable" });
    expect(h.resume).not.toHaveBeenCalled();
    expect(syncBase).not.toHaveBeenCalled();
    expect(await runs(t.w)).toBe(before);
    expect((await syncFacts(t.w)).map((f) => [f.kind, f.code])).toEqual([["escalated", "base_sync_unavailable"]]);
    // The item moves to Needs a person with the fixed sentence.
    expect(await stageOf(t.w)).toBe("needs_human");
    expect(await noticeOf(t)).toEqual({ kind: "needs_human", reason: BASE_SYNC_UNAVAILABLE_SENTENCE });
  });

  it("a pull request on a branch the item does not own is not taken: the round is refused the same way", async () => {
    const t = await item("sandbox");
    const syncBase = vi.fn(async () => merged());
    const h = harness({ privateHead: async () => ASKED, syncBase });
    expect(await h.module.advanceStartFix(who(t), { ...fixReq(t), pr: { number: PR, branch: "fx/issue-1" } })).toEqual({ ok: false, reason: "base_sync_unavailable" });
    expect(syncBase).not.toHaveBeenCalled();
  });

  it("a cross-side sandbox round (a runner-opened pull request) is synced on that branch, and the tip it starts from is the merge commit", async () => {
    const t = await item("runner");
    await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [t.a.repoId]);
    const syncBase = vi.fn(async () => merged());
    const started: Array<Record<string, unknown>> = [];
    const heads = { privateHead: async () => ASKED, syncBase };
    const base = harness(heads);
    const starter: RunStarter = {
      async start(input) {
        started.push(input as never);
        const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: input.accountId, workItemId: input.workItemId, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: input.repoId, idempotency: input.idempotency });
        await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
        return { runId: id } as never;
      },
    };
    const module = createAdvanceModule(writerPool, { starter, resolveRunSeat: async () => SEAT, startAdvance: async () => undefined, triage: null, registry, review: { load: vi.fn(), recordRound: vi.fn(), resume: base.resume, mergeGate: vi.fn() } as never, fixHeads: heads });
    const out = await module.advanceStartFix(who(t), { ...fixReq(t), pr: { number: PR, branch: t.branch }, expectedExecutionMode: "sandbox" });
    expect(out.ok).toBe(true);
    expect(started).toHaveLength(1);
    expect(syncBase).toHaveBeenCalledWith({ repo: { id: t.a.repoId, owner: "acme", name: "widgets" }, branch: t.branch, prNumber: PR });
    // The branch tip after the merge is the merge commit: the latest recorded head of the pull request, which is what the prompt's fetched `origin/<branch>` is.
    expect((await facts(t.w)).filter((f) => f.kind === "pr_head_pushed").at(-1)).toEqual({ kind: "pr_head_pushed", code: "base_synced", head_sha: MERGE, pr_number: PR });
  });

  it("the merge commit's synchronize webhook starts nothing: one recorded push, no run, no stage change", async () => {
    const t = await item("sandbox");
    const h = harness({ privateHead: async () => ASKED, syncBase: async () => merged() });
    expect((await h.module.advanceStartFix(who(t), fixReq(t))).ok).toBe(true);
    const runsBefore = await runs(t.w);
    const kindsBefore = (await facts(t.w)).map((f) => f.kind);
    const ctx = { accountId: t.a.accountId, installationId: "unused", repoId: t.a.repoId, repo: { accountId: t.a.accountId, repoId: t.a.repoId, ghRepoId: 1, fullName: "acme/widgets" }, deliveryId: `d-${randomUUID()}` } as unknown as ApplyEventCtx;
    const applied = await withTenant(writerPool, t.a.accountId, (client) => applyMappedEvent(client, ctx, { kind: "record_pr_push", prNumber: PR, headSha: MERGE, linkedIssueNumber: t.n, trust: "trusted", isFork: false } as never));
    expect(applied).toMatchObject({ applied: "pr_push_recorded", workItemId: t.w, recorded: true });
    expect(await runs(t.w)).toBe(runsBefore);
    expect((await facts(t.w)).map((f) => f.kind)).toEqual([...kindsBefore, "pr_head_pushed"]);
    expect(await stageOf(t.w)).toBe("changes_requested");
    expect(await h.module.advanceStartFix(who(t), { ...fixReq(t), headSha: MERGE })).toEqual({ ok: false, reason: "already_running" });
  });

  it("the sandbox and runner paths produce identical facts, run lines and item moves for the same fixture, whether the branch moved since the review or not", async () => {
    const outcomes: Array<[string, FixRoundHeadPorts["syncBase"], string]> = [
      ["merged", async () => merged(), ASKED],
      ["push in between", async () => merged({ parents: [LIVE, BASE] }), ASKED],
      ["up to date", upToDate, ASKED],
      ["conflict", conflict, ASKED],
      ["unavailable", async () => { throw new Error("down"); }, ASKED],
      // The branch moved after the review (tip differs from the asked head): both sides record the move, then sync from the tip.
      ["moved, merged", async () => merged({ parents: [LIVE, BASE] }), LIVE],
      ["moved, up to date", upToDate, LIVE],
      ["moved, conflict", conflict, LIVE],
      // A change stacked on another pull request: with a public copy it is refused before any merge on both sides (without one, the real port never answers this).
      ["stacked", async () => ({ kind: "stacked", baseRef: "fx/parent" }), ASKED],
    ];
    for (const [name, syncBase, tip, copy] of outcomes.flatMap((o) => [[...o, false] as const, [...o, true] as const])) {
      const seen: unknown[] = [];
      for (const side of ["runner", "sandbox"] as const) {
        const t = await item(side);
        if (copy) await publicCopy(t);
        const out = await harness({ privateHead: async () => tip, syncBase }).module.advanceStartFix(who(t), fixReq(t));
        const runId = out.ok ? (out as { runId: string }).runId : null;
        seen.push({
          result: out.ok ? "started" : out,
          facts: (await facts(t.w)).filter((f) => f.kind !== "fix_round_started").map((f) => [f.kind, f.code, f.head_sha, f.pr_number]),
          lines: runId === null ? [] : await stages(runId),
          stage: await stageOf(t.w),
          notice: await noticeOf(t),
        });
      }
      expect(seen[1], `${name}${copy ? " (public copy)" : ""}`).toEqual(seen[0]);
    }
  });

  describe("FIXROUND-REPUBLISH (R2-c2): a sandbox review fix round of an item whose public pull request is open", () => {
    const fixBaseOf = async (runId: string) => (await admin.query<{ payload: unknown }>("SELECT payload FROM run_events WHERE run_id = $1 AND kind = $2", [runId, FIX_BASE_EVENT])).rows.map((r) => r.payload);
    const codes = async (w: string) => (await facts(w)).filter((f) => f.kind !== "fix_round_refused" && f.code?.startsWith("republish_")).map((f) => [f.kind, f.code]);
    // The real port's contract: a stacked change is answered "stacked" (nothing merged) when the caller says a public copy exists; otherwise it would get a 201.
    const stackedPort = (merge: () => void) => async (i: { publicCopy?: boolean }): Promise<BranchSyncOutcome> => {
      if (i.publicCopy === true) return { kind: "stacked", baseRef: "fx/parent" };
      merge();
      return merged({ baseRef: "fx/parent", stacked: true });
    };

    it("asks the sync as a round with a public copy, and the run records the base it was brought up to date with, in its own create transaction", async () => {
      const t = await item("sandbox");
      await publicCopy(t);
      const syncBase = vi.fn(async () => merged());
      const h = harness({ privateHead: async () => ASKED, syncBase });
      const out = await h.module.advanceStartFix(who(t), fixReq(t));
      expect(out.ok).toBe(true);
      expect(syncBase).toHaveBeenCalledWith({ repo: { id: t.a.repoId, owner: "acme", name: "widgets" }, branch: t.branch, prNumber: PR, publicCopy: true });
      expect(h.resumed[0]!.base).toEqual({ sha: BASE, branch: t.branch });
      expect(await fixBaseOf((out as { runId: string }).runId)).toEqual([{ base_sha: BASE, branch: t.branch }]);
      // Up to date (204) carries the base too: the diff base is the base tip the cloud read, merged or not.
      const u = await item("sandbox");
      await publicCopy(u);
      const hu = harness({ privateHead: async () => ASKED, syncBase: upToDate });
      const outU = await hu.module.advanceStartFix(who(u), fixReq(u));
      expect(await fixBaseOf((outU as { runId: string }).runId)).toEqual([{ base_sha: "f".repeat(40), branch: u.branch }]);
    });

    it("an item with no public copy, or one a person took over, records no base and asks the sync as before", async () => {
      for (const over of [null, { managed: true }]) {
        const t = await item("sandbox");
        if (over) await publicCopy(t, over);
        const syncBase = vi.fn(async () => merged());
        const h = harness({ privateHead: async () => ASKED, syncBase });
        const out = await h.module.advanceStartFix(who(t), fixReq(t));
        expect(out.ok).toBe(true);
        expect(syncBase).toHaveBeenCalledWith({ repo: { id: t.a.repoId, owner: "acme", name: "widgets" }, branch: t.branch, prNumber: PR });
        expect(h.resumed[0]!.base).toBeUndefined();
        expect(await fixBaseOf((out as { runId: string }).runId)).toEqual([]);
      }
    });

    it("a stacked change is refused republish_stacked_unsupported BEFORE any merge, as on the runner side: nothing starts, the item is in Needs a person with the plain sentence", async () => {
      const t = await item("sandbox");
      await publicCopy(t);
      const merges = vi.fn();
      const syncBase = vi.fn(stackedPort(merges));
      const h = harness({ privateHead: async () => ASKED, syncBase });
      const before = await runs(t.w);
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "republish_stacked_unsupported" });
      expect(syncBase).toHaveBeenCalledWith(expect.objectContaining({ publicCopy: true }));
      expect(merges).not.toHaveBeenCalled();
      expect((await facts(t.w)).map((f) => f.code)).not.toContain("base_synced");
      expect(h.resume).not.toHaveBeenCalled();
      expect(await runs(t.w)).toBe(before);
      expect(await stageOf(t.w)).toBe("needs_human");
      expect(await codes(t.w)).toEqual([["escalated", "republish_stacked_unsupported"]]);
      expect(await noticeOf(t)).toEqual({ kind: "needs_human", reason: REPUBLISH_STACKED_UNSUPPORTED_SENTENCE });
    });

    it("a stacked change with no public copy yet is not refused: it is synced as ever, there is nothing to republish", async () => {
      const t = await item("sandbox");
      const merges = vi.fn();
      const syncBase = vi.fn(stackedPort(merges));
      const h = harness({ privateHead: async () => ASKED, syncBase });
      expect((await h.module.advanceStartFix(who(t), fixReq(t))).ok).toBe(true);
      expect(syncBase).toHaveBeenCalledWith(expect.not.objectContaining({ publicCopy: true }));
      expect(merges).toHaveBeenCalledTimes(1);
    });

    it("a cross-side sandbox round on a runner-opened pull request records the base for that run branch", async () => {
      const t = await item("runner");
      await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [t.a.repoId]);
      await publicCopy(t);
      const started: string[] = [];
      const heads = { privateHead: async () => ASKED, syncBase: async () => merged() };
      const base = harness(heads);
      const starter: RunStarter = {
        async start(input) {
          const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: input.accountId, workItemId: input.workItemId, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: input.repoId, idempotency: input.idempotency, inCreateTransaction: input.inCreateTransaction });
          started.push(id);
          await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
          return { runId: id } as never;
        },
      };
      const module = createAdvanceModule(writerPool, { starter, resolveRunSeat: async () => SEAT, startAdvance: async () => undefined, triage: null, registry, review: { load: vi.fn(), recordRound: vi.fn(), resume: base.resume, mergeGate: vi.fn() } as never, fixHeads: { publicHead: async () => "d".repeat(40), ...heads } });
      expect((await module.advanceStartFix(who(t), { ...fixReq(t), pr: { number: PR, branch: t.branch }, expectedExecutionMode: "sandbox" })).ok).toBe(true);
      expect(started).toHaveLength(1);
      expect(await fixBaseOf(started[0]!)).toEqual([{ base_sha: BASE, branch: t.branch }]);
    });
  });

  // D#519 MQ4-e1-b (R-519-C12-4): a MERGE-CONFLICT round on an item whose public pull request is open is signed with the round's OWN base (the default-branch tip it was asked to merge).
  describe("MQ4-e1-b: a conflict round on a public copy carries the round's base", () => {
    const ROUND_BASE = "1".repeat(40);
    const conflictReq = (t: { n: number; branch: string }, over: Record<string, unknown> = {}) => ({
      kind: "conflict" as const, issue: t.n, headSha: ASKED, prompt: "merge main", round: 1, actionId: randomUUID(), baseSha: ROUND_BASE,
      ...(t.branch === `fx/issue-${t.n}` ? { pr: { number: PR, branch: t.branch } } : {}), ...over,
    });
    const fixBaseOf = async (runId: string) => (await admin.query<{ payload: unknown }>("SELECT payload FROM run_events WHERE run_id = $1 AND kind = $2", [runId, FIX_BASE_EVENT])).rows.map((r) => r.payload);
    // The real port's contract (packages/github branchSync.ts): a stacked change with a public copy is answered "stacked"; `readOnly` stops before the merge; anything else would merge.
    const port = (merges: () => void, stacked = false) => vi.fn(async (i: { publicCopy?: boolean; readOnly?: boolean }): Promise<BranchSyncOutcome> => {
      if (i.publicCopy === true && stacked) return { kind: "stacked", baseRef: "fx/parent" };
      if (i.readOnly === true) return { kind: "up_to_date", baseSha: BASE, baseRef: "main", stacked };
      merges();
      return merged();
    });

    it("C12-e1b-2 (sandbox): the run's create transaction records the round's base, marked as a conflict round's, and the sync is only read: nothing is merged", async () => {
      const t = await item("sandbox");
      await publicCopy(t);
      const merges = vi.fn();
      const syncBase = port(merges);
      const h = harness({ privateHead: async () => ASKED, syncBase });
      const out = await h.module.advanceStartFix(who(t), conflictReq(t));
      expect(out.ok).toBe(true);
      expect(syncBase).toHaveBeenCalledWith({ repo: { id: t.a.repoId, owner: "acme", name: "widgets" }, branch: t.branch, prNumber: PR, publicCopy: true, readOnly: true });
      expect(merges).not.toHaveBeenCalled();
      // The signed base is the round's own, not the tip the read-only call happened to see.
      expect(h.resumed[0]!.base).toEqual({ sha: ROUND_BASE, branch: t.branch });
      expect(await fixBaseOf((out as { runId: string }).runId)).toEqual([{ base_sha: ROUND_BASE, branch: t.branch, conflict: true }]);
    });

    it("C15-1 (runner): a runner round on a public copy starts, signed with the round's own base on the item's branch, the sync only read; a stacked change and a copy a person took over keep their answers; a runner round with no public copy is unchanged", async () => {
      const t = await item("runner");
      await publicCopy(t);
      const merges = vi.fn();
      const syncBase = port(merges);
      const h = harness({ privateHead: async () => ASKED, syncBase });
      const out = await h.module.advanceStartFix(who(t), conflictReq(t));
      expect(out.ok).toBe(true);
      expect(syncBase).toHaveBeenCalledWith({ repo: { id: t.a.repoId, owner: "acme", name: "widgets" }, branch: t.branch, prNumber: PR, publicCopy: true, readOnly: true });
      expect(merges).not.toHaveBeenCalled();
      expect(h.resumed[0]!.base).toEqual({ sha: ROUND_BASE, branch: t.branch });
      const stacked = await item("runner");
      await publicCopy(stacked);
      const hs = harness({ privateHead: async () => ASKED, syncBase: port(vi.fn(), true) });
      const before = await runs(stacked.w);
      expect(await hs.module.advanceStartFix(who(stacked), conflictReq(stacked))).toEqual({ ok: false, reason: "republish_stacked_unsupported" });
      expect(hs.resume).not.toHaveBeenCalled();
      expect(await runs(stacked.w)).toBe(before);
      const taken = await item("runner");
      await publicCopy(taken, { managed: true });
      const ht = harness({ privateHead: async () => ASKED, syncBase: port(vi.fn()) });
      expect((await ht.module.advanceStartFix(who(taken), conflictReq(taken))).ok).toBe(true);
      expect(ht.resumed[0]!.base).toBeUndefined();
      const plain = await item("runner");
      const hp = harness({ privateHead: async () => ASKED, syncBase: port(vi.fn()) });
      expect((await hp.module.advanceStartFix(who(plain), conflictReq(plain))).ok).toBe(true);
      expect(hp.resumed[0]!.base).toBeUndefined();
    });

    it("C12-e1b-2: a stacked change still refuses republish_stacked_unsupported before anything starts; a base from a review round's request is invalid", async () => {
      const t = await item("sandbox");
      await publicCopy(t);
      const merges = vi.fn();
      const h = harness({ privateHead: async () => ASKED, syncBase: port(merges, true) });
      const before = await runs(t.w);
      expect(await h.module.advanceStartFix(who(t), conflictReq(t))).toEqual({ ok: false, reason: "republish_stacked_unsupported" });
      expect(merges).not.toHaveBeenCalled();
      expect(h.resume).not.toHaveBeenCalled();
      expect(await runs(t.w)).toBe(before);
      expect(await h.module.advanceStartFix(who(t), { ...fixReq(t), baseSha: ROUND_BASE } as never)).toEqual({ ok: false, reason: "invalid_input" });
      expect(await h.module.advanceStartFix(who(t), conflictReq(t, { baseSha: "not-a-sha" }))).toEqual({ ok: false, reason: "invalid_input" });
    });

    it("C12-e1b-2: a public copy with no base in the request is refused republish_base_missing (never started on a guess); a copy a person took over republishes nothing", async () => {
      const t = await item("sandbox");
      await publicCopy(t);
      const h = harness({ privateHead: async () => ASKED, syncBase: port(vi.fn()) });
      expect(await h.module.advanceStartFix(who(t), conflictReq(t, { baseSha: undefined }))).toEqual({ ok: false, reason: "republish_base_missing" });
      expect(h.resume).not.toHaveBeenCalled();
      const p = await item("sandbox");
      await publicCopy(p, { managed: true });
      const syncBase = port(vi.fn());
      const hp = harness({ privateHead: async () => ASKED, syncBase });
      const out = await hp.module.advanceStartFix(who(p), conflictReq(p));
      expect(out.ok).toBe(true);
      expect(syncBase).not.toHaveBeenCalled();
      expect(hp.resumed[0]!.base).toBeUndefined();
      expect(await fixBaseOf((out as { runId: string }).runId)).toEqual([]);
    });

    it("C12-e1b-3: a public branch that is not where the platform left it refuses a conflict round and a review round alike with public_branch_moved", async () => {
      const heads = { privateHead: async () => ASKED, syncBase: port(vi.fn()), publicHead: async () => "9".repeat(40) };
      const t = await item("sandbox");
      await publicCopy(t);
      expect(await harness(heads).module.advanceStartFix(who(t), conflictReq(t))).toEqual({ ok: false, reason: "public_branch_moved" });
      const u = await item("sandbox");
      await publicCopy(u);
      const review = harness(heads);
      expect(await review.module.advanceStartFix(who(u), fixReq(u))).toEqual({ ok: false, reason: "public_branch_moved" });
      expect((await facts(u.w)).filter((f) => f.kind === "stopped").map((f) => f.code)).toEqual(["public_branch_moved"]);
    });
  });

  // D#6 FIXROUND-REPUBLISH-STACKED: a sandbox round on a stacked change with a public copy goes on while the pull request it is stacked on is verifiably open.
  describe("FIXROUND-REPUBLISH-STACKED: the parent decides", () => {
    const PARENT_TIP = "7".repeat(40);
    const PARENT_PR = 40;
    const openParent: StackParentFacts = { state: "open", merged: false, headSha: PARENT_TIP, headRef: "fx/parent", headInBaseRepo: true, branchTipSha: PARENT_TIP, baseRef: "main", defaultBranch: "main" };
    const fixBaseOf = async (runId: string) => (await admin.query<{ payload: unknown }>("SELECT payload FROM run_events WHERE run_id = $1 AND kind = $2", [runId, FIX_BASE_EVENT])).rows.map((r) => r.payload);
    const codes = async (w: string) => (await facts(w)).filter((f) => ["escalated", "stopped"].includes(f.kind)).map((f) => [f.kind, f.code]);
    /** A change with a public copy whose pull request is stacked on a parent item's pull request (the number the parent's run reported). `parentPr: null`: the parent has no recorded pull request. */
    async function stacked(side: "sandbox" | "runner" = "sandbox", parentPr: number | null = PARENT_PR) {
      const t = await item(side);
      await publicCopy(t);
      const parent = randomUUID();
      await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'pr_opened', $4)", [parent, t.a.accountId, t.a.repoId, nextNumber++]);
      if (parentPr !== null) {
        await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, envelope) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', 'sandbox', $4, $5::jsonb)", [randomUUID(), t.a.accountId, parent, t.a.repoId, JSON.stringify({ summary: "built", pr_number: parentPr })]);
      }
      await admin.query("UPDATE work_items SET stack_parent_id = $1 WHERE id = $2", [parent, t.w]);
      return t;
    }
    /** The real port's contract (branchSync.ts): a stacked change with a public copy is answered "stacked" unless the caller named the pull request's base branch; then it merges (or is up to date). */
    const port = (merges: () => void, over: { tip?: string; upToDate?: boolean; parents?: string[] } = {}) =>
      vi.fn(async (i: { publicCopy?: boolean; stackBranch?: string }): Promise<BranchSyncOutcome> => {
        if (i.publicCopy === true && i.stackBranch !== "fx/parent") return { kind: "stacked", baseRef: "fx/parent" };
        const tip = over.tip ?? PARENT_TIP;
        if (over.upToDate) return { kind: "up_to_date", baseSha: tip, baseRef: "fx/parent", stacked: true };
        merges();
        return merged({ baseSha: tip, baseRef: "fx/parent", stacked: true, parents: over.parents ?? [ASKED, tip] });
      });
    const parentPort = (read: () => Promise<StackParentFacts>) => ({ readParent: vi.fn(read) });

    it.each([
      ["open, the child already holds its tip", { upToDate: true }, 0],
      ["open, moved: its new tip is merged into the child", { tip: "8".repeat(40) }, 1],
    ])("%s: the round starts, the sync is asked again naming the parent's branch, and the run records the parent's tip as its base", async (_label, over, mergeCount) => {
      const t = await stacked();
      const merges = vi.fn();
      const syncBase = port(merges, over);
      const stackBase = parentPort(async () => ({ ...openParent, ...("tip" in over ? { headSha: over.tip, branchTipSha: over.tip } : {}) }));
      const h = harness({ privateHead: async () => ASKED, syncBase, stackBase });
      const req = fixReq(t);
      const out = await h.module.advanceStartFix(who(t), req);
      expect(out.ok).toBe(true);
      const tip = "tip" in over ? over.tip : PARENT_TIP;
      const repo = { id: t.a.repoId, owner: "acme", name: "widgets" };
      expect(syncBase.mock.calls.map((c) => c[0])).toEqual([{ repo, branch: t.branch, prNumber: PR, publicCopy: true, readOnly: true }, { repo, branch: t.branch, prNumber: PR, publicCopy: true, stackBranch: "fx/parent" }]);
      expect(stackBase.readParent).toHaveBeenCalledWith({ repoId: t.a.repoId, owner: "acme", name: "widgets", prNumber: PARENT_PR });
      expect(merges).toHaveBeenCalledTimes(mergeCount);
      expect(h.resumed[0]!.base).toEqual({ sha: tip, branch: t.branch });
      expect(await fixBaseOf((out as { runId: string }).runId)).toEqual([{ base_sha: tip, branch: t.branch }]);
      // A replay finds its run: the parent is not merged a second time.
      expect(await h.module.advanceStartFix(who(t), req)).toEqual(out);
      expect(syncBase).toHaveBeenCalledTimes(2);
      expect(merges).toHaveBeenCalledTimes(mergeCount);
    });

    it("a merge whose second parent is not the parent's tip the port read is not believed: base_sync_unavailable, nothing starts", async () => {
      const t = await stacked();
      const h = harness({ privateHead: async () => ASKED, syncBase: port(vi.fn(), { parents: [ASKED, "1".repeat(40)] }), stackBase: parentPort(async () => openParent) });
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "base_sync_unavailable" });
      expect(h.resume).not.toHaveBeenCalled();
    });

    // D#6 FIRST-PUBLISH-BASE-DRIFT: a sandbox round before the item's first publish (a push row that published nothing) merges the base too, so it gets the parent decision a round with a public copy gets.
    // Nothing is signed or recorded for it: the first publish reads its base from the commits.
    const toPending = (t: { w: string }) => admin.query("UPDATE plane_pushes SET state = 'building', head_sha = NULL, tip_sha = NULL, pr_number = NULL, pr_url = NULL WHERE work_item_id = $1", [t.w]);

    it("before the first publish, a stacked change on its parent's branch with the parent open: the round starts, the sync names the parent's branch, and no base is recorded", async () => {
      const t = await stacked();
      await toPending(t);
      const merges = vi.fn();
      const syncBase = port(merges, { tip: "8".repeat(40) });
      const h = harness({ privateHead: async () => ASKED, syncBase, stackBase: parentPort(async () => ({ ...openParent, headSha: "8".repeat(40), branchTipSha: "8".repeat(40) })) });
      const out = await h.module.advanceStartFix(who(t), fixReq(t));
      expect(out.ok).toBe(true);
      expect(merges).toHaveBeenCalledTimes(1);
      expect(syncBase.mock.calls.map((c) => c[0])).toEqual([expect.objectContaining({ publicCopy: true, readOnly: true }), expect.objectContaining({ publicCopy: true, stackBranch: "fx/parent" })]);
      expect(h.resumed[0]!.base).toBeUndefined();
      expect(await fixBaseOf((out as { runId: string }).runId)).toEqual([]);
    });

    it("before the first publish, a change whose pull request targets main while its stack parent has not merged is refused before anything is merged (the parent probe), as with a public copy", async () => {
      const t = await stacked();
      await toPending(t);
      const merges = vi.fn();
      const syncBase = vi.fn(async (i: { readOnly?: boolean }): Promise<BranchSyncOutcome> => {
        if (i.readOnly === true) return { kind: "up_to_date", baseSha: BASE, baseRef: "main", stacked: false };
        merges();
        return merged();
      });
      const h = harness({ privateHead: async () => ASKED, syncBase: syncBase as never, stackBase: parentPort(async () => openParent) });
      const out = await h.module.advanceStartFix(who(t), fixReq(t));
      expect(out).toEqual({ ok: false, reason: "republish_stack_parent_open" });
      expect(merges).not.toHaveBeenCalled();
      expect(h.resume).not.toHaveBeenCalled();
    });

    it("before the first publish, that same change with its parent merged into main is merged as any change on main", async () => {
      const t = await stacked();
      await toPending(t);
      const merges = vi.fn();
      const syncBase = vi.fn(async (i: { readOnly?: boolean }): Promise<BranchSyncOutcome> => {
        if (i.readOnly === true) return { kind: "up_to_date", baseSha: BASE, baseRef: "main", stacked: false };
        merges();
        return merged();
      });
      const h = harness({ privateHead: async () => ASKED, syncBase: syncBase as never, stackBase: parentPort(async () => ({ ...openParent, state: "closed" as const, merged: true })) });
      expect((await h.module.advanceStartFix(who(t), fixReq(t))).ok).toBe(true);
      expect(merges).toHaveBeenCalledTimes(1);
    });

    it("an item that is not stacked and has published nothing yet is synced as before (nothing to decide), and records no base", async () => {
      const t = await item("sandbox");
      await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', $3) ON CONFLICT (repo_id) DO NOTHING", [t.a.repoId, t.a.accountId, ["private/**"]]);
      await admin.query("INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state) VALUES ($1, $2, $3, 'acme/widgets-public', $4, 'building')", [t.a.accountId, t.w, t.a.repoId, "f".repeat(64)]);
      const syncBase = vi.fn(async () => merged());
      const out = await harness({ privateHead: async () => ASKED, syncBase }).module.advanceStartFix(who(t), fixReq(t));
      expect(out.ok).toBe(true);
      expect(await fixBaseOf((out as { runId: string }).runId)).toEqual([]);
    });

    const setParentStage = async (t: { w: string }, stage: string) => admin.query("UPDATE work_items SET stage = $2 WHERE id = (SELECT stack_parent_id FROM work_items WHERE id = $1)", [t.w, stage]);
    const closedOnGithub = { ...openParent, state: "closed" as const, merged: false };

    it.each([
      ["merged on GitHub (nothing else recorded), its pull request not retargeted", "pr_opened", { ...closedOnGithub, merged: true }, "republish_stack_parent_ended", REPUBLISH_STACK_PARENT_ENDED_SENTENCE],
      ["merged publicly (the item says merged); the sweep closed its private pull request unmerged", "merged", closedOnGithub, "republish_stack_parent_ended", REPUBLISH_STACK_PARENT_ENDED_SENTENCE],
      ["closed without merging (the item says so)", "closed_unmerged", closedOnGithub, "republish_stack_parent_closed", REPUBLISH_STACK_PARENT_CLOSED_SENTENCE],
      ["closed on GitHub while the item still looks open", "pr_opened", closedOnGithub, "republish_stack_parent_closed", REPUBLISH_STACK_PARENT_CLOSED_SENTENCE],
    ])("the parent %s: refused %s BEFORE any merge, nothing starts; the card names the step that exists (Request changes), not Build again", async (_label, stage, read, code, sentence) => {
      const t = await stacked();
      await setParentStage(t, stage);
      await admin.query("UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2", [t.a.accountId, t.a.userId]);
      const merges = vi.fn();
      const syncBase = port(merges);
      const h = harness({ privateHead: async () => ASKED, syncBase, stackBase: parentPort(async () => read) });
      const before = await runs(t.w);
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: code });
      expect(merges).not.toHaveBeenCalled();
      expect(h.resume).not.toHaveBeenCalled();
      expect(await runs(t.w)).toBe(before);
      expect(await stageOf(t.w)).toBe("needs_human");
      expect(await codes(t.w)).toEqual([["escalated", code]]);
      expect(await noticeOf(t)).toEqual({ kind: "needs_human", reason: sentence });
      // The step the sentence names exists from this state: the owner's card lists Request changes. Build again would stop at the open pull request.
      const card = await getWorkItemActivity({ pool: adminPool, principal: { accountId: t.a.accountId, userId: t.a.userId, role: "owner" } }, t.w);
      expect(card.actions).toContain("request_changes");
    });

    it("every sentence of this change names Request changes and carries no raw code, null or Build again; the closed one says the work would be published and names reopening", () => {
      for (const sentence of [REPUBLISH_STACK_PARENT_ENDED_SENTENCE, REPUBLISH_STACK_PARENT_CLOSED_SENTENCE, REPUBLISH_STACKED_UNSUPPORTED_SENTENCE]) {
        expect(sentence).toContain("Request changes");
        expect(sentence).not.toMatch(/Build again|null|undefined|republish_/);
      }
      expect(REPUBLISH_STACK_PARENT_CLOSED_SENTENCE).toMatch(/would publish it/);
      expect(REPUBLISH_STACK_PARENT_CLOSED_SENTENCE).toMatch(/Reopen the closed pull request/);
      expect(REPUBLISH_STACK_PARENT_CLOSED_SENTENCE).not.toMatch(/Change this pull request's base to main/);
    });

    // The hole the security review reproduced: after a hand (or GitHub) retarget to main the sync is not "stacked", the parent is never read, the base is the main tip, and the next round would publish the parent's closed work.
    /** The real port for a change whose pull request now targets the default branch: a read-only call only reads, any other merges. */
    const retargeted = (merges: () => void) =>
      vi.fn(async (i: { readOnly?: boolean }): Promise<BranchSyncOutcome> => {
        if (i.readOnly === true) return { kind: "up_to_date", baseSha: BASE, baseRef: "main", stacked: false };
        merges();
        return merged();
      });

    it("a retargeted child whose parent was closed without merging is refused republish_stack_parent_closed with zero merges and nothing started or published", async () => {
      const t = await stacked();
      await setParentStage(t, "closed_unmerged");
      const merges = vi.fn();
      const syncBase = retargeted(merges);
      const stackBase = parentPort(async () => openParent);
      const h = harness({ privateHead: async () => ASKED, syncBase, stackBase });
      const before = await runs(t.w);
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "republish_stack_parent_closed" });
      expect(syncBase.mock.calls.map((c) => c[0])).toEqual([{ repo: { id: t.a.repoId, owner: "acme", name: "widgets" }, branch: t.branch, prNumber: PR, publicCopy: true, readOnly: true }]);
      expect(merges).not.toHaveBeenCalled();
      expect(h.resume).not.toHaveBeenCalled();
      expect(await runs(t.w)).toBe(before);
      expect((await admin.query("SELECT 1 FROM agent_runs WHERE work_item_id = $1 AND role = 'plane_publish'", [t.w])).rows).toEqual([]);
      expect(await codes(t.w)).toEqual([["escalated", "republish_stack_parent_closed"]]);
      // The same on the runner side and in a conflict round: the gate does not depend on which path asks.
      const r = await stacked("runner");
      await setParentStage(r, "closed_unmerged");
      const hr = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase });
      expect(await hr.module.advanceStartFix(who(r), fixReq(r))).toEqual({ ok: false, reason: "republish_stack_parent_closed" });
      const c = await stacked();
      await setParentStage(c, "closed_unmerged");
      const hc = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase });
      expect(await hc.module.advanceStartFix(who(c), { kind: "conflict" as const, issue: c.n, headSha: ASKED, prompt: "merge main", round: 1, actionId: randomUUID(), baseSha: "1".repeat(40), pr: { number: PR, branch: c.branch } })).toEqual({ ok: false, reason: "republish_stack_parent_closed" });
      expect(merges).not.toHaveBeenCalled();
    });

    it("a retargeted child whose parent merged still works: one merge of main, the run records main's tip", async () => {
      for (const stage of ["merged", "closed"]) {
        const t = await stacked();
        // `closed` after `merged` keeps its merge on record in the push row.
        await setParentStage(t, stage);
        if (stage === "closed") await admin.query("INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state) SELECT account_id, stack_parent_id, repo_id, 'acme/widgets-public', $2, $3, $4, 8, 'https://github.com/acme/widgets-public/pull/8', 'pr_merged' FROM work_items WHERE id = $1", [t.w, "f".repeat(64), "d".repeat(40), "e".repeat(40)]);
        const merges = vi.fn();
        const stackBase = parentPort(async () => ({ ...closedOnGithub, merged: true }));
        const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase });
        const out = await h.module.advanceStartFix(who(t), fixReq(t));
        expect(out.ok, stage).toBe(true);
        expect(merges).toHaveBeenCalledTimes(1);
        expect(h.resumed[0]!.base).toEqual({ sha: BASE, branch: t.branch });
        // Our rows keep no record of which branch the parent merged into, so a merged row is not enough: GitHub is asked.
        expect(stackBase.readParent).toHaveBeenCalledTimes(1);
      }
    });

    // D#6 FIXROUND-RETARGET-OPEN-PARENT: the two states #731 read as ordinary rounds. The child's pull request targets main, and the parent either is still open or was closed on GitHub before our rows say so.
    const conflictReqOf = (t: { n: number; branch: string }) => ({ kind: "conflict" as const, issue: t.n, headSha: ASKED, prompt: "merge main", round: 1, actionId: randomUUID(), baseSha: "1".repeat(40), pr: { number: PR, branch: t.branch } });
    type Round = (h: ReturnType<typeof harness>, t: Awaited<ReturnType<typeof stacked>>) => Promise<unknown>;
    const rounds: Array<[string, "sandbox" | "runner", Round]> = [
      ["sandbox review round", "sandbox", (h, t) => h.module.advanceStartFix(who(t), fixReq(t))],
      ["runner round", "runner", (h, t) => h.module.advanceStartFix(who(t), fixReq(t))],
      ["conflict round", "sandbox", (h, t) => h.module.advanceStartFix(who(t), conflictReqOf(t))],
    ];

    it.each([
      ["still open on GitHub (state 1)", openParent, "republish_stack_parent_open"],
      ["closed on GitHub, the item still looks open (state 2)", closedOnGithub, "republish_stack_parent_closed"],
    ])("a child retargeted to main whose parent is %s: every round path is refused %s with zero merges and nothing started or published", async (_label, read, code) => {
      for (const [name, side, run] of rounds) {
        const t = await stacked(side);
        await admin.query("UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2", [t.a.accountId, t.a.userId]);
        const merges = vi.fn();
        const syncBase = retargeted(merges);
        const stackBase = parentPort(async () => read);
        const h = harness({ privateHead: async () => ASKED, syncBase, stackBase });
        const before = await runs(t.w);
        expect(await run(h, t), name).toEqual({ ok: false, reason: code });
        expect(merges, name).not.toHaveBeenCalled();
        expect(syncBase.mock.calls.every((c) => (c[0] as { readOnly?: boolean }).readOnly === true), name).toBe(true);
        expect(stackBase.readParent, name).toHaveBeenCalledWith({ repoId: t.a.repoId, owner: "acme", name: "widgets", prNumber: PARENT_PR });
        expect(h.resume, name).not.toHaveBeenCalled();
        expect(await runs(t.w), name).toBe(before);
        expect((await admin.query("SELECT 1 FROM agent_runs WHERE work_item_id = $1 AND role = 'plane_publish'", [t.w])).rows, name).toEqual([]);
        expect(await codes(t.w), name).toEqual([["escalated", code]]);
        const card = await getWorkItemActivity({ pool: adminPool, principal: { accountId: t.a.accountId, userId: t.a.userId, role: "owner" } }, t.w);
        expect(card.actions, name).toContain("request_changes");
      }
    });

    it("the open-parent sentence names the step that works (base back to the parent's branch, then Request changes) and nothing that would publish the parent's work", async () => {
      const t = await stacked();
      const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(vi.fn()), stackBase: parentPort(async () => openParent) });
      await h.module.advanceStartFix(who(t), fixReq(t));
      expect(await noticeOf(t)).toEqual({ kind: "needs_human", reason: REPUBLISH_STACK_PARENT_OPEN_SENTENCE });
      expect(REPUBLISH_STACK_PARENT_OPEN_SENTENCE).toMatch(/base back to the branch it is stacked on/);
      expect(REPUBLISH_STACK_PARENT_OPEN_SENTENCE).toContain("Request changes");
      expect(REPUBLISH_STACK_PARENT_OPEN_SENTENCE).not.toMatch(/Build again|null|undefined|republish_|base to main on GitHub/);
    });

    it("a retargeted child whose parent merged on GitHub while our rows still say open goes on: the live read allows it, one merge of main, the run records main's tip (every path)", async () => {
      for (const [name, side, run] of rounds) {
        const t = await stacked(side);
        const merges = vi.fn();
        const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase: parentPort(async () => ({ ...closedOnGithub, merged: true })) });
        expect(((await run(h, t)) as { ok: boolean }).ok, name).toBe(true);
        expect(merges, name).toHaveBeenCalledTimes(name === "conflict round" ? 0 : 1);
        expect(h.resumed[0]!.base, name).toEqual(name === "conflict round" ? { sha: "1".repeat(40), branch: t.branch } : { sha: BASE, branch: t.branch });
      }
    });

    it.each([
      ["GitHub cannot be asked", { read: async () => { throw new Error("boom ghp_000"); } }],
      ["GitHub answers a state that is neither open nor closed", { read: async () => ({ ...openParent, state: "draft" as never }) }],
      ["no parent port is wired", { read: null }],
    ] as Array<[string, { read: (() => Promise<StackParentFacts>) | null; parentPr?: number | null }]>)("a retargeted child whose parent cannot be read (%s): refused base_sync_unavailable on every path, zero merges, nothing started", async (_label, over) => {
      for (const [name, side, run] of rounds) {
        const t = await stacked(side, "parentPr" in over ? over.parentPr : PARENT_PR);
        const merges = vi.fn();
        const stackBase = over.read === null ? undefined : parentPort(over.read);
        const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), ...(stackBase ? { stackBase } : {}) });
        expect(await run(h, t), name).toEqual({ ok: false, reason: "base_sync_unavailable" });
        expect(merges, name).not.toHaveBeenCalled();
        expect(h.resume, name).not.toHaveBeenCalled();
        expect((await codes(t.w)).map((c) => c[1]), name).toEqual(["base_sync_unavailable"]);
      }
    });

    // D#6 STACK-THREE-DEEP, paired repositories: the public pull request is the one that merges. Its private copy is closed unmerged by the sweep, or stays open until the sweep runs. These answer as the real reads do
    // (the real stack-base port over a fake private read and a fake public read), so a read of the wrong copy fails here.
    type PublicEnd = { state: "open" | "closed"; merged: boolean; baseRef: string; defaultBranch: string } | null;
    const privatePull = (over: Record<string, unknown> = {}) => ({ number: PARENT_PR, state: "open", merged: false, head: { sha: PARENT_TIP, ref: "fx/parent", repo: { full_name: "acme/widgets" } }, base: { ref: "main", repo: { full_name: "acme/widgets", default_branch: "main" } }, ...over });
    function realPort(priv: Record<string, unknown>, pub: () => Promise<PublicEnd>) {
      const privateReads: string[] = [];
      const publicReads: unknown[] = [];
      const http = {
        request: async (req: { path: string }) => {
          privateReads.push(req.path);
          return req.path.includes("/git/ref/") ? { status: 200, body: { object: { sha: PARENT_TIP } } } : { status: 200, body: priv };
        },
      };
      const port = createStackBasePort({
        open: async () => http,
        publicPull: async (i) => {
          publicReads.push(i);
          return pub();
        },
      });
      return { port, privateReads, publicReads };
    }
    /** The parent was published: its push row names the public pull request (number 8 in the public repository). */
    const pairParent = (t: { w: string }, state: string) =>
      admin.query("INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state) SELECT account_id, stack_parent_id, repo_id, 'acme/widgets-public', $2, $3, $4, 8, 'https://github.com/acme/widgets-public/pull/8', $5 FROM work_items WHERE id = $1", [t.w, "d".repeat(64), "e".repeat(40), "f".repeat(40), state]);
    const mergedToMain = async (): Promise<PublicEnd> => ({ state: "closed", merged: true, baseRef: "main", defaultBranch: "main" });
    const PUBLIC_PR = { accountId: "", codeRepo: "acme/widgets-public", number: 8 };

    it.each([
      ["closed unmerged by the sweep", privatePull({ state: "closed", merged: false }), "merged"],
      ["still open (the sweep has not run)", privatePull(), "merged"],
      ["still open, and our rows have not caught up with the merge", privatePull(), "pr_opened"],
    ])("a paired parent merged to main on the public side, its private copy %s: every round path goes on with one real merge of main, and the private pull request is never read", async (_l, priv, stage) => {
      for (const [name, side, run] of rounds) {
        const t = await stacked(side);
        await setParentStage(t, stage);
        await pairParent(t, "pr_merged");
        const merges = vi.fn();
        const real = realPort(priv, mergedToMain);
        const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase: real.port });
        expect(((await run(h, t)) as { ok: boolean }).ok, name).toBe(true);
        expect(merges, name).toHaveBeenCalledTimes(name === "conflict round" ? 0 : 1);
        expect(real.publicReads, name).toEqual([{ ...PUBLIC_PR, accountId: t.a.accountId }]);
        expect(real.privateReads, name).toEqual([]);
      }
    });

    it.each(["merged", "pr_opened"])("a paired parent merged on the public side into another branch (item row %s), the child retargeted to main: every round path is refused republish_stack_parent_off_main with zero merges", async (stage) => {
      for (const [name, side, run] of rounds) {
        const t = await stacked(side);
        await setParentStage(t, stage);
        await pairParent(t, "pr_merged");
        const merges = vi.fn();
        const real = realPort(privatePull({ state: "closed", merged: true }), async () => ({ state: "closed", merged: true, baseRef: "fx/grandparent", defaultBranch: "main" }));
        const syncBase = retargeted(merges);
        const h = harness({ privateHead: async () => ASKED, syncBase, stackBase: real.port });
        expect(await run(h, t), name).toEqual({ ok: false, reason: "republish_stack_parent_off_main" });
        expect(merges, name).not.toHaveBeenCalled();
        expect(syncBase.mock.calls.every((c) => (c[0] as { readOnly?: boolean }).readOnly === true), name).toBe(true);
        expect(h.resume, name).not.toHaveBeenCalled();
      }
    });

    it("a paired parent closed without merging on the public side is refused republish_stack_parent_closed even though its private copy says merged", async () => {
      for (const [name, side, run] of rounds) {
        const t = await stacked(side);
        await pairParent(t, "pr_closed");
        const merges = vi.fn();
        const real = realPort(privatePull({ state: "closed", merged: true }), async () => ({ state: "closed", merged: false, baseRef: "main", defaultBranch: "main" }));
        const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase: real.port });
        expect(await run(h, t), name).toEqual({ ok: false, reason: "republish_stack_parent_closed" });
        expect(merges, name).not.toHaveBeenCalled();
      }
    });

    it("a child still on its paired parent's branch, whose public copy merged to main: told the parent has ended (change the base to main), not that the parent is closed or open; zero merges", async () => {
      const t = await stacked();
      await pairParent(t, "pr_merged");
      const merges = vi.fn();
      const real = realPort(privatePull(), mergedToMain);
      const h = harness({ privateHead: async () => ASKED, syncBase: port(merges), stackBase: real.port });
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "republish_stack_parent_ended" });
      expect(merges).not.toHaveBeenCalled();
    });

    it.each([
      ["the public read fails", async (): Promise<PublicEnd> => { throw new Error("boom ghp_000"); }],
    ])("a paired parent when %s: base_sync_unavailable on every path, zero merges, the private copy is never trusted instead", async (_l, pub) => {
      for (const [name, side, run] of rounds) {
        const t = await stacked(side);
        await setParentStage(t, "merged");
        await pairParent(t, "pr_merged");
        const merges = vi.fn();
        const real = realPort(privatePull({ state: "closed", merged: true }), pub);
        const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase: real.port });
        expect(await run(h, t), name).toEqual({ ok: false, reason: "base_sync_unavailable" });
        expect(merges, name).not.toHaveBeenCalled();
        expect(real.privateReads, name).toEqual([]);
      }
    });

    it.each([
      ["retargeted to main", "retargeted"],
      ["still on its parent's branch", "stacked"],
    ])("a blip on the public read (%s) is read again, at most three times in all: a paired parent merged to main goes on after two blips; a lasting outage ends base_sync_unavailable after exactly three", async (_l, shape) => {
      const run = async (failures: number) => {
        const t = await stacked();
        await setParentStage(t, "merged");
        await pairParent(t, "pr_merged");
        let left = failures;
        const real = realPort(privatePull({ state: "closed", merged: true }), async () => {
          if (left-- > 0) throw Object.assign(new Error("public pull request read answered 503"), { transient: true });
          return mergedToMain();
        });
        const merges = vi.fn();
        const h = harness({ privateHead: async () => ASKED, syncBase: shape === "retargeted" ? retargeted(merges) : port(merges), stackBase: real.port });
        return { out: await h.module.advanceStartFix(who(t), fixReq(t)), real, merges };
      };
      const blips = await run(2);
      expect(blips.real.publicReads).toHaveLength(3);
      if (shape === "retargeted") expect(blips.out.ok).toBe(true);
      else expect(blips.out).toEqual({ ok: false, reason: "republish_stack_parent_ended" });
      const outage = await run(99);
      expect(outage.out).toEqual({ ok: false, reason: "base_sync_unavailable" });
      expect(outage.real.publicReads).toHaveLength(3);
      expect(outage.merges).not.toHaveBeenCalled();
    });

    // D#6 STACK-THREE-DEEP round 2.
    const closedUnmerged = async (): Promise<PublicEnd> => ({ state: "closed", merged: false, baseRef: "main", defaultBranch: "main" });
    const openPublic = async (): Promise<PublicEnd> => ({ state: "open", merged: false, baseRef: "main", defaultBranch: "main" });

    it("a paired parent closed on both copies: the closed sentence's step is walked. Reopening only one copy returns the same refusal; reopening both (the branch is there) goes on", async () => {
      const closedBoth = [privatePull({ state: "closed", merged: false }), closedUnmerged] as const;
      const onlyPrivate = [privatePull(), closedUnmerged] as const;
      const onlyPublic = [privatePull({ state: "closed", merged: false }), openPublic] as const;
      const both = [privatePull(), openPublic] as const;
      expect(REPUBLISH_STACK_PARENT_CLOSED_SENTENCE).toMatch(/reopen both its public pull request and its private copy/);
      for (const [label, [priv, pub], goesOn] of [["both closed", closedBoth, false], ["only the private copy reopened", onlyPrivate, false], ["only the public pull request reopened", onlyPublic, false], ["both reopened", both, true]] as const) {
        const t = await stacked();
        await setParentStage(t, "closed_unmerged");
        await pairParent(t, "pr_closed");
        const merges = vi.fn();
        const real = realPort(priv, pub);
        const h = harness({ privateHead: async () => ASKED, syncBase: port(merges), stackBase: real.port });
        const out = await h.module.advanceStartFix(who(t), fixReq(t));
        if (goesOn) expect(out.ok, label).toBe(true);
        else expect(out, label).toEqual({ ok: false, reason: "republish_stack_parent_closed" });
        expect(merges, label).toHaveBeenCalledTimes(goesOn ? 1 : 0);
      }
    });

    it("a paired parent, the child still on its branch: the ended answer comes from the public pull request, never from the item row", async () => {
      for (const [label, priv, pub, want] of [
        ["public closed unmerged, item row says merged", privatePull({ state: "closed", merged: true }), closedUnmerged, "republish_stack_parent_closed"],
        ["public open, private copy merged, item row says merged", privatePull({ state: "closed", merged: true }), openPublic, "republish_stack_parent_closed"],
        ["public merged to main, item row says closed", privatePull({ state: "closed", merged: false }), mergedToMain, "republish_stack_parent_ended"],
      ] as const) {
        const t = await stacked();
        await setParentStage(t, label.includes("row says merged") ? "merged" : "closed_unmerged");
        await pairParent(t, label.includes("closed unmerged") && label.includes("public closed") ? "pr_closed" : "pr_opened");
        const merges = vi.fn();
        const h = harness({ privateHead: async () => ASKED, syncBase: port(merges), stackBase: realPort(priv, pub).port });
        expect(await h.module.advanceStartFix(who(t), fixReq(t)), label).toEqual({ ok: false, reason: want });
        expect(merges, label).not.toHaveBeenCalled();
      }
    });

    it("the public pull request open, its private copy closed and saying merged, the child retargeted to main: refused republish_stack_parent_closed on every path (the merged bit is not taken from the private copy)", async () => {
      for (const [name, side, run] of rounds) {
        const t = await stacked(side);
        await setParentStage(t, "merged");
        await pairParent(t, "pr_opened");
        const merges = vi.fn();
        const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase: realPort(privatePull({ state: "closed", merged: true }), openPublic).port });
        expect(await run(h, t), name).toEqual({ ok: false, reason: "republish_stack_parent_closed" });
        expect(merges, name).not.toHaveBeenCalled();
      }
    });

    it("a lagging closed row does not decide for a paired parent: the public pull request merged to main, the child retargeted, goes on on every path", async () => {
      for (const [name, side, run] of rounds) {
        const t = await stacked(side);
        await setParentStage(t, "closed_unmerged");
        await pairParent(t, "pr_opened");
        const merges = vi.fn();
        const real = realPort(privatePull({ state: "closed", merged: false }), mergedToMain);
        const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase: real.port });
        expect(((await run(h, t)) as { ok: boolean }).ok, name).toBe(true);
        expect(real.publicReads, name).toHaveLength(1);
      }
    });

    it("a re-paired parent (an older push row without a pull request, a newer one with): the newest push row decides, so the public pull request is asked and a lagging closed row does not refuse", async () => {
      const t = await stacked();
      await setParentStage(t, "closed_unmerged");
      await admin.query("INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state, code) SELECT account_id, stack_parent_id, repo_id, 'acme/widgets-old', $2, 'refused', 'scan_refused' FROM work_items WHERE id = $1", [t.w, "c".repeat(64)]);
      await pairParent(t, "pr_opened");
      const merges = vi.fn();
      const real = realPort(privatePull({ state: "closed", merged: false }), mergedToMain);
      const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase: real.port });
      expect(((await h.module.advanceStartFix(who(t), fixReq(t))) as { ok: boolean }).ok).toBe(true);
      expect(real.publicReads).toHaveLength(1);
    });

    it("a lasting 404 on the public pull request is refused republish_stack_parent_no_pull_request (reading again, or pressing Request changes, cannot clear it) on every path", async () => {
      for (const [name, side, run] of rounds) {
        const t = await stacked(side);
        await setParentStage(t, "merged");
        await pairParent(t, "pr_merged");
        const merges = vi.fn();
        const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase: realPort(privatePull(), async (): Promise<PublicEnd> => null).port });
        expect(await run(h, t), name).toEqual({ ok: false, reason: "republish_stack_parent_no_pull_request" });
        expect(merges, name).not.toHaveBeenCalled();
      }
    });

    // A paired parent can have a public pull request and no private number on record (the paired sandbox executor's envelope carries none; the opener can fail while publish still runs; a built child can be linked later).
    describe("a paired parent with no private pull request number on record", () => {
      const noPrivate = async (side: "sandbox" | "runner", stage: string, push: string) => {
        const t = await stacked(side, null);
        await setParentStage(t, stage);
        await pairParent(t, push);
        return t;
      };
      it("public merged to main, the child retargeted: goes on on every path, the public pull request is read and the private one is not", async () => {
        for (const [name, side, run] of rounds) {
          const t = await noPrivate(side, "merged", "pr_merged");
          const merges = vi.fn();
          const real = realPort(privatePull(), mergedToMain);
          const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase: real.port });
          expect(((await run(h, t)) as { ok: boolean }).ok, name).toBe(true);
          expect(real.publicReads, name).toHaveLength(1);
          expect(real.privateReads, name).toEqual([]);
        }
      });
      it("public merged into another branch, or closed unmerged: refused off_main / closed on every path", async () => {
        for (const [name, side, run] of rounds) {
          for (const [pub, want, push] of [[async (): Promise<PublicEnd> => ({ state: "closed", merged: true, baseRef: "fx/grandparent", defaultBranch: "main" }), "republish_stack_parent_off_main", "pr_merged"], [closedUnmerged, "republish_stack_parent_closed", "pr_closed"]] as const) {
            const t = await noPrivate(side, "pr_opened", push);
            const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(vi.fn()), stackBase: realPort(privatePull(), pub).port });
            expect(await run(h, t), `${name}/${want}`).toEqual({ ok: false, reason: want });
          }
        }
      });
      it("public still open: the private copy is needed and is not on record, so republish_stack_parent_no_pull_request on every path", async () => {
        for (const [name, side, run] of rounds) {
          const t = await noPrivate(side, "pr_opened", "pr_opened");
          const merges = vi.fn();
          const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase: realPort(privatePull(), openPublic).port });
          expect(await run(h, t), name).toEqual({ ok: false, reason: "republish_stack_parent_no_pull_request" });
          expect(merges, name).not.toHaveBeenCalled();
        }
      });
      it("the child still on the parent's branch: a public copy that is still open with no private number, or that is gone (404), is refused republish_stack_parent_no_pull_request, never as unavailable", async () => {
        for (const [pub, hasNumber] of [[openPublic, false], [async (): Promise<PublicEnd> => null, true]] as const) {
          const t = await stacked("sandbox", hasNumber ? PARENT_PR : null);
          await pairParent(t, "pr_opened");
          const merges = vi.fn();
          const h = harness({ privateHead: async () => ASKED, syncBase: port(merges), stackBase: realPort(privatePull(), pub).port });
          expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "republish_stack_parent_no_pull_request" });
          expect(merges).not.toHaveBeenCalled();
        }
      });
      it("the child still on the parent's branch, public merged to main: told the parent has ended", async () => {
        const t = await noPrivate("sandbox", "merged", "pr_merged");
        const h = harness({ privateHead: async () => ASKED, syncBase: port(vi.fn()), stackBase: realPort(privatePull(), mergedToMain).port });
        expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "republish_stack_parent_ended" });
      });
    });

    it("a parent with no push row is read through its private pull request, and the public read is never made", async () => {
      for (const [name, side, run] of rounds) {
        const t = await stacked(side);
        await setParentStage(t, "merged");
        const merges = vi.fn();
        const real = realPort(privatePull({ state: "closed", merged: true }), async () => { throw new Error("must not be asked"); });
        const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase: real.port });
        expect(((await run(h, t)) as { ok: boolean }).ok, name).toBe(true);
        expect(real.publicReads, name).toEqual([]);
        expect(real.privateReads.length, name).toBeGreaterThan(0);
      }
    });

    it("a change with no public copy is not asked about its parent (nothing is published, so nothing is at risk)", async () => {
      const t = await item("sandbox");
      const parent = randomUUID();
      await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'pr_opened', $4)", [parent, t.a.accountId, t.a.repoId, nextNumber++]);
      await admin.query("UPDATE work_items SET stack_parent_id = $1 WHERE id = $2", [parent, t.w]);
      const stackBase = parentPort(async () => openParent);
      const h = harness({ privateHead: async () => ASKED, syncBase: vi.fn(async () => merged()), stackBase });
      expect((await h.module.advanceStartFix(who(t), fixReq(t))).ok).toBe(true);
      expect(stackBase.readParent).not.toHaveBeenCalled();
    });

    it("a parent reopened on GitHub (the item row still says closed) with this change still on its branch goes on: the live read decides, the parent's tip is merged", async () => {
      const t = await stacked();
      await setParentStage(t, "closed_unmerged");
      const merges = vi.fn();
      const syncBase = port(merges);
      const h = harness({ privateHead: async () => ASKED, syncBase, stackBase: parentPort(async () => openParent) });
      const out = await h.module.advanceStartFix(who(t), fixReq(t));
      expect(out.ok).toBe(true);
      expect(syncBase.mock.calls.map((c) => c[0].stackBranch)).toEqual([undefined, "fx/parent"]);
      expect(syncBase.mock.calls[0]![0]).toMatchObject({ readOnly: true });
      expect(merges).toHaveBeenCalledTimes(1);
      expect(h.resumed[0]!.base).toEqual({ sha: PARENT_TIP, branch: t.branch });
    });

    it("the second sync throwing, a stacked merge that conflicts, and a missing read port each end with their own fixed code and no run", async () => {
      const a = await stacked();
      const ha = harness({ privateHead: async () => ASKED, syncBase: vi.fn(async (i: { stackBranch?: string }): Promise<BranchSyncOutcome> => { if (i.stackBranch === undefined) return { kind: "stacked", baseRef: "fx/parent" }; throw new Error("boom ghp_000"); }), stackBase: parentPort(async () => openParent) });
      expect(await ha.module.advanceStartFix(who(a), fixReq(a))).toEqual({ ok: false, reason: "base_sync_unavailable" });
      expect(await codes(a.w)).toEqual([["stopped", "base_sync_unavailable"]]);
      const b = await stacked();
      const hb = harness({ privateHead: async () => ASKED, syncBase: vi.fn(async (i: { stackBranch?: string }): Promise<BranchSyncOutcome> => (i.stackBranch === undefined ? { kind: "stacked", baseRef: "fx/parent" } : { kind: "conflict", baseSha: PARENT_TIP, baseRef: "fx/parent", stacked: true })), stackBase: parentPort(async () => openParent) });
      expect(await hb.module.advanceStartFix(who(b), fixReq(b))).toEqual({ ok: false, reason: "base_sync_conflict" });
      expect(await codes(b.w)).toEqual([["escalated", "base_sync_conflict"]]);
      const c = await stacked();
      const merges = vi.fn();
      const syncBase = port(merges);
      const hc = harness({ privateHead: async () => ASKED, syncBase });
      expect(await hc.module.advanceStartFix(who(c), fixReq(c))).toEqual({ ok: false, reason: "republish_stacked_unsupported" });
      expect(syncBase).toHaveBeenCalledTimes(1);
      expect(merges).not.toHaveBeenCalled();
      for (const h of [ha, hb, hc]) expect(h.resume).not.toHaveBeenCalled();
    });

    it.each([
      ["GitHub cannot be asked", async () => { throw new Error("secret ghp_000 in a cause"); }],
      ["its pull request head and branch tip differ", async () => ({ ...openParent, branchTipSha: "6".repeat(40) })],
      ["its branch is in a fork", async () => ({ ...openParent, headInBaseRepo: false })],
    ])("the parent cannot be read (%s): refused base_sync_unavailable with zero merge calls", async (_label, read) => {
      const t = await stacked();
      const merges = vi.fn();
      const syncBase = port(merges);
      const h = harness({ privateHead: async () => ASKED, syncBase, stackBase: parentPort(read as () => Promise<StackParentFacts>) });
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "base_sync_unavailable" });
      expect(syncBase).toHaveBeenCalledTimes(1);
      expect(merges).not.toHaveBeenCalled();
      expect(h.resume).not.toHaveBeenCalled();
      expect(await codes(t.w)).toEqual([["stopped", "base_sync_unavailable"]]);
    });

    // D#6 REPUBLISH-TRANSIENT-RETRY: the parent read (both places it is made) is read again after a blip, at most three times; a lasting outage ends exactly as before.
    describe("D#6 REPUBLISH-TRANSIENT-RETRY: a blip on the stack-parent read", () => {
      const blip = () => Object.assign(new Error("stack parent: pull request read answered 503"), { transient: true });
      /** Fails `n` times with a blip (or with a plain error when `plain`), then answers. */
      const failing = (n: number, then: StackParentFacts, plain = false) => {
        let left = n;
        return async (): Promise<StackParentFacts> => {
          if (left-- > 0) throw plain ? new Error("forbidden") : blip();
          return then;
        };
      };

      it.each([1, 2])("a stacked change whose parent read fails %i time(s) then says open: the round starts after n+1 reads, with the same sync calls as without a blip", async (n) => {
        const t = await stacked();
        const merges = vi.fn();
        const syncBase = port(merges, { upToDate: true });
        const stackBase = parentPort(failing(n, openParent));
        const h = harness({ privateHead: async () => ASKED, syncBase, stackBase });
        expect((await h.module.advanceStartFix(who(t), fixReq(t))).ok).toBe(true);
        expect(stackBase.readParent).toHaveBeenCalledTimes(n + 1);
        expect(syncBase).toHaveBeenCalledTimes(2);
        expect(merges).not.toHaveBeenCalled();
      });

      it("a child retargeted to main whose parent read fails twice then says merged goes on (one merge of main, three reads); a parent that then says open is still refused", async () => {
        const t = await stacked();
        const merges = vi.fn();
        const stackBase = parentPort(failing(2, { ...closedOnGithub, merged: true }));
        const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges), stackBase });
        expect((await h.module.advanceStartFix(who(t), fixReq(t))).ok).toBe(true);
        expect(stackBase.readParent).toHaveBeenCalledTimes(3);
        expect(merges).toHaveBeenCalledTimes(1);
        const t2 = await stacked();
        const merges2 = vi.fn();
        const stackBase2 = parentPort(failing(1, openParent));
        const h2 = harness({ privateHead: async () => ASKED, syncBase: retargeted(merges2), stackBase: stackBase2 });
        expect(await h2.module.advanceStartFix(who(t2), fixReq(t2))).toEqual({ ok: false, reason: "republish_stack_parent_open" });
        expect(merges2).not.toHaveBeenCalled();
      });

      it.each([
        ["stacked on its parent's branch", "stacked"],
        ["retargeted to main", "retargeted"],
      ])("a lasting outage (%s) is exactly three reads and then the same base_sync_unavailable, zero merges, nothing started", async (_label, shape) => {
        const t = await stacked();
        const merges = vi.fn();
        const stackBase = parentPort(failing(99, openParent));
        const h = harness({ privateHead: async () => ASKED, syncBase: shape === "stacked" ? port(merges) : retargeted(merges), stackBase });
        expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "base_sync_unavailable" });
        expect(stackBase.readParent).toHaveBeenCalledTimes(3);
        expect(merges).not.toHaveBeenCalled();
        expect(h.resume).not.toHaveBeenCalled();
        expect(await codes(t.w)).toEqual([["stopped", "base_sync_unavailable"]]);
      });

      it("an error that is not a blip (a 4xx, a malformed answer) is read once and refused as before", async () => {
        const t = await stacked();
        const stackBase = parentPort(failing(99, openParent, true));
        const h = harness({ privateHead: async () => ASKED, syncBase: port(vi.fn()), stackBase });
        expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "base_sync_unavailable" });
        expect(stackBase.readParent).toHaveBeenCalledTimes(1);
      });
    });

    it("a parent with no recorded pull request number: refused republish_stack_parent_no_pull_request (a permanent state, not a transient one), the parent is never read, zero merges", async () => {
      const t = await stacked("sandbox", null);
      const merges = vi.fn();
      const stackBase = parentPort(async () => openParent);
      const h = harness({ privateHead: async () => ASKED, syncBase: port(merges), stackBase });
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "republish_stack_parent_no_pull_request" });
      expect(stackBase.readParent).not.toHaveBeenCalled();
      expect(merges).not.toHaveBeenCalled();
      expect(await noticeOf(t)).toEqual({ kind: "needs_human", reason: REPUBLISH_STACK_PARENT_NO_PULL_REQUEST_SENTENCE });
    });

    it("the no-pull-request sentence says what clears it and names a step that exists; it never offers Request changes, which would stop at the same place", () => {
      expect(REPUBLISH_STACK_PARENT_NO_PULL_REQUEST_SENTENCE).toMatch(/clears only if that item's pull request gets recorded/);
      expect(REPUBLISH_STACK_PARENT_NO_PULL_REQUEST_SENTENCE).toMatch(/yourself, or close this item/);
      expect(REPUBLISH_STACK_PARENT_NO_PULL_REQUEST_SENTENCE).not.toMatch(/Request changes|Build again|try again later|null|undefined|republish_|base to main on GitHub|Couldn't bring/);
    });

    // D#6 STACK-THREE-DEEP: G <- P <- C. P merged into G's branch while G is open, and C's base was set to main. The rows and GitHub both say P merged; only its base says the work is not in main.
    const offMain: StackParentFacts = { ...closedOnGithub, merged: true, baseRef: "fx/grandparent" };
    const parentRows = ["merged", "closed", "pr_opened"] as const;

    it.each(parentRows)("a retargeted child whose parent merged into another branch (item row %s): every round path is refused republish_stack_parent_off_main with zero merges, nothing started or published", async (stage) => {
      for (const [name, side, run] of rounds) {
        const t = await stacked(side);
        await setParentStage(t, stage);
        if (stage === "closed") await admin.query("INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state) SELECT account_id, stack_parent_id, repo_id, 'acme/widgets-public', $2, $3, $4, 8, 'https://github.com/acme/widgets-public/pull/8', 'pr_merged' FROM work_items WHERE id = $1", [t.w, "d".repeat(64), "e".repeat(40), "f".repeat(40)]);
        const merges = vi.fn();
        const syncBase = retargeted(merges);
        const stackBase = parentPort(async () => offMain);
        const h = harness({ privateHead: async () => ASKED, syncBase, stackBase });
        const before = await runs(t.w);
        expect(await run(h, t), `${name}/${stage}`).toEqual({ ok: false, reason: "republish_stack_parent_off_main" });
        expect(merges, name).not.toHaveBeenCalled();
        expect(syncBase.mock.calls.every((c) => (c[0] as { readOnly?: boolean }).readOnly === true), name).toBe(true);
        expect(stackBase.readParent, name).toHaveBeenCalledTimes(1);
        expect(h.resume, name).not.toHaveBeenCalled();
        expect(await runs(t.w), name).toBe(before);
        expect((await admin.query("SELECT 1 FROM agent_runs WHERE work_item_id = $1 AND role = 'plane_publish'", [t.w])).rows, name).toEqual([]);
        expect(await codes(t.w), name).toEqual([["escalated", "republish_stack_parent_off_main"]]);
      }
    });

    it("a child still on its parent's branch, whose parent merged into another branch, is refused republish_stack_parent_off_main (not told to change its base to main), zero merges", async () => {
      for (const stage of parentRows) {
        const t = await stacked();
        await setParentStage(t, stage);
        const merges = vi.fn();
        const h = harness({ privateHead: async () => ASKED, syncBase: port(merges), stackBase: parentPort(async () => offMain) });
        expect(await h.module.advanceStartFix(who(t), fixReq(t)), stage).toEqual({ ok: false, reason: "republish_stack_parent_off_main" });
        expect(merges, stage).not.toHaveBeenCalled();
        expect(h.resume, stage).not.toHaveBeenCalled();
      }
    });

    it("the off-main sentence says the work would be published, names no step that publishes it (not Request changes, not a base of main) and carries no raw code", async () => {
      const t = await stacked();
      const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(vi.fn()), stackBase: parentPort(async () => offMain) });
      await h.module.advanceStartFix(who(t), fixReq(t));
      expect(await noticeOf(t)).toEqual({ kind: "needs_human", reason: REPUBLISH_STACK_PARENT_OFF_MAIN_SENTENCE });
      expect(REPUBLISH_STACK_PARENT_OFF_MAIN_SENTENCE).toMatch(/would publish it/);
      expect(REPUBLISH_STACK_PARENT_OFF_MAIN_SENTENCE).toMatch(/close this item and start the change again as a new item once that work is in main/);
      expect(REPUBLISH_STACK_PARENT_OFF_MAIN_SENTENCE).not.toMatch(/Press Request changes|Build again|null|undefined|republish_|base to main on GitHub/);
    });

    it("a retargeted child whose merged parent's base is not shown, or whose parent has no recorded pull request, is refused with the matching fixed code on every path", async () => {
      for (const [name, side, run] of rounds) {
        const t = await stacked(side);
        await setParentStage(t, "merged");
        const h = harness({ privateHead: async () => ASKED, syncBase: retargeted(vi.fn()), stackBase: parentPort(async () => ({ ...offMain, baseRef: "" })) });
        expect(await run(h, t), name).toEqual({ ok: false, reason: "base_sync_unavailable" });
        const n = await stacked(side, null);
        const hn = harness({ privateHead: async () => ASKED, syncBase: retargeted(vi.fn()), stackBase: parentPort(async () => openParent) });
        expect(await run(hn, n), name).toEqual({ ok: false, reason: "republish_stack_parent_no_pull_request" });
      }
    });

    it("the pull request's base is not the parent's branch the read found (a race between the two reads): refused republish_stacked_unsupported, zero merges", async () => {
      const t = await stacked();
      const merges = vi.fn();
      const syncBase = port(merges);
      const h = harness({ privateHead: async () => ASKED, syncBase, stackBase: parentPort(async () => ({ ...openParent, headRef: "fx/other" })) });
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "republish_stacked_unsupported" });
      expect(syncBase).toHaveBeenCalledTimes(1);
      expect(merges).not.toHaveBeenCalled();
      // The base changes between the parent read and the second sync: the port answers stacked again, and the round is refused with no merge.
      const u = await stacked();
      const hu = harness({ privateHead: async () => ASKED, syncBase: vi.fn(async (): Promise<BranchSyncOutcome> => ({ kind: "stacked", baseRef: "fx/parent" })), stackBase: parentPort(async () => openParent) });
      expect(await hu.module.advanceStartFix(who(u), fixReq(u))).toEqual({ ok: false, reason: "republish_stacked_unsupported" });
      expect(hu.resume).not.toHaveBeenCalled();
    });

    it("the refusal stands where the gate stays shut: a runner-side round, a conflict round, and a change with no recorded parent never read a parent", async () => {
      const stackBase = parentPort(async () => openParent);
      const merges = vi.fn();
      const runner = await stacked("runner");
      const hr = harness({ privateHead: async () => ASKED, syncBase: port(merges), stackBase });
      expect(await hr.module.advanceStartFix(who(runner), fixReq(runner))).toEqual({ ok: false, reason: "republish_stacked_unsupported" });
      const conflicting = await stacked();
      const hc = harness({ privateHead: async () => ASKED, syncBase: port(merges), stackBase });
      expect(await hc.module.advanceStartFix(who(conflicting), { kind: "conflict" as const, issue: conflicting.n, headSha: ASKED, prompt: "merge main", round: 1, actionId: randomUUID(), baseSha: "1".repeat(40), pr: { number: PR, branch: conflicting.branch } })).toEqual({ ok: false, reason: "republish_stacked_unsupported" });
      const orphan = await item("sandbox");
      await publicCopy(orphan);
      const ho = harness({ privateHead: async () => ASKED, syncBase: port(merges), stackBase });
      expect(await ho.module.advanceStartFix(who(orphan), fixReq(orphan))).toEqual({ ok: false, reason: "republish_stacked_unsupported" });
      expect(stackBase.readParent).not.toHaveBeenCalled();
      expect(merges).not.toHaveBeenCalled();
      for (const h of [hr, hc, ho]) expect(h.resume).not.toHaveBeenCalled();
    });

    it("a change on the default branch (the parent merged and the pull request was retargeted) is not stacked: the parent is read once for the branch it merged into (main), then the sync merges", async () => {
      const t = await stacked();
      await setParentStage(t, "merged");
      const stackBase = parentPort(async () => ({ ...closedOnGithub, merged: true }));
      const syncBase = vi.fn(async () => merged());
      const h = harness({ privateHead: async () => ASKED, syncBase, stackBase });
      expect((await h.module.advanceStartFix(who(t), fixReq(t))).ok).toBe(true);
      expect(syncBase).toHaveBeenCalledTimes(2);
      expect(stackBase.readParent).toHaveBeenCalledTimes(1);
    });
  });
});
