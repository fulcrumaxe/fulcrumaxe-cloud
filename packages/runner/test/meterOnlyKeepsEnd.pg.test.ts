import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { ExecutionTargetRegistry } from "../src/executionTarget.js";
import { RunLimitError } from "../src/meteringGuard.js";
import type { EventMeta, SandboxPort } from "../src/sandboxPort.js";
import type { NormalizedEvent } from "../src/types.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`test setup: ${what} never happened within ${timeoutMs}ms`);
    await sleep(5);
  }
}

const usageEvent = (tokens: number, seq: number): NormalizedEvent => ({
  runId: "placeholder",
  role: "code-reviewer",
  seq,
  type: "assistant",
  ts: new Date().toISOString(),
  usage: { inputTokens: tokens, outputTokens: 0 },
});
const errorEvent = (text: string, seq: number): NormalizedEvent => ({ runId: "placeholder", role: "code-reviewer", seq, type: "error", ts: new Date().toISOString(), isError: true, text });

const SPEND = { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const, estimateModelUsd: 0.001, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 0.01 };
const OVER_CAP = 30_000_000; // priced far above the per-run cap
const META: EventMeta = { meterOnly: true };

/**
 * A run that has already ended for one reason, whose remaining usage is then counted (the catch-up behind an enforced end). The counted usage is
 * metered and booked; it must not stop the sandbox again, and it must not replace the reason the run ended for.
 */
describe("meter-only events keep the end that was already decided [pg]", () => {
  const db = pgHarness();

  /** `script` plays the port's side of one run against the target's own handler; its return or throw is what `hookFired` does. */
  async function play(script: (onEvent: (e: NormalizedEvent, meta?: EventMeta) => Promise<void>, stops: () => number) => Promise<void>) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    const harness = createSandboxTargetHarness(db.runWriterPool);
    let stopCount = 0;
    let stopsAtEnd = -1;
    const sandboxPort: SandboxPort = {
      ...harness.deps.sandboxPort,
      async stop(handle) {
        stopCount++;
        return harness.deps.sandboxPort.stop(handle);
      },
      startDetached(handle, opts) {
        const hookFired = (async (): Promise<NormalizedEvent | undefined> => {
          try {
            await script(async (e, meta) => opts.onEvent(e, meta), () => stopCount);
          } finally {
            stopsAtEnd = stopCount;
          }
          return undefined;
        })();
        return { handle, hookFired, launched: Promise.resolve() };
      },
    };
    const target = new SandboxTarget({ ...harness.deps, sandboxPort });
    const input: StartAgentRunInput = {
      accountId, repoId, role: "code-reviewer", product: "team", roleCard: "fake role card", prompt: "fake prompt", model: "haiku-4.5", capUsd: 5, spend: SPEND,
    };
    const result = await startAgentRun(db.runWriterPool, { sandbox: target } satisfies ExecutionTargetRegistry, input);
    if (result.status !== "running") throw new Error(`test setup: expected "running", got "${result.status}"`);
    await waitFor(() => harness.hooks.calls.some((c) => c.hookToken === result.hookToken), "the hook resuming");
    const report = harness.hooks.calls.find((c) => c.hookToken === result.hookToken)!.report;
    const booked = async (): Promise<number[]> => {
      const rows = await db.admin.query(`SELECT usd FROM ledger WHERE account_id = $1 AND run_id = $2 AND budget = 'model'`, [accountId, result.id]);
      return rows.rows.map((r: { usd: string }) => Number(r.usd));
    };
    return { report, stopsAtEnd: () => stopsAtEnd, booked };
  }

  it("a limit end with hidden usage counted afterwards over the cap stays the limit end: no new stop, the spend booked", async () => {
    const limit = { kind: "model_calls" as const, limit: 20, observed: 21 };
    const r = await play(async (onEvent) => {
      await onEvent(usageEvent(10, 1));
      await onEvent(usageEvent(OVER_CAP, 2), META); // resolves: no abort thrown for it
      throw new RunLimitError(limit);
    });
    expect(r.report.status).toBe("timed_out");
    expect(r.report.limit).toEqual(limit);
    expect(r.stopsAtEnd()).toBe(0);
    const booked = await r.booked();
    expect(booked).toHaveLength(1);
    expect(booked[0]).toBeGreaterThan(25); // the counted usage reached the bill
  });

  it("a spend kill stays the first spend kill when more usage and a key answer are counted afterwards", async () => {
    const r = await play(async (onEvent) => {
      const first = await onEvent(usageEvent(OVER_CAP, 1)).then(() => undefined, (e: unknown) => e);
      if (first === undefined) throw new Error("test setup: the first usage did not end the run");
      await onEvent(errorEvent("model returned 401 unauthorized", 2), META);
      await onEvent(usageEvent(OVER_CAP * 2, 3), META);
      throw first;
    });
    expect(r.report.status).toBe("killed_spend");
    expect(r.report.abortReason).toBe("per_run_cap");
    expect(r.stopsAtEnd()).toBe(1); // the one stop the first end issued
    expect((await r.booked()).length).toBe(1);
  });

  it("a key failure stays the key failure when usage over the cap is counted afterwards", async () => {
    const r = await play(async (onEvent) => {
      const first = await onEvent(errorEvent("model returned 401 unauthorized", 1)).then(() => undefined, (e: unknown) => e);
      if (first === undefined) throw new Error("test setup: the key answer did not end the run");
      await onEvent(usageEvent(OVER_CAP, 2), META);
      throw first;
    });
    expect(r.report.status).toBe("failed");
    expect(r.report.failureReason).toBe("model_key_broken");
    expect(r.stopsAtEnd()).toBe(1);
    expect((await r.booked()).length).toBe(1); // the counted usage is booked even though the run did not end for it
  });

  it("the first end stands even for events that are not marked: a later answer does not replace the reason", async () => {
    const first = await play(async (onEvent) => {
      const a = await onEvent(usageEvent(OVER_CAP, 1)).then(() => undefined, (e: unknown) => e);
      await onEvent(errorEvent("model returned 401 unauthorized", 2)).catch(() => undefined);
      throw a;
    });
    expect(first.report.status).toBe("killed_spend");
    const second = await play(async (onEvent) => {
      const a = await onEvent(errorEvent("model returned 401 unauthorized", 1)).then(() => undefined, (e: unknown) => e);
      await onEvent(usageEvent(OVER_CAP, 2)).catch(() => undefined);
      throw a;
    });
    expect(second.report.status).toBe("failed");
    expect(second.report.failureReason).toBe("model_key_broken");
  });

  it("an event that is not meter-only still ends the run as before", async () => {
    const r = await play(async (onEvent) => {
      await onEvent(usageEvent(OVER_CAP, 1));
    });
    expect(r.report.status).toBe("killed_spend");
    expect(r.stopsAtEnd()).toBe(1);
  });
});
