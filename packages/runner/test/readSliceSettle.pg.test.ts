import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { ExecutionRun } from "../src/executionTarget.js";
import { SliceAttachError, type SandboxPort } from "../src/sandboxPort.js";
import { sandboxNameFor } from "../src/sandboxNaming.js";
import { insertReader } from "../src/readerStore.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";
import type { RecordingVmOptions } from "./helpers/recorderSdk.js";
import { assistantLine, envelopeBlock, resultLine, sliceRig, type SliceScript } from "./helpers/sliceRig.js";

const SPEND = { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const, estimateModelUsd: 0.001, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 };
const initLine = (): string => JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\n";
const STREAM: SliceScript = {
  lines: [initLine(), assistantLine("m1", 10), assistantLine("m1", 15), assistantLine("m2", 1000), assistantLine("m3", 2000), assistantLine("m4", 50), resultLine(envelopeBlock("pass"))],
};
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * D#2 RLR-4 [pg]: how a sliced run ends when the end is not the reader's own (a cancel, the watchdog), when the reader dies after deciding the end, when the
 * exit outlasts the lease, and when the state outgrows its column. The run row, its reservations, the reader row and every save are real.
 */
describe("the ends of a sliced run [pg]", () => {
  const db = pgHarness();
  const until = (): number => Date.now() + 60_000;

  async function newRun(script: SliceScript, over: { vm?: RecordingVmOptions; spend?: Partial<typeof SPEND> } = {}) {
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
    const rig = sliceRig({ script, runId: run.id, sandboxName: name, ...(over.vm && { vm: over.vm }) });
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

  const events = async (runId: string) =>
    (await db.admin.query(`SELECT seq, kind, source_line, payload FROM run_events WHERE run_id = $1 ORDER BY seq`, [runId])).rows as Array<{ seq: number; kind: string; source_line: string | null; payload: Record<string, unknown> }>;
  const booked = async (accountId: string, runId: string): Promise<number[]> =>
    (await db.admin.query(`SELECT usd FROM ledger WHERE account_id = $1 AND run_id = $2 AND budget = 'model'`, [accountId, runId])).rows.map((r: { usd: string }) => Number(r.usd));
  const status = async (runId: string): Promise<string> => (await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId])).rows[0].status as string;
  const modelReservation = async (runId: string): Promise<string | undefined> =>
    (await db.admin.query(`SELECT state FROM spend_reservations WHERE run_id = $1 AND budget = 'model'`, [runId])).rows[0]?.state as string | undefined;
  const savedUsd = async (runId: string): Promise<number> => Number((await db.admin.query(`SELECT (state->'ledger'->>'cumulativeModelUsd')::numeric AS usd FROM run_log_readers WHERE run_id = $1`, [runId])).rows[0].usd);

  /** The first slice: header, init, m1, m1, m2 are read and metered; the lease is given back. */
  async function firstSlice(r: Awaited<ReturnType<typeof newRun>>) {
    const step = await r.target().readSlice(r.run, { untilMs: until(), maxRecords: 5 });
    expect(step).toEqual({ done: false, held: true });
    const usd = await savedUsd(r.run.id);
    expect(usd).toBeGreaterThan(0);
    return usd;
  }

  describe("an end that is not the reader's own books the spend the reader saved", () => {
    it("a cancel on another instance between slices (the API's order: status first, then the target's cancel) books the saved spend once, and the next slice adds nothing", async () => {
      const r = await newRun(STREAM);
      const usd = await firstSlice(r);
      await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [r.run.id]);
      await r.target().cancel(r.run); // an instance that read no slice: its own memory holds no meter
      expect(await booked(r.accountId, r.run.id)).toEqual([usd]);
      expect(await modelReservation(r.run.id)).toBe("settled");
      expect(await r.target().readSlice(r.run, { untilMs: until() })).toEqual({ done: true, held: false });
      expect(await booked(r.accountId, r.run.id)).toEqual([usd]);
      expect(await status(r.run.id)).toBe("cancelled");
    });

    it("the same, when the cancel's own settle ran first and found nothing: the next slice's end books the saved spend (once, the other order)", async () => {
      const r = await newRun(STREAM);
      const usd = await firstSlice(r);
      await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [r.run.id]);
      // The next slice reaches the end before any cancel has settled anything.
      expect(await r.target().readSlice(r.run, { untilMs: until() })).toEqual({ done: true, held: false });
      expect(await booked(r.accountId, r.run.id)).toEqual([usd]);
      await r.target().cancel(r.run);
      await r.target().cancel(r.run);
      expect(await booked(r.accountId, r.run.id)).toEqual([usd]);
    });

    it("a cancel noticed at a save, with no cancel call at all, ends the slice and still books what the save holds", async () => {
      const r = await newRun(STREAM);
      let saves = 0;
      const t = r.target((real) => (handle, o) =>
        real(handle, {
          ...o,
          checkpointEveryMs: 0,
          commit: async (cp) => {
            if (++saves === 6) await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [r.run.id]);
            return o.commit(cp);
          },
        }),
      );
      const step = await t.readSlice(r.run, { untilMs: until() });
      expect(step).toEqual({ done: true, held: false });
      const usd = await savedUsd(r.run.id);
      expect(usd).toBeGreaterThan(0);
      expect(await booked(r.accountId, r.run.id)).toEqual([usd]);
      expect(await status(r.run.id)).toBe("cancelled");
    });

    it("the watchdog's end of a lost sandbox, on an instance that read no slice, books the saved spend and records it on the run", async () => {
      const r = await newRun(STREAM);
      const usd = await firstSlice(r);
      const watchdog = r.target(undefined, { sandboxState: async () => "stopped" });
      expect(await watchdog.settleIfLost(r.run)).toBe("settled");
      expect(await status(r.run.id)).toBe("failed");
      expect(await booked(r.accountId, r.run.id)).toEqual([usd]);
      expect(await modelReservation(r.run.id)).toBe("settled");
      const done = (await events(r.run.id)).filter((e) => e.kind === "run.status_changed" && e.payload.to === "failed");
      expect(done).toHaveLength(1);
      expect(await r.target().readSlice(r.run, { untilMs: until() })).toEqual({ done: true, held: false });
      expect(await booked(r.accountId, r.run.id)).toEqual([usd]);
    });

    it("the watchdog's limit end (a run that outlived its clock) books it too", async () => {
      const r = await newRun(STREAM);
      const usd = await firstSlice(r);
      const limit = { kind: "run_time" as const, limit: 1, observed: 2 };
      await r.target().finalize(r.run, { status: "timed_out", limit });
      expect(await status(r.run.id)).toBe("timed_out");
      expect(await booked(r.accountId, r.run.id)).toEqual([usd]);
    });

    it("a run with no reader row, or nothing saved, books nothing extra: the reservation is released as before", async () => {
      const r = await newRun(STREAM);
      await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [r.run.id]);
      await r.target().cancel(r.run);
      expect(await booked(r.accountId, r.run.id)).toEqual([]);
      expect(await modelReservation(r.run.id)).toBe("released");
    });
  });

  describe("the first end the runner decided survives a takeover", () => {
    it("a spend kill whose reader dies before it finalizes is still a spend kill when the next reader finds the command dead", async () => {
      const spend = { monthlyModelBudgetUsd: 0.002 };
      const r = await newRun(STREAM, { spend });
      // The first invocation reads until the spend rule kills the run, saves its last checkpoint, and dies before it finalizes anything.
      const dying = r.target((real) => async (handle, o) => {
        await real(handle, o).catch(() => undefined);
        throw new SliceAttachError("crash");
      });
      expect(await dying.readSlice(r.run, { untilMs: until() })).toEqual({ done: false, held: true, failed: true });
      expect(await status(r.run.id)).toBe("running");
      const saved = (await db.admin.query(`SELECT state FROM run_log_readers WHERE run_id = $1`, [r.run.id])).rows[0].state as { abort?: { kind: string } };
      expect(saved.abort).toMatchObject({ kind: "spend_kill" });
      // A fresh invocation, with no memory of it.
      const step = await r.target().readSlice(r.run, { untilMs: until() });
      expect(step.done).toBe(true);
      expect(await status(r.run.id)).toBe("killed_spend");
      expect(step.status).toBe("killed_spend");
      expect((await booked(r.accountId, r.run.id)).length).toBe(1);
    });
  });

  describe("the first end survives into the ended path", () => {
    it("a spend kill whose reader dies, found by a reader that reads only a clean ending, is still the spend kill", async () => {
      const kill: SliceScript = { lines: [initLine(), assistantLine("m1", 5000), resultLine(envelopeBlock("pass"))] };
      const r = await newRun(kill, { spend: { monthlyModelBudgetUsd: 0.002 } });
      const dying = r.target((real) => async (handle, o) => {
        await real(handle, { ...o, maxRecords: 3 }).catch(() => undefined); // header, init, m1: the kill lands on m1
        throw new SliceAttachError("crash");
      });
      expect(await dying.readSlice(r.run, { untilMs: until() })).toEqual({ done: false, held: true, failed: true });
      const saved = (await db.admin.query(`SELECT state FROM run_log_readers WHERE run_id = $1`, [r.run.id])).rows[0].state as { abort?: { kind: string } };
      expect(saved.abort).toMatchObject({ kind: "spend_kill" });
      const step = await r.target().readSlice(r.run, { untilMs: until() });
      expect(step.done).toBe(true);
      expect(await status(r.run.id)).toBe("killed_spend");
    });
  });

  describe("the exit outlasts the lease", () => {
    it("a rebuild of the consumed part slower than the lease still saves and finalizes: the lease is renewed meanwhile", async () => {
      const slow = { on: false, runId: "" };
      const vm: RecordingVmOptions = {
        // The lease is cut to a second while the rebuild of the consumed part runs, which then takes three: only a renewal can keep the reader in charge.
        readDelay: async (ctx) => {
          if (!slow.on || ctx.offset !== 0) return;
          await db.admin.query(`UPDATE run_log_readers SET lease_until = clock_timestamp() + interval '1 second' WHERE run_id = $1`, [slow.runId]);
          await settle(3_000);
        },
      };
      const r = await newRun(STREAM, { vm });
      slow.runId = r.run.id;
      const t = r.target();
      expect(await t.readSlice(r.run, { untilMs: until(), maxRecords: 5, renewEveryMs: 200 })).toEqual({ done: false, held: true });
      slow.on = true;
      const step = await t.readSlice(r.run, { untilMs: until(), renewEveryMs: 200 });
      expect(step).toMatchObject({ done: true, held: true, status: "succeeded" });
      expect(await status(r.run.id)).toBe("succeeded");
      expect((await events(r.run.id)).filter((e) => e.kind === "run.status_changed" && e.payload.to === "succeeded")).toHaveLength(1);
      expect(await booked(r.accountId, r.run.id)).toHaveLength(1);
    }, 30_000);
  });

  describe("limits of the saved state and of the read", () => {
    it("a verdict of 1e300 values that would never fit the state column ends the run as failed instead of leaving it stuck", async () => {
      const env = { verdict: "pass", n: Array.from({ length: 12_000 }, () => 1e300) };
      const text = "done\n<!-- AGENT_OUTPUT -->\n```json\n" + JSON.stringify(env) + "\n```\n<!-- /AGENT_OUTPUT -->";
      const r = await newRun({ lines: [initLine(), assistantLine("m1", 10, text), assistantLine("m2", 20), resultLine("done")] });
      const step = await r.target().readSlice(r.run, { untilMs: until(), maxRecords: 2 }); // header and init: nothing near the verdict yet
      expect(step).toEqual({ done: false, held: true });
      const end = await r.target().readSlice(r.run, { untilMs: until() });
      expect(end.done).toBe(true);
      expect(await status(r.run.id)).toBe("failed");
      const metering = (await events(r.run.id)).find((e) => e.kind === "run.metering");
      expect(metering?.payload.flags).toContain("reader_unavailable");
    });

    it("failed reads in many short slices add up in the row and end the run at the limit", async () => {
      const fail = { on: false };
      const vm: RecordingVmOptions = {};
      vm.readFilter = (data) => {
        vm.readExit = fail.on ? 1 : 0;
        return data;
      };
      const r = await newRun({ lines: [initLine(), assistantLine("m1", 10)], endless: true }, { vm });
      const t = r.target();
      expect(await t.readSlice(r.run, { untilMs: until(), maxRecords: 2 })).toEqual({ done: false, held: true });
      fail.on = true;
      const counts: number[] = [];
      let done = false;
      for (let i = 0; i < 12 && !done; i++) {
        done = (await t.readSlice(r.run, { untilMs: Date.now() + 30 })).done;
        counts.push(Number((await db.admin.query(`SELECT read_failures FROM run_log_readers WHERE run_id = $1`, [r.run.id])).rows[0].read_failures));
      }
      expect(done).toBe(true);
      expect(counts.length).toBeLessThanOrEqual(4);
      expect(counts[0]).toBeGreaterThan(0);
      expect(await status(r.run.id)).toBe("failed");
    });
  });
});
