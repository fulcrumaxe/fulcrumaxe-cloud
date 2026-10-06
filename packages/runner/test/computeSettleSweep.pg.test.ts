import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reserve } from "@fx/spend";
import type { Pool } from "pg";
import { sweepComputeSettle, SWEEP_BATCH_SIZE, SWEEP_RUN_WORST_CASE_MS, SWEEP_TIME_BUDGET_MS, type ComputeSettler, type SweepDeps } from "../src/computeSettleSweep.js";
import { buildExecutionRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { SandboxPortError } from "../src/vercelSandboxPort.js";
import { sandboxNameFor } from "../src/sandboxNaming.js";
import type { SandboxPort } from "../src/sandboxPort.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(Math.random() * 20);

/** D#2 COMPUTE-SETTLE CS-2b-1: the deferred settle sweep (criteria 16-18 and 21-23). [pg] */
describe("D#2 COMPUTE-SETTLE CS-2b-1: the deferred settle sweep [pg]", () => {
  const db = pgHarness();
  /** Vercel's full figures for session "s1" = 0.466 at the test data's rates; the same session before CPU and network are reported. */
  const FULL = { sessionId: "s1", memoryMb: 4096, region: "iad1", durationMs: 300_000, activeCpuMs: 60_000, egressBytes: 2.2e9 };
  const LATE = { sessionId: "s1", memoryMb: 4096, region: "iad1", durationMs: 300_000 };
  const COUNTERS = { cpuMs: 61_000, txBytes: 10, uptimeMs: 299_000 };

  // Every [pg] file shares one database: runs other files left due must not crowd this file's batches.
  beforeEach(async () => {
    await db.admin.query(`UPDATE agent_runs SET compute_settle_due_at = NULL WHERE compute_settle_due_at IS NOT NULL`);
  });

  function newHarness(wrap?: (port: SandboxPort) => SandboxPort) {
    const h = createSandboxTargetHarness(db.runWriterPool);
    const deps = wrap ? { ...h.deps, sandboxPort: wrap(h.deps.sandboxPort) } : h.deps;
    return { h, target: new SandboxTarget(deps) };
  }

  interface DueOpts { accountId?: string; role?: string; repoId?: string; ids?: string[]; ageS?: number; reserved?: number; requested?: boolean; noStop?: boolean }
  /** An ended run owing its settle: marker, ids and stop time set by hand, an open $0.01 reservation, due since `ageS` ago. */
  async function dueRun(o: DueOpts = {}) {
    const accountId = o.accountId ?? randomUUID();
    if (!o.accountId) await seedAccount(db.admin, accountId);
    const id = randomUUID();
    const role = o.role ?? "code-reviewer";
    const executor = role === "executor";
    await db.admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, dispatch_repo_id, dispatch_pr_number) VALUES ($1, $2, $3, 'production', 'running', $4, $5)`,
      [id, accountId, role, executor ? o.repoId : null, executor ? 9 : null],
    );
    await db.admin.query(
      `UPDATE agent_runs SET sandbox_requested_at = CASE WHEN $4 THEN now() - interval '1 hour' END, sandbox_stopped_at = CASE WHEN $5 THEN NULL ELSE now() - make_interval(secs => $2) END,
              sandbox_session_ids = $3, compute_settle_due_at = now() - make_interval(secs => $2) WHERE id = $1`,
      [id, o.ageS ?? 60, o.ids ?? ["s1"], o.requested ?? true, o.noStop ?? false],
    );
    const verdict = await reserve(db.runWriterPool, { accountId, runId: id, plan: "starter", trigger: "foreground", estimateComputeUsd: o.reserved ?? 0.01 });
    if (verdict.decision !== "admit") throw new Error(`reserve denied: ${verdict.reason}`);
    const name = sandboxNameFor({ role: role as never, runId: id, accountId, repoId: o.repoId, pr: executor ? 9 : undefined });
    return { id, accountId, name, run: buildExecutionRun(id, { accountId, role, repoId: o.repoId, pr: executor ? 9 : undefined, product: "team", roleCard: "", prompt: "", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter" } } as StartAgentRunInput) };
  }
  type Due = Awaited<ReturnType<typeof dueRun>>;
  const PAST_DEADLINE = 1000; // ageS: stopped more than 15 minutes ago

  const ledgerOf = async (id: string) => (await db.admin.query(`SELECT usd::float AS usd, compute_basis AS basis FROM ledger WHERE run_id = $1 AND kind = 'compute'`, [id])).rows;
  const stateOf = async (id: string) => (await db.admin.query(`SELECT state FROM spend_reservations WHERE run_id = $1 AND budget <> 'model'`, [id])).rows[0].state;
  const dueOf = async (id: string) => (await db.admin.query(`SELECT compute_settle_due_at IS NOT NULL AS due FROM agent_runs WHERE id = $1`, [id])).rows[0].due;
  /** Lets a backed-off run be listed again, as the passing of its retry time would. */
  const makeDueAgain = (id: string) => db.admin.query(`UPDATE agent_runs SET compute_settle_retry_at = now() - interval '1 second' WHERE id = $1`, [id]);
  const tick = (target: ComputeSettler, extra: Partial<Pick<SweepDeps, "onError" | "clock" | "timeBudgetMs">> = {}) => sweepComputeSettle({ pool: db.runWriterPool, target, ...extra });

  describe("16: the tiers across ticks", () => {
    it("settles 'measured' on the first tick whose read has every figure, before the deadline, and deletes the sandbox then", async () => {
      const { h, target } = newHarness();
      const r = await dueRun();
      h.fakeSandbox.scriptUsage(r.name, [LATE]);
      expect(await tick(target)).toMatchObject({ listed: 1, settled: 0 });
      expect(await stateOf(r.id)).toBe("open");
      expect(h.fakeSandbox.state.deleted).toHaveLength(0);

      h.fakeSandbox.scriptUsage(r.name, [FULL]);
      expect(await tick(target)).toMatchObject({ settled: 1, deleted: 1 });
      expect(await ledgerOf(r.id)).toEqual([{ usd: 0.466, basis: "measured" }]);
      expect(await dueOf(r.id)).toBe(false);
      expect(h.fakeSandbox.state.deleted.map((d) => d.sandboxName)).toEqual([r.name]);
    });

    it("a figure that arrives just before the deadline tick still settles 'measured': the deadline tick re-reads", async () => {
      const { h, target } = newHarness();
      const r = await dueRun({ ageS: PAST_DEADLINE });
      h.fakeSandbox.scriptUsage(r.name, [FULL]);
      await db.admin.query(`UPDATE agent_runs SET sandbox_self_measured = $2::jsonb WHERE id = $1`, [r.id, JSON.stringify({ sessionId: "s1", ...COUNTERS })]);
      await tick(target);
      expect(await ledgerOf(r.id)).toEqual([{ usd: 0.466, basis: "measured" }]);
    });

    it("past the deadline each run settles with the best tier it has (counters pass: self_measured; none: fallback), and nothing is left open", async () => {
      const { h, target } = newHarness();
      const counted = await dueRun({ ageS: PAST_DEADLINE });
      const bare = await dueRun({ ageS: PAST_DEADLINE });
      const early = await dueRun({ ageS: 60 });
      for (const r of [counted, bare, early]) h.fakeSandbox.scriptUsage(r.name, [LATE]);
      await db.admin.query(`UPDATE agent_runs SET sandbox_self_measured = $2::jsonb WHERE id = $1`, [counted.id, JSON.stringify({ sessionId: "s1", ...COUNTERS })]);
      expect(await tick(target)).toMatchObject({ listed: 3, settled: 2, failed: 0 });
      expect((await ledgerOf(counted.id)).map((l) => l.basis)).toEqual(["self_measured"]);
      expect((await ledgerOf(bare.id)).map((l) => l.basis)).toEqual(["fallback"]);
      expect(await stateOf(early.id)).toBe("open"); // its own deadline is 14 minutes away
      expect(await dueOf(early.id)).toBe(true);
    });

    it("the deadline is 15 minutes after the recorded stop: stopped 14 minutes ago stays open, 16 minutes ago settles", async () => {
      const { h, target } = newHarness();
      const fourteen = await dueRun({ ageS: 14 * 60 });
      const sixteen = await dueRun({ ageS: 16 * 60 });
      for (const r of [fourteen, sixteen]) h.fakeSandbox.scriptUsage(r.name, [LATE]);
      await tick(target);
      expect(await stateOf(fourteen.id)).toBe("open");
      expect(await stateOf(sixteen.id)).toBe("settled");
    });

    it("a run with no recorded stop counts its deadline from when it became due", async () => {
      const { h, target } = newHarness();
      const fourteen = await dueRun({ ageS: 14 * 60, noStop: true });
      const sixteen = await dueRun({ ageS: 16 * 60, noStop: true });
      for (const r of [fourteen, sixteen]) h.fakeSandbox.scriptUsage(r.name, [LATE]);
      await tick(target);
      expect([await stateOf(fourteen.id), await stateOf(sixteen.id)]).toEqual(["open", "settled"]);
    });

    it("two overlapping ticks (20 rounds, random delays in measure and delete) settle each run once and delete each sandbox once", async () => {
      const jittery = (port: SandboxPort): SandboxPort => ({
        ...port,
        measure: async (...a) => (await jitter(), port.measure(...a)),
        deleteSandbox: async (...a) => (await jitter(), port.deleteSandbox(...a)),
      });
      const { h, target } = newHarness(jittery);
      const other = new SandboxTarget({ ...h.deps, sandboxPort: jittery(h.deps.sandboxPort) });
      const errors: unknown[] = [];
      const onError = (_id: string, e: unknown) => errors.push(e);
      for (let round = 0; round < 20; round++) {
        const runs = [await dueRun(), await dueRun()];
        const results = await Promise.all([tick(target, { onError }), tick(other, { onError })]);
        expect(results.reduce((n, x) => n + x.settled, 0)).toBe(2);
        for (const r of runs) {
          expect(await ledgerOf(r.id)).toEqual([{ usd: 0.0041, basis: "measured" }]);
          expect(await stateOf(r.id)).toBe("settled");
          expect(await dueOf(r.id)).toBe(false);
          expect(h.fakeSandbox.state.deleted.filter((d) => d.sandboxName === r.name), `round ${round}`).toHaveLength(1);
        }
      }
      expect(errors).toEqual([]);
    });
  });

  it("17: no transaction or lock is held across port.measure (every pooled connection is idle while it runs)", async () => {
    const busy: string[] = [];
    let measured = 0;
    const { target } = newHarness((port) => ({
      ...port,
      measure: async (...a) => {
        measured++;
        if (db.runWriterPool.totalCount !== db.runWriterPool.idleCount) busy.push(`${db.runWriterPool.totalCount} open, ${db.runWriterPool.idleCount} idle`);
        return port.measure(...a);
      },
    }));
    await dueRun();
    await dueRun();
    await tick(target);
    expect(measured).toBeGreaterThanOrEqual(2);
    expect(busy).toEqual([]);
  });

  describe("18: bounded, isolated ticks", () => {
    it("a tick takes at most 50 runs, the oldest first: with 60 due, the second tick gets the 10 newest", async () => {
      const { target } = newHarness();
      const accountId = randomUUID();
      await seedAccount(db.admin, accountId);
      const runs: Due[] = [];
      for (let i = 0; i < 60; i++) runs.push(await dueRun({ accountId, ageS: 600 - i })); // runs[0] is the oldest
      expect(SWEEP_BATCH_SIZE).toBe(50);
      expect(await tick(target)).toMatchObject({ listed: 50, settled: 50 });
      expect(await Promise.all(runs.slice(0, 10).map((r) => stateOf(r.id)))).toEqual(Array(10).fill("settled"));
      expect(await Promise.all(runs.slice(50).map((r) => stateOf(r.id)))).toEqual(Array(10).fill("open"));
      expect(await tick(target)).toMatchObject({ listed: 10, settled: 10 });
      expect(await Promise.all(runs.slice(50).map((r) => stateOf(r.id)))).toEqual(Array(10).fill("settled"));
    });

    it("a tick stops starting runs when its time budget is spent: the rest stay due and untouched, and the next tick takes them", async () => {
      const { h, target } = newHarness();
      expect(SWEEP_TIME_BUDGET_MS).toBe(600_000);
      expect(SWEEP_RUN_WORST_CASE_MS).toBe(120_000); // settle: open + measure; delete: open + delete; 30 s each
      const accountId = randomUUID();
      await seedAccount(db.admin, accountId);
      const runs: Due[] = [];
      for (let i = 0; i < 5; i++) runs.push(await dueRun({ accountId, ageS: 600 - i })); // runs[0] is the oldest
      let elapsed = 0; // each settle "takes" one worst-case run
      const slow: ComputeSettler = {
        settleRunCompute: async (run, opts) => (elapsed += SWEEP_RUN_WORST_CASE_MS, target.settleRunCompute(run, opts)),
        deleteSettledSandbox: (run, opts) => target.deleteSettledSandbox(run, opts),
      };
      // 270 s budget: the runs start at 0 s and 120 s; at 240 s another worst-case run would not fit.
      expect(await tick(slow, { clock: () => elapsed, timeBudgetMs: 270_000 })).toMatchObject({ listed: 5, settled: 2, skipped: 3 });
      expect(await Promise.all(runs.map((r) => stateOf(r.id)))).toEqual(["settled", "settled", "open", "open", "open"]);
      for (const r of runs.slice(2)) {
        expect(await ledgerOf(r.id)).toEqual([]);
        expect(await dueOf(r.id)).toBe(true);
        expect(h.fakeSandbox.state.deleted.some((d) => d.sandboxName === r.name)).toBe(false);
      }
      elapsed = 0;
      expect(await tick(slow, { clock: () => elapsed, timeBudgetMs: SWEEP_TIME_BUDGET_MS })).toMatchObject({ settled: 3, skipped: 0 });
      expect(await Promise.all(runs.map((r) => stateOf(r.id)))).toEqual(Array(5).fill("settled"));
    });

    it("a measure() error on one run leaves it due and does not stop the others", async () => {
      const { h, target } = newHarness();
      const [a, b, c] = [await dueRun(), await dueRun(), await dueRun()];
      h.fakeSandbox.failMeasure(b.name);
      expect(await tick(target)).toMatchObject({ listed: 3, settled: 2 });
      expect([await stateOf(a.id), await stateOf(b.id), await stateOf(c.id)]).toEqual(["settled", "open", "settled"]);
      expect(await dueOf(b.id)).toBe(true);
    });
  });

  describe("21: the sweep deletes the stopped sandbox", () => {
    it("past the deadline it is deleted even when the settle throws (and the run stays due); a later good tick settles and deletes again", async () => {
      const { h, target } = newHarness();
      const fails = { settle: true };
      const flaky: ComputeSettler = {
        settleRunCompute: (run, opts) => (fails.settle ? Promise.reject(new Error("db down")) : target.settleRunCompute(run, opts)),
        deleteSettledSandbox: (run) => target.deleteSettledSandbox(run),
      };
      const late = await dueRun({ ageS: PAST_DEADLINE });
      const early = await dueRun({ ageS: 60 });
      const errors: string[] = [];
      expect(await tick(flaky, { onError: (id) => errors.push(id) })).toMatchObject({ settled: 0, failed: 2 });
      expect(errors.sort()).toEqual([early.id, late.id].sort());
      expect(h.fakeSandbox.state.deleted.map((d) => d.sandboxName)).toEqual([late.name]); // not the early one
      expect(await stateOf(late.id)).toBe("open");
      expect(await dueOf(late.id)).toBe(true);

      fails.settle = false;
      await Promise.all([late.id, early.id].map(makeDueAgain)); // the failed settles backed both runs off; let their retry time pass
      expect(await tick(flaky)).toMatchObject({ settled: 2, failed: 0 });
      expect(await ledgerOf(late.id)).toHaveLength(1);
      expect(h.fakeSandbox.state.deleted.filter((d) => d.sandboxName === late.name)).toHaveLength(2); // idempotent
    });

    it("the backstop never deletes a run with no recorded session: a fault on tick 1 cannot turn tick 2 into a $0 'no_sandbox'", async () => {
      const { h, target } = newHarness();
      const fails = { settle: true };
      const flaky: ComputeSettler = {
        settleRunCompute: (run, opts) => (fails.settle ? Promise.reject(new Error("db down")) : target.settleRunCompute(run, opts)),
        deleteSettledSandbox: (run, opts) => target.deleteSettledSandbox(run, opts),
      };
      const r = await dueRun({ ids: [], ageS: PAST_DEADLINE, reserved: 5 });
      expect(await tick(flaky)).toMatchObject({ settled: 0, failed: 1 });
      expect(h.fakeSandbox.state.deleted).toEqual([]); // the VM may have run: its sandbox is the only proof
      fails.settle = false;
      await makeDueAgain(r.id); // the failed settle backed the run off; let its retry time pass
      expect(await tick(flaky)).toMatchObject({ settled: 1 });
      expect(await ledgerOf(r.id)).toEqual([{ usd: 5, basis: "fallback" }]);
    });

    it("an already-deleted sandbox (404 or 410 from the port) is success: no error, not left due, tick not failed; any other delete error is reported", async () => {
      const status = new Map<string, number>();
      const { target } = newHarness((port) => ({
        ...port,
        deleteSandbox: async (handle) => {
          if (status.has(handle.sandboxName)) throw new SandboxPortError("deleteSandbox", status.get(handle.sandboxName));
          return port.deleteSandbox(handle);
        },
      }));
      const [gone404, gone410, broken] = [await dueRun(), await dueRun(), await dueRun()];
      status.set(gone404.name, 404).set(gone410.name, 410).set(broken.name, 500);
      const errors: string[] = [];
      const result = await tick(target, { onError: (id) => errors.push(id) });
      expect(result).toMatchObject({ settled: 3, deleted: 2, failed: 1 });
      expect(errors).toEqual([broken.id]);
      for (const r of [gone404, gone410, broken]) {
        expect(await stateOf(r.id)).toBe("settled");
        expect(await dueOf(r.id)).toBe(false);
      }
    });

    it("a persistent (executor) sandbox is settled but never deleted", async () => {
      const { h, target } = newHarness();
      const accountId = randomUUID();
      const repoId = randomUUID();
      await seedAccount(db.admin, accountId);
      await seedRepo(db.admin, accountId, repoId);
      const r = await dueRun({ accountId, role: "executor", repoId });
      expect(await tick(target)).toMatchObject({ settled: 1, failed: 0 });
      expect(await ledgerOf(r.id)).toHaveLength(1);
      expect(h.fakeSandbox.state.deleted).toEqual([]);
    });
  });

  describe("22: 'no_sandbox' ($0) only when no session id was recorded AND the provider says no sandbox exists", () => {
    const settleAt = async (r: Due, target: SandboxTarget, deadlinePassed = true) => (await target.settleRunCompute(r.run, { deadlinePassed }), ledgerOf(r.id));

    it("no ids + the provider's 404: $0 'no_sandbox' (and only once the deadline has passed)", async () => {
      const { h, target } = newHarness();
      const r = await dueRun({ ids: [] });
      h.fakeSandbox.scriptExists(r.name, false);
      expect(await settleAt(r, target, false)).toEqual([]); // not yet: a creation may still be in flight
      expect(await settleAt(r, target)).toEqual([{ usd: 0, basis: "no_sandbox" }]);
    });

    it("no ids + the sandbox exists: the conservative fallback (the wall bound, floored at the reservation)", async () => {
      const { target } = newHarness();
      const r = await dueRun({ ids: [], reserved: 5 });
      expect(await settleAt(r, target)).toEqual([{ usd: 5, basis: "fallback" }]);
    });

    it("no ids + a provider that cannot answer (timeout): fallback, never $0", async () => {
      const { h, target } = newHarness();
      const r = await dueRun({ ids: [], reserved: 5 });
      h.fakeSandbox.scriptExists(r.name, "unknown");
      expect(await settleAt(r, target)).toEqual([{ usd: 5, basis: "fallback" }]);
    });

    it("ids present: sandboxExists is never asked", async () => {
      const { h, target } = newHarness();
      const r = await dueRun({ ids: ["s1"] });
      h.fakeSandbox.scriptExists(r.name, false);
      await settleAt(r, target);
      expect(h.fakeSandbox.state.calls.filter((c) => c.startsWith("exists:"))).toEqual([]);
    });
  });

  describe("23: Vercel's own session durations price the run; our stop-minus-request only fills a missing one", () => {
    it("a late recorded stop does not inflate a run whose sessions carry Vercel durations", async () => {
      const { h, target } = newHarness();
      const r = await dueRun({ reserved: 0.01 }); // requested 1 h ago, stopped 1 min ago: a 59 minute wall
      h.fakeSandbox.scriptUsage(r.name, [LATE]); // 5 min of Vercel wall, no CPU yet, no counters
      await target.settleRunCompute(r.run, { deadlinePassed: true });
      expect(await ledgerOf(r.id)).toEqual([{ usd: 0.08, basis: "fallback" }]); // 5 min of 2 vCPU at 100% + 4 GB
    });

    it("a session with no Vercel duration is priced on our wall time", async () => {
      const { h, target } = newHarness();
      const r = await dueRun({ reserved: 0.01 });
      h.fakeSandbox.scriptUsage(r.name, [{ sessionId: "s1", memoryMb: 4096, region: "iad1" }]);
      await target.settleRunCompute(r.run, { deadlinePassed: true });
      expect(await ledgerOf(r.id)).toEqual([{ usd: 0.708, basis: "fallback" }]); // 59 min of 2 vCPU at 100%
    });
  });

  describe("24: a settle that keeps throwing backs off", () => {
    const failuresOf = async (id: string) => (await db.admin.query(`SELECT compute_settle_failures AS n, compute_settle_retry_at AS retry_at, EXTRACT(EPOCH FROM (compute_settle_retry_at - clock_timestamp())) AS wait_s FROM agent_runs WHERE id = $1`, [id])).rows[0];
    /** A settler whose settle throws for the named runs and is the real one for the rest. */
    const throwingFor = (target: SandboxTarget, ids: Set<string>): ComputeSettler => ({
      settleRunCompute: (run, opts) => (ids.has(run.id) ? Promise.reject(new Error("db down")) : target.settleRunCompute(run, opts)),
      deleteSettledSandbox: (run, opts) => target.deleteSettledSandbox(run, opts),
    });

    it("50 older runs whose settle throws cannot starve 5 newer ones: tick 1 fails and backs off all 50, tick 2 settles the 5", async () => {
      const { target } = newHarness();
      const accountId = randomUUID();
      await seedAccount(db.admin, accountId);
      const old: Due[] = [];
      for (let i = 0; i < SWEEP_BATCH_SIZE; i++) old.push(await dueRun({ accountId, ageS: 900 - i }));
      const fresh: Due[] = [];
      for (let i = 0; i < 5; i++) fresh.push(await dueRun({ accountId, ageS: 60 - i }));
      const flaky = throwingFor(target, new Set(old.map((r) => r.id)));
      expect(await tick(flaky)).toMatchObject({ listed: 50, settled: 0, failed: 50 });
      expect((await failuresOf(old[0]!.id)).n).toBe(1);
      expect(await Promise.all(fresh.map((r) => stateOf(r.id)))).toEqual(Array(5).fill("open"));

      expect(await tick(flaky)).toMatchObject({ listed: 5, settled: 5, failed: 0 });
      expect(await Promise.all(fresh.map((r) => stateOf(r.id)))).toEqual(Array(5).fill("settled"));
      expect(await Promise.all(old.map(async (r) => (await failuresOf(r.id)).n))).toEqual(Array(50).fill(1)); // not tried again
      expect(await Promise.all(old.map((r) => dueOf(r.id)))).toEqual(Array(50).fill(true)); // never dropped
    });

    it("a run that fails on consecutive due ticks waits 1, 2, 4, 8, 16, 32, 60, 60 minutes, and is not listed before its retry time", async () => {
      const { target } = newHarness();
      const r = await dueRun();
      const flaky = throwingFor(target, new Set([r.id]));
      const waits: number[] = [];
      for (let n = 1; n <= 8; n++) {
        expect(await tick(flaky), `failure ${n}`).toMatchObject({ listed: 1, failed: 1 });
        const row = await failuresOf(r.id);
        expect(row.n).toBe(n);
        waits.push(Math.round(row.wait_s / 60));
        expect(await tick(flaky), `before retry ${n}`).toMatchObject({ listed: 0 });
        await makeDueAgain(r.id);
      }
      expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    });

    it("waiting for figures is not failing: the failure count stays 0, no retry time is set, and the run is listed on the next tick", async () => {
      const { h, target } = newHarness();
      const r = await dueRun();
      h.fakeSandbox.scriptUsage(r.name, [LATE]);
      for (let i = 0; i < 2; i++) {
        expect(await tick(target)).toMatchObject({ listed: 1, settled: 0, failed: 0 });
        expect(await failuresOf(r.id)).toMatchObject({ n: 0, retry_at: null });
      }
    });

    it("a backed-off run that later settles is settled once and its sandbox deleted once", async () => {
      const { h, target } = newHarness();
      const r = await dueRun();
      const fails = new Set([r.id]);
      const flaky = throwingFor(target, fails);
      expect(await tick(flaky)).toMatchObject({ failed: 1 });
      fails.clear();
      expect(await tick(flaky)).toMatchObject({ listed: 0 }); // still backed off
      await makeDueAgain(r.id);
      expect(await tick(flaky)).toMatchObject({ settled: 1, deleted: 1, failed: 0 });
      expect(await tick(flaky)).toMatchObject({ listed: 0 }); // its reservation closed
      expect(await ledgerOf(r.id)).toHaveLength(1);
      expect(h.fakeSandbox.state.deleted.filter((d) => d.sandboxName === r.name)).toHaveLength(1);
    });

    it("past the deadline the backstop delete still runs on the tick that fails and backs the run off", async () => {
      const { h, target } = newHarness();
      const r = await dueRun({ ageS: PAST_DEADLINE });
      expect(await tick(throwingFor(target, new Set([r.id])))).toMatchObject({ failed: 1, deleted: 1 });
      expect(h.fakeSandbox.state.deleted.map((d) => d.sandboxName)).toEqual([r.name]);
      expect((await failuresOf(r.id)).n).toBe(1);
    });

    it("if recording the failure itself fails, it is reported and the run stays due and is still listed", async () => {
      const { target } = newHarness();
      const r = await dueRun();
      const errors: string[] = [];
      const brokenWrites = { query: db.runWriterPool.query.bind(db.runWriterPool), connect: () => Promise.reject(new Error("pool down")) } as unknown as Pool;
      const result = await sweepComputeSettle({ pool: brokenWrites, target: throwingFor(target, new Set([r.id])), onError: (_id, e) => errors.push((e as Error).message) });
      expect(result).toMatchObject({ listed: 1, failed: 1 });
      expect(errors).toEqual(["db down", "pool down"]);
      expect(await failuresOf(r.id)).toMatchObject({ n: 0, retry_at: null });
    });

    it("the default clock is the monotonic performance.now()", async () => {
      const { target } = newHarness();
      const spy = vi.spyOn(performance, "now");
      try {
        await tick(target);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
