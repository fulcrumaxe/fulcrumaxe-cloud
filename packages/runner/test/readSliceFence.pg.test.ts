import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { ExecutionRun } from "../src/executionTarget.js";
import { type SandboxPort } from "../src/sandboxPort.js";
import { sandboxNameFor } from "../src/sandboxNaming.js";
import { fenceLease, insertReader, takeLease } from "../src/readerStore.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { assistantLine, envelopeBlock, resultLine, sliceRig, type SliceScript } from "./helpers/sliceRig.js";

const SPEND = { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const, estimateModelUsd: 0.001, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 };
const initLine = (): string => JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\n";
const STREAM: SliceScript = {
  lines: [initLine(), assistantLine("m1", 10), assistantLine("m1", 15), assistantLine("m2", 1000), assistantLine("m3", 2000), assistantLine("m4", 50), resultLine(envelopeBlock("pass"))],
};

/**
 * D#2 RLR-4 [pg]: how a sliced run ends when the end is not the reader's own (a cancel, the watchdog), when the reader dies after deciding the end, when the
 * exit outlasts the lease, and when the state outgrows its column. The run row, its reservations, the reader row and every save are real.
 */
describe("an end that is not the reader's own books the larger figure, once [pg]", () => {
  const db = pgHarness();
  const until = (): number => Date.now() + 60_000;

  async function newRun(script: SliceScript, over: { spend?: Partial<typeof SPEND> } = {}) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    const spend = { ...SPEND, ...over.spend };
    const harness = createSandboxTargetHarness(db.runWriterPool);
    // A launch that starts nothing and never ends: it only takes the run to `running`, with its reservation, as dispatch does.
    const idle: SandboxPort = { ...harness.deps.sandboxPort, startDetached: (handle) => ({ handle, hookFired: new Promise(() => undefined), launched: Promise.resolve() }) };
    const starter = new SandboxTarget({ ...harness.deps, sandboxPort: idle });
    const input: StartAgentRunInput = { accountId, repoId, role: "code-reviewer", product: "team", roleCard: "fake role card", prompt: "fake prompt", model: "haiku-4.5", capUsd: 5, spend };
    const started = await startAgentRun(db.runWriterPool, { sandbox: starter }, input);
    if (started.status !== "running") throw new Error(`test setup: expected "running", got "${started.status}"`);
    const run: ExecutionRun = { id: started.id, accountId, repoId, role: "code-reviewer", product: "team", roleCard: "fake role card", prompt: "fake prompt", model: "haiku-4.5", capUsd: 5, spend };
    const name = sandboxNameFor({ role: "code-reviewer", runId: run.id, accountId, repoId });
    const rig = sliceRig({ script, runId: run.id, sandboxName: name });
    const cmdId = await rig.startCommand();
    await db.admin.query(`UPDATE agent_runs SET sandbox_session_ids = ARRAY['sess-1'] WHERE id = $1`, [run.id]);
    expect(await insertReader(db.runWriterPool, { accountId, runId: run.id, cmdId })).toBe(true);
    /** A target instance (its own memory) over the rig's real port: `wrap` alters what the port is asked to read, `port` replaces other parts of the port. */
    const target = (wrap?: (real: NonNullable<SandboxPort["readSlice"]>) => NonNullable<SandboxPort["readSlice"]>, port: Partial<SandboxPort> = {}): SandboxTarget => {
      const p: SandboxPort = { ...rig.port, ...(wrap && { readSlice: wrap(rig.port.readSlice!.bind(rig.port)) }), ...port };
      return new SandboxTarget({ ...harness.deps, sandboxPort: p, lostConfirmDelayMs: 0 });
    };
    return { accountId, run, rig, target, cmdId };
  }

  const booked = async (accountId: string, runId: string): Promise<number[]> =>
    (await db.admin.query(`SELECT usd FROM ledger WHERE account_id = $1 AND run_id = $2 AND budget = 'model'`, [accountId, runId])).rows.map((r: { usd: string }) => Number(r.usd));
  const reservation = async (runId: string): Promise<string | undefined> =>
    (await db.admin.query(`SELECT state FROM spend_reservations WHERE run_id = $1 AND budget = 'model'`, [runId])).rows[0]?.state as string | undefined;
  const savedUsd = async (runId: string): Promise<number> => Number((await db.admin.query(`SELECT (state->'ledger'->>'cumulativeModelUsd')::numeric AS usd FROM run_log_readers WHERE run_id = $1`, [runId])).rows[0].usd);
  const status = async (runId: string): Promise<string> => (await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId])).rows[0].status as string;
  const cancelStatus = (runId: string) => db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [runId]);
  const expireLease = (runId: string) => db.admin.query(`UPDATE run_log_readers SET lease_until = clock_timestamp() WHERE run_id = $1`, [runId]);
  const epochOf = async (runId: string): Promise<number> => Number((await db.admin.query(`SELECT epoch FROM run_log_readers WHERE run_id = $1`, [runId])).rows[0].epoch);
  type Rig = Awaited<ReturnType<typeof newRun>>;
  /** Another instance's port: its stop does not wait on this test's in-process reader. */
  const apiInstance = (r: Rig): SandboxTarget => {
    const api = r.target();
    const d = (api as unknown as { deps: { sandboxPort: Record<string, unknown> } }).deps;
    d.sandboxPort = { ...d.sandboxPort, stop: async () => undefined };
    return api;
  };

  it("a watchdog on an instance holding an OLDER slice's meter books the newer save, not its own smaller figure; a later smaller settle leaves the row", async () => {
    const r = await newRun(STREAM);
    const a = r.target();
    const b = r.target();
    expect(await a.readSlice(r.run, { untilMs: until(), maxRecords: 5 })).toEqual({ done: false, held: true });
    const first = await savedUsd(r.run.id);
    expect(await b.readSlice(r.run, { untilMs: until(), maxRecords: 1 })).toEqual({ done: false, held: true });
    const newer = await savedUsd(r.run.id);
    expect(newer).toBeGreaterThan(first);
    await db.admin.query(`UPDATE agent_runs SET run_limit_ms = 60000 WHERE id = $1`, [r.run.id]);
    const realNow = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + 3 * 3_600_000);
    let outcome: string;
    try {
      outcome = await (a as unknown as { enforceLimitsDurably(run: ExecutionRun): Promise<string> }).enforceLimitsDurably(r.run);
    } finally {
      spy.mockRestore();
    }
    expect(outcome).toBe("settled");
    expect(await status(r.run.id)).toBe("timed_out");
    expect(await booked(r.accountId, r.run.id)).toEqual([newer]);
    const ended = (await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'checkpoint'`, [r.run.id])).rows;
    expect(ended).toHaveLength(1);
    expect(Number(ended[0].payload.metered_usd)).toBe(newer); // the end's own record carries the newer figure too
    // The older instance settling again (a repeat cancel) can only be smaller: the one row stays.
    await a.cancel(r.run);
    await b.cancel(r.run);
    expect(await booked(r.accountId, r.run.id)).toEqual([newer]);
  }, 60_000);

  it("a cancel while a slice holds the lease books nothing itself; the slice's next save is booked by the slice, at the larger figure, in one row", async () => {
    const r = await newRun(STREAM);
    const api = apiInstance(r);
    let saves = 0;
    let bookedAtCancel: number[] | undefined;
    let reservationAtCancel: string | undefined;
    const t = r.target((real) => (handle, o) =>
      real(handle, {
        ...o,
        checkpointEveryMs: 0,
        commit: async (cp) => {
          if (++saves === 7) {
            await cancelStatus(r.run.id);
            await api.cancel(r.run);
            bookedAtCancel = await booked(r.accountId, r.run.id);
            reservationAtCancel = await reservation(r.run.id);
          }
          return o.commit(cp);
        },
      }),
    );
    const earlier = { v: 0 };
    const step = await t.readSlice(r.run, { untilMs: until() });
    expect(step).toEqual({ done: true, held: false });
    expect(bookedAtCancel).toEqual([]);
    expect(reservationAtCancel).toBe("open");
    earlier.v = await savedUsd(r.run.id);
    expect(earlier.v).toBeGreaterThan(0);
    expect(await booked(r.accountId, r.run.id)).toEqual([earlier.v]);
    expect(await reservation(r.run.id)).toBe("settled");
    expect(await status(r.run.id)).toBe("cancelled");
  }, 60_000);

  it("a cancel while a slice holds the lease, and the holder never comes back: once the lease expires the next end fences and books the saved figure", async () => {
    const r = await newRun(STREAM);
    const usd = await (async () => {
      expect(await r.target().readSlice(r.run, { untilMs: until(), maxRecords: 5 })).toEqual({ done: false, held: true });
      return savedUsd(r.run.id);
    })();
    await cancelStatus(r.run.id);
    expect(await takeLease(db.runWriterPool, { accountId: r.accountId, runId: r.run.id })).not.toBeNull(); // a holder that will die
    await apiInstance(r).cancel(r.run);
    expect(await booked(r.accountId, r.run.id)).toEqual([]);
    expect(await reservation(r.run.id)).toBe("open");
    // Still live: a slice invocation and a second cancel on other instances change nothing either.
    expect(await r.target().readSlice(r.run, { untilMs: until() })).toEqual({ done: true, held: false });
    expect(await booked(r.accountId, r.run.id)).toEqual([]);
    await expireLease(r.run.id);
    const epochBefore = await epochOf(r.run.id);
    await apiInstance(r).cancel(r.run);
    expect(await epochOf(r.run.id)).toBeGreaterThan(epochBefore); // fenced
    expect(await booked(r.accountId, r.run.id)).toEqual([usd]);
    expect(await reservation(r.run.id)).toBe("settled");
  }, 60_000);

  it("the same, when the next end is a slice invocation (the scheduler's call) instead of a cancel", async () => {
    const r = await newRun(STREAM);
    expect(await r.target().readSlice(r.run, { untilMs: until(), maxRecords: 5 })).toEqual({ done: false, held: true });
    const usd = await savedUsd(r.run.id);
    await cancelStatus(r.run.id);
    await takeLease(db.runWriterPool, { accountId: r.accountId, runId: r.run.id });
    await expireLease(r.run.id);
    expect(await r.target().readSlice(r.run, { untilMs: until() })).toEqual({ done: true, held: false });
    expect(await booked(r.accountId, r.run.id)).toEqual([usd]);
  }, 60_000);

  it("a reader fenced out books nothing, at a save and at the booking itself", async () => {
    const r = await newRun(STREAM);
    let saves = 0;
    let stale = 0;
    const t = r.target((real) => (handle, o) =>
      real(handle, {
        ...o,
        checkpointEveryMs: 0,
        commit: async (cp) => {
          if (++saves === 7) {
            await cancelStatus(r.run.id);
            await expireLease(r.run.id);
            const fence = await fenceLease(db.runWriterPool, { accountId: r.accountId, runId: r.run.id }); // a takeover that has booked nothing yet
            expect(fence.kind).toBe("fenced");
            stale = await epochOf(r.run.id);
          }
          return o.commit(cp);
        },
      }),
    );
    expect(await t.readSlice(r.run, { untilMs: until() })).toEqual({ done: true, held: false });
    expect(await booked(r.accountId, r.run.id)).toEqual([]);
    expect(await reservation(r.run.id)).toBe("open");
    // The booking itself is guarded too: an epoch that is no longer current books nothing, though the run is over and a figure is saved.
    await expireLease(r.run.id);
    await fenceLease(db.runWriterPool, { accountId: r.accountId, runId: r.run.id });
    await (r.target() as unknown as { settleModelFromSavedMeter(run: ExecutionRun, epoch: number): Promise<void> }).settleModelFromSavedMeter(r.run, stale);
    expect(await booked(r.accountId, r.run.id)).toEqual([]);
    // Whoever fences next books the saved figure, once.
    await expireLease(r.run.id);
    await apiInstance(r).cancel(r.run);
    expect(await booked(r.accountId, r.run.id)).toEqual([await savedUsd(r.run.id)]);
  }, 60_000);
  it("a lease that merely ran out during the reader's own finalize (nobody fenced it) still lets the reader book its end, once", async () => {
    const r = await newRun(STREAM);
    // The port returns the run's end, and the lease runs out before the stop and the measure are done: no heartbeat covers the finalize.
    const t = r.target((real) => async (handle, o) => {
      const result = await real(handle, o);
      await expireLease(r.run.id);
      return result;
    });
    const step = await t.readSlice(r.run, { untilMs: until() });
    expect(step).toMatchObject({ done: true, held: true, status: "succeeded" });
    expect(await status(r.run.id)).toBe("succeeded");
    const usd = await savedUsd(r.run.id);
    expect(usd).toBeGreaterThan(0);
    expect(await booked(r.accountId, r.run.id)).toEqual([usd]);
    expect(await reservation(r.run.id)).toBe("settled");
  }, 60_000);

  it("a cancel deferred to a live holder whose saves then fail: the lost end releases its lease, fences and books the saved figure once", async () => {
    const r = await newRun(STREAM);
    const api = apiInstance(r);
    let saves = 0;
    let bookedAtCancel: number[] | undefined;
    const t = r.target((real) => (handle, o) =>
      real(handle, {
        ...o,
        checkpointEveryMs: 0,
        commit: async (cp) => {
          if (++saves === 7) {
            await cancelStatus(r.run.id);
            await api.cancel(r.run); // the lease is live: the cancel leaves the model booking to this holder
            bookedAtCancel = await booked(r.accountId, r.run.id);
            return false; // and this holder's save is refused
          }
          return o.commit(cp);
        },
      }),
    );
    expect(await t.readSlice(r.run, { untilMs: until() })).toEqual({ done: true, held: false });
    expect(bookedAtCancel).toEqual([]);
    const usd = await savedUsd(r.run.id);
    expect(usd).toBeGreaterThan(0);
    expect(await booked(r.accountId, r.run.id)).toEqual([usd]);
    expect(await reservation(r.run.id)).toBe("settled");
  }, 60_000);
});
