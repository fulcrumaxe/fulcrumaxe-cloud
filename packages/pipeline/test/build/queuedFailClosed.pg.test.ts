import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  QueuedRunNotSupportedError,
  createInMemoryHookChannel,
  startAgentRun,
  writeRunStatus,
  type ExecutionTargetRegistry,
  type StartAgentRunInput,
} from "@fx/runner";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { dispatchDebaterIfNeeded, dispatchReviewers, dispatchSpecReadyExecutor } from "../../src/build/stageMachine.js";
import { recordReviewVerdict } from "../../src/build/fixLoop.js";
import { continueAfterLimit } from "../../src/build/continuation.js";
import { createSandboxPanelRunner } from "../../src/plan/sandboxPanelRunner.js";
import { createFakeExecutionTarget } from "./helpers/fakeExecutionTarget.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#6 R3a (C12 section 2.1): the library callers of `startAgentRun` and `resumeAgentRun` fail closed when the target
 * queues the run for a runner. None treats it as started, waits on a hook that will never fire, or leaves it pending
 * for a runner to claim behind its back: the run is cancelled and the caller gets `QueuedRunNotSupportedError`.
 *
 * Each caller below runs against a fake target that answers `{ queued: true }`, the same answer `RunnerTarget` gives.
 */
describe("callers fail closed on a queued run [pg]", () => {
  const db = pgHarness();

  function input(repoId: string): Omit<StartAgentRunInput, "accountId" | "workItemId" | "role"> {
    return {
      repoId, pr: 7, product: "team", roleCard: "card", prompt: "p", model: "haiku-4.5", capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
  }

  async function seed() {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 7 });
    await withTenant(db.runWriterPool, accountId, async (c) => {
      for (const toStage of ["spec_ready", "in_progress"] as const) {
        await recordStage(c, { workItemId, toStage, at: new Date(), source: "control_plane", sourceRef: `seed-${toStage}` });
      }
    });
    const normal: ExecutionTargetRegistry = { sandbox: createFakeExecutionTarget().target };
    const queuedFake = createFakeExecutionTarget({ queued: true });
    const queued: ExecutionTargetRegistry = { sandbox: queuedFake.target };
    return { accountId, repoId, workItemId, normal, queued, queuedFake };
  }
  type Fx = Awaited<ReturnType<typeof seed>>;

  const statuses = async (f: Fx): Promise<string[]> =>
    (await db.admin.query<{ status: string }>(`SELECT status FROM agent_runs WHERE account_id = $1 ORDER BY created_at, id`, [f.accountId])).rows.map((r) => r.status);

  /** An executor run that ended with a checkpoint and a session, so it can be continued or resumed. */
  async function endedExecutor(f: Fx, role = "executor"): Promise<string> {
    const started = await startAgentRun(db.runWriterPool, f.normal, { ...input(f.repoId), accountId: f.accountId, workItemId: f.workItemId, role });
    if (started.status !== "running") throw new Error("test setup: dispatch failed");
    await writeRunStatus(db.runWriterPool, {
      accountId: f.accountId, runId: started.id, from: "running", to: "timed_out",
      result: { sessionId: "cc-owned" },
      checkpoint: { kind: "run_time", ccSessionId: "cc-forged", meteredUsd: 1, extensionsUsed: 0 },
    });
    return started.id;
  }

  it("dispatchSpecReadyExecutor: the build is cancelled, the stage does not move, and the caller is told", async () => {
    const f = await seed();
    await expect(dispatchSpecReadyExecutor(db.runWriterPool, f.queued, { accountId: f.accountId, workItemId: f.workItemId, executorInput: input(f.repoId) })).rejects.toThrow(QueuedRunNotSupportedError);
    expect(await statuses(f)).toEqual(["cancelled"]);
    expect((await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [f.workItemId])).rows[0].stage).toBe("in_progress");
  });

  it("dispatchSpecReadyExecutor from spec_ready: the item is not recorded in_progress for a run that never started", async () => {
    const f = await seed();
    const other = randomUUID();
    await seedWorkItem(db.admin, f.accountId, other, f.repoId, { ghNumber: 9 });
    await withTenant(db.runWriterPool, f.accountId, (c) => recordStage(c, { workItemId: other, toStage: "spec_ready", at: new Date(), source: "control_plane", sourceRef: "seed" }));
    await expect(dispatchSpecReadyExecutor(db.runWriterPool, f.queued, { accountId: f.accountId, workItemId: other, executorInput: { ...input(f.repoId), pr: 9 } })).rejects.toThrow(QueuedRunNotSupportedError);
    expect((await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [other])).rows[0].stage).toBe("spec_ready");
  });

  it("dispatchReviewers: the first review is cancelled and no later reviewer is started", async () => {
    const f = await seed();
    await expect(
      dispatchReviewers(db.runWriterPool, f.queued, {
        accountId: f.accountId, workItemId: f.workItemId, headSha: "sha-1", tier: "critical", securityDiffTriggerFired: false,
        buildInput: () => input(f.repoId),
      }),
    ).rejects.toThrow(QueuedRunNotSupportedError);
    expect(await statuses(f)).toEqual(["cancelled"]);
  });

  it("dispatchDebaterIfNeeded: the debate is cancelled", async () => {
    const f = await seed();
    await expect(
      dispatchDebaterIfNeeded(db.runWriterPool, f.queued, {
        accountId: f.accountId, workItemId: f.workItemId, headSha: "sha-1", tier: "feature", enabled: true,
        buildInput: () => input(f.repoId),
      }),
    ).rejects.toThrow(QueuedRunNotSupportedError);
    expect(await statuses(f)).toEqual(["cancelled"]);
  });

  it("recordReviewVerdict: a fix round queued for a runner is cancelled, not reported as dispatched", async () => {
    const f = await seed();
    const executor = await endedExecutor(f);
    await withTenant(db.runWriterPool, f.accountId, (c) => recordStage(c, { workItemId: f.workItemId, toStage: "pr_opened", at: new Date(), source: "control_plane", sourceRef: executor }));
    const review = await startAgentRun(db.runWriterPool, f.normal, { ...input(f.repoId), accountId: f.accountId, workItemId: f.workItemId, role: "code-reviewer", headSha: "sha-r1" });
    if (review.status !== "running") throw new Error("test setup: review dispatch failed");
    await expect(
      recordReviewVerdict(db.runWriterPool, f.queued, {
        accountId: f.accountId, workItemId: f.workItemId, role: "code-reviewer", runId: review.id, verdict: "needs-fix", resumeInput: input(f.repoId),
      }),
    ).rejects.toThrow(QueuedRunNotSupportedError);
    expect((await statuses(f)).at(-1)).toBe("cancelled");
  });

  it("continueAfterLimit: a continuation queued for a runner is cancelled, for the executor (a resume) and for another role (a start)", async () => {
    for (const role of ["executor", "project-manager"]) {
      const f = await seed();
      const prev = await endedExecutor(f, role);
      await expect(continueAfterLimit(db.runWriterPool, f.queued, { accountId: f.accountId, runId: prev, resumeInput: input(f.repoId) }), role).rejects.toThrow(QueuedRunNotSupportedError);
      expect((await statuses(f)).at(-1), role).toBe("cancelled");
    }
  });

  it("the panel runner: a seat queued for a runner is cancelled, its key is released, and the seat fails", async () => {
    const f = await seed();
    const channel = createInMemoryHookChannel();
    const runner = createSandboxPanelRunner({
      pool: db.runWriterPool,
      accountId: f.accountId,
      registry: f.queued,
      hookWait: channel.waitPort,
      pollMs: 10,
      resolveSeat: () => ({ ...input(f.repoId), repoId: f.repoId }),
    });
    const key = `panel:${randomUUID()}`;
    await expect(
      runner.runSeat({ workItemId: f.workItemId, discussionId: "d-1", role: "security-expert", round: 1, prompt: "say something", idempotencyKey: key } as never, new AbortController().signal),
    ).rejects.toThrow(QueuedRunNotSupportedError);
    expect(await statuses(f)).toEqual(["cancelled"]);
    expect((await db.admin.query(`SELECT 1 FROM agent_run_idempotency_keys WHERE account_id = $1`, [f.accountId])).rowCount).toBe(0);
  });

  it("the control: the same callers on a hook target are untouched (running, nothing cancelled)", async () => {
    const f = await seed();
    const dispatched = await dispatchReviewers(db.runWriterPool, f.normal, {
      accountId: f.accountId, workItemId: f.workItemId, headSha: "sha-1", tier: "small", securityDiffTriggerFired: false,
      buildInput: () => input(f.repoId),
    });
    expect(dispatched.map((d) => d.result.status)).toEqual(["running", "running"]);
    expect(await statuses(f)).toEqual(["running", "running"]);
  });
});
