import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxTarget } from "../../src/targets/sandboxTarget.js";
import { createInMemoryHookChannel } from "../../src/hookChannel.js";
import {
  agentRunWorkflow,
  configureAgentRunWiring,
  dispatchStep,
  followStatusBody,
  followTimeoutBody,
  hookWaitStep,
  runStatusStep,
} from "../../src/workflows/agentRun.js";
import type { AdmitResult, ExecutionTarget, ExecutionTargetRegistry, HookResult } from "../../src/executionTarget.js";
import { QueuedRunNotSupportedError, type StartAgentRunInput } from "../../src/startAgentRun.js";
import { RunnerTarget } from "../../src/targets/runnerTarget.js";
import { createFakeJobIssuer, createFakeVisibility } from "../helpers/runnerTargetFakes.js";
import type { CreateSandboxOptions, SandboxHandle, SandboxPort, StartDetachedOptions, StartDetachedResult } from "../../src/sandboxPort.js";
import { seedAccount, seedRepo } from "../helpers/seed.js";
import { createSandboxTargetHarness } from "../helpers/sandboxTargetFakes.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#2 H09b2-wf / H14c-3-3a-3: the post-dispatch watchdog as the `"use step"` functions `workflows/agentRun.ts`'s
 * `"use workflow"` entrypoint orchestrates. [pg]: real Postgres, zero model tokens.
 *
 * The steps reach the pool and the registry through the module-level wiring (`configureAgentRunWiring`), not through
 * arguments, so the workflow's own arguments are plain data. The target finalizes a finished run itself BEFORE it
 * resumes the hook, so the hook-wins scenario has no finalize step: it reads the status row the target wrote.
 *
 * The race's two outcomes are driven through the same steps with a test-controlled timer: the real `sleep()` throws
 * outside a workflow execution and this repo's vitest (2.x) is below `@workflow/vitest`'s 3.1 peer requirement. The
 * `refused_spend` path never reaches `sleep()`, so it calls `agentRunWorkflow` itself.
 */
describe("agentRunWorkflow (D#2 H09b2-wf, H09.7 watchdog) [pg]", () => {
  const db = pgHarness();
  afterEach(() => configureAgentRunWiring(undefined));

  async function seedRepoFixture(): Promise<{ accountId: string; repoId: string }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    return { accountId, repoId };
  }

  function baseInput(accountId: string, repoId: string): StartAgentRunInput {
    return {
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
  }

  function fakeSleep(ms: number): Promise<{ timedOut: true }> {
    return new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ms));
  }

  it("H09.7: when the hook never fires, the run becomes timed_out, cancel runs once, and the compute row settles as measured (never released)", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    const stopped: string[] = [];
    const harness = createSandboxTargetHarness(db.runWriterPool);
    // A port whose hookFired never settles -- the watchdog is the ONLY thing that can end this run.
    const port: SandboxPort = {
      async createSandbox(opts: CreateSandboxOptions): Promise<SandboxHandle> {
        return { runId: "", sandboxName: opts.sandboxName, sessionId: "sess-watchdog" };
      },
      startDetached(handle: SandboxHandle, _opts: StartDetachedOptions): StartDetachedResult {
        return { handle, hookFired: new Promise(() => {}) };
      },
      async extendTimeout() {},
      async stop(handle) {
        stopped.push(handle.sandboxName);
      },
      resume(handle: SandboxHandle, _s: string, _p: string, _opts: StartDetachedOptions): StartDetachedResult {
        return { handle, hookFired: new Promise(() => {}) };
      },
      async deleteSandbox() {},
      async measure(_handle, ids) {
        return ids.map((sessionId) => ({ sessionId, memoryMb: 4096, region: "iad1", durationMs: 60_000, activeCpuMs: 1_000, egressBytes: 0 }));
      },
      async readCounters() {
        return undefined;
      },
      async sandboxExists() {
        return true;
      },
    };
    const target = new SandboxTarget({ ...harness.deps, sandboxPort: port });
    const { waitPort } = createInMemoryHookChannel(); // never resumed -- the watchdog wins the race
    configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: target }, hookWait: waitPort });

    const started = await dispatchStep(baseInput(accountId, repoId));
    if (started.status !== "running") throw new Error("expected dispatch to reach running");

    const raced = await Promise.race<{ timedOut: true } | { timedOut: false; result: HookResult }>([
      hookWaitStep(started.hookToken).then((result) => ({ timedOut: false as const, result })),
      fakeSleep(20),
    ]);
    expect(raced.timedOut).toBe(true);

    expect(await followTimeoutBody(accountId, started.id)).toEqual({ status: "timed_out", done: true });
    expect(stopped.length).toBeGreaterThanOrEqual(1);

    const row = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [started.id]);
    expect(row.rows[0].status).toBe("timed_out");
    const open = await db.admin.query(`SELECT state FROM spend_reservations WHERE account_id = $1`, [accountId]);
    expect(open.rows).toEqual([{ state: "settled" }]);
    const ledger = await db.admin.query(`SELECT compute_basis FROM ledger WHERE account_id = $1`, [accountId]);
    expect(ledger.rows).toEqual([{ compute_basis: "measured" }]);
  });

  it("P2: when the hook fires first, the target has ALREADY finalized the run: the hook carries only { runId, status } and the status row is terminal by then", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    const harness = createSandboxTargetHarness(db.runWriterPool, []); // zero-event fixture -> a failed report, resolved at once
    const channel = createInMemoryHookChannel();
    const statusWhenWoken: string[] = [];
    const target = new SandboxTarget({
      ...harness.deps,
      finalizeBeforeResume: true,
      hooks: {
        resume: async (token, result) => {
          // The moment the hook is resumed, the record must already be there.
          statusWhenWoken.push((await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [result.runId])).rows[0].status as string);
          await channel.resumeSink.resume(token, result);
        },
      },
    });
    configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: target }, hookWait: channel.waitPort });

    const started = await dispatchStep(baseInput(accountId, repoId));
    if (started.status !== "running") throw new Error("expected dispatch to reach running");
    const result = await Promise.race([hookWaitStep(started.hookToken), fakeSleep(60_000)]);
    if ("timedOut" in result) throw new Error("the hook did not fire");

    expect(Object.keys(result).sort()).toEqual(["runId", "status"]);
    expect(result).toEqual({ runId: started.id, status: "failed" }); // zero-event fixture -> buildTerminalReport's "no lastEvent" branch
    expect(statusWhenWoken).toEqual(["failed"]);
    expect(await runStatusStep(accountId, started.id)).toBe("failed");
    expect(await followStatusBody(accountId, started.id)).toEqual({ status: "failed", done: true });
    // Finalized exactly once: one terminal status row.
    const finals = await db.admin.query(`SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'failed'`, [started.id]);
    expect(finals.rows[0].n).toBe(1);
  });

  it("a refused_spend run short-circuits before the watchdog is ever raced -- exercised through agentRunWorkflow itself", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    await db.admin.query(`UPDATE accounts SET owner_paused_at = now() WHERE id = $1`, [accountId]);
    const harness = createSandboxTargetHarness(db.runWriterPool);
    configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: new SandboxTarget(harness.deps) } });

    // This path returns before `agentRunWorkflow` ever calls `sleep()`, so it is safe to call the real function directly.
    const result = await agentRunWorkflow(baseInput(accountId, repoId), 60_000);
    expect(result.status).toBe("refused_spend");
  });

  it("the workflow's arguments are plain data: the input and a number, no pool, registry or port", () => {
    expect(agentRunWorkflow.length).toBe(2); // (input, watchdogMs): the watchdog is always the caller's, derived from the run's own timeout
    const { accountId, repoId } = { accountId: randomUUID(), repoId: randomUUID() };
    expect(structuredClone(baseInput(accountId, repoId))).toEqual(baseInput(accountId, repoId));
    return expect(dispatchStep(baseInput(accountId, repoId))).rejects.toThrow("not wired");
  });

  it("an admit refusal is recorded by its closed reason; a reason outside the set becomes a fixed code, never free text", async () => {
    const stub = (admit: AdmitResult): ExecutionTargetRegistry => {
      const never = async (): Promise<never> => {
        throw new Error("unused");
      };
      const target: ExecutionTarget = { runtime: "production", admit: async () => admit, dispatch: never, cancel: never, finalize: never, resume: never };
      return { sandbox: target };
    };
    for (const [admit, expected] of [
      [{ admitted: false, reason: "compute_cap_exceeded" }, "compute_cap_exceeded"],
      [{ admitted: false, reason: "sk-live-secret and a stack trace" as never }, "admit_refused"],
    ] as const) {
      const { accountId, repoId } = await seedRepoFixture();
      configureAgentRunWiring({ pool: db.runWriterPool, registry: stub(admit) });
      const result = await dispatchStep(baseInput(accountId, repoId));
      expect(result).toMatchObject({ status: "refused_spend", reason: expected });
      const row = await db.admin.query(`SELECT payload->>'failureReason' AS reason FROM run_events WHERE account_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'refused_spend'`, [accountId]);
      expect(row.rows).toEqual([{ reason: expected }]);
    }
  });

  it("D#6 R3a: a run the target queues for a runner has no hook to wait on, so the dispatch step cancels it and fails", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    await db.admin.query(`UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1`, [repoId]);
    const registry: ExecutionTargetRegistry = {
      runner_local: new RunnerTarget({ pool: db.runWriterPool, issuer: createFakeJobIssuer(), visibility: createFakeVisibility("private") }),
    };
    configureAgentRunWiring({ pool: db.runWriterPool, registry });
    await expect(dispatchStep(baseInput(accountId, repoId))).rejects.toThrow(QueuedRunNotSupportedError);
    expect((await db.admin.query(`SELECT status FROM agent_runs WHERE account_id = $1`, [accountId])).rows).toEqual([{ status: "cancelled" }]);
  });

  it("WORKFLOW-INPUT-IDS: agentRunWorkflow takes the full start input (prompt and role card included), so nothing may use it as a compiled workflow yet: no source outside this file mentions it", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", "dist", "test", "tests"].includes(name)) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name) && readFileSync(full, "utf8").includes("agentRunWorkflow")) hits.push(path.relative(root, full));
      }
    };
    for (const top of ["apps", "packages"]) walk(path.join(root, top));
    expect(hits).toEqual(["packages/runner/src/workflows/agentRun.ts"]);
  });
});
