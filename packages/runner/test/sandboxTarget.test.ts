import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { buildExecutionRun } from "../src/startAgentRun.js";
import { DispatchAbortedError, type ExecutionRun } from "../src/executionTarget.js";
import type { CreateSandboxOptions, SandboxHandle, SandboxPort, StartDetachedOptions } from "../src/sandboxPort.js";
import { describeExecutionTargetContract } from "./executionTarget.contract.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { writeRunStatus } from "../src/runStatusWriter.js";
import { pgHarness } from "./helpers/pgHarness.js";

describeExecutionTargetContract("SandboxTarget", (pool) => new SandboxTarget(createSandboxTargetHarness(pool).deps));

/**
 * D#2 H09b, correction C10: `SandboxTarget`-specific behavior the
 * target-agnostic contract suite above deliberately doesn't (and
 * shouldn't) assert.
 */
describe("SandboxTarget", () => {
  const db = pgHarness();

  async function seedRun(): Promise<ExecutionRun> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const runId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await db.admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'production', 'pending')`,
      [runId, accountId],
    );
    return {
      id: runId,
      accountId,
      role: "code-reviewer",
      product: "team",
      repoId,
      roleCard: "fake role card",
      prompt: "fake prompt",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
  }

  it("resumes the hook exactly once, with dispatch's own hookToken and a succeeded report", async () => {
    const harness = createSandboxTargetHarness(db.runWriterPool, [
      { runId: "ignored", role: "code-reviewer", seq: 1, type: "result", ts: new Date().toISOString(), text: "ok" },
    ]);
    const target = new SandboxTarget(harness.deps);
    const run = await seedRun();

    await target.admit(run, db.admin);
    const { hookToken } = await target.dispatch(run);

    // The stub runtime replays its fixed event list synchronously, then
    // resolves -- give the microtask queue one tick for dispatch's own
    // `.then` to run.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.hooks.calls).toHaveLength(1);
    expect(harness.hooks.calls[0]!.hookToken).toBe(hookToken);
    expect(harness.hooks.calls[0]!.report.status).toBe("succeeded");
  });

  it("resumes the hook exactly once with a failed report when the sandbox produces no terminal event", async () => {
    const harness = createSandboxTargetHarness(db.runWriterPool, []);
    const target = new SandboxTarget(harness.deps);
    const run = await seedRun();

    await target.admit(run, db.admin);
    await target.dispatch(run);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.hooks.calls).toHaveLength(1);
    expect(harness.hooks.calls[0]!.report.status).toBe("failed");
  });

  it("X-1: the extension policy reaches the port only when the composition root supplies one, with the target's own meter and event write", async () => {
    const seen: Array<StartDetachedOptions["extension"]> = [];
    const dispatched = async (withPolicy: boolean) => {
      const harness = createSandboxTargetHarness(db.runWriterPool);
      const port = harness.deps.sandboxPort;
      const deps = {
        ...harness.deps,
        sandboxPort: { ...port, startDetached: (h: SandboxHandle, o: StartDetachedOptions) => (seen.push(o.extension), port.startDetached(h, o)) } as SandboxPort,
        ...(withPolicy
          ? { extensionPolicyFor: () => ({ maxExtensions: 2, roleWrites: false, ceilings: { runMs: 1, modelCalls: 1, usd: 1 }, ghWrites: () => 3, reserveExtension: async () => true }) }
          : {}),
      };
      const run = await seedRun();
      const target = new SandboxTarget(deps);
      await target.admit(run, db.admin);
      await target.dispatch(run);
      return run;
    };
    await dispatched(false);
    expect(seen).toEqual([undefined]);
    const run = await dispatched(true);
    const policy = seen[1]!;
    expect(policy).toMatchObject({ maxExtensions: 2 });
    expect(policy.meteredUsd()).toBe(0);
    expect(policy.ghWrites()).toBe(3);
    await policy.onExtended({ kind: "model_calls", extensionsUsed: 1, newLimit: 450, progress: { usage_rose: true, gh_writes: 0, new_message_ids: 5 } });
    const { rows } = await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'limit_extended'`, [run.id]);
    expect(rows.map((r) => r.payload)).toEqual([{ kind: "model_calls", extensions_used: 1, new_limit: 450, progress: { usage_rose: true, gh_writes: 0, new_message_ids: 5 } }]);
  });

  it("H14c-3-2d-1: the run's limits reach startDetached and resume; a run without limits passes none", async () => {
    const limits = { maxTurns: 17, maxModelCalls: 40, maxRunMs: 9 * 60_000, meteringSilenceMs: 11 * 60_000 };
    const seen: Array<{ call: "startDetached" | "resume"; limits: StartDetachedOptions["limits"]; hasKey: boolean }> = [];
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const port = harness.deps.sandboxPort;
    const record = (call: "startDetached" | "resume", o: StartDetachedOptions) => seen.push({ call, limits: o.limits, hasKey: "limits" in o });
    const created: Array<CreateSandboxOptions["limits"]> = [];
    const spied: SandboxPort = {
      ...port,
      createSandbox: (o) => (created.push(o.limits), port.createSandbox(o)),
      startDetached: (h, o) => (record("startDetached", o), port.startDetached(h, o)),
      resume: (h, s, p, o) => (record("resume", o), port.resume(h, s, p, o)),
    };
    const target = new SandboxTarget({ ...harness.deps, sandboxPort: spied });

    const withLimits = { ...(await seedRun()), limits };
    await target.admit(withLimits, db.admin);
    await target.dispatch(withLimits);
    await target.resume(withLimits, "sess-1");
    const without = await seedRun();
    await target.admit(without, db.admin);
    await target.dispatch(without);
    await target.resume(without, "sess-2");

    expect(seen.map((s) => s.call)).toEqual(["startDetached", "resume", "startDetached", "resume"]);
    expect(seen[0]!.limits).toEqual(limits);
    expect(seen[1]!.limits).toEqual(limits);
    expect(seen.slice(2).map((s) => s.hasKey)).toEqual([false, false]);
    // R-CT: the sandbox is created knowing the run's limits, so the port can check its timeout against them.
    expect(created).toEqual([limits, undefined]);
  });

  it("H14c-3-2d-1: startAgentRun's input limits are copied onto the run, and absent stays absent", () => {
    const base = { accountId: "a", repoId: "r", role: "code-reviewer" as const, product: "team" as const, roleCard: "c", prompt: "p", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const } };
    const limits = { maxTurns: 17, maxModelCalls: 40, maxRunMs: 540_000, meteringSilenceMs: 660_000 };
    expect(buildExecutionRun("run-1", { ...base, limits }).limits).toEqual(limits);
    expect(buildExecutionRun("run-1", base).limits).toBeUndefined();
  });

  it("cancel stops the sandbox exactly once across two calls (fakeSandbox.state.stopped)", async () => {
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const target = new SandboxTarget(harness.deps);
    const run = await seedRun();

    await target.admit(run, db.admin);
    await target.dispatch(run);
    await target.cancel(run);
    await target.cancel(run);

    expect(harness.fakeSandbox.state.stopped).toHaveLength(1);
  });

  it("cancel before dispatch: closes the reservation without ever calling createSandbox", async () => {
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const target = new SandboxTarget(harness.deps);
    const run = await seedRun();

    await target.admit(run, db.admin);
    const result = await target.cancel(run);

    expect(harness.fakeSandbox.state.created).toHaveLength(0);
    // CS-2a: never released. No sandbox was ever requested, so the compute row settles $0 ('no_sandbox').
    expect([result.settled_usd, result.released_usd]).toEqual([0, 0]);
  });

  /**
   * PR #85 fix round item 1 (CWE-362/672): a cancel landing WHILE
   * `createSandbox` is still in flight used to have no effect on
   * `dispatch` -- `dispatch` never re-checked anything after
   * `createSandbox` resolved, so it went straight on to `startDetached`
   * regardless of what had happened to the run in the meantime. This
   * gates `createSandbox` on a promise the test resolves ITSELF, after
   * the cancel has already committed its durable status and released
   * the reservation -- "resolves slowly", never "never resolves".
   *
   * Pre-fix (fdc38c4) failure, run against this exact test body:
   *   FAIL  test/sandboxTarget.test.ts > SandboxTarget > PR #85 fix round item 1: ...
   *     AssertionError: expected [Function] to throw an error
   *      - Expected: "DispatchAbortedError"
   *      + Received: nothing thrown -- startDetached ran and the hook
   *        resumed, because `dispatch` never re-checked the run's status
   *        after `createSandbox` resolved.
   *     expect(harness.fakeSandbox.state.deleted).toHaveLength(1)
   *       AssertionError: expected [] to have a length of 1 but got +0
   */
  it("PR #85 fix round item 1: a cancel landing while createSandbox is in flight aborts before startDetached, deletes the sandbox, and settles the compute row (never releasing it) exactly once", async () => {
    const harness = createSandboxTargetHarness(db.runWriterPool);
    let resolveCreate!: (opts: CreateSandboxOptions) => void;
    let inFlight!: () => void;
    const createCalled = new Promise<void>((resolve) => (inFlight = resolve));
    const gatedPort: SandboxPort = {
      ...harness.deps.sandboxPort,
      createSandbox: (opts: CreateSandboxOptions) =>
        new Promise<SandboxHandle>((resolve) => {
          resolveCreate = () => resolve({ runId: "", sandboxName: opts.sandboxName });
          inFlight();
        }),
    };
    const target = new SandboxTarget({ ...harness.deps, sandboxPort: gatedPort });
    const run = await seedRun();

    await target.admit(run, db.admin);
    const dispatchOutcome = target.dispatch(run).catch((err: unknown) => err);
    await createCalled; // the request marker is committed before createSandbox is called

    // "A cancel landing in between": the durable marker commits, and
    // cancel's own release runs, WHILE createSandbox is still unresolved
    // -- mirroring cancelRun.ts's real order (status write, then
    // target.cancel).
    await writeRunStatus(db.runWriterPool, { accountId: run.accountId, runId: run.id, from: "pending", to: "cancelled" });
    await target.cancel(run);

    // CS-2a: the sandbox was requested but no session is known yet, so the compute row cannot be priced and stays open.
    const openBeforeCreateResolves = await db.admin.query(
      `SELECT 1 FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND state = 'open'`,
      [run.accountId, run.id],
    );
    expect(openBeforeCreateResolves.rows).toHaveLength(1);

    // NOW createSandbox resolves -- slowly, after the cancel landed, not
    // never.
    const stopsBeforeCreate = harness.fakeSandbox.state.stopped.length; // the cancel's own stop came before any VM existed
    expect(stopsBeforeCreate).toBe(1);
    resolveCreate({ sandboxName: "unused", retention: { persistent: false }, timeoutMs: 1 });
    const outcome = await dispatchOutcome;

    expect(outcome).toBeInstanceOf(DispatchAbortedError);
    // The just-created sandbox was stopped AFTER it existed (a second stop, not the cancel's earlier one), never
    // started, and is kept (stopped) until its compute settles.
    expect(harness.fakeSandbox.state.stopped).toHaveLength(stopsBeforeCreate + 1);
    expect(harness.fakeSandbox.state.deleted).toHaveLength(0);
    expect(harness.hooks.calls).toHaveLength(0);

    // Never released. At the deadline the row settles once, at the reservation, on the 'fallback' basis.
    await target.settleRunCompute(run, { deadlinePassed: true });
    const ledger = await db.admin.query(`SELECT usd::float AS usd, compute_basis FROM ledger WHERE account_id = $1 AND run_id = $2`, [run.accountId, run.id]);
    expect(ledger.rows).toEqual([{ usd: 1, compute_basis: "fallback" }]);
    const states = await db.admin.query(`SELECT state FROM spend_reservations WHERE account_id = $1 AND run_id = $2`, [run.accountId, run.id]);
    expect(states.rows).toEqual([{ state: "settled" }]);
    expect(harness.fakeSandbox.state.deleted).toHaveLength(1); // ...and only now deleted
  });
});
