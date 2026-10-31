import { sandboxRunBranch } from "@fx/core/src/work-items/buildIdentity.js";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CATALOGUE } from "@fx/decisions";
import { insertAgentRun, writeRunStatus, PREVIEW_WORKDIR, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { answerAsk } from "@fx/core/src/decisions/answer.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceReviewDeps, type AdvanceStartArgs } from "../src/advance.js";
import { upToDateHeads } from "./withIssuePr.js";
import { buildDecisionSnapshot, writeDecisionSnapshot } from "../src/decisionSnapshot.js";
import { createDecisionIntake } from "../src/decisionIntake.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";
import { createResumeModule } from "../src/resumeDecision.js";

/**
 * [pg] D#7 DP11c, the parked FIX ROUND resumed through the real fix start (`advanceStartFix`), not a re-implementation of it.
 *   - The first fix round is started by the real fix start (Spec "unchanged" prompt, the held pin), which moves the item to Changes requested and records
 *     `fix_round_started` for the run.
 *   - It ends succeeded asking a question; the real decision intake parks it; the answer asks for the resume.
 *   - The resume starts through the same real fix start. The only fake is the pipeline's `resumeAgentRun` (the call that continues the PR's persistent sandbox and
 *     session), which records exactly what it is given. That is where "same branch and PR" is proved: it is given the pull request's ISSUE number (which names the
 *     sandbox), the PARKED run as the session it continues, a working directory with NO clone, and a prompt with the Spec body.
 */
const INVOKER_LOGIN = "fx_resume_fix_invoker_test";
// Not reversal_over_cap: an answer to that ask is never a resume (D#7 DP7-2e, R4), so it cannot stand in for an ordinary class 3 ask here.
const CLASS3 = CATALOGUE.find((e) => e.class === "human_in_the_loop" && e.id !== "reversal_over_cap")!.id;
const OPTIONS = [
  { id: "keep", label: "Keep the current shape" },
  { id: "split", label: "Split it in two" },
];
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
const SPEC_BODY = "Build the widget exactly as described.";
const SPEC_SHA = createHash("sha256").update(SPEC_BODY).digest("hex");
const HEAD = "d".repeat(40);

describe("a parked fix round resumes through the real fix start [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let runnerPool: Pool;
  const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;
  let nextNumber = 7300;
  let nextDiscussion = 7300;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
    runnerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, receiptPool, runnerPool]) await p.end();
  });

  /** The pipeline's resume as the real one is at the data layer: a keyed run row with the start prompt kept, the Spec pin inherited from the session's run. */
  function resumeFake(deny?: string) {
    const inputs: StartAgentRunInput[] = [];
    const fn = vi.fn(async (_pool: Pool, _registry: ExecutionTargetRegistry, input: StartAgentRunInput) => {
      inputs.push(input);
      const { id } = await insertAgentRun(runnerPool, {
        id: randomUUID(),
        accountId: input.accountId,
        workItemId: input.workItemId,
        parentRunId: input.parentRunId,
        specParentRunId: input.parentRunId ?? null,
        role: "executor",
        runtime: "production",
        executionMode: "sandbox",
        dispatchRepoId: input.repoId,
        dispatchPrNumber: input.pr ?? null,
        idempotency: input.idempotency,
        startPrompt: input.prompt,
        inCreateTransaction: async (client, runId) => {
          await writeDecisionSnapshot(client, runId, buildDecisionSnapshot({ role: "executor", dials: new Map(), declared: [CLASS3] }));
        },
      });
      if (deny !== undefined) {
        await writeRunStatus(runnerPool, { accountId: input.accountId, runId: id, from: "pending", to: "refused_spend", failureReason: deny });
        return { id, status: "refused_spend", reason: deny };
      }
      await writeRunStatus(runnerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
      return { id, status: "running" };
    });
    return { fn, inputs };
  }
  function advanceWith(resume: ReturnType<typeof resumeFake>["fn"]) {
    const review: AdvanceReviewDeps = {
      load: vi.fn(async () => ({ ok: false as const, reason: "unused" })),
      recordRound: vi.fn(async () => ({ decision: "all_passed", round: 0, recorded: [] })) as never,
      resume,
      mergeGate: vi.fn(async () => ({ outcome: "merged", headSha: HEAD, reasons: [], status: "posted" })),
    };
    const starter: RunStarter = { async start() { return { runId: randomUUID() }; } };
    const deps: AdvanceModuleDeps = { starter, resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async () => undefined, triage: null, registry, review, fixHeads: upToDateHeads(HEAD) };
    return createAdvanceModule(runnerPool, deps);
  }

  /** An item at PR opened whose build ran in a persistent session, pinned to a Spec version. */
  async function item(a: SeedRefs) {
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    const id = randomUUID();
    const ghNumber = nextNumber++;
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'pr_opened', $4)", [id, a.accountId, a.repoId, ghNumber]);
    const discussion = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')", [discussion, a.accountId, nextDiscussion++, id]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [discussion, id]);
    const spec = randomUUID();
    await admin.query("INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, $3, 1, $4, $5, 'system')", [spec, a.accountId, id, SPEC_BODY, SPEC_SHA]);
    const { id: buildId } = await insertAgentRun(runnerPool, { id: randomUUID(), accountId: a.accountId, workItemId: id, specVersionId: spec, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: a.repoId, dispatchPrNumber: ghNumber });
    await writeRunStatus(runnerPool, { accountId: a.accountId, runId: buildId, from: "pending", to: "running" });
    await writeRunStatus(runnerPool, { accountId: a.accountId, runId: buildId, from: "running", to: "succeeded", result: { sessionId: "cc-session-build", envelope: { verdict: "done" } } });
    return { id, ghNumber, buildId };
  }

  const FIX_PROMPT = `You are the executor. The reviewers asked for changes.\n\nSpec v1 unchanged (sha256 ${SPEC_SHA})\n\nREVIEWER FINDINGS:\n- handle the empty list`;
  const FIX_PROMPT_WITH_BODY = `You are the executor. The reviewers asked for changes.\n\nSPEC (version 1):\n${SPEC_BODY}\n\nREVIEWER FINDINGS:\n- handle the empty list`;

  /** The first fix round (the real fix start), ended succeeded with a question, parked by the real intake. */
  async function parkedFixRound(a: SeedRefs) {
    const w = await item(a);
    const first = resumeFake();
    const advance = advanceWith(first.fn);
    const who = { accountId: a.accountId, userId: a.userId, workItemId: w.id, haltEpoch: 0 };
    const failingRunId = randomUUID();
    const started = await advance.advanceStartFix(who, {
      issue: w.ghNumber,
      headSha: HEAD,
      prompt: FIX_PROMPT,
      held: { version: 1, sha256: SPEC_SHA },
      fallbackPrompt: FIX_PROMPT_WITH_BODY,
      round: 1,
      actionId: randomUUID(),
      reviewer: "security",
      failingRunId,
      expectedExecutionMode: "sandbox",
      pr: { number: 41, branch: `fx/issue-${w.ghNumber}` },
    });
    if (!started.ok) throw new Error(`the first fix round was refused: ${started.reason}`);
    await writeRunStatus(runnerPool, {
      accountId: a.accountId,
      runId: started.runId,
      from: "running",
      to: "succeeded",
      result: { sessionId: "cc-session-fix", envelope: { verdict: "done", decision_request: { type: "d1", options: OPTIONS, proposed: "keep", rationale: "Smaller diff, same behaviour." } } },
    });
    const intake = createDecisionIntake({ runnerPool, receiptPool, declared: () => [CLASS3] });
    expect(await intake({ accountId: a.accountId, workItemId: w.id, haltEpoch: 0, runId: started.runId })).toBe("parked");
    const askId = (await admin.query<{ id: string }>("SELECT id FROM decision_asks WHERE run_id = $1", [started.runId])).rows[0]!.id;
    return { ...w, a, parkedRunId: started.runId, askId, failingRunId };
  }
  const answer = (a: SeedRefs, askId: string, choice: string) => answerAsk({ pool: receiptPool, principal: { accountId: a.accountId, userId: a.userId } }, { askId, choice });
  async function claimed(askId: string): Promise<string> {
    const r = (await admin.query("SELECT id FROM run_action_requests WHERE kind = 'resume_decision' AND target_id = $1", [askId])).rows[0];
    await admin.query("UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '5 minutes', attempts = attempts + 1 WHERE id = $1", [r.id]);
    return r.id;
  }
  function resumeModule(resume: ReturnType<typeof resumeFake>["fn"]) {
    const follows: AdvanceStartArgs[] = [];
    const advance = advanceWith(resume);
    const module = createResumeModule(runnerPool, {
      startRun: advance.advanceStartRun,
      startFix: advance.advanceStartFix,
      startAdvance: async (args) => void follows.push(args),
    });
    return { module, follows };
  }

  it("continues the pull request's own sandbox and session (the parked run), names the sandbox by the issue number, clones nothing, carries the Spec body once, and counts as a started round", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await parkedFixRound(a);
    expect((await admin.query("SELECT stage FROM work_items WHERE id = $1", [w.id])).rows[0].stage).toBe("changes_requested");
    await answer(a, w.askId, "split");
    const second = resumeFake();
    const { module, follows } = resumeModule(second.fn);
    const actionId = await claimed(w.askId);
    const out = await module.performResumeDecision(actionId);
    expect(out).toMatchObject({ result: "done", outcome: { work_item_id: w.id, cause: "decision_resolved" } });

    expect(second.inputs).toHaveLength(1);
    const input = second.inputs[0]!;
    // the session it continues is the parked fix run's; the sandbox is the one the issue number names; there is no clone and no new branch or pull request
    expect(input.parentRunId).toBe(w.parkedRunId);
    expect(input.pr).toBe(w.ghNumber);
    expect(input.workdir).toBe(PREVIEW_WORKDIR);
    expect(input.cloneRepo).toBeUndefined();
    expect(input.continues).toBeUndefined();
    expect(input.role).toBe("executor");
    expect(input.expectedExecutionMode).toBe("sandbox");
    // the prompt: the Spec body is back (the parked prompt only said "unchanged"), the findings and the pull request instructions are the round's own, one resume block
    expect(input.prompt).toContain(`SPEC (version 1):`);
    expect(input.prompt).toContain(SPEC_BODY);
    expect(input.prompt).not.toContain("unchanged");
    expect(input.prompt).toContain("REVIEWER FINDINGS:\n- handle the empty list");
    expect(input.prompt.match(/Resume context, from the orchestrator/g)).toHaveLength(1);
    expect(input.prompt).toContain("cause: decision_resolved\noption: split");
    expect(input.idempotency!.key).toBe(`advance:${w.id}:fix:${HEAD}:${actionId}`);

    // the resumed run is a new run linked to the parked one, the parked run stays ended, and the fix start counted the round it started
    const runs = (await admin.query("SELECT id, status, parent_run_id, spec_version_id FROM agent_runs WHERE work_item_id = $1 AND role = 'executor' ORDER BY created_at", [w.id])).rows;
    expect(runs.map((r) => r.status)).toEqual(["succeeded", "succeeded", "running"]);
    expect(runs[2]).toMatchObject({ parent_run_id: w.parkedRunId });
    expect(runs[2].spec_version_id).toBe(runs[1].spec_version_id);
    expect((await admin.query("SELECT count(*)::int AS n FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'fix_round_started'", [w.id])).rows[0].n).toBe(2);
    expect((await admin.query("SELECT round FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'fix_round_started' ORDER BY seq DESC LIMIT 1", [w.id])).rows[0].round).toBe(1);
    expect(follows).toEqual([expect.objectContaining({ workItemId: w.id, actionId, resumeRunId: runs[2].id, specVersion: 1 })]);

    // performing again starts nothing more
    expect(await module.performResumeDecision(actionId)).toEqual(out);
    expect(second.inputs).toHaveLength(1);
  });

  it("SANDBOX-RERUN-BRANCH-a criterion 6: resuming a parked fix round on an item built twice continues the pull request on run 2's branch (the open one), not the fixed name", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await parkedFixRound(a);
    // Run 1 (older) was on the fixed name; the build that opened the pull request is run 2, on its own run branch. Both recorded it when they started.
    const older = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, created_at) VALUES ($1, $2, $3, 'executor', 'production', 'failed', now() - interval '1 hour')", [older, a.accountId, w.id]);
    await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'build.branch', $3::jsonb)", [a.accountId, older, JSON.stringify({ branch: `fx/issue-${w.ghNumber}` })]);
    const runBranch = sandboxRunBranch(w.buildId);
    await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 90, 'build.branch', $3::jsonb)", [a.accountId, w.buildId, JSON.stringify({ branch: runBranch })]);
    await answer(a, w.askId, "split");
    const sent: Array<{ pr?: { number: number; branch: string } }> = [];
    const advance = advanceWith(resumeFake().fn);
    const module = createResumeModule(runnerPool, { startRun: advance.advanceStartRun, startFix: (who, req) => (sent.push(req as never), advance.advanceStartFix(who, req)), startAdvance: async () => undefined });
    const out = await module.performResumeDecision(await claimed(w.askId));
    expect(out).toMatchObject({ result: "done" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.pr).toEqual({ number: 41, branch: runBranch });
  });

  it("a second resume of the same round does not stack the first one's block", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await parkedFixRound(a);
    await answer(a, w.askId, "keep");
    const second = resumeFake();
    const { module } = resumeModule(second.fn);
    await module.performResumeDecision(await claimed(w.askId));
    expect(second.inputs[0]!.prompt.match(/Resume context, from the orchestrator/g)).toHaveLength(1);
    // the resumed run itself asks and is answered: its stored prompt already ends in a block
    const resumedId = (await admin.query<{ id: string }>("SELECT id FROM agent_runs WHERE parent_run_id = $1", [w.parkedRunId])).rows[0]!.id;
    await writeRunStatus(runnerPool, {
      accountId: a.accountId,
      runId: resumedId,
      from: "running",
      to: "succeeded",
      result: { sessionId: "cc-session-resumed", envelope: { verdict: "done", decision_request: { type: "d1", options: OPTIONS, proposed: "keep", rationale: "Again." } } },
    });
    const intake = createDecisionIntake({ runnerPool, receiptPool, declared: () => [CLASS3] });
    expect(await intake({ accountId: a.accountId, workItemId: w.id, haltEpoch: 0, runId: resumedId })).toBe("parked");
    const askId2 = (await admin.query<{ id: string }>("SELECT id FROM decision_asks WHERE run_id = $1", [resumedId])).rows[0]!.id;
    await answer(a, askId2, "split");
    const third = resumeFake();
    const m3 = resumeModule(third.fn);
    expect(await m3.module.performResumeDecision(await claimed(askId2))).toMatchObject({ result: "done" });
    const prompt = third.inputs[0]!.prompt;
    expect(prompt.match(/Resume context, from the orchestrator/g)).toHaveLength(1);
    expect(prompt).toContain("option: split");
    expect(prompt).not.toContain("option: keep");
    expect(third.inputs[0]!.parentRunId).toBe(resumedId);
  });

  it("a spending limit that denies the resumed round is a pause, not a refusal; the next attempt is a new key and starts", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await parkedFixRound(a);
    await answer(a, w.askId, "keep");
    const denied = resumeFake("model_budget_exceeded");
    const d = resumeModule(denied.fn);
    const actionId = await claimed(w.askId);
    await expect(d.module.performResumeDecision(actionId)).rejects.toMatchObject({ name: "ResumePausedError" });
    expect((await admin.query("SELECT kind FROM work_item_driver_events WHERE work_item_id = $1 AND kind IN ('fix_round_refused', 'resume_refused')", [w.id])).rows).toEqual([]);
    await admin.query("UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '5 minutes' WHERE id = $1", [actionId]);
    const ok = resumeFake();
    const o = resumeModule(ok.fn);
    expect(await o.module.performResumeDecision(actionId)).toMatchObject({ result: "done" });
    expect(ok.inputs[0]!.idempotency!.key).toBe(`advance:${w.id}:fix:${HEAD}:${actionId}:s1`);
  });
});
