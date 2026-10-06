import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { DispatchFailedError, type ExecutionRun, type ExecutionTargetRegistry } from "../src/executionTarget.js";
import type { SandboxHandle } from "../src/sandboxPort.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";
import type { NormalizedEvent } from "../src/types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * D#219 flake 3: poll on the state the next line needs instead of guessing a
 * fixed sleep. The fake replay, the spend-kill decision (a real Postgres
 * round trip) and the hook resumption are asynchronous and their duration
 * depends on runner load. On timeout it throws naming what never happened.
 * The intentional injected delays elsewhere in this file are NOT replaced by
 * this: they simulate slowness on purpose.
 */
async function waitFor(
  predicate: () => boolean,
  { what, timeoutMs = 5000, intervalMs = 5 }: { what: string; timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`test setup: ${what} never happened within ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

/**
 * D#2 H09b2 fix round 2: pool proxy that runs `hook` once, right after the
 * Nth query whose text starts with `sqlPrefix` resolves -- before handing
 * the result back to its caller. Same technique
 * `cancelRaceAfterSecondRecheck.pg.test.ts`'s own `hookedPool` uses for its
 * SELECT-then-startDetached race, generalized to any query prefix so it can
 * pin a caller mid-transaction at a specific statement rather than only
 * after a fixed one. Used below to force two concurrent racers into the
 * exact overlap window an advisory lock is supposed to make impossible.
 */
function hookedQuery(pool: Pool, sqlPrefix: string, nth: number, hook: () => void | Promise<void>): Pool {
  let count = 0;
  return new Proxy(pool, {
    get(t, k) {
      if (k === "connect") {
        return async () => {
          const c = await t.connect();
          return new Proxy(c, {
            get(ct, ck) {
              if (ck === "query") {
                return async (sql: unknown, params?: unknown) => {
                  const r = await (ct as PoolClient).query(sql as string, params as unknown[]);
                  if (typeof sql === "string" && sql.startsWith(sqlPrefix)) {
                    count++;
                    if (count === nth) await hook();
                  }
                  return r;
                };
              }
              const v = (ct as unknown as Record<string | symbol, unknown>)[ck];
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(ct) : v;
            },
          });
        };
      }
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as Pool;
}

/**
 * D#2 H09b2 (C10's revised criteria 2 and 4, H09.5/H09.8): key-failure
 * handling and mid-run spend-kill, both wired into `SandboxTarget.dispatch`'s
 * `onEvent` and finished off by `finalize`. [pg]: real Postgres, zero model
 * tokens.
 */
describe("D#2 H09b2: key failure and mid-run spend kill [pg]", () => {
  const db = pgHarness();

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

  /**
   * `SandboxTarget` only RESUMES the hook (via the injected
   * `HookResumePort`) once a dispatched run's outcome is known -- calling
   * `finalize` with the report the hook carried is the ORCHESTRATOR's job
   * (`workflows/agentRun.ts`, not built as a real Vercel Workflow endpoint
   * in this PR -- see that file's own header). This test stands in for
   * that orchestrator: it waits for the hook to resume, then calls
   * `target.finalize` with the exact report the hook received, exactly as
   * the real wrapper would.
   */
  async function runToFinalize(
    accountId: string,
    repoId: string,
    events: NormalizedEvent[],
  ): Promise<{ target: SandboxTarget; harness: ReturnType<typeof createSandboxTargetHarness>; runId: string }> {
    const harness = createSandboxTargetHarness(db.runWriterPool, events);
    const target = new SandboxTarget(harness.deps);
    const registry: ExecutionTargetRegistry = { sandbox: target };
    const result = await startAgentRun(db.runWriterPool, registry, baseInput(accountId, repoId));
    if (result.status !== "running") throw new Error(`test setup: expected "running", got "${result.status}"`);
    const hookResumed = () => harness.hooks.calls.some((c) => c.hookToken === result.hookToken);
    await waitFor(hookResumed, { what: "the hook resuming after the fake runtime's replay" });
    const call = harness.hooks.calls.find((c) => c.hookToken === result.hookToken)!;
    await target.finalize(
      {
        id: result.id,
        accountId,
        role: "code-reviewer",
        product: "team",
        roleCard: "fake role card",
        prompt: "fake prompt",
        model: "haiku-4.5",
        capUsd: 5,
        spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
      },
      call.report,
    );
    return { target, harness, runId: result.id };
  }

  it("H09.5: a fake 401 stops the run, calls markBroken, and writes failed/model_key_broken", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    const errorEvent: NormalizedEvent = {
      runId: "placeholder",
      role: "code-reviewer",
      seq: 1,
      type: "error",
      ts: new Date().toISOString(),
      isError: true,
      text: "model returned 401 unauthorized",
    };

    const { harness, runId } = await runToFinalize(accountId, repoId, [errorEvent]);

    const row = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId]);
    expect(row.rows[0].status).toBe("failed");

    expect(harness.connectionStatus.calls).toEqual([{ runId, code: 401 }]);

    const events = await db.admin.query(
      `SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed'`,
      [runId],
    );
    expect(events.rows.some((e: { payload: { failureReason?: string } }) => e.payload.failureReason === "model_key_broken")).toBe(
      true,
    );
  });

  it("H09.5: a fake 402 (quota_for_entity_exceeded) stops the run WITHOUT calling markBroken", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    const errorEvent: NormalizedEvent = {
      runId: "placeholder",
      role: "code-reviewer",
      seq: 1,
      type: "error",
      ts: new Date().toISOString(),
      isError: true,
      text: "quota_for_entity_exceeded",
    };
    const { harness, runId } = await runToFinalize(accountId, repoId, [errorEvent]);

    const row = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId]);
    expect(row.rows[0].status).toBe("failed");
    expect(harness.connectionStatus.calls).toEqual([]);
  });

  it("H09.5: pauses every OTHER queued (pending) run for the same tenant", async () => {
    const { accountId, repoId } = await seedRepoFixture();

    // Seed a second, separately-queued run for the SAME account by
    // starting it against a permanently-hanging sandbox port (never
    // reaches "running" -> "pending" forever, exactly what "queued" means).
    const hangingHarness = createSandboxTargetHarness(db.runWriterPool);
    // Held until the end of the test, then failed: the queued run's start must be finished (and its queue-TTL timer
    // cleared) before this file's pools close, or the timer fires later against a closed pool.
    let releaseCreate: (err: Error) => void = () => {};
    const hangingTarget = new SandboxTarget({
      ...hangingHarness.deps,
      sandboxPort: {
        ...hangingHarness.deps.sandboxPort,
        createSandbox: () => new Promise((_resolve, reject) => void (releaseCreate = reject)),
      },
    });
    const queuedPromise = startAgentRun(db.runWriterPool, { sandbox: hangingTarget }, baseInput(accountId, repoId), 60_000);
    queuedPromise.catch(() => {}); // an early assertion failure below must not leave this start as an unhandled rejection
    // Poll rather than a fixed sleep: the INSERT (pending) happens before
    // admit/dispatch, but exactly how long that takes depends on system
    // load when this suite runs alongside the rest of the workspace.
    let queuedRow: { id: string; status: string } | undefined;
    for (let i = 0; i < 200 && !queuedRow; i++) {
      const { rows } = await db.admin.query(
        `SELECT id, status FROM agent_runs WHERE account_id = $1 ORDER BY created_at`,
        [accountId],
      );
      queuedRow = rows[0];
      if (!queuedRow) await sleep(10);
    }
    if (!queuedRow) throw new Error("test setup: queued run row never appeared");
    expect(queuedRow.status).toBe("pending");
    const queuedRunId = queuedRow.id;

    const errorEvent: NormalizedEvent = {
      runId: "placeholder",
      role: "code-reviewer",
      seq: 1,
      type: "error",
      ts: new Date().toISOString(),
      isError: true,
      text: "403 forbidden",
    };
    await runToFinalize(accountId, repoId, [errorEvent]);

    const after = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [queuedRunId]);
    expect(after.rows[0].status).toBe("paused");

    // Dispose the queued start: fail its sandbox creation and wait for the start to finish before the pools close.
    releaseCreate(new Error("test: queued start released"));
    await expect(queuedPromise).rejects.toBeInstanceOf(DispatchFailedError);
  });

  it("H09.8: crossing the per-spawn cap mid-run kills the run -- killed_spend, stopped within one tick", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    const usageEvent: NormalizedEvent = {
      runId: "placeholder",
      role: "code-reviewer",
      seq: 1,
      type: "assistant",
      ts: new Date().toISOString(),
      usage: { inputTokens: 10_000_000, outputTokens: 10_000_000 }, // wildly over any cap
    };
    const harness = createSandboxTargetHarness(db.runWriterPool, [usageEvent]);
    const stopped: string[] = [];
    const target = new SandboxTarget({
      ...harness.deps,
      sandboxPort: {
        ...harness.deps.sandboxPort,
        async stop(handle) {
          stopped.push(handle.sandboxName);
          return harness.deps.sandboxPort.stop(handle);
        },
      },
    });
    const registry: ExecutionTargetRegistry = { sandbox: target };
    const input: StartAgentRunInput = {
      ...baseInput(accountId, repoId),
      model: "haiku-4.5",
      spend: {
        plan: "starter",
        estimateComputeUsd: 1,
        trigger: "foreground",
        estimateModelUsd: 0.001,
        monthlyModelBudgetUsd: 1000,
        perSpawnCapUsd: 0.01,
      },
    };
    const result = await startAgentRun(db.runWriterPool, registry, input);
    if (result.status !== "running") throw new Error(`test setup: expected "running", got "${result.status}"`);
    await waitFor(() => stopped.length >= 1, { what: "the spend kill stopping the sandbox" });

    expect(stopped.length).toBeGreaterThanOrEqual(1);

    await waitFor(() => harness.hooks.calls.some((c) => c.hookToken === result.hookToken), {
      what: "the hook resuming after the spend kill",
    });
    const call = harness.hooks.calls.find((c) => c.hookToken === result.hookToken)!;
    expect(call.report.status).toBe("killed_spend");
    await target.finalize(
      {
        id: result.id,
        accountId,
        role: "code-reviewer",
        product: "team",
        roleCard: "fake role card",
        prompt: "fake prompt",
        model: "haiku-4.5",
        capUsd: 5,
        spend: input.spend,
      },
      call.report,
    );

    const row = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [result.id]);
    expect(row.rows[0].status).toBe("killed_spend");
  });

  // ~$30 on haiku-4.5 -- wildly over any small cap used below.
  const bigUsageEvent: NormalizedEvent = {
    runId: "placeholder",
    role: "code-reviewer",
    seq: 1,
    type: "assistant",
    ts: new Date().toISOString(),
    usage: { inputTokens: 30_000_000, outputTokens: 0 },
  };

  function runFor(id: string, accountId: string, spend: StartAgentRunInput["spend"]): Parameters<SandboxTarget["finalize"]>[0] {
    return { id, accountId, role: "code-reviewer", product: "team", roleCard: "fake role card", prompt: "fake prompt", model: "haiku-4.5", capUsd: 5, spend };
  }

  it("S-MUST 1 (D#2 H09b2 fix round 1, CWE-840/682): a killed_spend run settles its real cost -- ledger reflects it, and a second run under a lower cap is refused at admit", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    const harness = createSandboxTargetHarness(db.runWriterPool, [bigUsageEvent]);
    const target = new SandboxTarget(harness.deps);
    const spend = { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const, estimateModelUsd: 0.001, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 0.01 };
    const input: StartAgentRunInput = { ...baseInput(accountId, repoId), model: "haiku-4.5", spend };
    const result = await startAgentRun(db.runWriterPool, { sandbox: target }, input);
    if (result.status !== "running") throw new Error(`test setup: expected "running", got "${result.status}"`);
    // the kill decision does a real Postgres round trip (S-MUST 2)
    await waitFor(() => harness.hooks.calls.some((c) => c.hookToken === result.hookToken), {
      what: "the hook resuming after the spend kill's Postgres round trip",
    });
    const call = harness.hooks.calls.find((c) => c.hookToken === result.hookToken)!;
    expect(call.report.status).toBe("killed_spend");
    await target.finalize(runFor(result.id, accountId, spend), call.report);

    // Failing-first on 0a9adfb: this returned zero rows -- buildAbortTerminalReport's
    // spend_kill branch omitted `usd`, so finalize's settle/release loop always
    // released (no ledger row at all) instead of settling.
    const ledgerRows = await db.admin.query(`SELECT usd FROM ledger WHERE account_id = $1 AND run_id = $2 AND budget = 'model'`, [
      accountId,
      result.id,
    ]);
    expect(ledgerRows.rows).toHaveLength(1);
    const settledUsd = Number(ledgerRows.rows[0].usd);
    expect(settledUsd).toBeGreaterThan(25);

    // monthToDateUsd's own aggregate for this account/budget -- nothing is
    // open anymore (settled above), so this equals the ledger sum.
    const mtd = await db.admin.query(
      `SELECT COALESCE(SUM(usd), 0)::text AS sum FROM ledger WHERE account_id = $1 AND budget = 'model'`,
      [accountId],
    );
    expect(Number(mtd.rows[0].sum)).toBe(settledUsd);

    // A second run, same tenant, monthly budget $25 (below the ~$30 already
    // truly incurred) -- must be REFUSED, not admitted against a ledger
    // that (pre-fix) still read back $0.
    const secondSpend = { ...spend, monthlyModelBudgetUsd: 25 };
    const secondInput: StartAgentRunInput = { ...baseInput(accountId, repoId), model: "haiku-4.5", spend: secondSpend };
    const secondHarness = createSandboxTargetHarness(db.runWriterPool);
    const secondResult = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget(secondHarness.deps) }, secondInput);
    expect(secondResult.status).toBe("refused_spend");
  });

  it("S-MUST 2 (D#2 H09b2 fix round 1, CWE-362): two concurrent same-tenant runs racing a shared cap both settle and are killed promptly, bounded combined overshoot", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    // perSpawnCapUsd huge -- only the SHARED monthly cap can kill here,
    // isolating S-MUST 2 (cross-run visibility) from the already-correct,
    // single-run-local per-spawn check.
    const spend = { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const, estimateModelUsd: 0.001, monthlyModelBudgetUsd: 0.02, perSpawnCapUsd: 1000 };
    const harnessA = createSandboxTargetHarness(db.runWriterPool, [bigUsageEvent]);
    const harnessB = createSandboxTargetHarness(db.runWriterPool, [bigUsageEvent]);
    const stoppedA: string[] = [];
    const stoppedB: string[] = [];
    // D#219 flake 3 (found by the 30-run contention loop): the two runs must
    // BOTH be admitted before either one's kill settles, or the cap correctly
    // refuses the second admit ("refused_spend") and the test's premise --
    // two admitted racers -- is gone. `admit` precedes `dispatch`, and
    // `decryptTenantKey` is the first thing dispatch awaits, so holding each
    // run there until both have arrived orders "both admitted" before "either
    // killed" by construction instead of by luck. If one run is refused it
    // never arrives; the barrier gives up after 5s so the startAgentRun
    // status check below reports the real cause.
    let arrived = 0;
    let releaseBarrier!: () => void;
    const bothAdmitted = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
      setTimeout(resolve, 5000).unref();
    });
    const wrapStop = (harness: ReturnType<typeof createSandboxTargetHarness>, sink: string[]) => ({
      ...harness.deps,
      decryptTenantKey: async (...args: Parameters<typeof harness.deps.decryptTenantKey>) => {
        arrived += 1;
        if (arrived >= 2) releaseBarrier();
        await bothAdmitted;
        return harness.deps.decryptTenantKey(...args);
      },
      sandboxPort: {
        ...harness.deps.sandboxPort,
        async stop(handle: SandboxHandle) {
          sink.push(handle.sandboxName);
          return harness.deps.sandboxPort.stop(handle);
        },
      },
    });
    const targetA = new SandboxTarget(wrapStop(harnessA, stoppedA));
    const targetB = new SandboxTarget(wrapStop(harnessB, stoppedB));
    const inputA: StartAgentRunInput = { ...baseInput(accountId, repoId), model: "haiku-4.5", spend };
    const inputB: StartAgentRunInput = { ...baseInput(accountId, repoId), model: "haiku-4.5", spend };

    const [resultA, resultB] = await Promise.all([
      startAgentRun(db.runWriterPool, { sandbox: targetA }, inputA),
      startAgentRun(db.runWriterPool, { sandbox: targetB }, inputB),
    ]);
    if (resultA.status !== "running" || resultB.status !== "running") {
      throw new Error(`test setup: expected both "running", got "${resultA.status}"/"${resultB.status}"`);
    }
    await waitFor(() => stoppedA.length >= 1, { what: "run A's spend kill stopping its sandbox" });
    await waitFor(() => stoppedB.length >= 1, { what: "run B's spend kill stopping its sandbox" });

    expect(stoppedA.length).toBeGreaterThanOrEqual(1);
    expect(stoppedB.length).toBeGreaterThanOrEqual(1);

    await waitFor(() => harnessA.hooks.calls.some((c) => c.hookToken === resultA.hookToken), {
      what: "run A's hook resuming after its spend kill",
    });
    await waitFor(() => harnessB.hooks.calls.some((c) => c.hookToken === resultB.hookToken), {
      what: "run B's hook resuming after its spend kill",
    });
    const callA = harnessA.hooks.calls.find((c) => c.hookToken === resultA.hookToken)!;
    const callB = harnessB.hooks.calls.find((c) => c.hookToken === resultB.hookToken)!;
    expect(callA.report.status).toBe("killed_spend");
    expect(callB.report.status).toBe("killed_spend");

    await targetA.finalize(runFor(resultA.id, accountId, spend), callA.report);
    await targetB.finalize(runFor(resultB.id, accountId, spend), callB.report);

    // Failing-first on 0a9adfb: both runs killed from the SAME stale $0
    // snapshot at their own dispatch, blind to each other, and (pre
    // S-MUST-1) neither settled anything. Bound achieved (see
    // meterModelUnderLock's doc comment): each racing run can cross the
    // cap by at most its own one in-flight event before the lock
    // serializes and settles it -- combined spend here is bounded by the
    // 2 runs' own 2 real events, not erased and not multiplied further.
    const ledgerRows = await db.admin.query(`SELECT usd FROM ledger WHERE account_id = $1 AND budget = 'model'`, [
      accountId,
    ]);
    expect(ledgerRows.rows).toHaveLength(2);
    const combined = ledgerRows.rows.reduce((sum: number, r: { usd: string }) => sum + Number(r.usd), 0);
    expect(combined).toBeGreaterThan(25);
    expect(combined).toBeLessThan(70);
  });

  it("D#2 H09b2 fix round 2 MUST (double-settle race, CWE-362/840): a cancel() racing a metered kill's own settle produces exactly one ledger row", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    // perSpawnCapUsd=5: the tiny first event stays well under it ("continue"),
    // the ~$30 second event blows straight through it ("kill"). Two events on
    // ONE run so `bk.cumulativeModelUsd` is still the FIRST event's tiny,
    // already-settled-elsewhere value (>0, so `cancel()` believes there is
    // something real to settle) at the moment `cancel()` races the second
    // event's own in-flight kill.
    const spend = {
      plan: "starter" as const,
      estimateComputeUsd: 1,
      trigger: "foreground" as const,
      estimateModelUsd: 0.001,
      monthlyModelBudgetUsd: 1000,
      perSpawnCapUsd: 5,
    };
    const tinyEvent: NormalizedEvent = {
      runId: "placeholder",
      role: "code-reviewer",
      seq: 1,
      type: "assistant",
      ts: new Date().toISOString(),
      usage: { inputTokens: 1_000, outputTokens: 0 }, // ~$0.001 -- "continue"
    };

    let killLockHeld = false;
    // Pause the KILL event's own `meterModelUnderLock` call right after it
    // takes the advisory lock, before it reads/decides/settles -- the
    // exact window `cancel()` must not be able to slip a second settle
    // into. This is the 4th `pg_advisory_xact_lock` acquisition on this
    // pool, not the 1st: `admit()` (reserve.ts) itself takes the SAME
    // `accountId:model` lock (and the `accountId:foreground_compute` one,
    // sorted first) once before this run ever dispatches -- slots 1-2 --
    // and the harmless tiny "continue" event's own metering call is slot
    // 3. The real kill event's own lock is slot 4.
    const pool = hookedQuery(db.runWriterPool, "SELECT pg_advisory_xact_lock", 4, async () => {
      killLockHeld = true;
      await sleep(250);
    });
    const harness = createSandboxTargetHarness(db.runWriterPool, [tinyEvent, bigUsageEvent]);
    const target = new SandboxTarget({ ...harness.deps, pool });
    const input: StartAgentRunInput = { ...baseInput(accountId, repoId), model: "haiku-4.5", spend };
    const result = await startAgentRun(db.runWriterPool, { sandbox: target }, input);
    if (result.status !== "running") throw new Error(`test setup: expected "running", got "${result.status}"`);

    for (let i = 0; i < 200 && !killLockHeld; i++) await sleep(5);
    if (!killLockHeld) throw new Error("test setup: the kill event never reached its locked settle section");

    // Race `cancel()` straight into the kill's held-lock window. Pre-fix,
    // this read its own `spend_reservations` snapshot outside any lock,
    // saw the row still 'open' (the kill's settle hadn't committed yet),
    // and settled the STALE $0.001 `bk.cumulativeModelUsd` itself -- then
    // the kill's own unconditional ledger INSERT landed on top of it: two
    // ledger rows for one run+budget. Post-fix, `cancel()` blocks on the
    // SAME lock and its fresh re-read sees 'settled', not 'open'.
    const run: ExecutionRun = {
      id: result.id,
      accountId,
      role: "code-reviewer",
      product: "team",
      roleCard: "fake role card",
      prompt: "fake prompt",
      model: "haiku-4.5",
      capUsd: 5,
      spend,
    };
    await target.cancel(run);
    await sleep(300); // clear the kill event's own 250ms injected delay

    const call = harness.hooks.calls.find((c) => c.hookToken === result.hookToken);
    if (!call) throw new Error("test setup: hook never resumed");
    await target.finalize(run, call.report);

    const ledgerRows = await db.admin.query(`SELECT usd FROM ledger WHERE account_id = $1 AND run_id = $2 AND budget = 'model'`, [
      accountId,
      result.id,
    ]);
    expect(ledgerRows.rows).toHaveLength(1);
    expect(Number(ledgerRows.rows[0].usd)).toBeGreaterThan(25);
  });

  it("D#2 H09b2 fix round 2 (lock-proof S-MUST 2): a same-tenant admit() blocks on the SAME lock a mid-run kill holds, so it never admits against a pre-commit snapshot", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    // Shared $10 monthly budget, huge per-spawn cap -- only the shared
    // total can kill run A; B's own admit-time estimate (0.001) is far too
    // small to be denied on its own -- it can ONLY be denied by seeing A's
    // real, settled spend.
    const spend = {
      plan: "starter" as const,
      estimateComputeUsd: 1,
      trigger: "foreground" as const,
      estimateModelUsd: 0.001,
      monthlyModelBudgetUsd: 10,
      perSpawnCapUsd: 1000,
    };
    // Run A: $20 alone, always over the shared $10 budget -- killed and
    // settled regardless of any race.
    const bigEvent: NormalizedEvent = { ...bigUsageEvent, usage: { inputTokens: 20_000_000, outputTokens: 0 } };

    let aReadMtd = false;
    // Pause run A's own MID-RUN `monthToDateUsd` call (inside
    // `meterModelUnderLock`, the ledger-sum half of it) for 200ms, INSIDE
    // its locked transaction, right after the read -- before it decides or
    // settles. Gated on the ledger-sum query text itself (always runs,
    // lock present or not) rather than on the lock acquisition, so this
    // same setup is what actually exercises the mutation.
    //
    // nth=3, not 1: `admit()` (reserve.ts) calls the SAME `monthToDateUsd`
    // helper twice on ITS OWN account, once for the 'model' budget check
    // and once for the 'foreground_compute' one, before this run ever
    // dispatches -- slots 1-2. The real mid-run kill check is slot 3.
    //
    // `admit()` also always takes the SAME `accountId:model` advisory lock
    // before its own monthly-budget check, unconditionally -- that part
    // isn't this fix round's code. What the round-1 `meterModelUnderLock`
    // fix controls is whether run A's kill-time settle ALSO holds that
    // lock while it commits. With it: B's admit() blocks on that lock
    // until A's real $20 is committed, then correctly sees committed
    // spend already over budget and refuses B outright. Without it (the
    // mutation): A's mid-run transaction holds no lock, so B's admit()
    // runs uncontested, reads a stale pre-commit total (only A's tiny
    // $0.001 open reservation), and wrongly admits B.
    const poolA = hookedQuery(
      db.runWriterPool,
      "SELECT COALESCE(SUM(usd), 0)::text AS sum FROM ledger",
      3,
      async () => {
        aReadMtd = true;
        await sleep(200);
      },
    );
    const harnessA = createSandboxTargetHarness(db.runWriterPool, [bigEvent]);
    const harnessB = createSandboxTargetHarness(db.runWriterPool);
    const targetA = new SandboxTarget({ ...harnessA.deps, pool: poolA });
    const targetB = new SandboxTarget(harnessB.deps);
    const inputA: StartAgentRunInput = { ...baseInput(accountId, repoId), model: "haiku-4.5", spend };
    const inputB: StartAgentRunInput = { ...baseInput(accountId, repoId), model: "haiku-4.5", spend };

    const resultA = await startAgentRun(db.runWriterPool, { sandbox: targetA }, inputA);
    if (resultA.status !== "running") throw new Error(`test setup: expected "running", got "${resultA.status}"`);

    for (let i = 0; i < 200 && !aReadMtd; i++) await sleep(5);
    if (!aReadMtd) throw new Error("test setup: run A never reached its own monthToDateUsd read");

    // B's admit() races straight into A's held-lock window.
    const resultB = await startAgentRun(db.runWriterPool, { sandbox: targetB }, inputB);
    await sleep(300); // clear A's 200ms injected delay plus its own settle/commit

    const callA = harnessA.hooks.calls.find((c) => c.hookToken === resultA.hookToken);
    if (!callA) throw new Error("test setup: run A's hook never resumed");
    await targetA.finalize(runFor(resultA.id, accountId, spend), callA.report);

    // The lock's whole job here: B's admit() must be forced to wait for
    // A's real, committed spend before it can decide -- never let through
    // on a pre-commit snapshot. Without the lock this reads stale and
    // wrongly admits B (`resultB.status === "running"`).
    expect(resultB.status).toBe("refused_spend");
    const ledgerRows = await db.admin.query(`SELECT usd FROM ledger WHERE account_id = $1 AND budget = 'model'`, [
      accountId,
    ]);
    expect(ledgerRows.rows).toHaveLength(1);
  });
});
