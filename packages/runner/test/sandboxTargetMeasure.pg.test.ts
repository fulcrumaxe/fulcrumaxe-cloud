import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { SandboxSessionFigures } from "@fx/spend";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { SandboxPort } from "../src/sandboxPort.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** D#2 COMPUTE-SETTLE CS-1: a run's sandbox is stopped when it ends, measured, then deleted. [pg] */
describe("D#2 COMPUTE-SETTLE CS-1: stop, measure, then delete [pg]", () => {
  const db = pgHarness();

  async function scenario(role: "code-reviewer" | "executor" = "code-reviewer") {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 5 });
    const input: StartAgentRunInput = {
      accountId, repoId, workItemId, role, product: "team",
      pr: role === "executor" ? 5 : undefined,
      roleCard: "rc", prompt: "p", model: "haiku-4.5", capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
    return { accountId, input };
  }

  const runOf = (id: string, accountId: string, input: StartAgentRunInput, role: "code-reviewer" | "executor") => ({
    id, accountId, role, product: "team" as const, roleCard: "rc", prompt: "p", model: "haiku-4.5", capUsd: 5,
    spend: input.spend, ...(role === "executor" && { pr: 5, repoId: input.repoId }),
  });

  /** The fake's provider-reported usage for the one session this run launched. */
  const REPORTED = { sessionId: "sess-1", memoryMb: 4096, region: "iad1", durationMs: 300_000, activeCpuMs: 60_000, egressBytes: 0 };

  /** A port whose agent never ends on its own (a run that is still going when it is cancelled). */
  function neverEnding(port: SandboxPort): SandboxPort {
    return {
      ...port,
      startDetached(handle, opts) {
        port.startDetached(handle, opts); // still reports its session
        return { handle, hookFired: new Promise(() => undefined) };
      },
    };
  }

  /** `pool`, but `hook` runs once, right after the first `SELECT status FROM agent_runs` has returned. */
  function afterFirstStatusRead(pool: Pool, hook: () => Promise<void>): Pool {
    let done = false;
    return new Proxy(pool, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (key !== "connect") return typeof value === "function" ? value.bind(target) : value;
        return async () => {
          const client: PoolClient = await target.connect();
          return new Proxy(client, {
            get(inner, innerKey) {
              const member = Reflect.get(inner, innerKey) as unknown;
              if (innerKey !== "query") return typeof member === "function" ? member.bind(inner) : member;
              return async (sql: unknown, params?: unknown) => {
                const rows = await inner.query(sql as string, params as unknown[]);
                if (!done && typeof sql === "string" && sql.startsWith("SELECT status FROM agent_runs")) {
                  done = true;
                  await hook();
                }
                return rows;
              };
            },
          });
        };
      },
    });
  }

  /** The measurement the target holds for `runId`. */
  const measurementOf = (target: SandboxTarget, runId: string): SandboxSessionFigures[] | undefined =>
    (target as unknown as { runs: Map<string, { measurement?: SandboxSessionFigures[] }> }).runs.get(runId)?.measurement;

  it("finalize of a non-persistent run: counters, stop (once), measure, then delete; the measurement is what the fake reported", async () => {
    const s = await scenario();
    const h = createSandboxTargetHarness(db.runWriterPool);
    let seen: SandboxSessionFigures[] | undefined;
    let runId = "";
    // eslint-disable-next-line prefer-const
    let target!: SandboxTarget;
    const port: SandboxPort = {
      ...h.deps.sandboxPort,
      async deleteSandbox(handle) {
        seen = measurementOf(target, runId); // the delete comes after the measure, so it is already there
        return h.deps.sandboxPort.deleteSandbox(handle);
      },
    };
    target = new SandboxTarget({ ...h.deps, sandboxPort: port });
    const result = await startAgentRun(db.runWriterPool, { sandbox: target }, s.input);
    if (result.status !== "running") throw new Error("run did not start");
    runId = result.id;
    const name = h.fakeSandbox.state.created[0]!.sandboxName;
    h.fakeSandbox.scriptUsage(name, [REPORTED, { ...REPORTED, sessionId: "someone-else" }]);
    h.fakeSandbox.scriptCounters(name, { cpuMs: 61_000, txBytes: 10, uptimeMs: 299_000 });
    await sleep(5);

    await target.finalize(runOf(result.id, s.accountId, s.input, "code-reviewer"), { status: "succeeded", usd: 0.1 });

    expect(h.fakeSandbox.state.calls).toEqual([`readCounters:${name}`, `stop:${name}`, `measure:${name}`, `delete:${name}`]);
    expect(h.fakeSandbox.state.stopped).toHaveLength(1);
    expect(seen).toEqual([
      {
        sessionId: "sess-1",
        memoryMb: 4096,
        region: "iad1",
        durationMs: 300_000,
        activeCpuMs: 60_000,
        egressBytes: 0,
        selfMeasured: { cpuMs: 61_000, txBytes: 10, uptimeMs: 299_000 },
        ownDurationMs: expect.any(Number),
      },
    ]);
  });

  it("finalize of a persistent role stops and measures but does not delete (the snapshot is what resume expects)", async () => {
    const s = await scenario("executor");
    const h = createSandboxTargetHarness(db.runWriterPool);
    const target = new SandboxTarget(h.deps);
    const result = await startAgentRun(db.runWriterPool, { sandbox: target }, s.input);
    if (result.status !== "running") throw new Error("run did not start");
    await sleep(5);
    const name = h.fakeSandbox.state.created[0]!.sandboxName;

    await target.finalize(runOf(result.id, s.accountId, s.input, "executor"), { status: "succeeded", usd: 0.1 });

    expect(h.fakeSandbox.state.calls).toEqual([`readCounters:${name}`, `stop:${name}`, `measure:${name}`]);
    expect(h.fakeSandbox.state.deleted).toHaveLength(0);
  });

  it("a replayed finalize of an old persistent run does not stop the sandbox a newer run owns; the current owner's finalize still does", async () => {
    const s = await scenario("executor");
    const h = createSandboxTargetHarness(db.runWriterPool);
    const target = new SandboxTarget(h.deps);
    const first = await startAgentRun(db.runWriterPool, { sandbox: target }, s.input);
    if (first.status !== "running") throw new Error("run did not start");
    await db.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE id = $1`, [first.id]);
    const second = await startAgentRun(db.runWriterPool, { sandbox: target }, s.input);
    if (second.status !== "running") throw new Error("fix-round run did not start");
    await sleep(5);

    // A late finalize for R1 reaches a fresh instance (a different step or process): it must not touch R2's VM.
    await new SandboxTarget(h.deps).finalize(runOf(first.id, s.accountId, s.input, "executor"), { status: "succeeded", usd: 0.1 });
    expect(h.fakeSandbox.state.stopped).toHaveLength(0);

    await target.finalize(runOf(second.id, s.accountId, s.input, "executor"), { status: "succeeded", usd: 0.1 });
    expect(h.fakeSandbox.state.stopped).toHaveLength(1);
  });

  it("a measure that fails does not fail the finalize, and the stop still happened first", async () => {
    const s = await scenario();
    const h = createSandboxTargetHarness(db.runWriterPool);
    const target = new SandboxTarget(h.deps);
    const result = await startAgentRun(db.runWriterPool, { sandbox: target }, s.input);
    if (result.status !== "running") throw new Error("run did not start");
    await sleep(5);
    const name = h.fakeSandbox.state.created[0]!.sandboxName;
    h.fakeSandbox.failMeasure(name);

    await target.finalize(runOf(result.id, s.accountId, s.input, "code-reviewer"), { status: "succeeded", usd: 0.1 });

    // Nothing was measured, so the compute row is still open and the stopped sandbox is NOT deleted: the deferred
    // settle must be able to read it. It is marked due, and the delete follows the settle.
    expect(h.fakeSandbox.state.calls).toEqual([`readCounters:${name}`, `stop:${name}`, `measure:${name}`]);
    const due = await db.admin.query(`SELECT compute_settle_due_at IS NOT NULL AS due FROM agent_runs WHERE id = $1`, [result.id]);
    expect(due.rows[0].due).toBe(true);
    await new SandboxTarget(h.deps).settleRunCompute(runOf(result.id, s.accountId, s.input, "code-reviewer"), { deadlinePassed: true });
    expect(h.fakeSandbox.state.calls.slice(-1)).toEqual([`delete:${name}`]);
  });

  it("cancel of a running non-persistent run: the direct stop no longer deletes; the delete follows the measure, once", async () => {
    const s = await scenario();
    const h = createSandboxTargetHarness(db.runWriterPool);
    const target = new SandboxTarget({ ...h.deps, sandboxPort: neverEnding(h.deps.sandboxPort) });
    const result = await startAgentRun(db.runWriterPool, { sandbox: target }, s.input);
    if (result.status !== "running") throw new Error("run did not start");
    await sleep(5);
    const name = h.fakeSandbox.state.created[0]!.sandboxName;
    h.fakeSandbox.scriptUsage(name, [REPORTED]);
    const run = runOf(result.id, s.accountId, s.input, "code-reviewer");

    await target.cancel(run);
    expect(measurementOf(target, result.id)).toHaveLength(1);
    await target.cancel(run); // a repeat changes nothing

    expect(h.fakeSandbox.state.calls).toEqual([`readCounters:${name}`, `stop:${name}`, `measure:${name}`, `delete:${name}`]);
  });

  for (const nth of [0, 1] as const) {
    it(`dispatch abort clean-up #${nth + 1}: stop, measure, delete, in that order`, async () => {
      const s = await scenario();
      const h = createSandboxTargetHarness(db.runWriterPool);
      const flip = async () => {
        await db.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE account_id = $1`, [s.accountId]);
      };
      // Clean-up #1: the run leaves 'pending' while the sandbox is being created. #2: after the first re-check.
      const port: SandboxPort = {
        ...h.deps.sandboxPort,
        async createSandbox(o) {
          const made = await h.deps.sandboxPort.createSandbox(o);
          if (nth === 0) await flip();
          return made;
        },
      };
      const pool = nth === 1 ? afterFirstStatusRead(db.runWriterPool, flip) : db.runWriterPool;
      const target = new SandboxTarget({ ...h.deps, pool, sandboxPort: port });

      await startAgentRun(db.runWriterPool, { sandbox: target }, s.input).catch(() => undefined);
      await sleep(20);

      const name = h.fakeSandbox.state.created[0]!.sandboxName;
      // The abort is the only stop: the cancel that follows it does not stop (or re-measure) a sandbox that is gone.
      expect(h.fakeSandbox.state.calls).toEqual([`readCounters:${name}`, `stop:${name}`, `measure:${name}`, `delete:${name}`]);
    });
  }
});
