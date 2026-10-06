import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExecutionTargetRegistry, StartAgentRunInput } from "@fx/runner";
import { DuplicateExecutorRunError, startAgentRun, writeRunStatus } from "@fx/runner";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { dispatchSpecReadyExecutor } from "../../src/build/stageMachine.js";
import { recordReviewVerdict, maxFixRounds } from "../../src/build/fixLoop.js";
import { NEEDS_FIX_LABEL, ROLE_PASS_LABEL } from "../../src/build/verdictLabels.js";
import { createFakeExecutionTarget } from "./helpers/fakeExecutionTarget.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#2 H14a criteria 1 and 2, replayed end to end against real Postgres,
 * fixture-only (zero model tokens -- `FX_FORBID_MODEL_CALLS=1` is set for
 * the whole suite by packages/test-guard's setup file):
 *
 *   SPEC_READY -> executor -> PR opened -> code-reviewer needs-fix (x3,
 *   each resuming the SAME executor session) -> escalation on the round after the limit
 *   round (criterion 2), and a separate passing path ending in
 *   `review_passed` with the `code-review-passed` label (criterion 1).
 */
describe("H14a fix loop [pg]", () => {
  const db = pgHarness();

  function baseInput(overrides: Partial<StartAgentRunInput> = {}): Omit<StartAgentRunInput, "accountId" | "workItemId" | "role"> {
    return {
      repoId: overrides.repoId as string,
      pr: 7,
      product: "team",
      roleCard: "fixture role card",
      prompt: "fixture prompt",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
      ...overrides,
    };
  }

  async function seedFixture(): Promise<{ accountId: string; repoId: string; workItemId: string; registry: ExecutionTargetRegistry }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 7 });
    await withTenant(db.runWriterPool, accountId, (client) =>
      recordStage(client, { workItemId, toStage: "spec_ready", at: new Date(), source: "control_plane", sourceRef: "fixture-seed" }),
    );
    const { target } = createFakeExecutionTarget();
    return { accountId, repoId, workItemId, registry: { sandbox: target } };
  }

  async function stageOf(accountId: string, workItemId: string): Promise<string> {
    const { rows } = await db.admin.query<{ stage: string }>(
      `SELECT stage FROM work_items WHERE account_id = $1 AND id = $2`,
      [accountId, workItemId],
    );
    return rows[0]!.stage;
  }

  it("SPEC_READY -> executor dispatch records in_progress", async () => {
    const { accountId, repoId, workItemId, registry } = await seedFixture();
    const result = await dispatchSpecReadyExecutor(db.runWriterPool, registry, {
      accountId,
      workItemId,
      executorInput: baseInput({ repoId }),
    });
    expect(result.status).toBe("running");
    expect(await stageOf(accountId, workItemId)).toBe("in_progress");
  });

  it("a second executor dispatch for the same PR returns already_dispatched (the first run's id), starts nothing, and records nothing", async () => {
    const { accountId, repoId, workItemId } = await seedFixture();
    const { target, calls } = createFakeExecutionTarget();
    const registry: ExecutionTargetRegistry = { sandbox: target };
    const input = { accountId, workItemId, executorInput: baseInput({ repoId }) };

    const first = await dispatchSpecReadyExecutor(db.runWriterPool, registry, input);
    if (first.status !== "running") throw new Error("test setup: expected the first dispatch to be running");
    const second = await dispatchSpecReadyExecutor(db.runWriterPool, registry, input);

    expect(second).toEqual({ status: "already_dispatched", id: first.id });
    expect(calls.filter((c) => c.method === "dispatch")).toHaveLength(1);
    const runs = await db.admin.query(`SELECT 1 FROM agent_runs WHERE work_item_id = $1 AND role = 'executor'`, [workItemId]);
    expect(runs.rowCount).toBe(1);
    const inProgress = await db.admin.query(
      `SELECT 1 FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'in_progress'`,
      [workItemId],
    );
    expect(inProgress.rowCount).toBe(1);
  });

  async function secondItemOnSamePr(accountId: string, repoId: string): Promise<string> {
    const otherItemId = randomUUID();
    await seedWorkItem(db.admin, accountId, otherItemId, repoId, { ghNumber: 8 });
    await withTenant(db.runWriterPool, accountId, (client) =>
      recordStage(client, { workItemId: otherItemId, toStage: "spec_ready", at: new Date(), source: "control_plane", sourceRef: "fixture-seed" }),
    );
    return otherItemId;
  }

  it("a duplicate caused by ANOTHER work item's live executor on the same PR is not reported as this item's: the error is rethrown", async () => {
    const { accountId, repoId, workItemId, registry } = await seedFixture();
    const otherItemId = await secondItemOnSamePr(accountId, repoId);
    const other = await dispatchSpecReadyExecutor(db.runWriterPool, registry, { accountId, workItemId: otherItemId, executorInput: baseInput({ repoId }) });
    expect(other.status).toBe("running");

    await expect(
      dispatchSpecReadyExecutor(db.runWriterPool, registry, { accountId, workItemId, executorInput: baseInput({ repoId }) }),
    ).rejects.toThrow(DuplicateExecutorRunError);
    expect((await db.admin.query(`SELECT 1 FROM agent_runs WHERE work_item_id = $1 AND role = 'executor'`, [workItemId])).rowCount).toBe(0);
    expect(await stageOf(accountId, workItemId)).toBe("spec_ready");
  });

  it("this item's own FINISHED executor is not reported as already_dispatched when another item's live one causes the duplicate", async () => {
    const { accountId, repoId, workItemId, registry } = await seedFixture();
    const first = await dispatchSpecReadyExecutor(db.runWriterPool, registry, { accountId, workItemId, executorInput: baseInput({ repoId }) });
    if (first.status !== "running") throw new Error("test setup: expected running");
    await writeRunStatus(db.runWriterPool, { accountId, runId: first.id, from: "running", to: "succeeded", result: { sessionId: "cc-done", envelope: { verdict: "done" } } });
    const otherItemId = await secondItemOnSamePr(accountId, repoId);
    const other = await dispatchSpecReadyExecutor(db.runWriterPool, registry, { accountId, workItemId: otherItemId, executorInput: baseInput({ repoId }) });
    expect(other.status).toBe("running");

    await expect(
      dispatchSpecReadyExecutor(db.runWriterPool, registry, { accountId, workItemId, executorInput: baseInput({ repoId }) }),
    ).rejects.toThrow(DuplicateExecutorRunError);
  });

  it("a finished executor on another PR does not make a duplicate on this PR look like this item's: B (done on PR 99) dispatching on PR 7 while A is live there is refused", async () => {
    const { accountId, repoId, workItemId: itemB, registry } = await seedFixture();
    const itemA = await secondItemOnSamePr(accountId, repoId);
    const doneOnOtherPr = await dispatchSpecReadyExecutor(db.runWriterPool, registry, { accountId, workItemId: itemB, executorInput: baseInput({ repoId, pr: 99 }) });
    if (doneOnOtherPr.status !== "running") throw new Error("test setup: expected running");
    await writeRunStatus(db.runWriterPool, { accountId, runId: doneOnOtherPr.id, from: "running", to: "succeeded", result: { sessionId: "cc-done", envelope: { verdict: "done" } } });
    const a = await dispatchSpecReadyExecutor(db.runWriterPool, registry, { accountId, workItemId: itemA, executorInput: baseInput({ repoId, pr: 7 }) });
    expect(a.status).toBe("running");

    await expect(
      dispatchSpecReadyExecutor(db.runWriterPool, registry, { accountId, workItemId: itemB, executorInput: baseInput({ repoId, pr: 7 }) }),
    ).rejects.toThrow(DuplicateExecutorRunError);
  });

  it("every allowed needs-fix round resumes the SAME executor session; the next one escalates to needs_human", async () => {
    const { accountId, repoId, workItemId, registry } = await seedFixture();
    const executor = await dispatchSpecReadyExecutor(db.runWriterPool, registry, {
      accountId,
      workItemId,
      executorInput: baseInput({ repoId }),
    });
    if (executor.status !== "running") throw new Error("test setup: expected executor dispatch to be running");
    // The executor "finishes" and opens a PR -- H09b2's finalize path
    // persists cc_session_id; simulated here directly (H13a's webhook,
    // which records `pr_opened`, is out of this package's scope).
    await writeRunStatus(db.runWriterPool, {
      accountId,
      runId: executor.id,
      from: "running",
      to: "succeeded",
      result: { sessionId: "cc-session-fixloop", envelope: { verdict: "done" } },
    });
    await withTenant(db.runWriterPool, accountId, (client) =>
      recordStage(client, { workItemId, toStage: "pr_opened", at: new Date(), source: "control_plane", sourceRef: executor.id }),
    );

    const resumeCalls: string[] = [];
    for (let round = 1; round <= maxFixRounds(); round++) {
      const review = await startAgentRun(db.runWriterPool, registry, {
        ...baseInput({ repoId }),
        accountId,
        workItemId,
        role: "code-reviewer",
        headSha: `sha-round-${round}`,
      });
      if (review.status !== "running") throw new Error(`test setup: round ${round} code-reviewer dispatch failed`);

      const outcome = await recordReviewVerdict(db.runWriterPool, registry, {
        accountId,
        workItemId,
        role: "code-reviewer",
        runId: review.id,
        verdict: "needs-fix",
        resumeInput: baseInput({ repoId }),
      });
      expect(outcome.outcome).toBe("fix_dispatched");
      if (outcome.outcome === "fix_dispatched") {
        expect(outcome.roundNumber).toBe(round);
        expect(outcome.resume.status).toBe("running");
        resumeCalls.push(outcome.resume.id);
        // The resumed executor "finishes" its fix and pushes a new head
        // SHA before the next round's re-review dispatches -- only one
        // LIVE executor run per PR is ever allowed
        // (0625_agent_runs_one_live_executor_per_pr.sql), so this must
        // reach a terminal state before round + 1's resume runs.
        await writeRunStatus(db.runWriterPool, {
          accountId,
          runId: outcome.resume.id,
          from: "running",
          to: "succeeded",
          result: { sessionId: `cc-session-fixloop-round-${round}`, envelope: { verdict: "done" } },
        });
      }
      expect(await stageOf(accountId, workItemId)).toBe("changes_requested");
    }
    expect(resumeCalls).toHaveLength(maxFixRounds());

    // The round after the limit: refused with escalate (packages/spend's own H05
    // vocabulary), no further resume dispatched.
    const fourthReview = await startAgentRun(db.runWriterPool, registry, {
      ...baseInput({ repoId }),
      accountId,
      workItemId,
      role: "code-reviewer",
      headSha: "sha-round-over",
    });
    if (fourthReview.status !== "running") throw new Error("test setup: the over-limit code-reviewer dispatch failed");
    const escalated = await recordReviewVerdict(db.runWriterPool, registry, {
      accountId,
      workItemId,
      role: "code-reviewer",
      runId: fourthReview.id,
      verdict: "needs-fix",
      resumeInput: baseInput({ repoId }),
    });
    expect(escalated.outcome).toBe("escalated");
    if (escalated.outcome === "escalated") {
      expect(escalated.roundNumber).toBe(maxFixRounds() + 1);
      expect(escalated.labels.add).toEqual([NEEDS_FIX_LABEL]);
    }
    expect(await stageOf(accountId, workItemId)).toBe("needs_human");

    const events = await db.admin.query(
      `SELECT type, payload FROM domain_events WHERE account_id = $1 AND type = 'work_item.needs_human'`,
      [accountId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload.workItemId).toBe(workItemId);
    expect(events.rows[0].payload.sourceRunId).toBe(fourthReview.id);
  });

  it("a passing verdict records review_passed and the code-review-passed label, with no resume", async () => {
    const { accountId, repoId, workItemId, registry } = await seedFixture();
    const executor = await dispatchSpecReadyExecutor(db.runWriterPool, registry, {
      accountId,
      workItemId,
      executorInput: baseInput({ repoId }),
    });
    if (executor.status !== "running") throw new Error("test setup: expected executor dispatch to be running");
    await writeRunStatus(db.runWriterPool, {
      accountId,
      runId: executor.id,
      from: "running",
      to: "succeeded",
      result: { sessionId: "cc-session-pass", envelope: { verdict: "done" } },
    });
    await withTenant(db.runWriterPool, accountId, (client) =>
      recordStage(client, { workItemId, toStage: "pr_opened", at: new Date(), source: "control_plane", sourceRef: executor.id }),
    );

    const review = await startAgentRun(db.runWriterPool, registry, {
      ...baseInput({ repoId }),
      accountId,
      workItemId,
      role: "code-reviewer",
      headSha: "sha-pass",
    });
    if (review.status !== "running") throw new Error("test setup: code-reviewer dispatch failed");

    const outcome = await recordReviewVerdict(db.runWriterPool, registry, {
      accountId,
      workItemId,
      role: "code-reviewer",
      runId: review.id,
      verdict: "pass",
    });
    expect(outcome.outcome).toBe("passed");
    expect(outcome.labels.add).toEqual([ROLE_PASS_LABEL["code-reviewer"]]);
    expect(await stageOf(accountId, workItemId)).toBe("review_passed");
  });

  it("a duplicate verdict replay (same runId) is idempotent and does not double-count a fix round", async () => {
    const { accountId, repoId, workItemId, registry } = await seedFixture();
    const executor = await dispatchSpecReadyExecutor(db.runWriterPool, registry, {
      accountId,
      workItemId,
      executorInput: baseInput({ repoId }),
    });
    if (executor.status !== "running") throw new Error("test setup");
    await writeRunStatus(db.runWriterPool, {
      accountId,
      runId: executor.id,
      from: "running",
      to: "succeeded",
      result: { sessionId: "cc-session-dup", envelope: { verdict: "done" } },
    });
    await withTenant(db.runWriterPool, accountId, (client) =>
      recordStage(client, { workItemId, toStage: "pr_opened", at: new Date(), source: "control_plane", sourceRef: executor.id }),
    );
    const review = await startAgentRun(db.runWriterPool, registry, {
      ...baseInput({ repoId }),
      accountId,
      workItemId,
      role: "code-reviewer",
      headSha: "sha-dup",
    });
    if (review.status !== "running") throw new Error("test setup");

    const first = await recordReviewVerdict(db.runWriterPool, registry, {
      accountId,
      workItemId,
      role: "code-reviewer",
      runId: review.id,
      verdict: "needs-fix",
      resumeInput: baseInput({ repoId }),
    });
    expect(first.outcome).toBe("fix_dispatched");

    const replay = await recordReviewVerdict(db.runWriterPool, registry, {
      accountId,
      workItemId,
      role: "code-reviewer",
      runId: review.id,
      verdict: "needs-fix",
      resumeInput: baseInput({ repoId }),
    });
    expect(replay.outcome).toBe("duplicate");

    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM work_item_transitions WHERE account_id = $1 AND work_item_id = $2 AND to_stage = 'changes_requested'`,
      [accountId, workItemId],
    );
    expect(rows[0].n).toBe(1);
  });
});
