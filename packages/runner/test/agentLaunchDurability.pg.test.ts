import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxPort } from "../src/sandboxPort.js";
import { createVercelSandboxPort } from "../src/vercelSandboxPort.js";
import { DispatchFailedError, type LostRunOutcome } from "../src/executionTarget.js";
import { sandboxNameFor } from "../src/sandboxNaming.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { configureAgentRunWiring, followStatusBody } from "../src/workflows/agentRun.js";
import { sweepLostRuns } from "../src/lostRunSweep.js";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
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

  /** The sweep over the whole database, acting on `mine` only (other tests' leftover runs are reported alive), repeated until it has met them all. */
  async function sweepUntilSeen(target: SandboxTarget, mine: readonly string[]): Promise<void> {
    const seen = new Set<string>();
    for (let tick = 0; tick < 60 && seen.size < mine.length; tick++) {
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

  it("the lister is for the runner login only, and takes a sane limit", async () => {
    await expect(db.pureAppUserPool.query(`SELECT * FROM agent_run_list_running(5, 0)`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.runWriterPool.query(`SELECT * FROM agent_run_list_running(0, 0)`)).rejects.toMatchObject({ code: "22023" });
  });
});
