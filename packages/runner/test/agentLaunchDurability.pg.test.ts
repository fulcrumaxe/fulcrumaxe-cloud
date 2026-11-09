import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxPort } from "../src/sandboxPort.js";
import { createVercelSandboxPort } from "../src/vercelSandboxPort.js";
import { DispatchFailedError, type LostRunOutcome } from "../src/executionTarget.js";
import { sandboxNameFor } from "../src/sandboxNaming.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { configureAgentRunWiring, followStatusBody } from "../src/workflows/agentRun.js";
import { LOST_SWEEP_BATCH_SIZE, sweepLostRuns } from "../src/lostRunSweep.js";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { AGENT_OUTPUT_DELAY_MS, createFrozenInvocationSdk, type Platform } from "./helpers/frozenInvocationSdk.js";
import { pgHarness } from "./helpers/pgHarness.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * PREVIEW-AGENT-LAUNCH. A run's launch (attach, firewall policy, CLI check, prompt files, the agent command) and its
 * stream used to be a floating promise: the invocation that called `dispatch` returned, the platform froze it, and the
 * sandbox was left with nothing running in it while the run read `running`. [pg]: real Postgres, the real Vercel port over
 * a fake SDK whose answers are dropped once the invocation has ended.
 */
describe("agent launch survives the invocation that started it [pg]", () => {
  const db = pgHarness();
  afterEach(() => configureAgentRunWiring(undefined));

  async function scenario() {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, randomUUID());
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 5 });
    const input: StartAgentRunInput = {
      accountId,
      repoId,
      workItemId,
      role: "code-reviewer",
      product: "team",
      roleCard: "rc",
      prompt: "p",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
    return { accountId, repoId, input };
  }

  /** The invocation: a target on the real port over a fake SDK, and a platform that keeps it alive only for `waitUntil` work. */
  function invocation(extra: { agentStartTimeoutMs?: number; keepAlive?: boolean; wrapPort?: (p: SandboxPort) => SandboxPort } = {}) {
    const platform: Platform = { frozen: false };
    const sdk = createFrozenInvocationSdk(platform);
    const waitUntilWork: Promise<unknown>[] = [];
    const h = createSandboxTargetHarness(db.runWriterPool);
    const realPort = createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk: sdk.sdk, measureRetryDelayMs: 0 });
    const port = extra.wrapPort ? extra.wrapPort(realPort) : realPort;
    const deps = {
      ...h.deps,
      sandboxPort: port,
      finalizeBeforeResume: undefined, // production: the target finalizes, then wakes the hook with the status only
      ...(extra.keepAlive !== false && { keepAlive: (work: Promise<unknown>) => void waitUntilWork.push(work) }),
      agentStartTimeoutMs: extra.agentStartTimeoutMs,
      lostConfirmDelayMs: 20,
    };
    const target = new SandboxTarget(deps);
    /** The invocation's response has been sent: only `waitUntil` work may still run, then the instance is frozen. */
    const endInvocation = async (): Promise<void> => {
      await Promise.allSettled(waitUntilWork);
      platform.frozen = true;
    };
    return { platform, sdk, h, deps, port, target, waitUntilWork, endInvocation };
  }

  const nameOf = (s: { accountId: string; repoId: string }, runId: string) => sandboxNameFor({ role: "code-reviewer", runId, accountId: s.accountId, repoId: s.repoId });
  const statusOf = async (runId: string): Promise<string> => (await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId])).rows[0].status;
  const failureReasonOf = async (runId: string): Promise<string | undefined> =>
    (await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'failed'`, [runId])).rows[0]?.payload.failureReason;
  const openReservations = async (runId: string): Promise<number> =>
    (await db.admin.query(`SELECT count(*)::int AS n FROM spend_reservations WHERE run_id = $1 AND state = 'open'`, [runId])).rows[0].n;

  it("the agent command exists, and the run is finalized, after the invocation ended (reproduces the dropped launch)", async () => {
    const s = await scenario();
    const inv = invocation();
    const started = await startAgentRun(db.runWriterPool, { sandbox: inv.target }, s.input);
    if (started.status !== "running") throw new Error("run did not start");

    await inv.endInvocation();
    // Let any timer a frozen instance would have run fire, and be dropped.
    await sleep(AGENT_OUTPUT_DELAY_MS + 100);

    // The launch finished inside the invocation: the provider was asked for the agent command...
    expect(inv.sdk.agentCommandCount()).toBe(1);
    // ...and the stream was read and finalized by work the platform was asked to keep alive.
    expect(inv.waitUntilWork).toHaveLength(1);
    expect(await statusOf(started.id)).toBe("succeeded");
    expect(inv.h.hooks.calls).toHaveLength(1);
  });

  it("the stream and finalize are handed to the keep-alive: without it, a frozen instance never reads the agent's output", async () => {
    const s = await scenario();
    const inv = invocation({ keepAlive: false });
    const started = await startAgentRun(db.runWriterPool, { sandbox: inv.target }, s.input);
    if (started.status !== "running") throw new Error("run did not start");
    await inv.endInvocation(); // nothing was handed to waitUntil: frozen at once
    await sleep(AGENT_OUTPUT_DELAY_MS + 100);

    expect(inv.sdk.agentCommandCount()).toBe(1); // the launch does not depend on the keep-alive
    expect(await statusOf(started.id)).toBe("running"); // the platform dropped the stream: this is why the follower must settle it
    expect(inv.h.hooks.calls).toHaveLength(0);
  });

  it("watchdog: a launch that never reaches the agent command fails the run as agent_start_timeout, stops and measures its sandbox", async () => {
    const s = await scenario();
    const inv = invocation({
      agentStartTimeoutMs: 150,
      // The launch stalls after the sandbox exists and its session is recorded: neither the command nor the hook ever arrives.
      wrapPort: (port) => ({ ...port, startDetached: (handle) => ({ handle, hookFired: new Promise(() => undefined), launched: new Promise<void>(() => undefined) }) }),
    });

    const failure = await startAgentRun(db.runWriterPool, { sandbox: inv.target }, s.input).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DispatchFailedError);
    expect((failure as DispatchFailedError).failureReason).toBe("agent_start_timeout");

    const runId = (failure as DispatchFailedError).runId;
    expect(await statusOf(runId)).toBe("failed");
    expect(await failureReasonOf(runId)).toBe("agent_start_timeout");
    // The sandbox was stopped and its compute read, not left to run to its own timeout.
    expect(inv.sdk.calls).toContain("stop");
    expect(inv.sdk.calls).toContain("listSessions");
    // Nothing is left reserved, and the compute was settled from what the provider reported.
    expect(await openReservations(runId)).toBe(0);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM ledger WHERE run_id = $1 AND budget <> 'model'`, [runId])).rows[0].n).toBeGreaterThan(0);
    expect(inv.h.hooks.calls).toHaveLength(0); // no agent ever ran: no hook to wake
  });

  it("a launch that fails before the command exists fails the run as sandbox_error", async () => {
    const s = await scenario();
    const inv = invocation({
      wrapPort: (port) => ({
        ...port,
        startDetached(handle) {
          const failing = Promise.reject(new Error("provider said no"));
          failing.catch(() => undefined);
          return { handle, hookFired: failing, launched: failing };
        },
      }),
    });
    const failure = await startAgentRun(db.runWriterPool, { sandbox: inv.target }, s.input).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DispatchFailedError);
    expect(await failureReasonOf((failure as DispatchFailedError).runId)).toBe("sandbox_error");
  });

  /** A run that is `running` with an agent that never ends (the stream is not what these tests are about). */
  async function runningRun() {
    const s = await scenario();
    const inv = invocation({
      wrapPort: (port) => ({
        ...port,
        startDetached(handle, opts) {
          const real = port.startDetached(handle, opts);
          real.hookFired.catch(() => undefined);
          return { ...real, hookFired: new Promise(() => undefined) };
        },
      }),
    });
    const started = await startAgentRun(db.runWriterPool, { sandbox: inv.target }, s.input);
    if (started.status !== "running") throw new Error("run did not start");
    return { s, inv, runId: started.id, name: nameOf(s, started.id) };
  }

  it("a sandbox stopped from outside while the run is running: the follower settles the run as failed, measured", async () => {
    const { s, inv, runId, name } = await runningRun();
    configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: inv.target } });

    // Still running: the follower leaves it alone.
    expect(await followStatusBody(s.accountId, runId)).toEqual({ status: "running", done: false });
    expect(inv.sdk.calls).not.toContain("stop");

    inv.sdk.stopFromOutside(name);
    expect(await followStatusBody(s.accountId, runId)).toEqual({ status: "failed", done: true });

    expect(await failureReasonOf(runId)).toBe("sandbox_stopped");
    // Compute was measured from the provider's own figures and the reservation is closed, with a ledger row.
    expect(inv.sdk.calls).toContain("listSessions");
    expect(await openReservations(runId)).toBe(0);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM ledger WHERE run_id = $1 AND budget <> 'model'`, [runId])).rows[0].n).toBeGreaterThan(0);
    // The preview reads an ended run: the run has an end time.
    expect((await db.admin.query(`SELECT ended_at IS NOT NULL AS ended FROM agent_runs WHERE id = $1`, [runId])).rows[0].ended).toBe(true);
    // A second look changes nothing.
    expect(await followStatusBody(s.accountId, runId)).toEqual({ status: "failed", done: true });
  });

  it("a deleted sandbox counts as lost; a provider that cannot answer does not", async () => {
    const { s, inv, runId, name } = await runningRun();
    const doubtful = new SandboxTarget({ ...inv.deps, sandboxPort: { ...inv.port, sandboxState: async () => "unknown" } });
    configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: doubtful } });
    inv.sdk.stopFromOutside(name, "deleted");
    expect(await followStatusBody(s.accountId, runId)).toEqual({ status: "running", done: false });

    configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: inv.target } });
    expect(await followStatusBody(s.accountId, runId)).toEqual({ status: "failed", done: true });
    expect(await failureReasonOf(runId)).toBe("sandbox_stopped");
  });

  /** Makes a run look as if its sandbox was requested half an hour ago (the column is set once, so the guard is lifted for this one write). */
  async function backdate(runId: string): Promise<void> {
    await db.admin.query(`ALTER TABLE agent_runs DISABLE TRIGGER agent_runs_sandbox_guard`);
    try {
      await db.admin.query(`UPDATE agent_runs SET sandbox_requested_at = now() - interval '30 minutes' WHERE id = $1`, [runId]);
    } finally {
      await db.admin.query(`ALTER TABLE agent_runs ENABLE TRIGGER agent_runs_sandbox_guard`);
    }
  }

  /**
   * The sweep over the whole database, acting on `mine` only (other tests' leftover runs are reported alive), repeated until it has met them all.
   * The lister picks a random batch of LOST_SWEEP_BATCH_SIZE running runs per tick (by design: a fixed order would let healthy long runs hide a stuck one),
   * and every [pg] file of this package shares one database, so hundreds of other files' running runs may be in the pool. The tick bound is therefore
   * derived from the real total: each tick meets a given run with probability BATCH/total, so 30 times total/BATCH ticks leave a miss chance near e^-30.
   */
  async function sweepUntilSeen(target: SandboxTarget, mine: readonly string[]): Promise<void> {
    const total = (await db.admin.query(`SELECT count(*)::int AS n FROM agent_runs WHERE status = 'running' AND sandbox_requested_at IS NOT NULL`)).rows[0].n as number;
    const maxTicks = Math.max(60, Math.ceil((30 * total) / LOST_SWEEP_BATCH_SIZE));
    const seen = new Set<string>();
    for (let tick = 0; tick < maxTicks && seen.size < mine.length; tick++) {
      await sweepLostRuns({
        pool: db.runWriterPool,
        target: {
          async settleIfLost(run): Promise<LostRunOutcome> {
            if (!mine.includes(run.id)) return "alive";
            seen.add(run.id);
            return target.settleIfLost(run);
          },
        },
      });
    }
    if (seen.size < mine.length) throw new Error(`the sweep did not meet ${mine.length - seen.size} of its runs in ${maxTicks} ticks over ${total} running runs`);
  }

  it("a run left running before this code existed: the sweep settles it with no manual edit, on a fresh instance", async () => {
    const { inv, runId, name } = await runningRun();
    // Nothing from the old deployment is in memory any more; the run has been running a while and its sandbox was stopped by hand.
    await backdate(runId);
    inv.sdk.stopFromOutside(name);

    const fresh = new SandboxTarget({ ...inv.deps });
    await sweepUntilSeen(fresh, [runId]);

    expect(await statusOf(runId)).toBe("failed");
    expect(await failureReasonOf(runId)).toBe("sandbox_stopped");
    expect(inv.sdk.calls).toContain("listSessions");
    expect(await openReservations(runId)).toBe(0);
  });

  it("the sweep leaves a running sandbox and a run younger than the minimum age alone", async () => {
    const live = await runningRun();
    const young = await runningRun();
    await backdate(live.runId);
    young.inv.sdk.stopFromOutside(young.name); // stopped, but its status changed a moment ago

    await sweepUntilSeen(live.inv.target, [live.runId]);
    await sweepLostRuns({ pool: db.runWriterPool, target: { settleIfLost: async (run) => (run.id === young.runId ? young.inv.target.settleIfLost(run) : "alive") } });

    expect(await statusOf(live.runId)).toBe("running");
    expect(await statusOf(young.runId)).toBe("running");
  });

  it("a stop this runner recorded itself is left to its own finalize for a few minutes, then settled", async () => {
    const recent = await runningRun();
    configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: recent.inv.target } });
    recent.inv.sdk.stopFromOutside(recent.name);
    // The run's own finalize stopped the sandbox a moment ago and is still writing the result.
    await db.admin.query(`UPDATE agent_runs SET sandbox_stopped_at = now() WHERE id = $1`, [recent.runId]);
    expect(await followStatusBody(recent.s.accountId, recent.runId)).toEqual({ status: "running", done: false });

    // Its finalize died after the stop, long ago: the run is settled instead of waiting for the watchdog.
    const old = await runningRun();
    configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: old.inv.target } });
    old.inv.sdk.stopFromOutside(old.name);
    await db.admin.query(`UPDATE agent_runs SET sandbox_stopped_at = now() - interval '10 minutes' WHERE id = $1`, [old.runId]);
    expect(await followStatusBody(old.s.accountId, old.runId)).toEqual({ status: "failed", done: true });
  });

  it("a run finishing normally is never settled as lost, even by a check that lands between its provider stop and its status write", async () => {
    const s = await scenario();
    let outcomeDuring: string | undefined;
    const second: { target?: SandboxTarget } = {};
    let runIdSeen = "";
    const inv = invocation({
      wrapPort: (port) => ({
        ...port,
        startDetached: (handle, opts) => ((runIdSeen = opts.runId), port.startDetached(handle, opts)),
        async stop(handle) {
          await port.stop(handle);
          // The provider now reports the sandbox stopped; the run's own finalize has not written its status yet.
          outcomeDuring = await second.target!.settleIfLost({ id: runIdSeen, accountId: s.accountId, role: "code-reviewer", product: "team", repoId: s.repoId, roleCard: "", prompt: "", model: "", capUsd: 0, spend: { plan: "starter" } });
        },
      }),
    });
    // A second instance (a sweep tick or the follower), looking twice with no pause at all.
    second.target = new SandboxTarget({ ...inv.deps, lostConfirmDelayMs: 0 });
    const started = await startAgentRun(db.runWriterPool, { sandbox: inv.target }, s.input);
    if (started.status !== "running") throw new Error("run did not start");
    await inv.endInvocation();
    await sleep(AGENT_OUTPUT_DELAY_MS + 100);

    expect(outcomeDuring).toBe("alive");
    expect(await statusOf(started.id)).toBe("succeeded");
    expect(await failureReasonOf(started.id)).toBeUndefined();
  });

  it("one odd answer settles nothing: the same definite answer must come on two looks", async () => {
    const { s, inv, runId, name } = await runningRun();
    inv.sdk.stopFromOutside(name);
    const answers = ["stopped", "running"] as const;
    let n = 0;
    const flaky = new SandboxTarget({ ...inv.deps, sandboxPort: { ...inv.port, sandboxState: async () => answers[Math.min(n++, 1)]! } });
    configureAgentRunWiring({ pool: db.runWriterPool, registry: { sandbox: flaky } });
    expect(await followStatusBody(s.accountId, runId)).toEqual({ status: "running", done: false });
    expect(n).toBe(2);
    expect(inv.sdk.calls).not.toContain("stop");
  });

  it("a keep-alive that throws neither fails the run nor goes unreported", async () => {
    const s = await scenario();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const inv = invocation({ keepAlive: false });
      const target = new SandboxTarget({ ...inv.deps, keepAlive: () => { throw new Error("no context"); } });
      const started = await startAgentRun(db.runWriterPool, { sandbox: target }, s.input);
      expect(started.status).toBe("running");
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain(JSON.stringify({ event: "run.keep_alive_failed" }));
    } finally {
      warn.mockRestore();
    }
  });

  it("a run reaching running marks the compute-settle cron as having work, so a stuck run is swept even when nothing else is pending", async () => {
    const marks = new Map<string, number>();
    setPendingHooks({ store: { get: async (k) => marks.get(k), set: async (k, v) => void marks.set(k, v), delete: async (k) => void marks.delete(k) } });
    try {
      const s = await scenario();
      const inv = invocation();
      const started = await startAgentRun(db.runWriterPool, { sandbox: inv.target }, s.input);
      if (started.status !== "running") throw new Error("run did not start");
      await sleep(50);
      expect(marks.has("pending:compute-settle-sweep")).toBe(true);
      await inv.endInvocation();
    } finally {
      setPendingHooks(null);
    }
  });

  /**
   * Moves a running run back in time: its latest move into running and its sandbox request `startedMin` minutes ago, its other events
   * `eventMin` minutes ago, and its liveness stamp `aliveMin` minutes ago (null: never stamped).
   */
  async function ageRun(runId: string, startedMin: number, eventMin: number, aliveMin: number | null = null, stored?: { silenceMin: number; runMin: number }): Promise<void> {
    // The run's stored limits: none by default (the platform ceilings apply), or the run's own.
    await db.admin.query(`UPDATE agent_runs SET silence_limit_ms = $2, run_limit_ms = $3 WHERE id = $1`, [runId, stored ? stored.silenceMin * 60_000 : null, stored ? stored.runMin * 60_000 : null]);
    await db.admin.query(`ALTER TABLE agent_runs DISABLE TRIGGER agent_runs_sandbox_guard`);
    try {
      await db.admin.query(`UPDATE agent_runs SET sandbox_requested_at = now() - make_interval(mins => $2) WHERE id = $1`, [runId, startedMin]);
    } finally {
      await db.admin.query(`ALTER TABLE agent_runs ENABLE TRIGGER agent_runs_sandbox_guard`);
    }
    await db.admin.query(`UPDATE run_events SET created_at = now() - make_interval(mins => $2) WHERE run_id = $1`, [runId, eventMin]);
    await db.admin.query(`UPDATE run_events SET created_at = now() - make_interval(mins => $2) WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'running'`, [runId, startedMin]);
    await db.admin.query(`UPDATE agent_runs SET last_alive_at = ${aliveMin === null ? "NULL" : "now() - make_interval(mins => $2)"} WHERE id = $1`, aliveMin === null ? [runId] : [runId, aliveMin]);
  }
  const stopCalls = (inv: { sdk: { calls: readonly string[] } }) => inv.sdk.calls.filter((c) => c === "stop").length;
  const checkpointKindOf = async (runId: string): Promise<string | undefined> =>
    (await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'checkpoint'`, [runId])).rows[0]?.payload.kind;
  const checkpointCcSessionOf = async (runId: string): Promise<string | undefined> =>
    (await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'checkpoint'`, [runId])).rows[0]?.payload.cc_session_id;
  const countEvents = async (runId: string, kind: string): Promise<number> => (await db.admin.query(`SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND kind = $2`, [runId, kind])).rows[0].n;
  const runOf = (s: { accountId: string; repoId: string }, runId: string) => ({ id: runId, accountId: s.accountId, role: "code-reviewer" as const, product: "team" as const, repoId: s.repoId, roleCard: "", prompt: "", model: "", capUsd: 0, spend: { plan: "starter" as const } });

  it("durable limits: a running sandbox whose run has been silent past the silence ceiling is stopped and ended as timed_out/silence, once", async () => {
    const { s, inv, runId } = await runningRun();
    await ageRun(runId, 90, 80, 75); // started 90 minutes ago; last event 80 and last stamp 75 minutes ago: a fresh instance, the starter's timers are gone
    const fresh = new SandboxTarget({ ...inv.deps });
    const callsBefore = stopCalls(inv);
    // Two ticks at once on the same instance, then a later one.
    const outcomes = await Promise.all([fresh.settleIfLost(runOf(s, runId)), fresh.settleIfLost(runOf(s, runId))]);
    expect(outcomes).toContain("settled");
    expect(await fresh.settleIfLost(runOf(s, runId))).toBe("alive");
    expect(await statusOf(runId)).toBe("timed_out");
    expect(await checkpointKindOf(runId)).toBe("silence");
    expect(stopCalls(inv) - callsBefore).toBe(1);
    expect(await openReservations(runId)).toBe(0);
  });

  it("durable limits: the kill charges no model spend: only compute is ledgered and settled, as on the sandbox_stopped path", async () => {
    const { s, inv, runId } = await runningRun();
    await ageRun(runId, 90, 80, null);
    expect(await new SandboxTarget({ ...inv.deps }).settleIfLost(runOf(s, runId))).toBe("settled");
    const ledger = (await db.admin.query(`SELECT budget FROM ledger WHERE run_id = $1 ORDER BY budget`, [runId])).rows.map((r: { budget: string }) => r.budget);
    const reservations = (await db.admin.query(`SELECT budget, state FROM spend_reservations WHERE run_id = $1 ORDER BY budget`, [runId])).rows;
    // Exactly what is ledgered: one compute row, no model row; the one reservation (compute) is settled, none is open and none holds model spend.
    expect(ledger).toEqual(["foreground_compute"]);
    expect(reservations).toEqual([{ budget: "foreground_compute", state: "settled" }]);
  });

  it("durable limits: the run's own limits are stored at dispatch, before any event (default limits, no extensions)", async () => {
    const { runId } = await runningRun();
    const r = (await db.admin.query(`SELECT silence_limit_ms, run_limit_ms::int AS run_limit_ms, last_alive_at IS NOT NULL AS stamped FROM agent_runs WHERE id = $1`, [runId])).rows[0];
    expect(r).toEqual({ silence_limit_ms: 15 * 60_000, run_limit_ms: 60 * 60_000, stamped: true });
  });

  it("durable limits: a silent run is stopped on its OWN silence limit (below the platform ceiling), not only the ceiling", async () => {
    const { s, inv, runId } = await runningRun();
    await ageRun(runId, 40, 20, 20, { silenceMin: 15, runMin: 60 }); // 20 minutes quiet: past 15 + 2 margin, well under the 30 minute ceiling
    expect(await new SandboxTarget({ ...inv.deps }).settleIfLost(runOf(s, runId))).toBe("settled");
    expect(await checkpointKindOf(runId)).toBe("silence");
    const inside = await runningRun();
    await ageRun(inside.runId, 40, 16, 16, { silenceMin: 15, runMin: 120 }); // 16 minutes: inside the two minute margin
    expect(await new SandboxTarget({ ...inside.inv.deps }).settleIfLost(runOf(inside.s, inside.runId))).toBe("alive");
  });

  it("durable limits: a run past its OWN run limit is stopped as run_time (below the platform ceiling); a live stamping run inside it is not", async () => {
    const over = await runningRun();
    await ageRun(over.runId, 75, 1, 1, { silenceMin: 15, runMin: 60 }); // 75 minutes: past 60 + 10 margin, well under 240
    expect(await new SandboxTarget({ ...over.inv.deps }).settleIfLost(runOf(over.s, over.runId))).toBe("settled");
    expect(await checkpointKindOf(over.runId)).toBe("run_time");
    const live = await runningRun();
    await ageRun(live.runId, 65, 1, 1, { silenceMin: 15, runMin: 60 }); // inside the margin, stamped a minute ago
    const callsBefore = stopCalls(live.inv);
    expect(await new SandboxTarget({ ...live.inv.deps }).settleIfLost(runOf(live.s, live.runId))).toBe("alive");
    expect(stopCalls(live.inv)).toBe(callsBefore);
  });

  it("durable limits: the finalized run marks the invariant sweep pending (what frees the item's slot), for a silent run and for an expired sandbox", async () => {
    const marks = new Map<string, number>();
    setPendingHooks({ store: { get: async (k) => marks.get(k), set: async (k, v) => void marks.set(k, v), delete: async (k) => void marks.delete(k) } });
    try {
      const silent = await runningRun();
      await ageRun(silent.runId, 90, 80, 80);
      marks.clear();
      expect(await new SandboxTarget({ ...silent.inv.deps }).settleIfLost(runOf(silent.s, silent.runId))).toBe("settled");
      expect(marks.has("pending:invariant-sweep")).toBe(true);
      const expired = await runningRun();
      expired.inv.sdk.stopFromOutside(expired.name, "deleted");
      marks.clear();
      expect(await new SandboxTarget({ ...expired.inv.deps }).settleIfLost(runOf(expired.s, expired.runId))).toBe("settled");
      expect(await statusOf(expired.runId)).toBe("failed");
      expect(await failureReasonOf(expired.runId)).toBe("sandbox_stopped");
      expect(marks.has("pending:invariant-sweep")).toBe(true);
    } finally {
      setPendingHooks(null);
    }
  });

  it("durable limits: the instance that holds the run's meter reports what it metered, so model spend already incurred is settled", async () => {
    const { s, inv, runId } = await runningRun();
    await ageRun(runId, 90, 80, null);
    const held = (inv.target as unknown as { runs: Map<string, { cumulativeModelUsd: number; ccSessionId?: string; sessionIds: string[] }> }).runs.get(runId)!;
    held.cumulativeModelUsd = 0.5;
    held.ccSessionId = "cc-stream-session";
    expect(held.sessionIds.length).toBeGreaterThan(0); // a VM session id exists and must not be what is recorded
    expect(await inv.target.settleIfLost(runOf(s, runId))).toBe("settled");
    const rows = (await db.admin.query(`SELECT budget, usd::float AS usd FROM ledger WHERE run_id = $1 ORDER BY budget`, [runId])).rows;
    expect(rows.find((r: { budget: string }) => r.budget === "model")?.usd).toBe(0.5);
    const recorded = (await db.admin.query(`SELECT cc_session_id FROM agent_runs WHERE id = $1`, [runId])).rows[0].cc_session_id;
    expect(recorded).toBe("cc-stream-session");
    expect(held.sessionIds).not.toContain(recorded);
    expect(await checkpointCcSessionOf(runId)).toBe("cc-stream-session");
  });

  it("durable limits: a run with a fresh liveness stamp is NOT killed although its run events are old (events are capped and sparse)", async () => {
    const { s, inv, runId } = await runningRun();
    await ageRun(runId, 120, 100, 1); // events 100 minutes old (as after the activity cap), stamped a minute ago
    const callsBefore = stopCalls(inv);
    expect(await new SandboxTarget({ ...inv.deps }).settleIfLost(runOf(s, runId))).toBe("alive");
    expect(await statusOf(runId)).toBe("running");
    expect(stopCalls(inv)).toBe(callsBefore);
  });

  it("durable limits: a run with a stale liveness stamp and stale events IS killed", async () => {
    const { s, inv, runId } = await runningRun();
    await ageRun(runId, 120, 100, 45);
    expect(await new SandboxTarget({ ...inv.deps }).settleIfLost(runOf(s, runId))).toBe("settled");
    expect(await checkpointKindOf(runId)).toBe("silence");
  });

  it("durable limits: a run past the run-time ceiling that is still chatty is ended as timed_out/run_time, but not inside the margin", async () => {
    const inside = await runningRun();
    await ageRun(inside.runId, 245, 1, 1); // past the 240 minute ceiling, inside the 10 minute margin
    expect(await new SandboxTarget({ ...inside.inv.deps }).settleIfLost(runOf(inside.s, inside.runId))).toBe("alive");
    expect(await statusOf(inside.runId)).toBe("running");
    const { s, inv, runId } = await runningRun();
    await ageRun(runId, 300, 1, 1);
    expect(await new SandboxTarget({ ...inv.deps }).settleIfLost(runOf(s, runId))).toBe("settled");
    expect(await statusOf(runId)).toBe("timed_out");
    expect(await checkpointKindOf(runId)).toBe("run_time");
  });

  it("durable limits: an active run (recent event, inside the run-time ceiling) is left running and its sandbox untouched", async () => {
    const { s, inv, runId } = await runningRun();
    await ageRun(runId, 120, 2, 1);
    const callsBefore = stopCalls(inv);
    expect(await new SandboxTarget({ ...inv.deps }).settleIfLost(runOf(s, runId))).toBe("alive");
    expect(await statusOf(runId)).toBe("running");
    expect(stopCalls(inv)).toBe(callsBefore);
  });

  it("durable limits: a run already finalized is skipped without a stop", async () => {
    const { s, inv, runId } = await runningRun();
    await ageRun(runId, 300, 200);
    expect(await new SandboxTarget({ ...inv.deps }).settleIfLost(runOf(s, runId))).toBe("settled");
    const callsAfterFirst = stopCalls(inv);
    // The sandbox is reported running again (a stale read); the run is over, so nothing more is done.
    const stale = new SandboxTarget({ ...inv.deps, sandboxPort: { ...inv.port, sandboxState: async () => "running" } });
    expect(await stale.settleIfLost(runOf(s, runId))).toBe("alive");
    expect(stopCalls(inv)).toBe(callsAfterFirst);
  });

  it("durable limits: two separate instances ticking at once may both call stop, but the run is finalized once", async () => {
    const { s, inv, runId } = await runningRun();
    await ageRun(runId, 90, 80, null);
    const one = new SandboxTarget({ ...inv.deps });
    const two = new SandboxTarget({ ...inv.deps });
    const callsBefore = stopCalls(inv);
    const outcomes = await Promise.all([one.settleIfLost(runOf(s, runId)), two.settleIfLost(runOf(s, runId))]);
    expect(outcomes.filter((o) => o === "settled").length).toBeGreaterThanOrEqual(1);
    expect(stopCalls(inv) - callsBefore).toBeLessThanOrEqual(2);
    expect(await statusOf(runId)).toBe("timed_out");
    expect(await countEvents(runId, "checkpoint")).toBe(1);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'timed_out'`, [runId])).rows[0].n).toBe(1);
    expect(await openReservations(runId)).toBe(0);
  });

  it("durable limits: another tenant's silent run is untouched by a check made in this tenant's context", async () => {
    const mine = await runningRun();
    const theirs = await runningRun();
    await ageRun(theirs.runId, 90, 80, null);
    const callsBefore = stopCalls(theirs.inv);
    // This tenant's context naming the other tenant's run id finds no row: nothing is stopped or written.
    const crossed = await new SandboxTarget({ ...theirs.inv.deps }).settleIfLost({ ...runOf(mine.s, theirs.runId) });
    expect(crossed).not.toBe("settled");
    expect(await statusOf(theirs.runId)).toBe("running");
    expect(stopCalls(theirs.inv)).toBe(callsBefore);
    // And this tenant's own healthy run is not touched when the other's is settled.
    expect(await new SandboxTarget({ ...theirs.inv.deps }).settleIfLost(runOf(theirs.s, theirs.runId))).toBe("settled");
    expect(await statusOf(mine.runId)).toBe("running");
  });

  it("liveness stamp: the definer writes at most once per minute per run, only for a running run, only in the caller's tenant", async () => {
    const { s, runId } = await runningRun();
    await db.admin.query(`UPDATE agent_runs SET last_alive_at = NULL WHERE id = $1`, [runId]);
    const mark = async (account = s.accountId, context = s.accountId): Promise<boolean> =>
      (await withTenant(db.runWriterPool, context, (c) => c.query(`SELECT agent_run_alive_mark($1::uuid, $2::uuid) AS w`, [account, runId]))).rows[0].w;
    expect(await mark()).toBe(true);
    expect(await mark()).toBe(false); // inside the minute
    await db.admin.query(`UPDATE agent_runs SET last_alive_at = now() - interval '61 seconds' WHERE id = $1`, [runId]);
    expect(await mark()).toBe(true);
    await expect(mark(s.accountId, randomUUID())).rejects.toMatchObject({ code: "42501" });
    await db.admin.query(`UPDATE agent_runs SET last_alive_at = NULL WHERE id = $1`, [runId]);
    await db.admin.query(`ALTER TABLE agent_runs DISABLE TRIGGER USER`);
    try {
      await db.admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [runId]);
    } finally {
      await db.admin.query(`ALTER TABLE agent_runs ENABLE TRIGGER USER`);
    }
    expect(await mark()).toBe(false); // not running
  });

  it("liveness stamp: a run's stream lines stamp it while the run is running", async () => {
    const s = await scenario();
    const inv = invocation();
    const started = await startAgentRun(db.runWriterPool, { sandbox: inv.target }, s.input);
    if (started.status !== "running") throw new Error("run did not start");
    await inv.endInvocation();
    await sleep(AGENT_OUTPUT_DELAY_MS + 100);
    expect((await db.admin.query(`SELECT last_alive_at IS NOT NULL AS stamped FROM agent_runs WHERE id = $1`, [started.id])).rows[0].stamped).toBe(true);
  });

  it("liveness stamp: the runner writes it at most once per minute however many events arrive", async () => {
    const { s, inv, runId } = await runningRun();
    let stamps = 0;
    const wrapped = new WeakSet<object>(); // a pooled client is handed out again: wrap it once
    const pool = {
      connect: async () => {
        const client = await db.runWriterPool.connect();
        if (!wrapped.has(client)) {
          wrapped.add(client);
          const query = client.query.bind(client) as (...a: unknown[]) => unknown;
          (client as unknown as { query: unknown }).query = (...a: unknown[]) => {
            if (typeof a[0] === "string" && a[0].includes("agent_run_alive_mark")) stamps++;
            return query(...a);
          };
        }
        return client;
      },
    };
    const target = new SandboxTarget({ ...inv.deps, pool: pool as never });
    const bk = {} as { aliveStampedMs?: number };
    const stamp = (target as unknown as { stampAlive(run: unknown, bk: unknown): Promise<void> }).stampAlive.bind(target);
    for (let i = 0; i < 25; i++) await stamp(runOf(s, runId), bk);
    expect(stamps).toBe(1);
    bk.aliveStampedMs = Date.now() - 61_000;
    await stamp(runOf(s, runId), bk);
    await stamp(runOf(s, runId), bk);
    expect(stamps).toBe(2);
  });

  it("the lister is for the runner login only, and takes a sane limit", async () => {
    await expect(db.pureAppUserPool.query(`SELECT * FROM agent_run_list_running(5, 0)`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.runWriterPool.query(`SELECT * FROM agent_run_list_running(0, 0)`)).rejects.toMatchObject({ code: "22023" });
  });
});
