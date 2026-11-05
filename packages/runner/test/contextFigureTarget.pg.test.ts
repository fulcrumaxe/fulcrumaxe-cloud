import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContextLedgerCapture, type ContextLedgerMeasure } from "@fulcrumaxe/runner-protocol";
import { buildExecutionRun, startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { SandboxPort, StartDetachedOptions } from "../src/sandboxPort.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * [pg] D#600 CX-9b: a sandbox run's context figure reaches `run_context_figure` while the run goes on (the port's `onContextFigure`) and once more at the end (from the
 * ledger measure), the newest figure always wins, and a figure that cannot be stored never fails the run.
 */
describe("sandbox target records the context figure [pg] (D#600 CX-9b)", () => {
  const db = pgHarness();

  const measureOf = (windowTokens?: number): ContextLedgerMeasure => {
    const c = new ContextLedgerCapture();
    c.observe({ type: "assistant", message: { id: "m1", content: [], usage: { input_tokens: 4, cache_creation_input_tokens: 6, cache_read_input_tokens: 90 } } });
    c.observe({ type: "assistant", message: { id: "m2", content: [], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 150 } } });
    return { ...c.snapshot(), ...(windowTokens === undefined ? {} : { window_tokens: windowTokens }) };
  };

  /** A started run whose fake port hands the test the stream's callbacks, as the real port calls them. */
  async function started(measure?: ContextLedgerMeasure) {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 5 });
    const input: StartAgentRunInput = {
      accountId, repoId, workItemId, role: "code-reviewer", product: "team", roleCard: "rc", prompt: "p", model: "haiku-4.5", capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
    const h = createSandboxTargetHarness(db.runWriterPool);
    let opts: StartDetachedOptions | undefined;
    const port: SandboxPort = {
      ...h.deps.sandboxPort,
      startDetached(handle, o) {
        opts = o;
        const out = h.deps.sandboxPort.startDetached(handle, o);
        if (measure !== undefined) o.onContextLedger?.(measure);
        return out;
      },
    };
    const target = new SandboxTarget({ ...h.deps, sandboxPort: port });
    const result = await startAgentRun(db.runWriterPool, { sandbox: target }, input);
    if (result.status !== "running") throw new Error("run did not start");
    await sleep(30);
    return { accountId, id: result.id, target, run: buildExecutionRun(result.id, input), figure: (tokens: number, window?: number) => opts!.onContextFigure!(tokens, window) };
  }
  const figureOf = async (accountId: string, id: string) =>
    (await db.admin.query("SELECT last_context_tokens, window_tokens FROM run_context_figure WHERE account_id = $1 AND run_id = $2", [accountId, id])).rows;
  const until = async (read: () => Promise<unknown[]>, ok: (rows: unknown[]) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const rows = await read();
      if (ok(rows)) return rows;
      await sleep(20);
    }
    return read();
  };

  it("a live run has its figure before it ends, and each turn replaces it (the context can fall after a compaction)", async () => {
    const s = await started();
    s.figure(60_000, 200_000);
    expect(await until(() => figureOf(s.accountId, s.id), (r) => r.length === 1)).toEqual([{ last_context_tokens: "60000", window_tokens: "200000" }]);
    s.figure(150_000, 200_000);
    expect(await until(() => figureOf(s.accountId, s.id), (r) => (r[0] as { last_context_tokens: string }).last_context_tokens === "150000")).toEqual([{ last_context_tokens: "150000", window_tokens: "200000" }]);
    s.figure(40_000, 200_000);
    expect(await until(() => figureOf(s.accountId, s.id), (r) => (r[0] as { last_context_tokens: string }).last_context_tokens === "40000")).toEqual([{ last_context_tokens: "40000", window_tokens: "200000" }]);
  });

  it("a burst of turns ends on the newest figure, never an older one that finished writing later", async () => {
    const s = await started();
    for (let t = 1; t <= 30; t++) s.figure(t * 1000, 200_000);
    expect(await until(() => figureOf(s.accountId, s.id), (r) => (r[0] as { last_context_tokens: string } | undefined)?.last_context_tokens === "30000")).toEqual([{ last_context_tokens: "30000", window_tokens: "200000" }]);
  });

  it("a model with no window stores the figure and no window (window not known, no percent)", async () => {
    const s = await started();
    s.figure(5_000, undefined);
    expect(await until(() => figureOf(s.accountId, s.id), (r) => r.length === 1)).toEqual([{ last_context_tokens: "5000", window_tokens: null }]);
  });

  it("finalize stores the end figure from the measure even when no live write happened, with the window the port named", async () => {
    const s = await started(measureOf(200_000));
    await s.target.finalize(s.run, { status: "succeeded", usd: 0.1 });
    expect(await figureOf(s.accountId, s.id)).toEqual([{ last_context_tokens: "151", window_tokens: "200000" }]);
  });

  it("finalize waits for a live write in flight, so the end figure is the one that stays", async () => {
    const s = await started(measureOf(200_000));
    s.figure(999_999, 200_000);
    await s.target.finalize(s.run, { status: "succeeded", usd: 0.1 });
    expect(await figureOf(s.accountId, s.id)).toEqual([{ last_context_tokens: "151", window_tokens: "200000" }]);
  });

  it("a run whose stream reported no usage has no figure row (Not recorded), not a row of zeros", async () => {
    const c = new ContextLedgerCapture();
    c.observe({ type: "system", subtype: "init" });
    const s = await started(c.snapshot());
    await s.target.finalize(s.run, { status: "succeeded", usd: 0.1 });
    expect(await figureOf(s.accountId, s.id)).toEqual([]);
  });

  it("a figure that cannot be stored (not a whole number) is dropped, and the run still finishes", async () => {
    const s = await started(measureOf(200_000));
    s.figure(Number.NaN, 200_000);
    s.figure(-5, 200_000);
    await sleep(100);
    expect(await figureOf(s.accountId, s.id)).toEqual([]);
    await expect(s.target.finalize(s.run, { status: "succeeded", usd: 0.1 })).resolves.toBeDefined();
    expect(await figureOf(s.accountId, s.id)).toEqual([{ last_context_tokens: "151", window_tokens: "200000" }]);
  });
});
