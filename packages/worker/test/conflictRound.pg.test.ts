import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BranchSyncOutcome } from "@fx/github";
import { insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceReviewDeps } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";
import { decideRound, fixRoundsStarted } from "@fx/pipeline";
import { maxFixRounds, checkFixRound } from "@fx/spend";
import { readOperatorFacts } from "@fx/core/src/work-items/operatorActions.js";

/**
 * D#519 MQ4-b [pg]: the `conflict` kind of a fix round. Real rows and real keys; the only fake is the pipeline's resume, which behaves as the real one does at
 * admit (a keyed run row, then `refused_spend` with the admit's reason), and the branch-sync port, which is a spy that would answer a conflict if it were
 * ever called (the contract of the real port: GitHub's merges endpoint answers 409). A conflict round must never reach it.
 */
describe("advance: the conflict fix-round kind [pg]", { timeout: 60_000 }, () => {
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
  const HEAD = "a".repeat(40);
  let nextNumber = 9700;
  let nextDiscussion = 970;
  const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;

  function harness(opts: { deny?: string } = {}) {
    const inputs: StartAgentRunInput[] = [];
    const resume = vi.fn(async (_pool: Pool, _registry: ExecutionTargetRegistry, input: StartAgentRunInput) => {
      inputs.push(input);
      const { id } = await insertAgentRun(writerPool, {
        id: randomUUID(),
        accountId: input.accountId,
        workItemId: input.workItemId,
        parentRunId: input.parentRunId,
        role: "executor",
        runtime: "production",
        executionMode: "sandbox",
        dispatchRepoId: input.repoId,
        dispatchPrNumber: input.pr ?? null,
        idempotency: input.idempotency,
      });
      if (opts.deny !== undefined) {
        await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "refused_spend", failureReason: opts.deny });
        return { id, status: "refused_spend", reason: opts.deny };
      }
      await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
      return { id, status: "running" };
    });
    const syncBase = vi.fn(async (): Promise<BranchSyncOutcome> => ({ kind: "conflict", baseSha: "f".repeat(40), baseRef: "main", stacked: false }));
    const review: AdvanceReviewDeps = { load: vi.fn(), recordRound: vi.fn(), resume, mergeGate: vi.fn() } as never;
    const starter: RunStarter = { async start() { throw new Error("a same-side round never starts a fresh session"); } };
    const deps: AdvanceModuleDeps = { starter, resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async () => undefined, triage: null, registry, review, fixHeads: { privateHead: async () => HEAD, publicHead: async () => "d".repeat(40), syncBase } };
    return { module: createAdvanceModule(writerPool, deps), inputs, resume, syncBase, resolveRunSeat: deps.resolveRunSeat };
  }

  async function item(a: SeedRefs, stage = "review_passed") {
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    const id = randomUUID();
    const n = nextNumber++;
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', $4, $5)", [id, a.accountId, a.repoId, stage, n]);
    const discussion = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')", [discussion, a.accountId, nextDiscussion++, id]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [discussion, id]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, id]);
    const spec = (await admin.query<{ id: string }>("SELECT id FROM spec_versions WHERE work_item_id = $1", [id])).rows[0]!.id;
    const { id: build } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId: id, specVersionId: spec, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: a.repoId, dispatchPrNumber: n });
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: build, from: "pending", to: "running" });
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: build, from: "running", to: "succeeded", result: { sessionId: "cc-session-1", envelope: { verdict: "done" } } });
    return { id, n, build };
  }
  const who = (a: SeedRefs, workItemId: string) => ({ accountId: a.accountId, userId: a.userId, workItemId, haltEpoch: 0 });
  const conflictReq = (t: { n: number }, over: Record<string, unknown> = {}) => ({ kind: "conflict" as const, issue: t.n, headSha: HEAD, prompt: "merge main", round: 1, actionId: randomUUID(), pr: { number: 41, branch: `fx/issue-${t.n}` }, ...over });
  const events = async (w: string) => (await admin.query<{ kind: string; code: string | null; round: number | null }>("SELECT kind, code, round FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq", [w])).rows;
  const stageOf = async (w: string) => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [w])).rows[0]!.stage;
  const stageMoves = async (w: string) => (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM work_item_transitions WHERE work_item_id = $1", [w])).rows[0]!.n;

  it("C6-b1: a conflict round resumes the build's session, makes no base-sync call, and needs no reviewer, failing run or person", async () => {
    const a = await seedAccount(admin, randomUUID());
    const t = await item(a);
    const h = harness();
    const out = await h.module.advanceStartFix(who(a, t.id), conflictReq(t));
    expect(out.ok).toBe(true);
    expect(h.syncBase).not.toHaveBeenCalled();
    expect(h.inputs).toHaveLength(1);
    // The continuation of the build's own run (the same session), carrying the prompt it was given, on the issue's number as the build used it.
    expect(h.inputs[0]).toMatchObject({ parentRunId: t.build, role: "executor", pr: t.n, prompt: expect.stringContaining("merge main") });
    expect(h.inputs[0]!.base).toBeUndefined();
    expect(h.inputs[0]!.idempotency!.key).toMatch(new RegExp(`^advance:${t.id}:fix:${HEAD}:[0-9a-f-]{36}:c1$`));
    expect((await events(t.id)).map((e) => e.kind)).toEqual(["fix_round_started"]);
  });

  it("C6-b8: the stage stays where it was during a conflict round (no move to changes_requested); a review round still moves it", async () => {
    const a = await seedAccount(admin, randomUUID());
    const t = await item(a);
    const h = harness();
    const before = await stageMoves(t.id);
    expect((await h.module.advanceStartFix(who(a, t.id), conflictReq(t))).ok).toBe(true);
    expect(await stageOf(t.id)).toBe("review_passed");
    expect(await stageMoves(t.id)).toBe(before);

    const b = await seedAccount(admin, randomUUID());
    const u = await item(b, "pr_opened");
    const control = harness();
    // The control: a review round on the same kind of item DOES call the sync (a conflict there goes to a person) and moves the stage.
    const review = await control.module.advanceStartFix(who(b, u.id), { issue: u.n, headSha: HEAD, prompt: "fix it", round: 1, actionId: randomUUID(), reviewer: "code", failingRunId: randomUUID(), pr: { number: 41, branch: `fx/issue-${u.n}` } });
    expect(control.syncBase).toHaveBeenCalledTimes(1);
    expect(review).toMatchObject({ ok: false, reason: expect.stringMatching(/base_sync_conflict|conflict/) });
  });

  it("a conflict round is not bounded by the review fix-round limit (its bound is the entry's rounds, checked by the caller)", async () => {
    const a = await seedAccount(admin, randomUUID());
    const t = await item(a);
    const h = harness();
    // A review round at this number is past the plan's limit; a conflict round at it is not.
    const review = await h.module.advanceStartFix(who(a, t.id), { issue: t.n, headSha: HEAD, prompt: "fix it", round: 20, actionId: randomUUID(), reviewer: "code", failingRunId: randomUUID() });
    expect(review).toEqual({ ok: false, reason: "max_fix_rounds" });
    expect((await h.module.advanceStartFix(who(a, t.id), conflictReq(t, { round: 20 }))).ok).toBe(true);
  });

  it("C7-2: conflict rounds do not use up review fix rounds: two conflict rounds, then a review finding, still leave the full review budget", async () => {
    const a = await seedAccount(admin, randomUUID());
    const t = await item(a);
    const h = harness();
    const finish = async (runId: string, session: string) => writeRunStatus(writerPool, { accountId: a.accountId, runId, from: "running", to: "succeeded", result: { sessionId: session, envelope: { verdict: "done" } } });
    const r1 = await h.module.advanceStartFix(who(a, t.id), conflictReq(t));
    expect(r1.ok).toBe(true);
    await finish((r1 as { runId: string }).runId, "cc-session-2");
    const r2 = await h.module.advanceStartFix(who(a, t.id), conflictReq(t, { round: 2, headSha: "b".repeat(40) }));
    expect(r2.ok).toBe(true);
    await finish((r2 as { runId: string }).runId, "cc-session-3");
    // Both conflict rounds are recorded, as the existing fact.
    expect((await events(t.id)).filter((e) => e.kind === "fix_round_started")).toHaveLength(2);

    // Every place the review side counts its rounds reads none of them: the reviewers' count, and the operator's Request changes bound.
    const reviewCount = () => fixRoundsStarted(writerPool, a.accountId, t.id);
    const needsFix = () => decideRound({ requiredRoles: ["code-reviewer"], verdicts: [{ role: "code-reviewer", verdict: "needs-fix" }], fixRoundsStarted: 0 });
    expect(needsFix()).toBe("fix");
    expect(await reviewCount()).toBe(0);
    expect((await readOperatorFacts(admin, t.id, "owner"))?.fix_rounds_started).toBe(0);

    // Review rounds are counted as they always were: the full plan budget is still there, and only the round past it escalates.
    for (let k = 1; k <= maxFixRounds(); k++) {
      const decision = decideRound({ requiredRoles: ["code-reviewer"], verdicts: [{ role: "code-reviewer", verdict: "needs-fix" }], fixRoundsStarted: await reviewCount() });
      expect(decision).toBe("fix");
      await admin.query(
        "INSERT INTO work_item_driver_events (account_id, work_item_id, kind, head_sha, round, dedupe_key) VALUES ($1, $2, 'fix_round_started', $3, $4, $5)",
        [a.accountId, t.id, "d".repeat(40), k, `fix:${"d".repeat(40)}:${randomUUID()}`],
      );
    }
    expect(await reviewCount()).toBe(maxFixRounds());
    expect((await readOperatorFacts(admin, t.id, "owner"))?.fix_rounds_started).toBe(maxFixRounds());
    expect(decideRound({ requiredRoles: ["code-reviewer"], verdicts: [{ role: "code-reviewer", verdict: "needs-fix" }], fixRoundsStarted: await reviewCount() })).toBe("escalated");
    expect(checkFixRound(maxFixRounds() + 1)).toBe("escalate");
  });

  it("each round of a conflict is its own run: the key carries the round, so a replay finds the run and the next round starts another", async () => {
    const a = await seedAccount(admin, randomUUID());
    const t = await item(a);
    const h = harness();
    const req = conflictReq(t);
    const first = await h.module.advanceStartFix(who(a, t.id), req);
    const again = await h.module.advanceStartFix(who(a, t.id), req);
    expect(first.ok && again.ok && first.runId === again.runId).toBe(true);
    expect(h.resume).toHaveBeenCalledTimes(1);
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: (first as { runId: string }).runId, from: "running", to: "succeeded", result: { sessionId: "cc-session-2", envelope: { verdict: "done" } } });
    const second = await h.module.advanceStartFix(who(a, t.id), { ...req, round: 2, headSha: "b".repeat(40) });
    expect(second.ok && second.runId !== (first as { runId: string }).runId).toBe(true);
    expect(h.inputs[1]!.parentRunId).toBe((first as { runId: string }).runId);
  });

  it("a conflict round that carries a reviewer, a failing run or a person's note is refused before anything is written", async () => {
    const a = await seedAccount(admin, randomUUID());
    const t = await item(a);
    const h = harness();
    for (const extra of [{ reviewer: "code" }, { failingRunId: randomUUID() }, { person: true }, { kind: "renumber" }]) {
      expect(await h.module.advanceStartFix(who(a, t.id), conflictReq(t, extra))).toEqual({ ok: false, reason: "invalid_input" });
    }
    expect(h.resume).not.toHaveBeenCalled();
    expect(await events(t.id)).toEqual([]);
  });

  it("a review round with no kind is today's round: it needs a reviewer and a failing run (or a person)", async () => {
    const a = await seedAccount(admin, randomUUID());
    const t = await item(a);
    const h = harness();
    expect(await h.module.advanceStartFix(who(a, t.id), { issue: t.n, headSha: HEAD, prompt: "p", round: 1, actionId: randomUUID() } as never)).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("C6-b4: a start refused for spend is answered as the denial and starts no run; the stage is unchanged", async () => {
    const a = await seedAccount(admin, randomUUID());
    const t = await item(a);
    const h = harness({ deny: "model_budget_exceeded" });
    expect(await h.module.advanceStartFix(who(a, t.id), conflictReq(t))).toEqual({ ok: false, reason: "model_budget_exceeded" });
    expect(await stageOf(t.id)).toBe("review_passed");
    expect((await events(t.id)).map((e) => e.kind)).toEqual([]);
  });

  it("a conflict round on an item with a public pull request is refused conflict_public_copy: no run, no stage move, nothing recorded", async () => {
    const a = await seedAccount(admin, randomUUID());
    const t = await item(a);
    // The record of what the platform pushed to the public repo for the item, with no person having taken it over.
    await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', $3) ON CONFLICT (repo_id) DO NOTHING", [a.repoId, a.accountId, ["private/**"]]);
    await admin.query(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state)
       VALUES ($1, $2, $3, 'acme/widgets-public', $4, $5, $6, 7, 'https://github.com/acme/widgets-public/pull/7', 'pr_opened')`,
      [a.accountId, t.id, a.repoId, "f".repeat(64), "d".repeat(40), "e".repeat(40)],
    );
    const h = harness();
    const before = await stageMoves(t.id);
    expect(await h.module.advanceStartFix(who(a, t.id), conflictReq(t))).toEqual({ ok: false, reason: "conflict_public_copy" });
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.syncBase).not.toHaveBeenCalled();
    expect(await stageOf(t.id)).toBe("review_passed");
    expect(await stageMoves(t.id)).toBe(before);
  });

  it("a stage that cannot take a fix round refuses the conflict round too", async () => {
    const a = await seedAccount(admin, randomUUID());
    const t = await item(a, "merged");
    const h = harness();
    expect(await h.module.advanceStartFix(who(a, t.id), conflictReq(t))).toMatchObject({ ok: false, reason: "stage_merged" });
    expect(h.resume).not.toHaveBeenCalled();
  });

  it("C6-b7 (sandbox): the round is resolved on the item's own execution mode and resumes the hosted sandbox on the issue's number", async () => {
    const a = await seedAccount(admin, randomUUID());
    const t = await item(a);
    const h = harness();
    await h.module.advanceStartFix(who(a, t.id), conflictReq(t, { expectedExecutionMode: "sandbox" }));
    expect(h.resolveRunSeat).toHaveBeenCalledWith(expect.objectContaining({ role: "executor", workItemId: t.id, expectedExecutionMode: "sandbox" }));
    expect(h.inputs[0]).toMatchObject({ pr: t.n, workdir: expect.any(String), expectedExecutionMode: "sandbox" });
    expect(h.inputs[0]).not.toHaveProperty("cloneRepo");
  });
});
