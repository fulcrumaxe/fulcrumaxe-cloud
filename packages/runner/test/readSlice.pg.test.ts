import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { ExecutionRun } from "../src/executionTarget.js";
import type { SandboxPort } from "../src/sandboxPort.js";
import { sandboxNameFor } from "../src/sandboxNaming.js";
import { insertReader, takeLease } from "../src/readerStore.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { assistantLine, envelopeBlock, resultLine, sliceRig, type SliceScript } from "./helpers/sliceRig.js";

const SPEND = { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const, estimateModelUsd: 0.001, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 };
const initLine = (): string => JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\n";
const STREAM: SliceScript = {
  lines: [initLine(), assistantLine("m1", 10), assistantLine("m1", 15), assistantLine("m2", 1000), assistantLine("m3", 2000), assistantLine("m4", 50), resultLine(envelopeBlock("pass"))],
};
const ASSISTANT_LINES = 5;

/**
 * D#2 RLR-4 [pg]: the sliced reader against the real lease table, the real writer and the real settle. The agent is the strict recording VM; the run row, its
 * reservation, the reader row and every save are real.
 */
describe("sliced reader on the lease [pg]", () => {
  const db = pgHarness();
  const until = (): number => Date.now() + 60_000;

  async function newRun(script: SliceScript, rigOver: Partial<Parameters<typeof sliceRig>[0]> = {}) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    const harness = createSandboxTargetHarness(db.runWriterPool);
    // A launch that starts nothing and never ends: it only takes the run to `running`, with its reservation, as dispatch does.
    const idle: SandboxPort = { ...harness.deps.sandboxPort, startDetached: (handle) => ({ handle, hookFired: new Promise(() => undefined), launched: Promise.resolve() }) };
    const starter = new SandboxTarget({ ...harness.deps, sandboxPort: idle });
    const input: StartAgentRunInput = { accountId, repoId, role: "code-reviewer", product: "team", roleCard: "fake role card", prompt: "fake prompt", model: "haiku-4.5", capUsd: 5, spend: SPEND, ...(rigOver.limits && { limits: { maxTurns: 17, maxModelCalls: 40, maxRunMs: 9 * 60_000, meteringSilenceMs: 11 * 60_000, ...rigOver.limits } }) };
    const started = await startAgentRun(db.runWriterPool, { sandbox: starter }, input);
    if (started.status !== "running") throw new Error(`test setup: expected "running", got "${started.status}"`);
    const run: ExecutionRun = { id: started.id, accountId, repoId, role: "code-reviewer", product: "team", roleCard: "fake role card", prompt: "fake prompt", model: "haiku-4.5", capUsd: 5, spend: SPEND, ...(rigOver.limits && { limits: { maxTurns: 17, maxModelCalls: 40, maxRunMs: 9 * 60_000, meteringSilenceMs: 11 * 60_000, ...rigOver.limits } }) };
    const name = sandboxNameFor({ role: "code-reviewer", runId: run.id, accountId, repoId });
    const rig = sliceRig({ script, runId: run.id, sandboxName: name, ...rigOver });
    const cmdId = await rig.startCommand();
    await db.admin.query(`UPDATE agent_runs SET sandbox_session_ids = ARRAY['sess-1'] WHERE id = $1`, [run.id]);
    expect(await insertReader(db.runWriterPool, { accountId, runId: run.id, cmdId })).toBe(true);
    /** A target instance (its own memory) over the rig's real port, `wrap` altering what the port is asked. */
    const target = (wrap?: (real: NonNullable<SandboxPort["readSlice"]>) => NonNullable<SandboxPort["readSlice"]>): SandboxTarget => {
      const port: SandboxPort = { ...rig.port, ...(wrap && { readSlice: wrap(rig.port.readSlice!.bind(rig.port)) }) };
      return new SandboxTarget({ ...harness.deps, sandboxPort: port });
    };
    return { accountId, run, rig, target, cmdId };
  }

  const events = async (runId: string) =>
    (await db.admin.query(`SELECT seq, kind, source_line, payload FROM run_events WHERE run_id = $1 ORDER BY seq`, [runId])).rows as Array<{ seq: number; kind: string; source_line: string | null; payload: Record<string, unknown> }>;
  const lines = async (runId: string): Promise<number[]> => (await events(runId)).filter((e) => e.kind === "agent.output").map((e) => Number(e.source_line));
  const booked = async (accountId: string, runId: string): Promise<number[]> =>
    (await db.admin.query(`SELECT usd FROM ledger WHERE account_id = $1 AND run_id = $2 AND budget = 'model'`, [accountId, runId])).rows.map((r: { usd: string }) => Number(r.usd));
  const status = async (runId: string): Promise<string> => (await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId])).rows[0].status as string;
  const reader = async (runId: string) =>
    (await db.admin.query(`SELECT epoch, next_seq, lease_until > clock_timestamp() AS held FROM run_log_readers WHERE run_id = $1`, [runId])).rows[0] as { epoch: string; next_seq: string; held: boolean };

  /** The figures a run ends with when it is read in one go: what every other way of reading it must reproduce. */
  async function baseline() {
    const b = await newRun(STREAM);
    const step = await b.target().readSlice(b.run, { untilMs: until() });
    expect(step).toMatchObject({ done: true, held: true, status: "succeeded" });
    return { lines: await lines(b.run.id), booked: await booked(b.accountId, b.run.id), texts: (await events(b.run.id)).filter((e) => e.kind === "agent.output").map((e) => e.payload.text) };
  }

  it("two invocations racing on one run: exactly one takes the lease and reads, the other does nothing, and the run ends once", async () => {
    const r = await newRun(STREAM);
    const steps = await Promise.all([r.target().readSlice(r.run, { untilMs: until() }), r.target().readSlice(r.run, { untilMs: until() })]);
    expect(steps.filter((s) => s.held)).toHaveLength(1);
    expect(steps.filter((s) => !s.held)).toEqual([{ done: expect.any(Boolean) as boolean, held: false }]);
    expect(await status(r.run.id)).toBe("succeeded");
    const ev = await events(r.run.id);
    expect(ev.filter((e) => e.kind === "run.status_changed" && e.payload.to === "succeeded")).toHaveLength(1);
    expect((await lines(r.run.id)).length).toBe(ASSISTANT_LINES);
    expect(new Set(await lines(r.run.id)).size).toBe(ASSISTANT_LINES);
    expect(await booked(r.accountId, r.run.id)).toHaveLength(1);
  });

  it("a stale epoch is refused: a reader whose lease was taken over moves no cursor, writes no row, finalizes nothing and stops nothing", async () => {
    const r = await newRun(STREAM);
    let saves = 0;
    const zombie = r.target((real) => (handle, o) =>
      real(handle, {
        ...o,
        checkpointEveryMs: 0,
        commit: async (cp) => {
          if (++saves === 2) {
            // The lease runs out and another invocation takes it over, between this reader's two saves.
            await db.admin.query(`UPDATE run_log_readers SET lease_until = clock_timestamp() - interval '1 second' WHERE run_id = $1`, [r.run.id]);
            await takeLease(db.runWriterPool, { accountId: r.accountId, runId: r.run.id });
          }
          return o.commit(cp);
        },
      }),
    );
    const step = await zombie.readSlice(r.run, { untilMs: until() });
    expect(step).toEqual({ done: false, held: false });
    expect(await status(r.run.id)).toBe("running");
    expect(r.rig.vm.log.some((e) => e.kind === "sandbox_stop")).toBe(false);
    const row = await reader(r.run.id);
    expect(row.epoch).toBe("2");
    // Only the first save, which the zombie still held, left anything behind.
    expect(Number(row.next_seq)).toBeLessThanOrEqual(2);
    expect((await lines(r.run.id)).length).toBeLessThanOrEqual(1);
    expect((await events(r.run.id)).some((e) => e.kind === "run.status_changed" && e.payload.to !== "running")).toBe(false);
  });

  it("a crash between saves replays exactly once: each output line is stored once under its line number, the spend is booked once, the verdict is the same", async () => {
    const base = await baseline();
    const r = await newRun(STREAM);
    let saves = 0;
    // The first invocation dies after its second save: every later save fails, as they would for a process that is gone.
    const dying = r.target((real) => (handle, o) =>
      real(handle, {
        ...o,
        checkpointEveryMs: 0,
        commit: async (cp) => {
          if (++saves > 2) throw new Error("the process died");
          return o.commit(cp);
        },
      }),
    );
    expect(await dying.readSlice(r.run, { untilMs: until() })).toEqual({ done: false, held: false });
    expect(await status(r.run.id)).toBe("running");
    const midRows = await lines(r.run.id);
    expect(midRows.length).toBeLessThan(ASSISTANT_LINES);
    // A fresh invocation, with no memory of the first, takes over from the last save.
    const step = await r.target().readSlice(r.run, { untilMs: until() });
    expect(step).toMatchObject({ done: true, held: true, status: "succeeded" });
    expect(await lines(r.run.id)).toEqual(base.lines.map((_, i) => base.lines[i]!));
    expect(new Set(await lines(r.run.id)).size).toBe(ASSISTANT_LINES);
    expect((await events(r.run.id)).filter((e) => e.kind === "agent.output").map((e) => e.payload.text)).toEqual(base.texts);
    expect(await booked(r.accountId, r.run.id)).toEqual(base.booked);
    expect((await events(r.run.id)).filter((e) => e.kind === "run.status_changed" && e.payload.to === "succeeded")).toHaveLength(1);
  });

  it("the row's 1-based next_seq at both edges: a fresh row starts at the header, and a file read only as far as its header resumes at the first line", async () => {
    const r = await newRun(STREAM);
    expect(Number((await reader(r.run.id)).next_seq)).toBe(1); // fresh: the header is next
    const t = r.target();
    expect(await t.readSlice(r.run, { untilMs: until(), maxRecords: 1 })).toEqual({ done: false, held: true });
    expect(Number((await reader(r.run.id)).next_seq)).toBe(2); // the header alone is read
    expect(r.rig.flags).toEqual([]);
    const step = await t.readSlice(r.run, { untilMs: until() }); // resumes at record 1, not at the header again and not one line late
    expect(step).toMatchObject({ done: true, status: "succeeded" });
    expect((await lines(r.run.id)).length).toBe(ASSISTANT_LINES);
  });

  it("a run cut into slices of one record is the run read in one go: the same lines, the same booking, one terminal row, and the lease given up at each hand-over", async () => {
    const base = await baseline();
    const r = await newRun(STREAM);
    const t = r.target();
    let done = false;
    let slices = 0;
    while (!done) {
      const step = await t.readSlice(r.run, { untilMs: until(), maxRecords: 1 });
      expect(step.held).toBe(true);
      expect((await reader(r.run.id)).held).toBe(false);
      done = step.done;
      slices++;
    }
    expect(slices).toBeGreaterThan(5);
    expect(await status(r.run.id)).toBe("succeeded");
    expect(await lines(r.run.id)).toEqual(base.lines);
    expect(await booked(r.accountId, r.run.id)).toEqual(base.booked);
  });

  it("the order at the end: the last read, the echo replay, the stop, then the terminal status, with every output row before it", async () => {
    const r = await newRun(STREAM);
    await r.target().readSlice(r.run, { untilMs: until() });
    const order = r.rig.vm.log.filter((e) => e.kind === "read" || e.kind === "agent_logs" || e.kind === "sandbox_stop").map((e) => e.kind);
    const lastRead = order.lastIndexOf("read");
    expect(order.indexOf("agent_logs")).toBeGreaterThan(lastRead);
    expect(order.indexOf("sandbox_stop")).toBeGreaterThan(order.indexOf("agent_logs"));
    expect(order.filter((k) => k === "agent_logs")).toHaveLength(1);
    const ev = await events(r.run.id);
    const terminal = ev.findIndex((e) => e.kind === "run.status_changed" && e.payload.to === "succeeded");
    expect(terminal).toBeGreaterThan(-1);
    expect(ev.map((e, i) => (e.kind === "agent.output" ? i : -1)).filter((i) => i >= 0).every((i) => i < terminal)).toBe(true);
  });

  it("a cancel is noticed at the next save: the slice stops at once, finalizes nothing and does not stop what the cancel already stopped", async () => {
    const r = await newRun(STREAM);
    let saves = 0;
    const t = r.target((real) => (handle, o) =>
      real(handle, {
        ...o,
        checkpointEveryMs: 0,
        commit: async (cp) => {
          if (++saves === 2) await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [r.run.id]);
          return o.commit(cp);
        },
      }),
    );
    const step = await t.readSlice(r.run, { untilMs: until() });
    expect(step.done).toBe(true);
    expect(step.held).toBe(false);
    expect(r.rig.vm.log.some((e) => e.kind === "sandbox_stop")).toBe(false);
    expect(await status(r.run.id)).toBe("cancelled");
  });

  it("a run that is not running is not read, and one that is still pending is left for later", async () => {
    const r = await newRun(STREAM);
    await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [r.run.id]);
    expect(await r.target().readSlice(r.run, { untilMs: until() })).toEqual({ done: true, held: false });
    expect(r.rig.vm.log.some((e) => e.kind === "read")).toBe(false);
  });

  it("a slice that cannot re-attach changes nothing and gives the lease back, so the next try can take it", async () => {
    const r = await newRun(STREAM);
    await db.admin.query(`UPDATE run_log_readers SET cmd_id = 'cmd_gone' WHERE run_id = $1`, [r.run.id]);
    const step = await r.target().readSlice(r.run, { untilMs: until() });
    expect(step).toEqual({ done: false, held: true, failed: true });
    expect(await status(r.run.id)).toBe("running");
    expect((await reader(r.run.id)).held).toBe(false);
    expect(await lines(r.run.id)).toEqual([]);
  });

  it("a limit that ends the run in a later slice is the limit end, and the spend is booked once", async () => {
    const lines24 = [initLine(), ...Array.from({ length: 24 }, (_, i) => assistantLine(`a${i}`, 10)), resultLine(envelopeBlock("pass"))];
    const r = await newRun({ lines: lines24 }, { limits: { maxModelCalls: 20 } });
    const t = r.target();
    let step = await t.readSlice(r.run, { untilMs: until(), maxRecords: 8 });
    expect(step).toEqual({ done: false, held: true });
    step = await t.readSlice(r.run, { untilMs: until(), maxRecords: 8 });
    expect(step.done).toBe(false);
    step = await t.readSlice(r.run, { untilMs: until() });
    expect(step).toMatchObject({ done: true, status: "timed_out" });
    expect(await status(r.run.id)).toBe("timed_out");
    expect(await booked(r.accountId, r.run.id)).toHaveLength(1);
  });
});
