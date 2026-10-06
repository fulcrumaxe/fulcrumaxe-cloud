import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { DispatchFailedError } from "../src/executionTarget.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * The queue-TTL timer belongs to one `startAgentRun` call. A call whose dispatch has settled must not leave it armed:
 * a run left queued past its TTL used to fire a `timed_out` write at whatever pool the caller had by then closed, and
 * the runner suite's single worker reported that as an unhandled "Cannot use a pool after calling end on the pool"
 * against an unrelated test file. These tests watch the timer itself (not a sleep), so they do not depend on load.
 */
describe("the queue-TTL timer is released when the dispatch settles [pg]", () => {
  const db = pgHarness();

  afterEach(() => vi.restoreAllMocks());

  async function seedInput(): Promise<StartAgentRunInput> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    return { accountId, repoId, role: "code-reviewer", product: "team", roleCard: "c", prompt: "p", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" } };
  }

  /** Records the timers armed with a given delay and which of them were cleared. Only the delay under test is tracked. */
  function watchTimers(delayMs: number): { armed: unknown[]; cleared: Set<unknown> } {
    const armed: unknown[] = [];
    const cleared = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = (realSet as (...a: unknown[]) => unknown)(fn, ms, ...rest);
      if (ms === delayMs) armed.push(handle);
      return handle;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle: unknown) => {
      cleared.add(handle);
      return (realClear as (h: unknown) => void)(handle);
    }) as typeof clearTimeout);
    return { armed, cleared };
  }

  it("a dispatch that wins the race clears the TTL timer before startAgentRun returns", async () => {
    const TTL = 987_651;
    const timers = watchTimers(TTL);
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const result = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget(harness.deps) }, await seedInput(), TTL);
    expect(result.status).toBe("running");
    expect(timers.armed).toHaveLength(1);
    expect(timers.cleared.has(timers.armed[0])).toBe(true);
  });

  it("a dispatch that fails clears the TTL timer before startAgentRun rejects", async () => {
    const TTL = 987_652;
    const timers = watchTimers(TTL);
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const target = new SandboxTarget({
      ...harness.deps,
      sandboxPort: { ...harness.deps.sandboxPort, createSandbox: () => Promise.reject(new Error("provider down")) },
    });
    await expect(startAgentRun(db.runWriterPool, { sandbox: target }, await seedInput(), TTL)).rejects.toBeInstanceOf(DispatchFailedError);
    expect(timers.armed).toHaveLength(1);
    expect(timers.cleared.has(timers.armed[0])).toBe(true);
  });

  it("a queued start that is released before its TTL leaves nothing to fire on a pool closed afterwards", async () => {
    const TTL = 3000;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const timers = watchTimers(TTL);
      // The caller's own pool, closed the way a finished test file closes its pools.
      const ownPool = createPool(process.env.RUNNER_DATABASE_URL_RUN_WRITER!);
      const harness = createSandboxTargetHarness(ownPool);
      let release: ((err: Error) => void) | undefined;
      const target = new SandboxTarget({
        ...harness.deps,
        sandboxPort: { ...harness.deps.sandboxPort, createSandbox: () => new Promise((_resolve, reject) => void (release = reject)) },
      });
      const started = startAgentRun(ownPool, { sandbox: target }, await seedInput(), TTL);
      const outcome = started.then(
        () => "resolved",
        (err: unknown) => err,
      );
      for (let i = 0; i < 1000 && release === undefined; i++) await new Promise<void>((r) => setImmediate(() => setTimeout(r, 10)));
      expect(timers.armed).toHaveLength(1);
      if (!release) throw new Error("test setup: createSandbox was never reached");
      release(new Error("test: queued start released"));
      expect(await outcome).toBeInstanceOf(DispatchFailedError);
      // The TTL is still in the future here, and it is already disarmed.
      expect(timers.cleared.has(timers.armed[0])).toBe(true);
      await ownPool.end();
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
