import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInMemoryHookChannel, startAgentRun, writeRunStatus, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { dispatchDebaterIfNeeded, dispatchReviewers, dispatchSpecReadyExecutor } from "../../src/build/stageMachine.js";
import { recordReviewVerdict } from "../../src/build/fixLoop.js";
import { continueAfterLimit } from "../../src/build/continuation.js";
import { resumeAgentRun } from "../../src/build/resumeAgentRun.js";
import { createSandboxPanelRunner } from "../../src/plan/sandboxPanelRunner.js";
import { createFakeExecutionTarget } from "./helpers/fakeExecutionTarget.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#2 RLR-5: a run is handed to the slice follower only when its caller says so, and only the run starter that also starts the follower does. Every library caller
 * below dispatches or resumes a run through the target; none of the runs it hands the target carries the opt-in, so with a reader configured they are all read in the
 * invocation that starts them, as before. (The fake target answers the way a runner target does, so each call ends in the caller's fail-closed path; what is checked
 * is the run the target was handed.)
 */
describe("no library caller opts in to slice reading [pg]", () => {
  const db = pgHarness();

  function input(repoId: string): Omit<StartAgentRunInput, "accountId" | "workItemId" | "role"> {
    return { repoId, pr: 7, product: "team", roleCard: "card", prompt: "p", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" } };
  }

  async function seed() {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 7 });
    await withTenant(db.runWriterPool, accountId, async (c) => {
      for (const toStage of ["spec_ready", "in_progress"] as const) await recordStage(c, { workItemId, toStage, at: new Date(), source: "control_plane", sourceRef: `seed-${toStage}` });
    });
    const normal: ExecutionTargetRegistry = { sandbox: createFakeExecutionTarget().target };
    const fake = createFakeExecutionTarget({ queued: true });
    return { accountId, repoId, workItemId, normal, fake, queued: { sandbox: fake.target } as ExecutionTargetRegistry };
  }
  type Fx = Awaited<ReturnType<typeof seed>>;

  async function endedExecutor(f: Fx, role = "executor"): Promise<string> {
    const started = await startAgentRun(db.runWriterPool, f.normal, { ...input(f.repoId), accountId: f.accountId, workItemId: f.workItemId, role });
    if (started.status !== "running") throw new Error("test setup: dispatch failed");
    await writeRunStatus(db.runWriterPool, { accountId: f.accountId, runId: started.id, from: "running", to: "timed_out", result: { sessionId: "cc-owned" }, checkpoint: { kind: "run_time", ccSessionId: "cc-forged", meteredUsd: 1, extensionsUsed: 0 } });
    return started.id;
  }

  const handed = (f: Fx): Array<{ method: string; slice: unknown }> => f.fake.calls.filter((c) => c.method === "dispatch" || c.method === "resume").map((c) => ({ method: c.method, slice: c.run.slice }));
  const swallow = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined);

  it("the stage machine's executor, reviewer and debater starts", async () => {
    const f = await seed();
    await swallow(dispatchSpecReadyExecutor(db.runWriterPool, f.queued, { accountId: f.accountId, workItemId: f.workItemId, executorInput: input(f.repoId) }));
    await swallow(dispatchReviewers(db.runWriterPool, f.queued, { accountId: f.accountId, workItemId: f.workItemId, headSha: "sha-1", tier: "critical", securityDiffTriggerFired: false, buildInput: () => input(f.repoId) }));
    await swallow(dispatchDebaterIfNeeded(db.runWriterPool, f.queued, { accountId: f.accountId, workItemId: f.workItemId, headSha: "sha-1", tier: "feature", enabled: true, buildInput: () => input(f.repoId) }));
    const calls = handed(f);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((c) => c.slice === undefined)).toBe(true);
  });

  it("the fix loop's resume, and a continuation after a limit (a resume for the executor, a start for another role)", async () => {
    const f = await seed();
    const executor = await endedExecutor(f);
    await withTenant(db.runWriterPool, f.accountId, (c) => recordStage(c, { workItemId: f.workItemId, toStage: "pr_opened", at: new Date(), source: "control_plane", sourceRef: executor }));
    const review = await startAgentRun(db.runWriterPool, f.normal, { ...input(f.repoId), accountId: f.accountId, workItemId: f.workItemId, role: "code-reviewer", headSha: "sha-r1" });
    if (review.status !== "running") throw new Error("test setup: review dispatch failed");
    await swallow(recordReviewVerdict(db.runWriterPool, f.queued, { accountId: f.accountId, workItemId: f.workItemId, role: "code-reviewer", runId: review.id, verdict: "needs-fix", resumeInput: input(f.repoId) }));
    const g = await seed();
    const prev = await endedExecutor(g);
    await swallow(continueAfterLimit(db.runWriterPool, g.queued, { accountId: g.accountId, runId: prev, resumeInput: input(g.repoId) }));
    const h = await seed();
    const prevPm = await endedExecutor(h, "project-manager");
    await swallow(continueAfterLimit(db.runWriterPool, h.queued, { accountId: h.accountId, runId: prevPm, resumeInput: input(h.repoId) }));
    for (const x of [f, g, h]) {
      expect(handed(x).length, "each caller reached the target").toBeGreaterThan(0);
      expect(handed(x).every((c) => c.slice === undefined)).toBe(true);
    }
    expect(handed(f).some((c) => c.method === "resume") || handed(g).some((c) => c.method === "resume")).toBe(true);
  });

  it("the panel runner's seat", async () => {
    const f = await seed();
    const channel = createInMemoryHookChannel();
    const runner = createSandboxPanelRunner({ pool: db.runWriterPool, accountId: f.accountId, registry: f.queued, hookWait: channel.waitPort, pollMs: 10, resolveSeat: () => ({ ...input(f.repoId), repoId: f.repoId }) });
    await swallow(runner.runSeat({ workItemId: f.workItemId, discussionId: "d-1", role: "security-expert", round: 1, prompt: "say something", idempotencyKey: `panel:${randomUUID()}` } as never, new AbortController().signal));
    expect(handed(f).length).toBeGreaterThan(0);
    expect(handed(f).every((c) => c.slice === undefined)).toBe(true);
  });

  it("the library's own start: a run started with `startAgentRun` and no opt-in carries none, and one that sets it carries exactly that", async () => {
    const f = await seed();
    await startAgentRun(db.runWriterPool, f.normal, { ...input(f.repoId), accountId: f.accountId, workItemId: f.workItemId, role: "code-reviewer" });
    const own = createFakeExecutionTarget();
    await startAgentRun(db.runWriterPool, { sandbox: own.target }, { ...input(f.repoId), accountId: f.accountId, workItemId: f.workItemId, role: "code-reviewer" });
    await startAgentRun(db.runWriterPool, { sandbox: own.target }, { ...input(f.repoId), accountId: f.accountId, workItemId: f.workItemId, role: "code-reviewer", slice: true });
    expect(own.calls.filter((c) => c.method === "dispatch").map((c) => c.run.slice)).toEqual([undefined, true]);
  });

  it("resumeAgentRun passes the command's start on when the target hands the run over, and says nothing when it does not", async () => {
    const f = await seed();
    await endedExecutor(f);
    const fake = createFakeExecutionTarget();
    const handing: ExecutionTargetRegistry = { sandbox: { ...fake.target, resume: async () => ({ hookToken: "t-1", startedMs: 1_700_000_000_123 }) } };
    const out = await resumeAgentRun(db.runWriterPool, handing, { ...input(f.repoId), accountId: f.accountId, workItemId: f.workItemId, role: "executor" });
    expect(out).toMatchObject({ status: "running", hookToken: "t-1", startedMs: 1_700_000_000_123 });
    const g = await seed();
    await endedExecutor(g);
    const plain = await resumeAgentRun(db.runWriterPool, { sandbox: createFakeExecutionTarget().target }, { ...input(g.repoId), accountId: g.accountId, workItemId: g.workItemId, role: "executor" });
    expect(plain).toMatchObject({ status: "running" });
    expect("startedMs" in plain).toBe(false);
  });
});
