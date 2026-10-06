import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_OUTPUT_LIMITS, AgentOutputRecorder, type Timers } from "../src/agentOutput.js";
import type { ExecutionRun, ExecutionTargetRegistry, TerminalReport } from "../src/executionTarget.js";
import { insertAgentRun, recordAgentOutput, recordLimitExtended, writeRunStatus } from "../src/runStatusWriter.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { NormalizedEvent } from "../src/types.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";

/**
 * Timers whose waits never expire. A test that counts rows exactly uses these so the only way a message is lost is the
 * cap it is about: on the real timers a slow database (a loaded machine) outlasts the 2 s queue wait and drops one.
 */
const heldTimers: Timers = { set: (fn) => fn, clear: () => {} };

/** A pool whose client queries pass through `reject` first: an Error fails that query. */
function failingPool(pool: Pool, reject: (sql: string, params: unknown[] | undefined) => Error | undefined): Pool {
  return new Proxy(pool, {
    get(t, k) {
      const v = Reflect.get(t, k) as unknown;
      if (k !== "connect") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      return async () => {
        const c = await t.connect();
        return new Proxy(c, {
          get(ct, ck) {
            const cv = Reflect.get(ct, ck) as unknown;
            if (ck !== "query") return typeof cv === "function" ? (cv as (...a: unknown[]) => unknown).bind(ct) : cv;
            return (sql: unknown, params?: unknown[]) => {
              const err = typeof sql === "string" ? reject(sql, params) : undefined;
              return err ? Promise.reject(err) : (ct.query as (...a: unknown[]) => Promise<unknown>)(sql, params);
            };
          },
        });
      };
    },
  }) as Pool;
}

/** Output-write queries (the seed read and the inserts) wait on `gate`; everything else runs at once. */
function gatedPool(pool: Pool, gate: Promise<void>): Pool {
  const output = (sql: string, params?: unknown[]) => sql.includes("kind = 'agent.output'") || Boolean(params?.includes("agent.output"));
  return new Proxy(pool, {
    get(t, k) {
      const v = Reflect.get(t, k) as unknown;
      if (k !== "connect") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      return async () => {
        const c = await t.connect();
        return new Proxy(c, {
          get(ct, ck) {
            const cv = Reflect.get(ct, ck) as unknown;
            if (ck !== "query") return typeof cv === "function" ? (cv as (...a: unknown[]) => unknown).bind(ct) : cv;
            return async (sql: unknown, params?: unknown[]) => {
              if (typeof sql === "string" && output(sql, params)) await gate;
              return (ct.query as (...a: unknown[]) => Promise<unknown>)(sql, params);
            };
          },
        });
      };
    },
  }) as Pool;
}

/** D#2 H14c-3-2c: agent.output persistence, seq safety and the run.metering row. [pg]: real Postgres, zero model tokens. */
describe("agent output persistence and run.metering [pg]", { timeout: 60_000 }, () => {
  const db = pgHarness();
  afterEach(() => vi.restoreAllMocks());

  async function seedRun(): Promise<{ accountId: string; repoId: string; runId: string }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    const { id } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId, role: "executor", runtime: "production" });
    return { accountId, repoId, runId: id };
  }

  const rowsOf = async (runId: string, kind?: string) =>
    (
      await db.admin.query(`SELECT seq::int AS seq, kind, payload FROM run_events WHERE run_id = $1 ${kind ? "AND kind = $2" : ""} ORDER BY seq`, kind ? [runId, kind] : [runId])
    ).rows as { seq: number; kind: string; payload: Record<string, unknown> }[];

  it("criteria 1 and 2: a message is one agent.output row {text}, redacted at source", async () => {
    const { accountId, runId } = await seedRun();
    const rec = new AgentOutputRecorder(db.runWriterPool, accountId, runId);
    await rec.record("plain message");
    await rec.record("token ghs_" + "a".repeat(30) + " inside");
    await rec.record("");
    await rec.finish();
    expect((await rowsOf(runId, "agent.output")).map((r) => r.payload)).toEqual([{ text: "plain message" }, { text: "token [redacted] inside" }]);
  });

  it("criterion 2: a message over the cap keeps a code-point prefix and records the full byte length", async () => {
    const { accountId, runId } = await seedRun();
    const rec = new AgentOutputRecorder(db.runWriterPool, accountId, runId);
    const text = "😀".repeat(10_000); // 4 bytes each: the 32 KiB cut lands on a boundary
    await rec.record(text);
    await rec.finish();
    const [a] = await rowsOf(runId, "agent.output");
    expect(Object.keys(a!.payload).sort()).toEqual(["original_bytes", "text", "truncated"]);
    expect(a!.payload).toMatchObject({ original_bytes: 40_000, truncated: true });
    expect(Buffer.byteLength(a!.payload.text as string)).toBe(32 * 1024);
    expect(text.startsWith(a!.payload.text as string)).toBe(true);
  });

  it("criterion 2: worst-case escaping (32 KiB of control characters, quotes, a NUL) stays under the 64 KiB wire cap as stored", async () => {
    const { accountId, runId } = await seedRun();
    const rec = new AgentOutputRecorder(db.runWriterPool, accountId, runId);
    const nasty = ["\u0001".repeat(32 * 1024), '"'.repeat(32 * 1024), "\\".repeat(32 * 1024), "a\u0000b", "\ud800 lone"];
    for (const t of nasty) await rec.record(t);
    await rec.finish();
    const rows = await rowsOf(runId, "agent.output");
    expect(rows).toHaveLength(nasty.length);
    const { rows: sized } = await db.admin.query(`SELECT max(octet_length(payload::text)) AS n FROM run_events WHERE run_id = $1 AND kind = 'agent.output'`, [runId]);
    expect(sized[0].n).toBeLessThan(64 * 1024);
    expect(rows[0]!.payload.truncated).toBe(true);
    expect(rows[3]!.payload).toEqual({ text: "a�b" });
    expect(rows[4]!.payload).toEqual({ text: "� lone" });
  });

  it("criterion 3: 1,005 messages store 1,000 rows and one agent.output.capped row with dropped_messages 5", async () => {
    const { accountId, runId } = await seedRun();
    const rec = new AgentOutputRecorder(db.runWriterPool, accountId, runId, heldTimers);
    for (let i = 0; i < 1005; i++) await rec.record(`m${i}`);
    await rec.finish();
    expect(await rowsOf(runId, "agent.output")).toHaveLength(AGENT_OUTPUT_LIMITS.maxRows);
    const capped = await rowsOf(runId, "agent.output.capped");
    expect(capped.map((r) => r.payload)).toEqual([{ dropped_messages: 5, dropped_bytes: 25 }]);
  });

  it("criterion 3 + R-C: the 4 MiB text cap holds across a resume on another instance, and a later small message is not let through", async () => {
    const { accountId, runId } = await seedRun();
    const full = "x".repeat(AGENT_OUTPUT_LIMITS.maxMessageBytes);
    const fits = AGENT_OUTPUT_LIMITS.maxRunBytes / full.length; // 128
    const before = new AgentOutputRecorder(db.runWriterPool, accountId, runId, heldTimers);
    for (let i = 0; i < fits - 1; i++) await before.record(full);
    await before.finish();
    const after = new AgentOutputRecorder(db.runWriterPool, accountId, runId, heldTimers); // another instance
    for (let i = 0; i < 3; i++) await after.record(full);
    await after.record("small");
    await after.finish();
    expect(await rowsOf(runId, "agent.output")).toHaveLength(fits);
    expect((await rowsOf(runId, "agent.output.capped"))[0]!.payload).toEqual({ dropped_messages: 3, dropped_bytes: 2 * full.length + 5 });
  });

  it("R-C: a run resumed on another instance continues from the persisted totals, not zero", async () => {
    const { accountId, runId } = await seedRun();
    const first = new AgentOutputRecorder(db.runWriterPool, accountId, runId, heldTimers);
    for (let i = 0; i < 998; i++) await first.record(`a${i}`);
    await first.finish();
    // A different instance: no shared memory with `first`.
    const second = new AgentOutputRecorder(db.runWriterPool, accountId, runId, heldTimers);
    for (let i = 0; i < 5; i++) await second.record(`b${i}`);
    await second.finish();
    expect(await rowsOf(runId, "agent.output")).toHaveLength(1000);
    expect(second.droppedMessages).toBe(3);
    expect((await rowsOf(runId, "agent.output.capped"))[0]!.payload).toMatchObject({ dropped_messages: 3 });
  });

  it("criterion 4: 50 parallel writers (output, limit_extended, a status write) get seqs exactly 1..51, no unique violation", async () => {
    for (let round = 0; round < 3; round++) {
      const { accountId, runId } = await seedRun(); // run.created is seq 1
      const pool = db.runWriterPool;
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          i === 49
            ? writeRunStatus(pool, { accountId, runId, from: "pending", to: "running" })
            : i % 3 === 1
              ? recordLimitExtended(pool, { accountId, runId, kind: "run_time", extensionsUsed: i, newLimit: 1, progress: {} as never })
              : recordAgentOutput(pool, { accountId, runId, payload: { text: `t${i}` } }),
        ),
      );
      expect((await rowsOf(runId)).map((r) => r.seq)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
    }
  });

  it("criterion 5: a failing pool for output writes is logged (fixed text), counted, and never throws", async () => {
    const { accountId, runId } = await seedRun();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = failingPool(db.runWriterPool, (_sql, params) => (params?.includes("agent.output") ? new Error("secret-detail-in-error") : undefined));
    const rec = new AgentOutputRecorder(failing, accountId, runId);
    await rec.record("first");
    await rec.record("second SECRET-PAYLOAD");
    await expect(rec.finish()).resolves.toBeUndefined();
    expect(rec.failedWrites).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) expect(call).toEqual(["agent output: a run_events write failed"]);
    expect(await rowsOf(runId, "agent.output")).toEqual([]);
    // The same pool still does its other writes.
    await expect(writeRunStatus(failing, { accountId, runId, from: "pending", to: "running" })).resolves.toEqual({ updated: true });
  });

  // The bounded waits run on a clock the test controls: a timeout fires only when `fire()` is called, so no
  // outcome depends on how fast the database is.
  describe("backpressure (controlled clock and write gate)", () => {
    function harness() {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const pending = new Set<() => void>();
      const timers = { set: (fn: () => void) => (pending.add(fn), fn), clear: (t: unknown) => void pending.delete(t as () => void) };
      const fire = () => [...pending].forEach((fn) => (pending.delete(fn), fn()));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const drops = () => warn.mock.calls.filter((c) => c[0] === "agent output: a message was dropped, the write queue is full").length;
      return { gate, release, fire, drops, make: (pool: Pool, a: string, r: string) => new AgentOutputRecorder(gatedPool(pool, gate), a, r, timers) };
    }
    const fill = async (rec: AgentOutputRecorder, n: number) => { for (let i = 0; i < n; i++) await rec.record(`q${i}`); };
    const texts = async (runId: string) => (await rowsOf(runId, "agent.output")).map((r) => r.payload.text);

    it("a slow database alone never drops: below a full queue nothing waits or drops, whatever the clock does", async () => {
      const { accountId, runId } = await seedRun();
      const h = harness();
      const rec = h.make(db.runWriterPool, accountId, runId);
      await fill(rec, AGENT_OUTPUT_LIMITS.maxQueued - 1); // writes are all hung, the queue is one short of full
      h.fire();
      await rec.record("last");
      h.release();
      await rec.finish();
      expect(h.drops()).toBe(0);
      expect(await texts(runId)).toEqual([...Array.from({ length: 31 }, (_, i) => `q${i}`), "last"]);
      expect(await rowsOf(runId, "agent.output.capped")).toEqual([]);
    });

    it("a full queue that drains before the timeout fires does not drop the waiting message", async () => {
      const { accountId, runId } = await seedRun();
      const h = harness();
      const rec = h.make(db.runWriterPool, accountId, runId);
      await fill(rec, AGENT_OUTPUT_LIMITS.maxQueued);
      const waiting = rec.record("waited");
      h.release(); // the queue drains; the timeout is never fired
      await waiting;
      await rec.finish();
      expect(h.drops()).toBe(0);
      expect((await texts(runId)).at(-1)).toBe("waited");
      expect(await texts(runId)).toHaveLength(33);
    });

    it("a full queue whose wait expires drops exactly those messages: counted in the capped row, stored output ordered, once", async () => {
      const { accountId, runId } = await seedRun();
      const h = harness();
      const rec = h.make(db.runWriterPool, accountId, runId);
      await fill(rec, AGENT_OUTPUT_LIMITS.maxQueued);
      for (let i = 0; i < 3; i++) {
        const waiting = rec.record(`dropped${i}`);
        h.fire(); // this wait expires while the queue is still full
        await waiting;
      }
      expect(h.drops()).toBe(3);
      h.release();
      await rec.finish(); // the flush wait is on the controlled clock too: it ends when the writes do
      expect(await texts(runId)).toEqual(Array.from({ length: 32 }, (_, i) => `q${i}`));
      expect((await rowsOf(runId, "agent.output.capped")).map((r) => r.payload)).toEqual([{ dropped_messages: 3, dropped_bytes: 3 * 8 }]);
    });
  });

  it("a run over its spend limit is killed at once while every output write hangs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    const text = (seq: number, extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({ runId: "x", role: "code-reviewer", seq, type: "assistant", ts: new Date().toISOString(), text: `m${seq}`, ...extra });
    // 32 messages fill the queue behind the hung writes; the 33rd carries the over-limit usage.
    const events = [...Array.from({ length: AGENT_OUTPUT_LIMITS.maxQueued }, (_, i) => text(i + 1)), text(99, { usage: { inputTokens: 10_000_000, outputTokens: 10_000_000 } })];
    const harness = createSandboxTargetHarness(gatedPool(db.runWriterPool, gate), events);
    const started = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget(harness.deps) }, {
      accountId, repoId, role: "code-reviewer", product: "team", roleCard: "r", prompt: "p", model: "haiku-4.5", capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    } as StartAgentRunInput);
    if (started.status !== "running") throw new Error(`setup: ${started.status}`);
    const t0 = Date.now();
    while (!harness.hooks.calls.some((c) => c.hookToken === started.hookToken) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 5));
    const elapsed = Date.now() - t0;
    release();
    expect(harness.hooks.calls.find((c) => c.hookToken === started.hookToken)?.report.status).toBe("killed_spend");
    expect(elapsed).toBeLessThan(AGENT_OUTPUT_LIMITS.backpressureTimeoutMs * 0.75); // the kill did not wait out the queue timeout
  });

  describe("criterion 6: run.metering in the status transaction", () => {
    it.each(["succeeded", "failed", "timed_out", "killed_spend"] as const)("%s: one row {metered_usd, reported_usd, flags}", async (to) => {
      const { accountId, runId } = await seedRun();
      await writeRunStatus(db.runWriterPool, { accountId, runId, from: "pending", to: "running" });
      const limit = { timed_out: "run_time", killed_spend: "per_run_usd" }[to as string];
      const checkpoint = limit ? { kind: limit, ccSessionId: null, meteredUsd: 1, extensionsUsed: 0 } : undefined;
      await writeRunStatus(db.runWriterPool, {
        accountId,
        runId,
        from: "running",
        to,
        metering: { meteredUsd: 1.25, reportedUsd: null, flags: ["metering_silent"] },
        ...(checkpoint ? { checkpoint } : {}),
      });
      const rows = await rowsOf(runId, "run.metering");
      expect(rows.map((r) => r.payload)).toEqual([{ metered_usd: 1.25, reported_usd: null, flags: ["metering_silent"] }]);
    });

    it("a write that loses the compare-and-set leaves no metering row", async () => {
      const { accountId, runId } = await seedRun();
      const lost = await writeRunStatus(db.runWriterPool, { accountId, runId, from: "running", to: "succeeded", metering: { meteredUsd: 0, reportedUsd: 0, flags: [] } });
      expect(lost.updated).toBe(false);
      expect(await rowsOf(runId, "run.metering")).toEqual([]);
    });

    it("a status write that rolls back leaves neither the status nor a metering row", async () => {
      const { accountId, runId } = await seedRun();
      await writeRunStatus(db.runWriterPool, { accountId, runId, from: "pending", to: "running" });
      // Fails the domain-event insert, the last statement of the transaction.
      const failing = failingPool(db.runWriterPool, (sql) => (/INSERT INTO domain_events/i.test(sql) ? new Error("boom") : undefined));
      await expect(
        writeRunStatus(failing, { accountId, runId, from: "running", to: "succeeded", metering: { meteredUsd: 1, reportedUsd: 1, flags: [] } }),
      ).rejects.toThrow("boom");
      expect((await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId])).rows[0].status).toBe("running");
      expect(await rowsOf(runId, "run.metering")).toEqual([]);
    });
  });

  describe("through SandboxTarget (dispatch, onEvent, finalize)", () => {
    const base = {
      role: "code-reviewer",
      product: "team",
      roleCard: "fake role card",
      prompt: "fake prompt",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    } as const;
    const assistant = (seq: number, text?: string): NormalizedEvent => ({ runId: "placeholder", role: "code-reviewer", seq, type: "assistant", ts: new Date().toISOString(), text });

    async function runThrough(events: NormalizedEvent[], override?: (r: TerminalReport) => TerminalReport) {
      const accountId = randomUUID();
      const repoId = randomUUID();
      await seedAccount(db.admin, accountId);
      await seedRepo(db.admin, accountId, repoId);
      const harness = createSandboxTargetHarness(db.runWriterPool, events);
      const target = new SandboxTarget(harness.deps);
      const registry: ExecutionTargetRegistry = { sandbox: target };
      const started = await startAgentRun(db.runWriterPool, registry, { ...base, accountId, repoId } as StartAgentRunInput);
      if (started.status !== "running") throw new Error(`setup: ${started.status}`);
      for (let i = 0; i < 12_000 && !harness.hooks.calls.some((c) => c.hookToken === started.hookToken); i++) await new Promise((r) => setTimeout(r, 5));
      const call = harness.hooks.calls.find((c) => c.hookToken === started.hookToken)!;
      const run = { ...base, id: started.id, accountId } as unknown as ExecutionRun;
      await target.finalize(run, override ? override(call.report) : call.report);
      return { runId: started.id, report: call.report };
    }

    it("stores each non-empty assistant text in order, then the status row, then the metering row", async () => {
      const { runId, report } = await runThrough([assistant(1, "hello"), assistant(2), assistant(3, ""), assistant(4, "world")]);
      const rows = await rowsOf(runId);
      const kinds = rows.map((r) => r.kind);
      expect(rows.filter((r) => r.kind === "agent.output").map((r) => r.payload)).toEqual([{ text: "hello" }, { text: "world" }]);
      expect(kinds.lastIndexOf("agent.output")).toBeLessThan(kinds.lastIndexOf("run.status_changed"));
      const metering = rows.filter((r) => r.kind === "run.metering");
      expect(metering).toHaveLength(1);
      expect(metering[0]!.payload).toEqual({ metered_usd: report.metering!.meteredUsd, reported_usd: report.metering!.reportedUsd, flags: report.metering!.flags });
    });

    it("a report without a metering block writes {null, null, [no_metering]}", async () => {
      const { runId } = await runThrough([assistant(1, "x")], (r) => ({ ...r, metering: undefined }));
      expect((await rowsOf(runId, "run.metering"))[0]!.payload).toEqual({ metered_usd: null, reported_usd: null, flags: ["no_metering"] });
    });

    it("the per-run cap never ends the run, and finalize leaves the one capped row", async () => {
      const events = Array.from({ length: 1003 }, (_, i) => assistant(i + 1, `m${i}`));
      const { runId } = await runThrough(events);
      expect(await rowsOf(runId, "agent.output")).toHaveLength(1000);
      expect((await rowsOf(runId, "agent.output.capped")).map((r) => r.payload)).toEqual([{ dropped_messages: 3, dropped_bytes: 15 }]);
      expect((await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId])).rows[0].status).not.toBe("running");
    });
  });
});
