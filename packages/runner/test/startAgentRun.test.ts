import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExecutionModeChangedError, startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget, type ModelConnectionPort } from "../src/targets/sandboxTarget.js";
import { DispatchFailedError, type ExecutionRun, type ExecutionTarget, type ExecutionTargetRegistry } from "../src/executionTarget.js";
import { writeRunStatus } from "../src/runStatusWriter.js";
import type { CreateSandboxOptions, SandboxHandle, SandboxPort, StartDetachedOptions, StartDetachedResult } from "../src/sandboxPort.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

describe("startAgentRun", () => {
  const db = pgHarness();

  /** Seeded with the default `execution_mode = 'sandbox'` (the CHECK
   * allows nothing else). The "unregistered mode" test below exercises
   * the resolver's fail-closed path via an empty registry instead. */
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

  it("H09.1: when admit refuses, the run goes pending -> refused_spend, dispatch is never called, and no reservation is left open", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    // D#69 (migration 0606): status is derived -- set the owner_paused_at
    // marker instead of the (now rejected) status literal.
    await db.admin.query(`UPDATE accounts SET owner_paused_at = now() WHERE id = $1`, [accountId]);

    const harness = createSandboxTargetHarness(db.runWriterPool);
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };

    const result = await startAgentRun(db.runWriterPool, registry, baseInput(accountId, repoId));
    expect(result.status).toBe("refused_spend");

    expect(harness.fakeSandbox.state.created).toHaveLength(0);
    const { rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE account_id = $1`, [accountId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("refused_spend");

    const open = await db.admin.query(`SELECT 1 FROM spend_reservations WHERE account_id = $1`, [accountId]);
    expect(open.rows).toHaveLength(0);
  });

  it("pass/fail 10: an unregistered mode ('runner') throws UnknownExecutionModeError before writing anything", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    const emptyRegistry: ExecutionTargetRegistry = {};

    await expect(startAgentRun(db.runWriterPool, emptyRegistry, baseInput(accountId, repoId))).rejects.toThrow(
      "unknown repos.execution_mode",
    );

    const { rows } = await db.admin.query(`SELECT 1 FROM agent_runs WHERE account_id = $1`, [accountId]);
    expect(rows).toHaveLength(0);
    const reservations = await db.admin.query(`SELECT 1 FROM spend_reservations WHERE account_id = $1`, [accountId]);
    expect(reservations.rows).toHaveLength(0);
  });

  it("D#6 R4d-1: a start that names the mode its prompt was built for is refused ExecutionModeChangedError when the repo is in another, before anything is written; the matching mode (and none named) starts", async () => {
    const { accountId, repoId } = await seedRepoFixture(); // execution_mode = 'sandbox'
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };
    const rows = async (table: string) => (await db.admin.query(`SELECT 1 FROM ${table} WHERE account_id = $1`, [accountId])).rows.length;

    await expect(startAgentRun(db.runWriterPool, registry, { ...baseInput(accountId, repoId), expectedExecutionMode: "runner_local" })).rejects.toBeInstanceOf(ExecutionModeChangedError);
    expect(await rows("agent_runs")).toBe(0);
    expect(await rows("spend_reservations")).toBe(0);
    expect(harness.fakeSandbox.state.created).toHaveLength(0);
    expect(new ExecutionModeChangedError().code).toBe("execution_mode_changed");

    // The check is exact: it is not a prefix match and it is not skipped for a mode that merely looks alike.
    for (const wrong of ["", "Sandbox", "sandbox ", "runner"]) await expect(startAgentRun(db.runWriterPool, registry, { ...baseInput(accountId, repoId), expectedExecutionMode: wrong }), JSON.stringify(wrong)).rejects.toBeInstanceOf(ExecutionModeChangedError);
    expect(await rows("agent_runs")).toBe(0);

    await startAgentRun(db.runWriterPool, registry, { ...baseInput(accountId, repoId), expectedExecutionMode: "sandbox" });
    await startAgentRun(db.runWriterPool, registry, baseInput(accountId, repoId));
    expect(await rows("agent_runs")).toBe(2);
  });

  it("pass/fail 11 (queue TTL): when dispatch (createSandbox) never resolves, the run becomes timed_out, cancel has run, and the compute row waits for its figures (never released)", async () => {
    const { accountId, repoId } = await seedRepoFixture();

    const neverFires = (): StartDetachedResult => ({ handle: { runId: "x", sandboxName: "x" }, hookFired: new Promise(() => {}) });
    const hangingPort: SandboxPort = {
      createSandbox: (_opts: CreateSandboxOptions): Promise<SandboxHandle> => new Promise(() => {}), // never resolves
      startDetached: (_handle: SandboxHandle, _opts: StartDetachedOptions): StartDetachedResult => neverFires(),
      extendTimeout: async () => {},
      stop: async () => {},
      resume: (_h: SandboxHandle, _s: string, _p: string, _o: StartDetachedOptions): StartDetachedResult => neverFires(),
      deleteSandbox: async () => {},
      measure: async () => [],
      readCounters: async () => undefined,
      sandboxExists: async () => true,
    };

    const harness = createSandboxTargetHarness(db.runWriterPool);
    const target = new SandboxTarget({ ...harness.deps, sandboxPort: hangingPort });
    const registry: ExecutionTargetRegistry = { sandbox: target };

    const result = await startAgentRun(db.runWriterPool, registry, baseInput(accountId, repoId), 20 /* queueTtlMs */);
    expect(result.status).toBe("timed_out");

    const { rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE account_id = $1`, [accountId]);
    expect(rows[0].status).toBe("timed_out");

    // CS-2a: the sandbox was requested but no session id ever reached us, so it cannot be priced yet: the row
    // stays open, marked for the deferred settle (CS-2b's sweep), and is never released.
    const held = await db.admin.query(
      `SELECT s.state, (a.compute_settle_due_at IS NOT NULL) AS due FROM spend_reservations s JOIN agent_runs a ON a.id = s.run_id WHERE s.account_id = $1`,
      [accountId],
    );
    expect(held.rows).toEqual([{ state: "open", due: true }]);
  });

  it("admitted and dispatched: the run reaches 'running' with a hookToken, and agent_runs.status is 'running'", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };

    const result = await startAgentRun(db.runWriterPool, registry, baseInput(accountId, repoId));
    expect(result.status).toBe("running");
    if (result.status === "running") {
      expect(result.hookToken.length).toBeGreaterThan(0);
    }

    const { rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE account_id = $1`, [accountId]);
    expect(rows[0].status).toBe("running");
  });

  /**
   * PR #85 fix round item 2 (CWE-362): the final `pending -> running` CAS
   * write's result used to be ignored outright -- `startAgentRun`
   * returned `status: "running"` unconditionally, even when the write
   * itself reported `updated: false` because something else already
   * moved the run away from `pending`. This target's own `dispatch`
   * stands in for that "something else": it commits a concurrent cancel
   * BEFORE returning its hookToken, simulating the real race (a
   * `cancelRun` call landing between `admit` and the final write).
   *
   * Pre-fix (fdc38c4) failure, run against this exact test body:
   *   FAIL  test/startAgentRun.test.ts > startAgentRun > PR #85 fix round item 2: ...
   *     AssertionError: expected 'running' to be 'cancelled'
   *      - Expected: "cancelled"
   *      + Received: "running"
   *     (startAgentRun returned status: "running" and a hookToken even
   *      though the CAS write's own `updated` flag was false and the
   *      row's real status was already "cancelled")
   */
  it("PR #85 fix round item 2: a status write that loses the final CAS race returns the run's real terminal status, never 'running'", async () => {
    const { accountId, repoId } = await seedRepoFixture();

    const raceLosingTarget: ExecutionTarget = {
      runtime: "production",
      async admit() {
        return { admitted: true };
      },
      async dispatch(run: ExecutionRun) {
        // Stands in for a concurrent cancelRun call that commits its
        // durable write between admit() and startAgentRun's own final
        // CAS write.
        await writeRunStatus(db.runWriterPool, {
          accountId: run.accountId,
          runId: run.id,
          from: "pending",
          to: "cancelled",
        });
        return { hookToken: "tok-race-lost" };
      },
      async cancel() {
        return { settled_usd: 0, released_usd: 0 };
      },
      async resume() {
        return { hookToken: "tok-resume-unused" };
      },
      async finalize() {
        return { settled_usd: 0, released_usd: 0 };
      },
    };
    const registry: ExecutionTargetRegistry = { sandbox: raceLosingTarget };

    const result = await startAgentRun(db.runWriterPool, registry, baseInput(accountId, repoId));

    expect(result.status).not.toBe("running");
    expect(result.status).toBe("cancelled");
    expect("hookToken" in result).toBe(false);

    const { rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE account_id = $1`, [accountId]);
    expect(rows[0].status).toBe("cancelled");
  });

  /**
   * PR #85 fix round item 3 (CWE-772): a rejecting `dispatch` used to
   * propagate straight out of `startAgentRun`, leaving the run stuck at
   * `pending` forever with its reservation still open and (in this
   * exact scenario) a real sandbox `createSandbox` already created and
   * never cleaned up. `modelConnection.get` rejects here, AFTER
   * `SandboxTarget.dispatch`'s own `createSandbox` call has already
   * succeeded -- matching the brief's "rejecting dispatch after
   * createSandbox" scenario exactly.
   *
   * Pre-fix (fdc38c4) failure, run against this exact test body:
   *   FAIL  test/startAgentRun.test.ts > startAgentRun > PR #85 fix round item 3: ...
   *     AssertionError: promise resolved "Error: modelConnection.get failed" instead of rejecting
   *     (startAgentRun's returned promise rejected with the RAW Error,
   *      not DispatchFailedError, and:)
   *     AssertionError: expected 'pending' to be 'failed'
   *      - Expected: "failed"
   *      + Received: "pending"
   *     AssertionError: expected [ { …1 row… } ] to have a length of 0
   *      (the $1 spend_reservations row was still 'open' -- leaked)
   */
  it("PR #85 fix round item 3: a rejecting dispatch (after createSandbox) writes a terminal failed status, releases the reservation, and re-throws a typed error", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    const harness = createSandboxTargetHarness(db.runWriterPool);
    // H14c-3-1: a missing key is now refused BEFORE createSandbox (below), so
    // this "after createSandbox" case injects its failure at startDetached.
    const failingPort: SandboxPort = {
      ...harness.deps.sandboxPort,
      startDetached() {
        throw new Error("startDetached failed");
      },
    };
    const target = new SandboxTarget({ ...harness.deps, sandboxPort: failingPort });
    const registry: ExecutionTargetRegistry = { sandbox: target };

    await expect(startAgentRun(db.runWriterPool, registry, baseInput(accountId, repoId))).rejects.toThrow(
      DispatchFailedError,
    );

    // createSandbox ran (and succeeded) before the injected failure --
    // this is the "after createSandbox" scenario, not "before dispatch
    // even started".
    expect(harness.fakeSandbox.state.created).toHaveLength(1);

    const { rows } = await db.admin.query(`SELECT id, status FROM agent_runs WHERE account_id = $1`, [accountId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");

    const events = await db.admin.query(
      `SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed'`,
      [rows[0].id],
    );
    expect(events.rows[0].payload).toMatchObject({ from: "pending", to: "failed", failureReason: "internal_error" });

    const open = await db.admin.query(`SELECT 1 FROM spend_reservations WHERE account_id = $1 AND state = 'open'`, [
      accountId,
    ]);
    expect(open.rows).toHaveLength(0);
  });

  it("H14c-3-1: a tenant with no usable key is refused before any sandbox is created, the reservation released", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const noKey: ModelConnectionPort = {
      async get() {
        throw new Error("no connection");
      },
    };
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget({ ...harness.deps, modelConnection: noKey }) };

    await expect(startAgentRun(db.runWriterPool, registry, baseInput(accountId, repoId))).rejects.toThrow(DispatchFailedError);

    expect(harness.fakeSandbox.state.created).toHaveLength(0);
    const { rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE account_id = $1`, [accountId]);
    expect(rows.map((r: { status: string }) => r.status)).toEqual(["failed"]);
    const open = await db.admin.query(`SELECT 1 FROM spend_reservations WHERE account_id = $1 AND state = 'open'`, [accountId]);
    expect(open.rows).toHaveLength(0);
  });
});
