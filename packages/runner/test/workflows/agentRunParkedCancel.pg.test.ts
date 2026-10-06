import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// `sleep()` throws outside a real workflow execution, so the watchdog leg is a plain timer here.
// unref'd: a long watchdog left pending by the hook-wins case must not hold the process open.
vi.mock("workflow", () => ({
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref();
    }),
}));

import { SandboxTarget } from "../../src/targets/sandboxTarget.js";
import { cancelRun } from "../../src/cancelRun.js";
import { createInMemoryHookChannel } from "../../src/hookChannel.js";
import { agentRunWorkflow, configureAgentRunWiring } from "../../src/workflows/agentRun.js";
import type { ExecutionTarget, ExecutionTargetRegistry } from "../../src/executionTarget.js";
import type { StartAgentRunInput } from "../../src/startAgentRun.js";
import type { CreateSandboxOptions, SandboxHandle, SandboxPort, StartDetachedOptions, StartDetachedResult } from "../../src/sandboxPort.js";
import type { NormalizedEvent } from "../../src/types.js";
import { seedAccount, seedMember, seedRepo } from "../helpers/seed.js";
import { createSandboxTargetHarness } from "../helpers/sandboxTargetFakes.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#2 H14c-3b, C5 (CARRY-20's hardest case): an agentRunWorkflow parked in the hook wait
 * or the watchdog sleep, whose run is cancelled out of band, wakes, sees the run is
 * already `cancelled`, and skips finalize and cancelStep. Real agentRunWorkflow (with
 * `sleep` swapped for a timer), real Postgres, fake sandbox port.
 *
 * What would go wrong without the check: the watchdog leg would call the target's cancel a
 * second time, and the hook leg would call finalize on a run that is already over. Both are
 * counted on the target, and the sandbox stop is counted on the port.
 */
describe("agentRunWorkflow woken after an out-of-band cancel [pg]", () => {
  const db = pgHarness();

  async function world() {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const userId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId);
    const input: StartAgentRunInput = {
      accountId,
      repoId,
      role: "code-reviewer",
      product: "team",
      roleCard: "fake role card",
      prompt: "fake prompt",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
    return { accountId, userId, input };
  }

  /** A port whose sandbox never finishes on its own; `finish()` ends it the way a stopped sandbox would. */
  function parkedPort() {
    const stopped: string[] = [];
    let finish!: (e: NormalizedEvent | undefined) => void;
    const hookFired = new Promise<NormalizedEvent | undefined>((resolve) => {
      finish = resolve;
    });
    const port: SandboxPort = {
      async createSandbox(opts: CreateSandboxOptions): Promise<SandboxHandle> {
        return { runId: "", sandboxName: opts.sandboxName };
      },
      startDetached(handle: SandboxHandle, _o: StartDetachedOptions): StartDetachedResult {
        return { handle, hookFired };
      },
      async extendTimeout() {},
      async stop(handle) {
        stopped.push(handle.sandboxName);
      },
      resume(handle: SandboxHandle, _s: string, _p: string, _o: StartDetachedOptions): StartDetachedResult {
        return { handle, hookFired };
      },
      async deleteSandbox() {},
      async measure() {
        return [];
      },
      async readCounters() {
        return undefined;
      },
      async sandboxExists() {
        return true;
      },
    };
    return { port, stopped, finish };
  }

  async function runningRunId(accountId: string): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const { rows } = await db.admin.query(`SELECT id FROM agent_runs WHERE account_id = $1 AND status = 'running'`, [accountId]);
      if (rows[0]) return rows[0].id as string;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the run never reached running");
  }

  const eventCount = async (runId: string): Promise<number> =>
    Number((await db.admin.query(`SELECT count(*) AS n FROM run_events WHERE run_id = $1`, [runId])).rows[0].n);

  async function scenario(wake: "watchdog" | "hook") {
    const { accountId, userId, input } = await world();
    const { port, stopped, finish } = parkedPort();
    const { resumeSink, waitPort } = createInMemoryHookChannel();
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const real = new SandboxTarget({ ...harness.deps, sandboxPort: port, hooks: resumeSink });
    const calls = { cancel: 0, finalize: 0 };
    const target: ExecutionTarget = {
      runtime: real.runtime,
      admit: (run, client) => real.admit(run, client),
      dispatch: (run) => real.dispatch(run),
      resume: (run, sessionId) => real.resume(run, sessionId),
      cancel: (run) => (calls.cancel++, real.cancel(run)),
      finalize: (run, report) => (calls.finalize++, real.finalize(run, report)),
    };
    const registry: ExecutionTargetRegistry = { sandbox: target };

    const watchdogMs = wake === "watchdog" ? 1500 : 60 * 60 * 1000;
    configureAgentRunWiring({ pool: db.runWriterPool, registry, hookWait: waitPort });
    const workflow = agentRunWorkflow(input, watchdogMs);
    const runId = await runningRunId(accountId);

    // Out of band: the same call the cancel performer makes through the facade.
    const cancelled = await cancelRun({ pool: db.runWriterPool, principal: { accountId, userId } }, runId, registry);
    expect(cancelled.status).toBe("cancelled");
    expect(stopped).toHaveLength(1);
    expect(calls).toEqual({ cancel: 1, finalize: 0 });
    const eventsAfterCancel = await eventCount(runId);

    if (wake === "hook") finish(undefined); // the stopped sandbox reports in; the parked hook wait wakes
    const result = await workflow;

    expect(result).toMatchObject({ id: runId, status: "cancelled" });
    expect(stopped).toHaveLength(1); // exactly one stop, ever
    expect(calls).toEqual({ cancel: 1, finalize: 0 }); // no second cancel, no finalize
    const { rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId]);
    expect(rows[0].status).toBe("cancelled");
    expect(await eventCount(runId)).toBe(eventsAfterCancel); // no status write after cancelled
    const changes = await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq`, [runId]);
    expect(changes.rows.map((r: { payload: { to: string } }) => r.payload.to)).toEqual(["running", "cancelled"]);
  }

  it("parked in the watchdog sleep: wakes, sees cancelled, and does not time the run out or stop it again", async () => {
    await scenario("watchdog");
  });

  it("parked in the hook wait: wakes on the stopped sandbox's report, sees cancelled, and does not finalize", async () => {
    await scenario("hook");
  });

  it("a hook that answers for a DIFFERENT run is refused, and the run is left alone", async () => {
    const { accountId, input } = await world();
    const { port } = parkedPort();
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const target = new SandboxTarget({ ...harness.deps, sandboxPort: port });
    configureAgentRunWiring({
      pool: db.runWriterPool,
      registry: { sandbox: target },
      hookWait: { wait: async () => ({ runId: randomUUID(), status: "succeeded" }) },
    });
    await expect(agentRunWorkflow(input, 60 * 60 * 1000)).rejects.toThrow("different run");
    expect((await db.admin.query(`SELECT status FROM agent_runs WHERE account_id = $1 AND dispatch_repo_id IS NOT NULL`, [accountId])).rows).toEqual([{ status: "running" }]);
  });
});
