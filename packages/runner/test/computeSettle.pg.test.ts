import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import * as spend from "@fx/spend";
import { getUsage, reserve, type SandboxSessionFigures } from "@fx/spend";
import { buildExecutionRun, startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { cancelRun } from "../src/cancelRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { SandboxPort } from "../src/sandboxPort.js";
import type { NormalizedEvent } from "../src/types.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** D#2 COMPUTE-SETTLE CS-2a: a run's compute reservation closes with ONE ledger row (never a release). [pg] */
describe("D#2 COMPUTE-SETTLE CS-2a: the settle core [pg]", () => {
  const db = pgHarness();

  /** Vercel's own figures for the one session a fake run launches: 60 s of CPU, 5 min wall, 4 GB, 2.2 GB of egress = 0.466 at the test data's rates. */
  const REPORTED = { sessionId: "sess-1", memoryMb: 4096, region: "iad1", durationMs: 300_000, activeCpuMs: 60_000, egressBytes: 2.2e9 };
  /** The same session before Vercel reports its CPU and network (they arrive only after the stop, sometimes late). */
  const LATE = { sessionId: "sess-1", memoryMb: 4096, region: "iad1", durationMs: 300_000 };
  const GOOD_COUNTERS = { cpuMs: 61_000, txBytes: 10, uptimeMs: 299_000 };

  async function seedInput() {
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
    return { accountId, userId, input };
  }

  /** A run that really started on the fake (so its marker and session ids were persisted by the target itself). */
  async function started(events: NormalizedEvent[] = []) {
    const { accountId, userId, input } = await seedInput();
    const h = createSandboxTargetHarness(db.runWriterPool, events);
    const target = new SandboxTarget(h.deps);
    const result = await startAgentRun(db.runWriterPool, { sandbox: target }, input);
    if (result.status !== "running") throw new Error("run did not start");
    await sleep(30);
    return { accountId, userId, input, h, target, id: result.id, run: buildExecutionRun(result.id, input), name: h.fakeSandbox.state.created[0]!.sandboxName };
  }
  type Started = Awaited<ReturnType<typeof started>>;

  const ledgerOf = async (id: string) => (await db.admin.query(`SELECT budget, usd::float AS usd, compute_basis AS basis FROM ledger WHERE run_id = $1 AND kind = 'compute'`, [id])).rows;
  const statesOf = async (id: string) => (await db.admin.query(`SELECT state FROM spend_reservations WHERE run_id = $1 AND budget <> 'model'`, [id])).rows.map((r) => r.state);
  const dueOf = async (id: string) => (await db.admin.query(`SELECT compute_settle_due_at IS NOT NULL AS due FROM agent_runs WHERE id = $1`, [id])).rows[0].due;
  const measuredRow = (usd = 0.466) => [{ budget: "foreground_compute", usd, basis: "measured" }];
  const freshTarget = (s: Started) => new SandboxTarget(s.h.deps);

  describe("criterion 8: every path closes the compute row with one measured ledger row", () => {
    it("finalize (and usage: reserved 1.00 before, spent 0.466 after)", async () => {
      const s = await started();
      s.h.fakeSandbox.scriptUsage(s.name, [REPORTED]);
      const ctx = { pool: db.runWriterPool, principal: { accountId: s.accountId, userId: s.userId } };
      expect((await getUsage(ctx)).foreground_compute).toMatchObject({ spent_usd: 0, reserved_usd: 1 });

      await s.target.finalize(s.run, { status: "succeeded", usd: 0.1 });

      expect(await ledgerOf(s.id)).toEqual(measuredRow());
      expect(await statesOf(s.id)).toEqual(["settled"]);
      expect((await getUsage(ctx)).foreground_compute).toMatchObject({ spent_usd: 0.466, reserved_usd: 0 });
    });

    it("cancel (cancelRun -> target.cancel)", async () => {
      const s = await started();
      s.h.fakeSandbox.scriptUsage(s.name, [REPORTED]);
      const pool = db.runWriterPool;
      await cancelRun({ pool, principal: { accountId: s.accountId, userId: s.userId } }, s.id, { sandbox: freshTarget(s) });
      expect(await ledgerOf(s.id)).toEqual(measuredRow());
      expect(await statesOf(s.id)).toEqual(["settled"]);
    });

    it("lost pending->running CAS", async () => {
      const s = await started();
      const real = new SandboxTarget(s.h.deps);
      const racing = Object.create(real) as SandboxTarget;
      racing.dispatch = async (run) => {
        const out = await real.dispatch(run);
        await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [run.id]);
        return out;
      };
      const result = await startAgentRun(db.runWriterPool, { sandbox: racing }, s.input);
      expect(result.status).toBe("cancelled");
      expect(await statesOf(result.id)).toEqual(["settled"]);
      expect((await ledgerOf(result.id)).map((r) => r.basis)).toEqual(["measured"]);
    });
  });

  it("8a: before Vercel reports CPU and network the row stays open (still reserved), is marked due, and writes no ledger row; a late 'measured' figure settles it", async () => {
    const s = await started();
    s.h.fakeSandbox.scriptUsage(s.name, [LATE]);
    await s.target.finalize(s.run, { status: "succeeded", usd: 0.1 });
    expect(await statesOf(s.id)).toEqual(["open"]);
    expect(await ledgerOf(s.id)).toEqual([]);
    expect(await dueOf(s.id)).toBe(true);
    expect(s.h.fakeSandbox.state.deleted).toHaveLength(0); // an unmeasured ephemeral sandbox is kept, stopped
    expect((await getUsage({ pool: db.runWriterPool, principal: { accountId: s.accountId, userId: s.userId } })).foreground_compute).toMatchObject({ spent_usd: 0, reserved_usd: 1 });

    s.h.fakeSandbox.scriptUsage(s.name, [REPORTED]); // the figures arrive
    expect(await freshTarget(s).settleRunCompute(s.run, { deadlinePassed: false })).toEqual({ wrote: true });
    expect(await ledgerOf(s.id)).toEqual(measuredRow());
    expect(await dueOf(s.id)).toBe(false);
    expect(s.h.fakeSandbox.state.deleted).toHaveLength(1); // deleted only after the settle
  });

  describe("D#454 H3c: the compute-settle cron is told when a run is waiting for its figures", () => {
    const entries = new Map<string, number>();
    const useMarkerStore = () =>
      setPendingHooks({
        store: {
          get: async (key) => entries.get(key) ?? null,
          set: async (key, value) => void entries.set(key, value),
          delete: async (key) => void entries.delete(key),
        },
      });
    afterEach(() => {
      setPendingHooks(null);
      entries.clear();
    });

    it("marking a run's settle due leaves a marker for the cron", async () => {
      const s = await started();
      useMarkerStore(); // after the start: reaching `running` sets the same marker, which would hide a missing settle-due writer
      s.h.fakeSandbox.scriptUsage(s.name, [LATE]);
      await s.target.finalize(s.run, { status: "succeeded", usd: 0.1 });
      expect(await dueOf(s.id)).toBe(true);
      await vi.waitFor(() => expect(entries.has("pending:compute-settle-sweep")).toBe(true));
    });

    it("a run that settled at once leaves none (the cron has nothing to wait for)", async () => {
      const s = await started();
      useMarkerStore(); // after the start: reaching `running` marks the cron too, which this test is not about
      s.h.fakeSandbox.scriptUsage(s.name, [REPORTED]);
      await s.target.finalize(s.run, { status: "succeeded", usd: 0.1 });
      expect(await dueOf(s.id)).toBe(false);
      await sleep(30);
      expect(entries.has("pending:compute-settle-sweep")).toBe(false); // (finishing a run may mark other sweeps, e.g. its status events)
    });
  });

  describe("9a: the deadline settles with the best tier, from the persisted counters, on a fresh instance", () => {
    const cases: [string, object, { usd: number; basis: string }][] = [
      ["valid counters under the floor: self_measured, usd = reserved", GOOD_COUNTERS, { usd: 1, basis: "self_measured" }],
      ["counters above wall x 2 vCPUs x 1.02 are rejected, not clamped: fallback", { ...GOOD_COUNTERS, cpuMs: 612_001 }, { usd: 1, basis: "fallback" }],
      ["forged 0/0 counters settle at exactly the reservation", { cpuMs: 0, txBytes: 0, uptimeMs: 299_000 }, { usd: 1, basis: "self_measured" }],
      ["real egress above the egress-free fallback bound is recorded UNCAPPED", { cpuMs: 60_000, txBytes: 20e9, uptimeMs: 299_000 }, { usd: 4.026, basis: "self_measured" }],
    ];
    for (const [title, counters, expected] of cases) {
      it(title, async () => {
        const s = await started();
        s.h.fakeSandbox.scriptUsage(s.name, [LATE]);
        s.h.fakeSandbox.scriptCounters(s.name, counters as typeof GOOD_COUNTERS);
        await s.target.finalize(s.run, { status: "succeeded", usd: 0.1 });
        expect(await statesOf(s.id)).toEqual(["open"]);
        await freshTarget(s).settleRunCompute(s.run, { deadlinePassed: true });
        expect(await ledgerOf(s.id)).toEqual([{ budget: "foreground_compute", ...expected }]);
      });
    }

    it("a figure of ours (Vercel reports no duration) is never 'measured'", async () => {
      const s = await started();
      s.h.fakeSandbox.scriptUsage(s.name, [{ ...REPORTED, durationMs: undefined }]);
      await s.target.finalize(s.run, { status: "succeeded", usd: 0.1 });
      expect(await statesOf(s.id)).toEqual(["open"]);
      await freshTarget(s).settleRunCompute(s.run, { deadlinePassed: true });
      expect((await ledgerOf(s.id)).map((r) => r.basis)).toEqual(["self_measured"]);
    });
  });

  /** A reserved run with no sandbox of its own, its persisted columns set by hand. */
  async function seeded(cols: { requested?: string; stopped?: string; reserved?: number } = {}) {
    const accountId = randomUUID();
    const id = randomUUID();
    await seedAccount(db.admin, accountId);
    await db.admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'production', 'running')`, [id, accountId]);
    await db.admin.query(`UPDATE agent_runs SET sandbox_requested_at = $2::timestamptz, sandbox_stopped_at = $3::timestamptz WHERE id = $1`, [id, cols.requested ?? null, cols.stopped ?? null]);
    const input: StartAgentRunInput = { accountId, role: "code-reviewer", product: "team", roleCard: "rc", prompt: "p", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter", estimateComputeUsd: cols.reserved ?? 1, trigger: "foreground" } } as StartAgentRunInput;
    const run = buildExecutionRun(id, input);
    const target = new SandboxTarget(createSandboxTargetHarness(db.runWriterPool).deps);
    await target.admit(run, db.admin);
    return { id, run, target };
  }
  const egress = (usd: number): SandboxSessionFigures => ({ sessionId: "x", memoryMb: 0, region: "iad1", durationMs: 1, activeCpuMs: 0, egressBytes: (usd / 0.2) * 1e9 });

  it("9: measured above the reservation is not capped; unmeasurable is the wall bound floored at the reservation; no marker is $0 'no_sandbox'", async () => {
    const over = await seeded({ requested: "2026-10-01T00:00:00Z" });
    await over.target.settleRunCompute(over.run, { deadlinePassed: false, measured: [egress(1.37)] });
    expect(await ledgerOf(over.id)).toEqual(measuredRow(1.37));

    const unknown = await seeded({ requested: "2026-10-01T00:00:00Z", stopped: "2026-10-01T10:00:00Z" });
    await unknown.target.settleRunCompute(unknown.run, { deadlinePassed: true });
    expect(await ledgerOf(unknown.id)).toEqual([{ budget: "foreground_compute", usd: 7.2, basis: "fallback" }]); // 10 h x 2 vCPU x 0.36

    const none = await seeded();
    await none.target.settleRunCompute(none.run, { deadlinePassed: false });
    expect(await ledgerOf(none.id)).toEqual([{ budget: "foreground_compute", usd: 0, basis: "no_sandbox" }]);
  });

  it("9b: the fallback's wall time ends at the recorded stop: settling 15 minutes later gives the same usd", async () => {
    const stoppedAt = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
    const at = async (agoMs: number) => {
      const stopped = stoppedAt(agoMs);
      const r = await seeded({ reserved: 0.01, requested: new Date(Date.parse(stopped) - 600_000).toISOString(), stopped });
      await r.target.settleRunCompute(r.run, { deadlinePassed: true });
      return (await ledgerOf(r.id))[0]!.usd;
    };
    expect(await at(0)).toBe(0.12); // 10 min of 2 vCPU at 100%
    expect(await at(15 * 60_000)).toBe(0.12);
  });

  it("9c: a fresh instance with no bookkeeping settles 'measured' from the persisted session ids", async () => {
    const s = await started();
    s.h.fakeSandbox.scriptUsage(s.name, [REPORTED]);
    await freshTarget(s).finalize(s.run, { status: "succeeded", usd: 0.1 });
    expect(await ledgerOf(s.id)).toEqual(measuredRow());
    // ...and it measured before it deleted, as an instance that remembered the run would have.
    expect(s.h.fakeSandbox.state.calls.slice(-4)).toEqual([`readCounters:${s.name}`, `stop:${s.name}`, `measure:${s.name}`, `delete:${s.name}`]);
  });

  it("9d: a run whose abort stopped its sandbox without measuring ends due, with its sessions persisted, and then settles", async () => {
    const error: NormalizedEvent = { runId: "x", role: "code-reviewer", seq: 1, type: "error", ts: new Date().toISOString(), isError: true, text: "model returned 401 unauthorized" };
    const s = await started([error]);
    s.h.fakeSandbox.scriptUsage(s.name, []); // nothing reported yet
    const report = s.h.hooks.calls[0]!.report;
    expect(report.failureReason).toBe("model_key_broken");
    await s.target.finalize(s.run, report);
    expect((await db.admin.query(`SELECT sandbox_session_ids AS ids FROM agent_runs WHERE id = $1`, [s.id])).rows[0].ids).toEqual(["sess-1"]);
    expect(await dueOf(s.id)).toBe(true);
    await freshTarget(s).settleRunCompute(s.run, { deadlinePassed: true });
    expect((await ledgerOf(s.id)).map((r) => r.basis)).toEqual(["fallback"]);
  });

  it("9e: a cancel that reaches dispatch's instance before startDetached returned: stop, measure, then (settled) delete, in that order", async () => {
    const { input } = await seedInput();
    const h = createSandboxTargetHarness(db.runWriterPool);
    // eslint-disable-next-line prefer-const
    let target!: SandboxTarget;
    const port: SandboxPort = {
      ...h.deps.sandboxPort,
      startDetached(handle, opts) {
        const out = h.deps.sandboxPort.startDetached(handle, opts);
        (target as unknown as { runs: Map<string, { cancelRequested: boolean }> }).runs.get(opts.runId)!.cancelRequested = true;
        return out;
      },
    };
    target = new SandboxTarget({ ...h.deps, sandboxPort: port });
    const result = await startAgentRun(db.runWriterPool, { sandbox: target }, input);
    if (result.status !== "running") throw new Error("run did not start");
    const name = h.fakeSandbox.state.created[0]!.sandboxName;
    // dispatch's branch stops and measures; the delete waits for the settle the cancel itself performs.
    expect(h.fakeSandbox.state.calls).toEqual([`readCounters:${name}`, `stop:${name}`, `measure:${name}`]);
    await target.cancel(buildExecutionRun(result.id, input));
    expect(h.fakeSandbox.state.calls).toEqual([`readCounters:${name}`, `stop:${name}`, `measure:${name}`, `delete:${name}`]);
  });

  it("a direct stop of the agent this instance started stops again even when a stop is already recorded (a cancel's earlier stop found no VM)", async () => {
    const s = await started();
    await db.admin.query(`UPDATE agent_runs SET sandbox_stopped_at = now() WHERE id = $1`, [s.id]);
    const before = s.h.fakeSandbox.state.stopped.length;
    const t = s.target as unknown as { directStop(run: unknown, bk: unknown): Promise<void>; runs: Map<string, unknown> };
    await t.directStop(s.run, t.runs.get(s.id));
    expect(s.h.fakeSandbox.state.stopped).toHaveLength(before + 1);
    // ...while an ordinary stop of an already-stopped run is not repeated.
    await freshTarget(s).finalize(s.run, { status: "succeeded", usd: 0.1 });
    expect(s.h.fakeSandbox.state.stopped).toHaveLength(before + 1);
  });

  it("10: finalize racing a cancel (20 runs) leaves exactly one compute ledger row each, and neither caller sees an error", async () => {
    for (let i = 0; i < 20; i++) {
      const s = await started();
      const racer = freshTarget(s);
      await Promise.all([
        racer.finalize(s.run, { status: "succeeded", usd: 0.1 }),
        cancelRun({ pool: db.runWriterPool, principal: { accountId: s.accountId, userId: s.userId } }, s.id, { sandbox: s.target }),
      ]);
      expect(await ledgerOf(s.id)).toHaveLength(1);
      expect(await statesOf(s.id)).toEqual(["settled"]);
    }
  });

  it("10: two settles of one run at the same instant (20 runs) write one ledger row and neither throws", async () => {
    for (let i = 0; i < 20; i++) {
      const r = await seeded({ requested: "2026-10-01T00:00:00Z" });
      const other = new SandboxTarget(createSandboxTargetHarness(db.runWriterPool).deps);
      const outcomes = await Promise.all([
        r.target.settleRunCompute(r.run, { deadlinePassed: false, measured: [egress(0.5)] }),
        other.settleRunCompute(r.run, { deadlinePassed: false, measured: [egress(0.5)] }),
      ]);
      expect(outcomes.filter((o) => o.wrote)).toHaveLength(1);
      expect(await ledgerOf(r.id)).toHaveLength(1);
    }
  });

  it("11: the monthly compute budget sees settled spend: runs are admitted until the budget is reached, then one is denied; a new month admits; background is independent", async () => {
    const accountId = randomUUID();
    await seedAccount(db.admin, accountId);
    const now = new Date("2026-10-15T12:00:00Z");
    const target = new SandboxTarget(createSandboxTargetHarness(db.runWriterPool).deps);
    const attempt = async (trigger: "foreground" | "background", at: Date) => {
      const id = randomUUID();
      await db.admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, sandbox_requested_at) VALUES ($1, $2, 'code-reviewer', 'production', 'running', now())`, [id, accountId]);
      const verdict = await reserve(db.runWriterPool, { accountId, runId: id, plan: "starter", trigger, estimateComputeUsd: 1, now: at });
      if (verdict.decision === "admit") {
        const run = buildExecutionRun(id, { accountId, role: "code-reviewer", product: "team", roleCard: "", prompt: "", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter", trigger } } as StartAgentRunInput);
        await target.settleRunCompute(run, { deadlinePassed: false, measured: [egress(0.5)] });
      }
      return verdict;
    };
    // Each settled run spends 0.5 and each attempt reserves 1, so this many fit under the plan's foreground budget.
    const fits = Math.floor((spend.foregroundBudgetUsd("starter") - 1) / 0.5) + 1;
    for (let n = 1; n <= fits; n++) expect((await attempt("foreground", now)).decision, `run ${n}`).toBe("admit");
    expect(await attempt("foreground", now)).toEqual({ decision: "deny", reason: "compute_cap_exceeded" });
    expect((await attempt("background", now)).decision).toBe("admit");
    expect((await attempt("foreground", new Date("2026-11-01T00:00:00Z"))).decision).toBe("admit");
  });

  it("14: the runner releases no compute reservation, and the unused data-transfer writer is gone", () => {
    const source = readFileSync(new URL("../src/targets/sandboxTarget.ts", import.meta.url), "utf8");
    expect(source.match(/releaseWith\(/g)).toHaveLength(1);
    expect(source).toMatch(/if \(row\.budget !== "model"\) continue;[\s\S]{0,400}releaseWith\(client/);
    expect("writeDataTransferLedgerRow" in spend).toBe(false);
  });
});
