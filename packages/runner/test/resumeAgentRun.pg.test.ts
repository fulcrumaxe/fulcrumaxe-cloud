import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startAgentRun, buildExecutionRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { insertAgentRun } from "../src/runStatusWriter.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { sandboxNameFor } from "../src/sandboxNaming.js";
import type { ExecutionTargetRegistry } from "../src/executionTarget.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";
import type { NormalizedEvent } from "../src/types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * D#2 H09b2 (C10's revised criterion 5, H09.9): "`resume` uses the same
 * sandbox name and `--resume <cc_session_id>` from `agent_runs`. When the
 * snapshot has expired (fake: `NotFound`), it falls back to a fresh
 * executor seeded with the PR diff." [pg]: real Postgres, zero model
 * tokens.
 */
describe("D#2 H09b2, H09.9: resume [pg]", () => {
  const db = pgHarness();

  async function seedExecutorFixture(): Promise<{ accountId: string; repoId: string; workItemId: string }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 7 });
    return { accountId, repoId, workItemId };
  }

  function executorInput(accountId: string, repoId: string, workItemId: string): StartAgentRunInput {
    return {
      accountId,
      repoId,
      workItemId,
      pr: 7,
      role: "executor",
      product: "team",
      roleCard: "executor role card",
      prompt: "implement it",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
  }

  it("cc_session_id is persisted on finalize, and a later resume uses the SAME sandbox name plus --resume <cc_session_id>", async () => {
    const { accountId, repoId, workItemId } = await seedExecutorFixture();
    const events: NormalizedEvent[] = [
      { runId: "placeholder", role: "executor", seq: 1, type: "assistant", ts: new Date().toISOString(), sessionId: "cc-session-42" },
    ];
    const harness = createSandboxTargetHarness(db.runWriterPool, events);
    const target = new SandboxTarget(harness.deps);
    const registry: ExecutionTargetRegistry = { sandbox: target };
    const input = executorInput(accountId, repoId, workItemId);

    const first = await startAgentRun(db.runWriterPool, registry, input);
    if (first.status !== "running") throw new Error(`test setup: expected "running", got "${first.status}"`);
    await sleep(20);
    const call = harness.hooks.calls.find((c) => c.hookToken === first.hookToken);
    if (!call) throw new Error("test setup: hook never resumed");
    expect(call.report.sessionId).toBe("cc-session-42");

    const run = buildExecutionRun(first.id, input);
    await target.finalize(run, call.report);

    const row = await db.admin.query(`SELECT cc_session_id, status FROM agent_runs WHERE id = $1`, [first.id]);
    expect(row.rows[0].cc_session_id).toBe("cc-session-42");
    expect(row.rows[0].status).toBe("succeeded"); // a non-error last event -> buildTerminalReport's "succeeded" branch

    // A fix round: a NEW run, resumed against the recorded session id.
    const resumeCalls: { sessionId: string; sandboxName: string }[] = [];
    const wrappedPort = {
      ...harness.deps.sandboxPort,
      resume: (handle: { sandboxName: string }, sessionId: string, prompt: string, opts: unknown) => {
        resumeCalls.push({ sessionId, sandboxName: handle.sandboxName });
        return harness.deps.sandboxPort.resume(
          handle as never,
          sessionId,
          prompt,
          opts as Parameters<typeof harness.deps.sandboxPort.resume>[3],
        );
      },
    };
    const resumeTarget = new SandboxTarget({ ...harness.deps, sandboxPort: wrappedPort });
    const second = await startAgentRun(db.runWriterPool, { sandbox: resumeTarget }, input);
    if (second.status !== "running") throw new Error(`test setup: expected "running" (dispatch), got "${second.status}"`);
    // The 2nd `startAgentRun` still DISPATCHED (fresh); simulate the caller
    // instead calling `resume` for a fix round on a NEW run row by cancelling
    // the dispatched one and building a third run that resumes.
    await resumeTarget.cancel(buildExecutionRun(second.id, input));

    const thirdId = randomUUID();
    const expectedSandboxName = sandboxNameFor({ role: "executor", runId: thirdId, accountId, repoId, pr: 7 });
    const thirdRun = buildExecutionRun(thirdId, input);
    // CS-2a: a resume marks its sandbox request on the run's own (pending) row, so the row must exist.
    await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [second.id]);
    await insertAgentRun(db.runWriterPool, {
      id: thirdId,
      accountId,
      workItemId,
      role: "executor",
      runtime: "production",
      executionMode: "sandbox",
      dispatchRepoId: repoId,
      dispatchPrNumber: 7,
    });
    await resumeTarget.resume(thirdRun, "cc-session-42");

    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]!.sessionId).toBe("cc-session-42");
    expect(resumeCalls[0]!.sandboxName).toBe(expectedSandboxName);
  });

  it("falls back to a fresh dispatch when the sandbox's snapshot is gone (SandboxNotFoundError)", async () => {
    const { accountId, repoId, workItemId } = await seedExecutorFixture();
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const input = executorInput(accountId, repoId, workItemId);
    const sandboxName = sandboxNameFor({ role: "executor", runId: "unused-for-persistent-roles", accountId, repoId, pr: 7 });
    harness.fakeSandbox.failResumeWithNotFound(sandboxName);

    const target = new SandboxTarget(harness.deps);
    const { id: runId } = await insertAgentRun(db.runWriterPool, {
      id: randomUUID(),
      accountId,
      workItemId,
      role: "executor",
      runtime: "production",
      executionMode: "sandbox",
      dispatchRepoId: repoId,
      dispatchPrNumber: 7,
    });
    const run = buildExecutionRun(runId, input);
    // admit first, matching startAgentRun's own order -- resume() does not
    // itself call admit.
    await target.admit(run, db.admin);

    const { hookToken } = await target.resume(run, "some-expired-session-id");
    expect(typeof hookToken).toBe("string");
    // The fallback path is `dispatch`, which DOES call `createSandbox` --
    // proving the fallback actually ran, not just that `resume` itself
    // didn't throw.
    expect(harness.fakeSandbox.state.created.some((c) => c.sandboxName === sandboxName)).toBe(true);
  });
});
