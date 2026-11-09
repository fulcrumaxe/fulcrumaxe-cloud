import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget, type SandboxTargetDeps } from "../src/targets/sandboxTarget.js";
import type { ExecutionRun } from "../src/executionTarget.js";
import { SliceAttachError, type SandboxPort } from "../src/sandboxPort.js";
import { insertReader, takeLease } from "../src/readerStore.js";
import type { ReaderConfig, ReaderFaults } from "../src/readerConfig.js";
import { sliceFactsOf } from "../src/sliceRun.js";
import { configureAgentRunWiring, followAttachLostBody, followRevisitBody, followSliceBody, type FollowSliceArgs } from "../src/workflows/agentRun.js";
import { createVercelSandboxPort } from "../src/vercelSandboxPort.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { createRecordingVm, recordingSdk, type RecordingVm, type RecordingVmOptions } from "./helpers/recorderSdk.js";
import { assistantLine, envelopeBlock, resultLine, scriptedAgent, type SliceScript } from "./helpers/sliceRig.js";

const SPEND = { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const, estimateModelUsd: 0.001, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 };
const initLine = (): string => JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\n";
const STREAM: SliceScript = {
  lines: [initLine(), assistantLine("m1", 10), assistantLine("m1", 15), assistantLine("m2", 1000), assistantLine("m3", 2000), assistantLine("m4", 50), resultLine(envelopeBlock("pass"))],
};
const ASSISTANT_LINES = 5;
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * D#2 RLR-5 [pg]: the follower's side of the sliced reader against the real lease table, the real writer and the real settle. The run is DISPATCHED here (the real
 * port over the strict recording VM): dispatch hands the started command over and inserts the reader row, and every later read is a `followSliceBody` call on a new
 * target instance with its own memory, as each follower step is. The agent is scripted; the run row, reservations, reader row and saves are real.
 */
describe("the follower reads a run in slices [pg]", () => {
  const db = pgHarness();
  const until = (): number => Date.now() + 60_000;
  afterEach(() => {
    configureAgentRunWiring(undefined);
    vi.restoreAllMocks();
  });

  async function dispatched(script: SliceScript, over: { vm?: RecordingVmOptions; reader?: ReaderConfig | null; slice?: boolean; spend?: Partial<typeof SPEND>; allowFailed?: boolean; startPort?: (real: SandboxPort, pool: Pool) => SandboxPort; onAccount?: (id: string) => void } = {}) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    over.onAccount?.(accountId);
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const vm: RecordingVm = createRecordingVm(over.vm);
    const sdk = recordingSdk({ create: async (p) => scriptedAgent(script, p.name), get: async (p) => scriptedAgent(script, p.name) }, vm);
    const port = createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk, reader: { probeMs: 20, trailerWaitMs: 60, exitWaitMs: 40 } });
    const reader: ReaderConfig | undefined = over.reader === null ? undefined : (over.reader ?? { sliceMs: 60_000, faults: {} });
    /** A target instance (its own memory) over the real port; `portOver` alters what the port is asked or answers. */
    const target = (r: ReaderConfig | undefined = reader, portOver: (real: SandboxPort) => SandboxPort = (p) => p, depsOver: Partial<SandboxTargetDeps> = {}): SandboxTarget =>
      new SandboxTarget({ ...harness.deps, sandboxPort: portOver(port), ...(r && { reader: r }), lostConfirmDelayMs: 0, ...depsOver });
    const spend = { ...SPEND, ...over.spend };
    const input: StartAgentRunInput = { accountId, repoId, role: "code-reviewer", product: "team", roleCard: "fake role card", prompt: "fake prompt", model: "haiku-4.5", capUsd: 5, spend, ...(over.slice !== false && { slice: true as const }) };
    const started = await startAgentRun(db.runWriterPool, { sandbox: over.startPort ? target(undefined, (p) => over.startPort!(p, db.runWriterPool)) : target() }, input);
    if (started.status !== "running" && !over.allowFailed) throw new Error(`test setup: expected "running", got "${started.status}"`);
    const startedMs = started.status === "running" ? started.startedMs : undefined;
    const run: ExecutionRun = { id: started.id, accountId, repoId, role: "code-reviewer", product: "team", roleCard: "fake role card", prompt: "fake prompt", model: "haiku-4.5", capUsd: 5, spend };
    const slice: FollowSliceArgs = { startedMs: startedMs ?? Date.now(), run: sliceFactsOf(run) };
    return { accountId, run, started, startedMs, vm, port, target, slice, harness };
  }
  type Dispatched = Awaited<ReturnType<typeof dispatched>>;

  const events = async (runId: string) =>
    (await db.admin.query(`SELECT seq, kind, source_line, payload FROM run_events WHERE run_id = $1 ORDER BY seq`, [runId])).rows as Array<{ seq: number; kind: string; source_line: string | null; payload: Record<string, unknown> }>;
  const lines = async (runId: string): Promise<number[]> => (await events(runId)).filter((e) => e.kind === "agent.output").map((e) => Number(e.source_line));
  const booked = async (accountId: string, runId: string): Promise<number[]> =>
    (await db.admin.query(`SELECT usd FROM ledger WHERE account_id = $1 AND run_id = $2 AND budget = 'model'`, [accountId, runId])).rows.map((r: { usd: string }) => Number(r.usd));
  const status = async (runId: string): Promise<string> => (await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId])).rows[0].status as string;
  const readerRow = async (runId: string) =>
    (await db.admin.query(`SELECT epoch, cmd_id, lease_until > clock_timestamp() AS held, state, side_effects FROM run_log_readers WHERE run_id = $1`, [runId])).rows[0] as { epoch: string; cmd_id: string; held: boolean; state: Record<string, unknown>; side_effects: Record<string, unknown> };
  const savedUsd = async (runId: string): Promise<number> => Number((await db.admin.query(`SELECT (state->'ledger'->>'cumulativeModelUsd')::numeric AS usd FROM run_log_readers WHERE run_id = $1`, [runId])).rows[0].usd);
  const expireLease = (runId: string) => db.admin.query(`UPDATE run_log_readers SET lease_until = clock_timestamp() - interval '1 second' WHERE run_id = $1`, [runId]);

  /** What the follower step does: wire a NEW target instance, call the step's body. `seam` caps the records of a slice (the port's test seam), `faults` are the staging flags. */
  async function step(d: Dispatched, o: { maxRecords?: number; faults?: ReaderFaults; deadlineMs?: number; deps?: Partial<SandboxTargetDeps> } = {}) {
    const wrap = (real: SandboxPort): SandboxPort => ({ ...real, readSlice: (h, so) => real.readSlice!(h, { ...so, checkpointEveryMs: 0, ...(o.maxRecords !== undefined && { maxRecords: o.maxRecords }) }) });
    configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: d.target({ sliceMs: 60_000, faults: o.faults ?? {} }, wrap, o.deps) } });
    return followSliceBody(d.accountId, d.run.id, d.slice, o.deadlineMs);
  }

  /** The follower's loop in miniature: step until the run is done; a step that does not hold the lease (a reader that died) waits out the lease, which the test expires. */
  async function follow(d: Dispatched, o: { maxRecords?: number; faults?: ReaderFaults } = {}) {
    const outs = [];
    for (let i = 0; i < 80; i++) {
      const out = await step(d, o);
      outs.push(out);
      if (out.done) return outs;
      if (!out.held) await expireLease(d.run.id);
    }
    throw new Error("the run did not end in 80 steps");
  }

  async function baseline() {
    const d = await dispatched(STREAM);
    const outs = await follow(d);
    expect(outs).toHaveLength(1);
    return { lines: await lines(d.run.id), booked: await booked(d.accountId, d.run.id), texts: (await events(d.run.id)).filter((e) => e.kind === "agent.output").map((e) => e.payload.text) };
  }

  describe("dispatch hands the command over", () => {
    it("inserts the reader row with the command's id, reads nothing, finalizes nothing and passes the command's start on", async () => {
      const before = Date.now();
      const d = await dispatched(STREAM);
      const row = await readerRow(d.run.id);
      expect(row.cmd_id).toBe(d.vm.log.find((e) => e.kind === "agent_started")?.cmdId);
      expect(d.vm.agents).toHaveLength(1);
      expect(row.held).toBe(false);
      expect(Number(row.epoch)).toBe(0);
      expect(d.startedMs).toBeGreaterThanOrEqual(before);
      expect(d.startedMs).toBeLessThanOrEqual(Date.now());
      // Nothing subscribed to the agent command, nothing was read, nothing stopped, nothing ended.
      expect(d.vm.log.some((e) => e.kind === "read_logs" || e.kind === "agent_logs")).toBe(false);
      expect(d.vm.log.some((e) => e.kind === "sandbox_stop")).toBe(false);
      expect(await status(d.run.id)).toBe("running");
      expect(await booked(d.accountId, d.run.id)).toEqual([]);
      expect(await lines(d.run.id)).toEqual([]);
    });

    it("a target with no reader setting reads in the starting invocation: no reader row, no hand-over, no start time", async () => {
      const d = await dispatched({ lines: [initLine(), assistantLine("m1", 10), resultLine(envelopeBlock("pass"))] }, { reader: null });
      expect(d.startedMs).toBeUndefined();
      expect((await db.admin.query(`SELECT 1 FROM run_log_readers WHERE run_id = $1`, [d.run.id])).rowCount).toBe(0);
    });

    it("a run that already has a reader row fails the launch (its cursor says nothing about this command), and the old row is left as it was", async () => {
      let seeded: string | undefined;
      await expect(
        dispatched(STREAM, {
          startPort: (real, pool) => ({
            ...real,
            startDetached: (h, o) => real.startDetached(h, { ...o, handOff: async (c) => { await insertReader(pool, { accountId: seeded!, runId: o.runId, cmdId: "cmd_old" }); return o.handOff!(c); } }),
          }),
          onAccount: (id) => (seeded = id),
        }),
      ).rejects.toThrow(/sandbox_error/);
      const row = (await db.admin.query(`SELECT r.run_id, r.cmd_id, a.status FROM run_log_readers r JOIN agent_runs a ON a.id = r.run_id WHERE r.account_id = $1`, [seeded])).rows;
      expect(row).toEqual([expect.objectContaining({ cmd_id: "cmd_old", status: "failed" })]);
    });
  });

  describe("many slices with crashes between them", () => {
    it("a run cut into slices of two records, with a reader that dies in the third slice, ends exactly as the run read in one go: each line once, one booking, one terminal row", async () => {
      const base = await baseline();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const d = await dispatched(STREAM);
      const outs = await follow(d, { maxRecords: 2, faults: { crashAtEpoch: 3 } });
      expect(outs.length).toBeGreaterThanOrEqual(5);
      expect(outs.filter((o) => !o.held)).toHaveLength(1); // the dead reader's lease was held until it ran out, once
      expect(outs.every((o) => o.sliced)).toBe(true);
      expect(await status(d.run.id)).toBe("succeeded");
      expect(await lines(d.run.id)).toEqual(base.lines.map((_, i) => base.lines[i]!));
      expect(new Set(await lines(d.run.id)).size).toBe(ASSISTANT_LINES);
      expect((await events(d.run.id)).filter((e) => e.kind === "agent.output").map((e) => e.payload.text)).toEqual(base.texts);
      expect(await booked(d.accountId, d.run.id)).toEqual(base.booked);
      expect((await events(d.run.id)).filter((e) => e.kind === "run.status_changed" && e.payload.to === "succeeded")).toHaveLength(1);
      // The fault fired once.
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("reader.fault_injected"))).toHaveLength(1);
      expect(Number((await readerRow(d.run.id)).epoch)).toBe(outs.length - 1); // every step took the lease but the one that found the dead reader's still held
    }, 120_000);

    it("a crash in every slice after the first (the reader dies at each epoch in turn) still replays each line once and meters once", async () => {
      const base = await baseline();
      for (const epoch of [2, 4]) {
        const d = await dispatched(STREAM);
        await follow(d, { maxRecords: 2, faults: { crashAtEpoch: epoch } });
        expect(await lines(d.run.id)).toEqual(base.lines);
        expect(await booked(d.accountId, d.run.id)).toEqual(base.booked);
        expect(await status(d.run.id)).toBe("succeeded");
      }
    }, 120_000);

    it("a deadline too close to leave a slice any time still makes progress (the slice is never shorter than the floor)", async () => {
      const d = await dispatched(STREAM);
      const out = await step(d, { maxRecords: 3, deadlineMs: Date.now() + 1 });
      expect(out).toMatchObject({ sliced: true, held: true, done: false });
      expect(Number((await readerRow(d.run.id)).epoch)).toBe(1);
    });

    it("the staging tamper flag empties the record file before the second slice; the exit finds it and the run does not succeed", async () => {
      const d = await dispatched(STREAM);
      expect(await step(d, { maxRecords: 5, faults: { tamper: true } })).toMatchObject({ held: true, done: false });
      expect(await step(d, { faults: { tamper: true } })).toMatchObject({ done: true });
      expect(d.vm.log.some((e) => e.kind === "tamper")).toBe(true);
      expect(await status(d.run.id)).toBe("failed");
      const metering = (await events(d.run.id)).find((e) => e.kind === "run.metering");
      expect(metering?.payload.flags).toContain("record_file_tampered");
    });
  });

  describe("hard conditions carried over from the slice reader", () => {
    it("(a) a re-attach that fails is reported as failed with the lease held and the run going on; the follower's give-up ends it as failed from the saved meter, once", async () => {
      const d = await dispatched(STREAM);
      expect(await step(d, { maxRecords: 5 })).toMatchObject({ held: true, done: false });
      const usd = await savedUsd(d.run.id);
      expect(usd).toBeGreaterThan(0);
      const failing = (real: SandboxPort): SandboxPort => ({ ...real, readSlice: async () => { throw new SliceAttachError("x"); } });
      configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: d.target(undefined, failing) } });
      expect(await followSliceBody(d.accountId, d.run.id, d.slice)).toMatchObject({ sliced: true, held: true, failed: true, done: false });
      expect(await status(d.run.id)).toBe("running");
      configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: d.target(undefined, failing) } });
      expect(await followAttachLostBody(d.accountId, d.run.id, d.slice)).toMatchObject({ status: "failed", done: true });
      expect(await booked(d.accountId, d.run.id)).toEqual([usd]);
      expect(d.vm.log.some((e) => e.kind === "sandbox_stop")).toBe(true);
      // Asked again (the workflow retried its step): nothing is booked twice and the run stays as it ended.
      expect(await followAttachLostBody(d.accountId, d.run.id, d.slice)).toMatchObject({ status: "failed", done: true });
      expect(await booked(d.accountId, d.run.id)).toEqual([usd]);
      expect((await events(d.run.id)).filter((e) => e.kind === "run.status_changed" && e.payload.to === "failed")).toHaveLength(1);
    }, 60_000);

    it("(b) a finished run whose reader row holds an unbooked meter is booked once by the revisit, after the live holder's lease ran out, and never twice", async () => {
      const d = await dispatched(STREAM);
      expect(await step(d, { maxRecords: 5 })).toMatchObject({ held: true, done: false });
      const usd = await savedUsd(d.run.id);
      // A cancel while another invocation holds the lease: the status is set, that holder never comes back.
      await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [d.run.id]);
      expect(await takeLease(db.runWriterPool, { accountId: d.accountId, runId: d.run.id })).not.toBeNull();
      configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: d.target() } });
      expect(await followRevisitBody(d.accountId, d.run.id, d.slice)).toBe("held");
      expect(await booked(d.accountId, d.run.id)).toEqual([]);
      await expireLease(d.run.id);
      expect(await followRevisitBody(d.accountId, d.run.id, d.slice)).toBe("done");
      expect(await booked(d.accountId, d.run.id)).toEqual([usd]);
      expect(await followRevisitBody(d.accountId, d.run.id, d.slice)).toBe("done");
      expect(await followRevisitBody(d.accountId, d.run.id, d.slice)).toBe("done");
      expect(await booked(d.accountId, d.run.id)).toEqual([usd]);
      expect((await readerRow(d.run.id)).held).toBe(false); // the fence gave its lease back
    }, 60_000);

    it("(b) the revisit leaves a run that is still going alone: no fence, no booking", async () => {
      const d = await dispatched(STREAM);
      expect(await step(d, { maxRecords: 5 })).toMatchObject({ held: true });
      const epoch = (await readerRow(d.run.id)).epoch;
      configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: d.target() } });
      expect(await followRevisitBody(d.accountId, d.run.id, d.slice)).toBe("done");
      expect((await readerRow(d.run.id)).epoch).toBe(epoch);
      expect(await booked(d.accountId, d.run.id)).toEqual([]);
    });

    it("(c) saved state without a reader part is refused: the run ends as failed, booked from the saved meter, and nothing is read from a guard that was never restored", async () => {
      const d = await dispatched(STREAM);
      expect(await step(d, { maxRecords: 5 })).toMatchObject({ held: true });
      const usd = await savedUsd(d.run.id);
      await db.admin.query(`UPDATE run_log_readers SET state = state - 'reader' WHERE run_id = $1`, [d.run.id]);
      expect(await step(d)).toMatchObject({ done: true, held: true });
      expect(await status(d.run.id)).toBe("failed");
      expect(await booked(d.accountId, d.run.id)).toEqual([usd]);
    }, 60_000);

    it("(c) a consumed-record count that is not the cursor is refused the same way", async () => {
      const d = await dispatched(STREAM);
      expect(await step(d, { maxRecords: 5 })).toMatchObject({ held: true });
      const usd = await savedUsd(d.run.id);
      await db.admin.query(`UPDATE run_log_readers SET next_seq = next_seq + 1 WHERE run_id = $1`, [d.run.id]);
      expect(await step(d)).toMatchObject({ done: true, held: true });
      expect(await status(d.run.id)).toBe("failed");
      expect(await booked(d.accountId, d.run.id)).toEqual([usd]);
    }, 60_000);

    it("(c) an honest cursor and reader part are never refused: a run in slices of one record reaches its end", async () => {
      const d = await dispatched(STREAM);
      const outs = await follow(d, { maxRecords: 1 });
      expect(outs.length).toBeGreaterThan(6);
      expect(await status(d.run.id)).toBe("succeeded");
    }, 120_000);

    it("(d) the finalize after the port returns keeps the lease: another invocation cannot take the run while the stop is slow", async () => {
      const slowStop = { on: false };
      const d = await dispatched(STREAM);
      const t = d.target(undefined, (real) => ({
        ...real,
        stop: async (h) => {
          if (slowStop.on) {
            // The lease is cut to a second, and the stop takes three: only a renewal keeps this reader in charge.
            await db.admin.query(`UPDATE run_log_readers SET lease_until = clock_timestamp() + interval '1 second' WHERE run_id = $1`, [d.run.id]);
            await settle(3_000);
          }
          return real.stop(h);
        },
      }));
      expect(await t.readSlice(d.run, { untilMs: until(), maxRecords: 5, renewEveryMs: 200 })).toEqual({ done: false, held: true });
      slowStop.on = true;
      const ending = t.readSlice(d.run, { untilMs: until(), renewEveryMs: 200 });
      await settle(1_800);
      // Mid-finalize, past the cut lease's end: a second invocation finds the lease taken.
      expect(await d.target().readSlice(d.run, { untilMs: until() })).toEqual({ done: false, held: false });
      expect(await ending).toMatchObject({ done: true, held: true, status: "succeeded" });
      expect((await events(d.run.id)).filter((e) => e.kind === "run.status_changed" && e.payload.to === "succeeded")).toHaveLength(1);
      expect(await booked(d.accountId, d.run.id)).toHaveLength(1);
    }, 60_000);
  });

  describe("the caps a slice enforces are the ones the run was reserved with", () => {
    const anyRead = (d: Dispatched): boolean => d.vm.log.some((e) => e.kind === "read_logs" || e.kind === "read");

    it("the facts stored at hand-over carry the cap the reservation was made with, and the slice runs on that copy", async () => {
      const d = await dispatched(STREAM);
      const stored = (await readerRow(d.run.id)).side_effects.facts as { capUsd: number; spend: { perSpawnCapUsd: number; estimateModelUsd: number; monthlyModelBudgetUsd: number } };
      expect(stored.spend.perSpawnCapUsd).toBe(SPEND.perSpawnCapUsd);
      expect(stored.capUsd).toBe(5);
      expect(stored.spend.monthlyModelBudgetUsd).toBe(SPEND.monthlyModelBudgetUsd);
      // The reservation was taken for the same estimate, which admit holds to be within that cap.
      const reserved = Number((await db.admin.query(`SELECT usd_reserved FROM spend_reservations WHERE run_id = $1 AND budget = 'model'`, [d.run.id])).rows[0].usd_reserved);
      expect(reserved).toBeCloseTo(stored.spend.estimateModelUsd, 6);
      expect(reserved).toBeLessThanOrEqual(stored.spend.perSpawnCapUsd);
      expect(await step(d, { maxRecords: 3 })).toMatchObject({ sliced: true, held: true, done: false });
    });

    it("a follower copy with a higher cap fails closed: nothing is read, the run is ended as failed, no uncapped slice runs", async () => {
      const d = await dispatched(STREAM);
      const tampered = { ...d.slice, run: { ...d.slice.run, spend: { ...d.slice.run.spend, perSpawnCapUsd: 5000 }, capUsd: 5000 } };
      configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: d.target() } });
      expect(await followSliceBody(d.accountId, d.run.id, tampered)).toMatchObject({ done: true, held: false });
      expect(await status(d.run.id)).toBe("failed");
      expect(anyRead(d)).toBe(false);
      expect(await lines(d.run.id)).toEqual([]);
    });

    it("an absent follower copy, an absent stored copy and an unparsable stored copy each fail closed the same way", async () => {
      for (const damage of ["absent_args", "absent_stored", "unknown_key", "huge_number"] as const) {
        const d = await dispatched(STREAM);
        if (damage === "absent_stored") await db.admin.query(`UPDATE run_log_readers SET side_effects = side_effects - 'facts' WHERE run_id = $1`, [d.run.id]);
        if (damage === "unknown_key") await db.admin.query(`UPDATE run_log_readers SET side_effects = jsonb_set(side_effects, '{facts,extra}', '1') WHERE run_id = $1`, [d.run.id]);
        if (damage === "huge_number") await db.admin.query(`UPDATE run_log_readers SET side_effects = jsonb_set(side_effects, '{facts,capUsd}', '1e12') WHERE run_id = $1`, [d.run.id]);
        configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: d.target() } });
        expect(await followSliceBody(d.accountId, d.run.id, damage === "absent_args" ? undefined : d.slice), damage).toMatchObject({ done: true, held: false });
        expect(await status(d.run.id), damage).toBe("failed");
        expect(anyRead(d), damage).toBe(false);
      }
    }, 60_000);
  });

  describe("runs that are not opted in are read where they start (the paths with no slice follower)", () => {
    const waitHook = async (d: Dispatched): Promise<void> => {
      for (let i = 0; i < 200 && d.harness.hooks.calls.length === 0; i++) await settle(25);
      expect(d.harness.hooks.calls.length).toBeGreaterThan(0);
    };

    it("with the reader configured, a run started without the opt-in has no hand-over, is read and metered in-process, and books what it spent", async () => {
      const base = await baseline();
      const d = await dispatched(STREAM, { slice: false });
      expect(d.startedMs).toBeUndefined();
      expect((await db.admin.query(`SELECT 1 FROM run_log_readers WHERE run_id = $1`, [d.run.id])).rowCount).toBe(0);
      await waitHook(d);
      const call = d.harness.hooks.calls[0]!;
      await d.target().finalize(d.run, call.report);
      expect(await status(d.run.id)).toBe("succeeded");
      expect(await booked(d.accountId, d.run.id)).toEqual(base.booked);
      expect((await booked(d.accountId, d.run.id)).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
      expect(d.vm.log.filter((e) => e.kind === "read").length).toBeGreaterThan(0); // it was read, here
      // The watchdog finds no reader row, so it has nothing to say about it.
      await db.admin.query(`UPDATE agent_runs SET status = 'running' WHERE id = $1`, [d.run.id]).catch(() => undefined);
    }, 60_000);

    it("the target hands a command over only for a run that carries the opt-in, on a start and on a resume", async () => {
      const idle = (real: SandboxPort, seen: Array<{ entry: string; handOff: boolean }>): SandboxPort => ({
        ...real,
        startDetached: (h, o) => (seen.push({ entry: "dispatch", handOff: o.handOff !== undefined }), { handle: h, hookFired: new Promise(() => undefined), launched: Promise.resolve() }),
        resume: (h, _sid, _p, o) => (seen.push({ entry: "resume", handOff: o.handOff !== undefined }), { handle: h, hookFired: new Promise(() => undefined), launched: Promise.resolve() }),
      });
      for (const slice of [false, true]) {
        const seen: Array<{ entry: string; handOff: boolean }> = [];
        const d = await dispatched(STREAM, { slice, reader: { sliceMs: 60_000, faults: {} }, startPort: (real) => idle(real, seen) });
        expect(seen, `dispatch slice=${slice}`).toEqual([{ entry: "dispatch", handOff: slice }]);
        await db.admin.query(`UPDATE agent_runs SET status = 'pending' WHERE id = $1`, [d.run.id]); // a resume starts from a run that has not started
        await d.target(undefined, (real) => idle(real, seen)).resume({ ...d.run, ...(slice && { slice: true as const }) }, "cc-session").catch(() => undefined);
        expect(seen.at(-1), `resume slice=${slice}`).toEqual({ entry: "resume", handOff: slice });
      }
    }, 60_000);
  });

  describe("an operator run keeps the operator budget in slices", () => {
    it("a monthly budget far below the run's spend kills an ordinary run in a later slice and leaves an operator run alone", async () => {
      const over = { spend: { estimateModelUsd: 0.000001, monthlyModelBudgetUsd: 0.00001 } };
      const ordinary = await dispatched(STREAM, over);
      expect(await step(ordinary)).toMatchObject({ done: true });
      expect(await status(ordinary.run.id)).toBe("killed_spend");
      const operator = await dispatched(STREAM, over);
      expect(await step(operator, { deps: { operatorToken: () => "operator-subscription-token" } })).toMatchObject({ done: true });
      expect(await status(operator.run.id)).toBe("succeeded");
    }, 60_000);
  });

  describe("the watchdog reads once more before it ends a run nobody follows", () => {
    it("what the command spent since the last save is booked: the saved figure is not where the books stop", async () => {
      const script: SliceScript = { lines: [initLine(), assistantLine("m1", 10), assistantLine("m2", 1000), assistantLine("m3", 2000), assistantLine("m4", 50)], endless: true };
      const d = await dispatched(script);
      await settle(100);
      expect(await step(d, { maxRecords: 3 })).toMatchObject({ held: true, done: false }); // header, init, m1
      const savedBefore = await savedUsd(d.run.id);
      await db.admin.query(`UPDATE run_log_readers SET updated_at = now() - interval '20 minutes' WHERE run_id = $1`, [d.run.id]);
      const sweeper = d.target(undefined, (real) => ({ ...real, sandboxState: async () => "running" }), { followerCatchUpMs: 1_500 });
      expect(await sweeper.settleIfLost(d.run)).toBe("settled");
      expect(await status(d.run.id)).toBe("failed");
      const total = (await booked(d.accountId, d.run.id)).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(savedBefore);
      expect(await booked(d.accountId, d.run.id)).toHaveLength(1);
    }, 60_000);

    it("a read that ends the run itself leaves nothing for the watchdog to fail", async () => {
      const d = await dispatched(STREAM);
      await settle(200);
      expect(await step(d, { maxRecords: 3 })).toMatchObject({ held: true });
      await db.admin.query(`UPDATE run_log_readers SET updated_at = now() - interval '20 minutes' WHERE run_id = $1`, [d.run.id]);
      const sweeper = d.target(undefined, (real) => ({ ...real, sandboxState: async () => "running" }), { followerCatchUpMs: 10_000 });
      expect(await sweeper.settleIfLost(d.run)).toBe("settled");
      expect(await status(d.run.id)).toBe("succeeded");
    }, 60_000);
  });

  describe("the watchdog for a follower that stopped", () => {
    it("a running sliced run whose reader row has stood still past the limit is ended as failed from the saved meter; a live one is left alone", async () => {
      const d = await dispatched({ ...STREAM, endless: true });
      expect(await step(d, { maxRecords: 5 })).toMatchObject({ held: true });
      const usd = await savedUsd(d.run.id);
      const sweeper = d.target(undefined, (real) => ({ ...real, sandboxState: async () => "running" }), { followerCatchUpMs: 1_500 });
      expect(await sweeper.settleIfLost(d.run)).not.toBe("settled");
      expect(await status(d.run.id)).toBe("running");
      await db.admin.query(`UPDATE run_log_readers SET updated_at = now() - interval '20 minutes' WHERE run_id = $1`, [d.run.id]);
      expect(await sweeper.settleIfLost(d.run)).toBe("settled");
      expect(await status(d.run.id)).toBe("failed");
      const bookedNow = await booked(d.accountId, d.run.id);
      expect(bookedNow).toHaveLength(1);
      expect(bookedNow[0]!).toBeGreaterThanOrEqual(usd); // what the command spent since the last save is in it too
      expect((await events(d.run.id)).filter((e) => e.kind === "run.status_changed" && e.payload.to === "failed")).toHaveLength(1);
    }, 60_000);

    it("a run with no reader row is not touched by it", async () => {
      const d = await dispatched(STREAM, { reader: null });
      const sweeper = d.target(undefined, (real) => ({ ...real, sandboxState: async () => "running" }));
      expect(await sweeper.settleIfLost(d.run)).not.toBe("settled");
    });
  });
});
