import { randomUUID } from "node:crypto";
import { APIError } from "@vercel/sandbox";
import { describe, expect, it } from "vitest";
import { insertAgentRun, writeRunStatus } from "../src/runStatusWriter.js";
import { buildExecutionRun, startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { sandboxNameFor } from "../src/sandboxNaming.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { createVercelSandboxPort } from "../src/vercelSandboxPort.js";
import type { NormalizedEvent } from "../src/types.js";
import { createFrozenInvocationSdk } from "./helpers/frozenInvocationSdk.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`test setup: ${what} never happened within ${timeoutMs}ms`);
    await sleep(5);
  }
}

/**
 * D#2 H14c-3-3b-1 (C88): the runner half of the continuation. [pg]: real Postgres, zero model tokens.
 * CARRY-26 (the kill cause is stored on the status event), CARRY-10 (a replayed finalize), CARRY-11 (a snapshot that is gone, answered by a rejection).
 */
describe("C88 3b-1: the runner half of a continuation [pg]", () => {
  const db = pgHarness();

  async function fixture() {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 7 });
    return { accountId, repoId, workItemId };
  }
  const input = (f: { accountId: string; repoId: string }, over: Partial<StartAgentRunInput> = {}): StartAgentRunInput => ({
    accountId: f.accountId, repoId: f.repoId, role: "code-reviewer", product: "team", roleCard: "card", prompt: "p", model: "haiku-4.5", capUsd: 5,
    spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" }, ...over,
  });
  const statusEvents = async (runId: string) => (await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq`, [runId])).rows.map((r) => r.payload);
  const statusOf = async (runId: string) => (await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId])).rows[0].status as string;

  async function runningRun(f: { accountId: string; repoId: string }) {
    const harness = createSandboxTargetHarness(db.runWriterPool);
    harness.fakeSandbox.hang(sandboxNameFor({ role: "code-reviewer", runId: "unused", accountId: f.accountId, repoId: f.repoId }));
    const started = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget(harness.deps) }, input(f));
    if (started.status !== "running") throw new Error("test setup: not running");
    return started.id;
  }

  describe("CARRY-26 write", () => {
    it.each(["per_run_cap", "monthly_budget"] as const)("%s is stored on the running -> killed_spend status event, with the status, in one move", async (abortReason) => {
      const f = await fixture();
      const runId = await runningRun(f);
      expect(await writeRunStatus(db.runWriterPool, { accountId: f.accountId, runId, from: "running", to: "killed_spend", abortReason })).toEqual({ updated: true });
      expect(await statusOf(runId)).toBe("killed_spend");
      expect((await statusEvents(runId)).at(-1)).toEqual({ from: "running", to: "killed_spend", abortReason });
    });

    it("a spend kill without a cause stores none (a caller that does not know writes no guess)", async () => {
      const f = await fixture();
      const runId = await runningRun(f);
      await writeRunStatus(db.runWriterPool, { accountId: f.accountId, runId, from: "running", to: "killed_spend" });
      expect((await statusEvents(runId)).at(-1)).toEqual({ from: "running", to: "killed_spend" });
    });

    it("a value that is not one of the two, and any other move, throw before any query and write nothing", async () => {
      const f = await fixture();
      const runId = await runningRun(f);
      const before = await statusEvents(runId);
      const attempts: Array<Parameters<typeof writeRunStatus>[1]> = [
        { accountId: f.accountId, runId, from: "running", to: "killed_spend", abortReason: "platform_budget" as never },
        { accountId: f.accountId, runId, from: "running", to: "killed_spend", abortReason: "" as never },
        { accountId: f.accountId, runId, from: "running", to: "timed_out", abortReason: "per_run_cap" },
        { accountId: f.accountId, runId, from: "running", to: "failed", abortReason: "monthly_budget" },
        { accountId: f.accountId, runId, from: "running", to: "succeeded", abortReason: "per_run_cap" },
        { accountId: f.accountId, runId, from: "pending", to: "killed_spend", abortReason: "per_run_cap" },
      ];
      for (const a of attempts) await expect(writeRunStatus(db.runWriterPool, a)).rejects.toThrow(/abortReason|transition/i);
      expect(await statusOf(runId)).toBe("running");
      expect(await statusEvents(runId)).toEqual(before);
    });

    // The two real kill paths of the sandbox target: `finalize` passes the report's cause on to the writer.
    const bigUsage: NormalizedEvent = { runId: "placeholder", role: "code-reviewer", seq: 1, type: "assistant", ts: new Date().toISOString(), usage: { inputTokens: 30_000_000, outputTokens: 0 } };
    it.each([
      ["per_run_cap", { perSpawnCapUsd: 0.01, monthlyModelBudgetUsd: 1000 }],
      ["monthly_budget", { perSpawnCapUsd: 100_000, monthlyModelBudgetUsd: 1 }],
    ] as const)("a real %s kill is stored by finalize", async (cause, limits) => {
      const f = await fixture();
      const harness = createSandboxTargetHarness(db.runWriterPool, [bigUsage]);
      const target = new SandboxTarget(harness.deps);
      const spend = { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const, estimateModelUsd: 0.001, ...limits };
      const started = await startAgentRun(db.runWriterPool, { sandbox: target }, input(f, { spend }));
      if (started.status !== "running") throw new Error("test setup: not running");
      await waitFor(() => harness.hooks.calls.some((c) => c.hookToken === started.hookToken), "the hook resuming after the kill");
      const report = harness.hooks.calls.find((c) => c.hookToken === started.hookToken)!.report;
      expect(report).toMatchObject({ status: "killed_spend", abortReason: cause });
      await target.finalize(buildExecutionRun(started.id, input(f, { spend })), report);
      const moved = (await statusEvents(started.id)).find((p) => p.to === "killed_spend");
      expect(moved).toEqual({ from: "running", to: "killed_spend", abortReason: cause });
      // the per-run kill leaves its checkpoint (resumable); the monthly one does not
      const checkpoints = await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'checkpoint'`, [started.id]);
      expect(checkpoints.rows).toHaveLength(cause === "per_run_cap" ? 1 : 0);
    });
  });

  describe("CARRY-10: a finalize replayed for a run that is already terminal", () => {
    it("writes no second status row, settles the reservation once and never releases it, and starts no second sandbox", async () => {
      const f = await fixture();
      // The run meters a little model usage, so both of its reservations are settled by the first finalize (an unused one is released by design).
      const used: NormalizedEvent = { runId: "placeholder", role: "code-reviewer", seq: 1, type: "assistant", ts: new Date().toISOString(), usage: { inputTokens: 1000, outputTokens: 100 } };
      const harness = createSandboxTargetHarness(db.runWriterPool, [used]);
      const target = new SandboxTarget(harness.deps);
      const spend = { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const, estimateModelUsd: 0.5, monthlyModelBudgetUsd: 1000 };
      const started = await startAgentRun(db.runWriterPool, { sandbox: target }, input(f, { spend }));
      if (started.status !== "running") throw new Error("test setup: not running");
      await waitFor(() => harness.hooks.calls.some((c) => c.hookToken === started.hookToken), "the hook resuming");
      const report = harness.hooks.calls.find((c) => c.hookToken === started.hookToken)!.report;
      const run = buildExecutionRun(started.id, input(f, { spend }));
      const snapshot = async () => ({
        statusRows: (await statusEvents(started.id)).filter((p) => p.to === report.status).length,
        reservations: (await db.admin.query(`SELECT state, count(*)::int AS n FROM spend_reservations WHERE run_id = $1 GROUP BY state ORDER BY state`, [started.id])).rows,
        ledger: Number((await db.admin.query(`SELECT count(*) FROM ledger WHERE run_id = $1`, [started.id])).rows[0].count),
        created: harness.fakeSandbox.state.created.length,
      });

      await target.finalize(run, report);
      const first = await snapshot();
      expect(first.statusRows).toBe(1);
      expect(first.reservations.length).toBeGreaterThan(0);
      expect(first.reservations.every((r) => r.state === "settled")).toBe(true); // settled, never open and never released

      await target.finalize(run, report); // the replay
      await target.finalize(run, report);
      expect(await snapshot()).toEqual(first);
      expect(await statusOf(started.id)).toBe(report.status);
    });
  });

  describe("CARRY-11: a resume whose sandbox is gone rejects asynchronously", () => {
    it("falls back to one fresh dispatch under the same run; the run is not failed (real port over the SDK fake, the SDK's own error)", async () => {
      const f = await fixture();
      const platform = { frozen: false };
      const sdk = createFrozenInvocationSdk(platform);
      // 3.5.1's APIError: a real Response carries the status, as the SDK's own client builds it for a 404.
      const gone = () => new APIError(new Response(null, { status: 404 }), { message: "Sandbox not found" });
      const getCalls: boolean[] = [];
      const port = createVercelSandboxPort({
        teamId: "t", projectId: "p", getToken: async () => "tok", measureRetryDelayMs: 0,
        sdk: { ...sdk.sdk, get: async (params) => { getCalls.push(params.resume === true); if (params.resume === true) throw gone(); return sdk.sdk.get(params); } },
      });
      const harness = createSandboxTargetHarness(db.runWriterPool);
      const target = new SandboxTarget({ ...harness.deps, sandboxPort: port, lostConfirmDelayMs: 20 });
      const executor = input(f, { role: "executor", workItemId: f.workItemId, pr: 7, roleCard: "executor card", prompt: "continue", fallbackPrompt: "fresh prompt with the Spec" });
      const { id } = await insertAgentRun(db.runWriterPool, {
        id: randomUUID(), accountId: f.accountId, workItemId: f.workItemId, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: f.repoId, dispatchPrNumber: 7,
      });
      const run = buildExecutionRun(id, executor);
      await target.admit(run, db.admin);
      const { hookToken } = await target.resume(run, "cc-session-gone");
      expect(typeof hookToken).toBe("string");
      await writeRunStatus(db.runWriterPool, { accountId: f.accountId, runId: id, from: "pending", to: "running" });

      // one resume attempt reached the provider, then exactly one fresh start: no second fallback
      expect(getCalls.filter(Boolean)).toHaveLength(1);
      expect(sdk.calls.filter((c) => c === "create")).toHaveLength(1);
      await waitFor(() => harness.hooks.calls.some((c) => c.hookToken === hookToken), "the fresh session ending");
      const report = harness.hooks.calls.find((c) => c.hookToken === hookToken)!.report;
      expect(report.status).toBe("succeeded"); // not the "failed" the rejection used to produce
      expect(harness.hooks.calls.filter((c) => c.hookToken === hookToken)).toHaveLength(1);
      expect(sdk.agentCommandCount()).toBe(1);
      expect(await statusOf(id)).toBe("running");
    });
  });
});
