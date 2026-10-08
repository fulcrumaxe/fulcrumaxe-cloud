import { vi } from "vitest";

// A spy on @fx/spend that calls through: it lets the sandbox control below prove the spy sees real calls, so "zero
// calls" for a runner run means something.
const { reserveSpy, releaseWithSpy, settleWithSpy } = vi.hoisted(() => ({ reserveSpy: vi.fn(), releaseWithSpy: vi.fn(), settleWithSpy: vi.fn() }));
vi.mock("@fx/spend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fx/spend")>();
  reserveSpy.mockImplementation(actual.reserve);
  releaseWithSpy.mockImplementation(actual.releaseWith);
  settleWithSpy.mockImplementation(actual.settleWith);
  return { ...actual, reserve: reserveSpy, releaseWith: releaseWithSpy, settleWith: settleWithSpy };
});

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DispatchFailedError,
  UnknownExecutionModeError,
  type ExecutionTargetRegistry,
  type FailureReason,
} from "../src/executionTarget.js";
import { cancelRun } from "../src/cancelRun.js";
import { QueuedRunNotSupportedError, failClosedOnQueued, startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { pauseQueuedRuns, writeRunStatus } from "../src/runStatusWriter.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { RunnerTarget, unwiredJobIssuer, unwiredRepoVisibility } from "../src/targets/runnerTarget.js";
import { seedAccount, seedMember, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { createFakeJobIssuer, createFakeRunnerLimits, createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#6 R3a: a run for a `runner_local` repo, end to end through `startAgentRun` against a real database. Zero model tokens.
 */
describe("runner runs through startAgentRun [pg]", () => {
  const db = pgHarness();

  beforeEach(() => {
    reserveSpy.mockClear();
    releaseWithSpy.mockClear();
    settleWithSpy.mockClear();
  });

  async function world(executionMode: "runner_local" | "sandbox" = "runner_local") {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId, { executionMode });
    return { accountId, userId, repoId };
  }

  function registryOf(visibility: "private" | "public" | "unknown" | "throw" = "private", runsPerDay = 1000) {
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const issuer = createFakeJobIssuer();
    const registry: ExecutionTargetRegistry = {
      sandbox: new SandboxTarget(harness.deps),
      runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(runsPerDay), pool: db.runWriterPool, issuer, visibility: createFakeVisibility(visibility) }),
    };
    return { registry, harness, issuer };
  }

  function inputOf(w: { accountId: string; repoId: string }, over: Partial<StartAgentRunInput> = {}): StartAgentRunInput {
    return {
      accountId: w.accountId,
      repoId: w.repoId,
      role: "code-reviewer",
      product: "team",
      roleCard: "card",
      prompt: "prompt",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
      ...over,
    };
  }

  const rowOf = async (id: string) =>
    (
      await db.admin.query(
        `SELECT status, runtime, execution_mode, usd, tokens_in, tokens_out, initiated_by, job_signed FROM agent_runs WHERE id = $1`,
        [id],
      )
    ).rows[0];

  describe("a runner_local repo", () => {
    it("starts as a queued run: pending, runtime 'runner', no money anywhere, and no sandbox", async () => {
      const w = await world();
      const { registry, harness, issuer } = registryOf();

      const result = await startAgentRun(db.runWriterPool, registry, inputOf(w, { initiatedBy: w.userId }));

      expect(result).toEqual({ id: expect.any(String), status: "pending", queued: true });
      const row = await rowOf(result.id);
      expect(row).toMatchObject({ status: "pending", runtime: "runner", execution_mode: "runner_local", usd: null, tokens_in: null, tokens_out: null, initiated_by: w.userId });
      // A real database for the rows below, a spy for the calls: neither saw any money move.
      expect((await db.admin.query(`SELECT 1 FROM spend_reservations WHERE account_id = $1`, [w.accountId])).rows).toHaveLength(0);
      expect((await db.admin.query(`SELECT 1 FROM ledger WHERE account_id = $1`, [w.accountId])).rows).toHaveLength(0);
      expect(reserveSpy).not.toHaveBeenCalled();
      expect(settleWithSpy).not.toHaveBeenCalled();
      expect(releaseWithSpy).not.toHaveBeenCalled();
      // The target was handed the run, and no sandbox was created.
      expect(issuer.calls.map((c) => c.run.id)).toEqual([result.id]);
      expect(harness.fakeSandbox.state.created).toHaveLength(0);
    });

    it("with no runner online the run stays pending: nothing moves it, and nothing falls back to the sandbox", async () => {
      const w = await world();
      const { registry, harness } = registryOf();
      const result = await startAgentRun(db.runWriterPool, registry, inputOf(w));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect((await rowOf(result.id)).status).toBe("pending");
      expect(harness.fakeSandbox.state.created).toHaveLength(0);
      const events = await db.admin.query(`SELECT kind FROM run_events WHERE run_id = $1 ORDER BY seq`, [result.id]);
      expect(events.rows.map((r: { kind: string }) => r.kind)).not.toContain("run.status_changed");
    });

    it("routing is by data: the same result with VERCEL set and unset", async () => {
      const w = await world();
      const { registry } = registryOf();
      const before = process.env.VERCEL;
      try {
        for (const value of [undefined, "1"]) {
          if (value === undefined) delete process.env.VERCEL;
          else process.env.VERCEL = value;
          const result = await startAgentRun(db.runWriterPool, registry, inputOf(w));
          expect(result).toMatchObject({ status: "pending", queued: true });
          expect((await rowOf(result.id)).runtime).toBe("runner");
        }
      } finally {
        if (before === undefined) delete process.env.VERCEL;
        else process.env.VERCEL = before;
      }
    });

    it("a registry without runner_local throws UnknownExecutionModeError and writes nothing", async () => {
      const w = await world();
      const { registry } = registryOf();
      await expect(startAgentRun(db.runWriterPool, { sandbox: registry.sandbox! }, inputOf(w))).rejects.toThrow(UnknownExecutionModeError);
      expect((await db.admin.query(`SELECT 1 FROM agent_runs WHERE account_id = $1`, [w.accountId])).rows).toHaveLength(0);
    });

    it("a user who is not a member of the account cannot be recorded as the initiator: nothing is created", async () => {
      const w = await world();
      const stranger = randomUUID();
      await db.admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [stranger, `${stranger}@fixture.test`]);
      const { registry, issuer } = registryOf();
      await expect(startAgentRun(db.runWriterPool, registry, inputOf(w, { initiatedBy: stranger }))).rejects.toMatchObject({ code: "42501" });
      expect((await db.admin.query(`SELECT 1 FROM agent_runs WHERE account_id = $1`, [w.accountId])).rows).toHaveLength(0);
      expect(issuer.calls).toHaveLength(0);
    });
  });

  describe("admit refusals reach the run with their own reason", () => {
    it.each([
      ["public", "public_repo"],
      ["unknown", "repo_visibility_unknown"],
      ["throw", "repo_visibility_unknown"],
    ] as const)("a repo the port reads as %s: refused_spend with %s, no job issued", async (visibility, reason) => {
      const w = await world();
      const { registry, issuer } = registryOf(visibility);
      const result = await startAgentRun(db.runWriterPool, registry, inputOf(w));
      expect(result).toMatchObject({ status: "refused_spend", reason });
      const { rows } = await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed'`, [result.id]);
      expect(rows[0].payload).toEqual({ from: "pending", to: "refused_spend", failureReason: reason });
      expect(issuer.calls).toHaveLength(0);
    });

    it("the run after the plan's daily limit is refused as runner_daily_limit, and the refused run does not count against the next", async () => {
      const w = await world();
      const perDay = 3;
      const { registry } = registryOf("private", perDay);
      for (let i = 0; i < perDay; i++) {
        expect(await startAgentRun(db.runWriterPool, registry, inputOf(w))).toMatchObject({ status: "pending" });
      }
      const over = await startAgentRun(db.runWriterPool, registry, inputOf(w));
      expect(over).toMatchObject({ status: "refused_spend", reason: "runner_daily_limit" });
      const again = await startAgentRun(db.runWriterPool, registry, inputOf(w));
      expect(again).toMatchObject({ status: "refused_spend", reason: "runner_daily_limit" });
    });

    it("a role no runner may run is refused as role_not_runner_eligible", async () => {
      const w = await world();
      const { registry } = registryOf();
      const result = await startAgentRun(db.runWriterPool, registry, inputOf(w, { role: "researcher" }));
      expect(result).toMatchObject({ status: "refused_spend", reason: "role_not_runner_eligible" });
    });

    it("the composition root's defaults refuse: unwired visibility reads every repo as unknown", async () => {
      const w = await world();
      const registry: ExecutionTargetRegistry = {
        runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(), pool: db.runWriterPool, issuer: unwiredJobIssuer, visibility: unwiredRepoVisibility }),
      };
      expect(await startAgentRun(db.runWriterPool, registry, inputOf(w))).toMatchObject({ status: "refused_spend", reason: "repo_visibility_unknown" });
    });

    it("the unwired issuer fails the run instead of leaving it pending with no job behind it", async () => {
      const w = await world();
      const registry: ExecutionTargetRegistry = {
        runner_local: new RunnerTarget({ limits: createFakeRunnerLimits(), pool: db.runWriterPool, issuer: unwiredJobIssuer, visibility: createFakeVisibility("private") }),
      };
      await expect(startAgentRun(db.runWriterPool, registry, inputOf(w))).rejects.toThrow(DispatchFailedError);
      const { rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE account_id = $1`, [w.accountId]);
      expect(rows).toEqual([{ status: "failed" }]);
    });
  });

  describe("the sandbox is unchanged (the control)", () => {
    it("a sandbox repo still starts a sandbox run: runtime 'production', a hook token, a sandbox created, the spend spy called", async () => {
      const w = await world("sandbox");
      const { registry, harness, issuer } = registryOf();
      const result = await startAgentRun(db.runWriterPool, registry, inputOf(w, { initiatedBy: w.userId }));
      expect(result).toMatchObject({ status: "running", hookToken: expect.any(String) });
      expect(await rowOf(result.id)).toMatchObject({ runtime: "production", execution_mode: "sandbox", initiated_by: w.userId });
      expect(harness.fakeSandbox.state.created.length).toBeGreaterThan(0);
      expect(reserveSpy).toHaveBeenCalled();
      expect(issuer.calls).toHaveLength(0);
    });
  });

  describe("callers that cannot wait for a claim fail closed", () => {
    it("failClosedOnQueued cancels the queued run and throws; the run is cancelled, with the reason on its event", async () => {
      const w = await world();
      const { registry } = registryOf();
      const queued = await startAgentRun(db.runWriterPool, registry, inputOf(w));
      await expect(failClosedOnQueued(db.runWriterPool, w.accountId, queued)).rejects.toThrow(QueuedRunNotSupportedError);
      expect((await rowOf(queued.id)).status).toBe("cancelled");
      const { rows } = await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed'`, [queued.id]);
      expect(rows[0].payload).toEqual({ from: "pending", to: "cancelled", failureReason: "queued_not_supported" });
    });

    it("a cancel that cannot be written is logged with a fixed code and the run id (no error text), and the caller still gets the error", async () => {
      const w = await world();
      const { registry } = registryOf();
      const queued = await startAgentRun(db.runWriterPool, registry, inputOf(w));
      const broken = { connect: async () => { throw new Error("password=hunter2 host=db.internal"); } } as unknown as typeof db.runWriterPool;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await expect(failClosedOnQueued(broken, w.accountId, queued)).rejects.toThrow(QueuedRunNotSupportedError);
        expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([JSON.stringify({ event: "run.queued_cancel_failed", run_id: queued.id })]);
      } finally {
        warn.mockRestore();
      }
      expect((await rowOf(queued.id)).status).toBe("pending");
    });

    it("queued_not_supported is a member of the closed FailureReason set", () => {
      const reason = "queued_not_supported" satisfies FailureReason;
      expect(reason).toBe("queued_not_supported");
    });

    it("a run a runner already claimed is not cancelled from under it", async () => {
      const w = await world();
      const { registry } = registryOf();
      const queued = await startAgentRun(db.runWriterPool, registry, inputOf(w));
      await writeRunStatus(db.runWriterPool, { accountId: w.accountId, runId: queued.id, from: "pending", to: "running" });
      await expect(failClosedOnQueued(db.runWriterPool, w.accountId, queued)).rejects.toThrow(QueuedRunNotSupportedError);
      expect((await rowOf(queued.id)).status).toBe("running");
    });

    it("every other result passes through untouched", async () => {
      const w = await world("sandbox");
      const { registry } = registryOf();
      const started = await startAgentRun(db.runWriterPool, registry, inputOf(w));
      expect(await failClosedOnQueued(db.runWriterPool, w.accountId, started)).toBe(started);
    });
  });

  describe("cancel, and the pause that follows a broken model key", () => {
    it("cancelRun cancels a queued runner run through the registered target, with zeros and no spend call", async () => {
      const w = await world();
      const { registry } = registryOf();
      const queued = await startAgentRun(db.runWriterPool, registry, inputOf(w));
      const result = await cancelRun({ pool: db.runWriterPool, principal: { accountId: w.accountId, userId: w.userId } }, queued.id, registry);
      expect(result).toEqual({ status: "cancelled", settled_usd: 0, released_usd: 0 });
      expect((await rowOf(queued.id)).status).toBe("cancelled");
      expect(settleWithSpy).not.toHaveBeenCalled();
      expect(releaseWithSpy).not.toHaveBeenCalled();
    });

    it("pausing the account's queued runs after a sandbox key failure leaves a queued runner run alone", async () => {
      const w = await world();
      const { registry } = registryOf();
      const queued = await startAgentRun(db.runWriterPool, registry, inputOf(w));
      const sandboxRepo = randomUUID();
      await seedRepo(db.admin, w.accountId, sandboxRepo, { executionMode: "sandbox" });
      const waiting = await db.admin.query<{ id: string }>(
        `INSERT INTO agent_runs (account_id, role, runtime, status, execution_mode) VALUES ($1, 'code-reviewer', 'production', 'pending', 'sandbox') RETURNING id`,
        [w.accountId],
      );
      const paused = await pauseQueuedRuns(db.runWriterPool, w.accountId, randomUUID());
      expect(paused).toEqual([waiting.rows[0]!.id]);
      expect((await rowOf(queued.id)).status).toBe("pending");
    });
  });
});
