import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { applyMappedEvent, type ApplyEventCtx, type BranchSyncOutcome } from "@fx/github";
import { withTenant } from "@fx/db/src/withTenant.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { BASE_SYNC_CONFLICT_SENTENCE, BASE_SYNC_UNAVAILABLE_SENTENCE, REPUBLISH_STACKED_UNSUPPORTED_SENTENCE } from "@fx/core/src/work-items/baseSync.js";
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
});
