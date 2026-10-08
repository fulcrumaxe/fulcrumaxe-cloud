import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { markWorkPending, setPendingHooks } from "@fx/core/src/pendingWork";
import type { RunActionsWorker } from "@fx/pipeline";
import { API_SWEEP_KICK_BODY, API_SWEEP_KICK_HEADER, apiSweepKickHeader, apiSweepKickKey, type SweepSummary } from "@fx/webhooks";
import { makeRegion, storeOf, type FakeRegion } from "../../../test/support/runtimeCacheFake";

/**
 * D#454 H3c: each sweep cron, end to end through its handler, behind the no-database marker gate.
 * `createPool` is mocked so a pool created anywhere fails the "zero connections" assertions; the worker factories are
 * spies for the same reason (building the worker is what opens the database for the other two sweeps).
 */
const createPool = vi.hoisted(() => vi.fn(() => ({ fake: "pool" })));
vi.mock("@fx/db/src/pool", () => ({ createPool }));

import { apiSweepHandler, apiSweepKickHandler, defaultApiSweepDeps } from "./api-sweep/handler";
import { runActionSweepHandler } from "./run-action-sweep/handler";
import { computeSettleSweepHandler } from "./compute-settle-sweep/handler";
import { runnerSweeperHandler } from "./runner-sweeper/handler";

const SECRET = "test-cron-secret";
const KICK_KEY = apiSweepKickKey(SECRET); // what the kick is signed with: derived from the cron secret, never the secret itself
const MIN = 60_000;
const clock = { value: Date.now() };
let region: FakeRegion;

const EMPTY_SUMMARY: SweepSummary = { fanOut: { eventsProcessed: 0, deliveriesCreated: 0 }, sent: { claimed: 0, succeeded: 0, failed: 0, dead: 0 }, disabledEndpoints: [], purged: {} };
const BUSY_SUMMARY: SweepSummary = { ...EMPTY_SUMMARY, fanOut: { eventsProcessed: 1, deliveriesCreated: 1 } };

function cronRequest(name: string): NextRequest {
  return new NextRequest(`https://example.test/api/cron/${name}`, { method: "GET", headers: { authorization: `Bearer ${SECRET}` } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock.value);
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://platform_ops@localhost/none");
  createPool.mockClear();
  region = makeRegion(clock);
  setPendingHooks({ store: storeOf(region) });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  setPendingHooks(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function advance(ms: number): void {
  clock.value += ms;
  vi.setSystemTime(clock.value);
}

describe("api-sweep", () => {
  const sweep = vi.fn(async () => EMPTY_SUMMARY);
  const nextDue = vi.fn(async () => null as number | null);
  beforeEach(() => {
    sweep.mockClear();
    nextDue.mockClear();
  });

  it("with no pending work makes ZERO database connections: no pool is created, no sweep runs", async () => {
    await apiSweepHandler(cronRequest("api-sweep"), defaultApiSweepDeps(), sweep, nextDue); // first tick after a deploy connects
    createPool.mockClear();
    sweep.mockClear();
    nextDue.mockClear();
    vi.resetModules();
    const fresh = await import("./api-sweep/handler"); // a cold instance: no pool cached from the first tick
    const res = await fresh.apiSweepHandler(cronRequest("api-sweep"), fresh.defaultApiSweepDeps(), sweep, nextDue);
    expect(await res.json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(createPool).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
    expect(nextDue).not.toHaveBeenCalled();
  });

  it("does connect (and builds its pool only then) once a writer has marked work", async () => {
    await apiSweepHandler(cronRequest("api-sweep"), defaultApiSweepDeps(), sweep, nextDue);
    advance(10 * MIN);
    await markWorkPending("api-sweep");
    advance(2 * MIN);
    createPool.mockClear();
    vi.resetModules();
    const fresh = await import("./api-sweep/handler");
    sweep.mockResolvedValueOnce(BUSY_SUMMARY);
    const res = await fresh.apiSweepHandler(cronRequest("api-sweep"), fresh.defaultApiSweepDeps(), sweep, nextDue);
    expect(await res.json()).toEqual(BUSY_SUMMARY);
    expect(createPool).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(nextDue).toHaveBeenCalled();
  });

  it("connects on the 30-minute backstop even with no marker", async () => {
    await apiSweepHandler(cronRequest("api-sweep"), defaultApiSweepDeps(), sweep, nextDue);
    advance(31 * MIN);
    sweep.mockClear();
    await apiSweepHandler(cronRequest("api-sweep"), defaultApiSweepDeps(), sweep, nextDue);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("keeps the marker alive for a retry that is still waiting, and only that long", async () => {
    await apiSweepHandler(cronRequest("api-sweep"), defaultApiSweepDeps(), sweep, nextDue);
    advance(10 * MIN);
    await markWorkPending("api-sweep");
    advance(2 * MIN);
    nextDue.mockResolvedValueOnce(clock.value + 5 * MIN);
    await apiSweepHandler(cronRequest("api-sweep"), defaultApiSweepDeps(), sweep, nextDue);
    sweep.mockClear();
    advance(4 * MIN);
    await apiSweepHandler(cronRequest("api-sweep"), defaultApiSweepDeps(), sweep, nextDue);
    expect(sweep).not.toHaveBeenCalled();
    advance(2 * MIN);
    await apiSweepHandler(cronRequest("api-sweep"), defaultApiSweepDeps(), sweep, nextDue);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("an unauthenticated call touches neither the cache nor the database", async () => {
    const res = await apiSweepHandler(new NextRequest("https://example.test/api/cron/api-sweep"), defaultApiSweepDeps(), sweep, nextDue);
    expect(res.status).toBe(401);
    expect(region.calls).toEqual({ get: 0, set: 0, delete: 0 });
    expect(createPool).not.toHaveBeenCalled();
  });

  it("keeps the marker when it cannot read what is left to do, rather than dropping work", async () => {
    await apiSweepHandler(cronRequest("api-sweep"), defaultApiSweepDeps(), sweep, nextDue);
    advance(10 * MIN);
    await markWorkPending("api-sweep");
    advance(2 * MIN);
    nextDue.mockRejectedValueOnce(new Error("db hiccup"));
    await apiSweepHandler(cronRequest("api-sweep"), defaultApiSweepDeps(), sweep, nextDue);
    sweep.mockClear();
    advance(MIN);
    await apiSweepHandler(cronRequest("api-sweep"), defaultApiSweepDeps(), sweep, nextDue);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});

describe("api-sweep kick", () => {
  const sweep = vi.fn(async () => BUSY_SUMMARY);
  const nextDue = vi.fn(async () => null as number | null);
  function kickRequest(header: string | null, body: string = API_SWEEP_KICK_BODY): Request {
    const headers = new Headers({ "content-type": "application/json" });
    if (header !== null) headers.set(API_SWEEP_KICK_HEADER, header);
    return new Request("https://example.test/api/cron/api-sweep", { method: "POST", headers, body });
  }
  function kickDeps(over: Partial<Parameters<typeof apiSweepKickHandler>[1]> = {}) {
    const scheduled: Array<Promise<unknown>> = [];
    return { scheduled, deps: { cronSecret: SECRET, schedule: (w: Promise<unknown>) => scheduled.push(w), sweepDeps: defaultApiSweepDeps, ...over } };
  }
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  beforeEach(() => {
    sweep.mockClear();
    nextDue.mockClear();
  });

  it("still runs the sweep right away (a signed kick answers 202 and sweeps after the response), with no marker set", async () => {
    await apiSweepHandler(cronRequest("api-sweep"), defaultApiSweepDeps(), sweep, nextDue); // establish a recent connect
    sweep.mockClear();
    const { deps, scheduled } = kickDeps();
    const res = await apiSweepKickHandler(kickRequest(apiSweepKickHeader(KICK_KEY, nowSeconds())), deps, sweep, nextDue);
    expect(res.status).toBe(202);
    await Promise.all(scheduled);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no signature", null],
    ["a wrong key", apiSweepKickHeader("another-key", Math.floor(Date.now() / 1000))],
    ["a stale timestamp", apiSweepKickHeader(KICK_KEY, Math.floor(Date.now() / 1000) - 600)],
    ["a malformed header", "t=1,sig=zz"],
  ])("answers a bare 401 for %s and does nothing", async (_n, header) => {
    const { deps, scheduled } = kickDeps();
    const res = await apiSweepKickHandler(kickRequest(header), deps, sweep, nextDue);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(scheduled).toHaveLength(0);
    expect(region.calls).toEqual({ get: 0, set: 0, delete: 0 });
    expect(createPool).not.toHaveBeenCalled();
  });

  it("refuses a signature made with the cron secret itself rather than the key derived from it", async () => {
    const { deps, scheduled } = kickDeps();
    expect((await apiSweepKickHandler(kickRequest(apiSweepKickHeader(SECRET, nowSeconds())), deps, sweep, nextDue)).status).toBe(401);
    expect(scheduled).toHaveLength(0);
  });

  it("refuses a signature made for a different body (a run-action kick cannot trigger a sweep)", async () => {
    const body = JSON.stringify({ actionId: "0b6f0c3e-9d3a-4f3e-9a58-1f2f3b2c9d11" });
    const { createHmac } = await import("node:crypto");
    const t = nowSeconds();
    const header = `t=${t},sig=${createHmac("sha256", KICK_KEY).update(`${t}.${body}`).digest("hex")}`;
    const { deps, scheduled } = kickDeps();
    expect((await apiSweepKickHandler(kickRequest(header, body), deps, sweep, nextDue)).status).toBe(401);
    expect(scheduled).toHaveLength(0);
  });

  it("fails closed with no cron secret configured, even for a signature made with the empty key", async () => {
    const { deps } = kickDeps({ cronSecret: "" });
    expect((await apiSweepKickHandler(kickRequest(apiSweepKickHeader("", nowSeconds())), deps, sweep, nextDue)).status).toBe(401);
  });

  it("runs one kicked sweep at a time per process", async () => {
    let release: () => void = () => {};
    sweep.mockImplementationOnce(() => new Promise<SweepSummary>((resolve) => (release = () => resolve(BUSY_SUMMARY))));
    const { deps, scheduled } = kickDeps();
    const header = apiSweepKickHeader(KICK_KEY, nowSeconds());
    expect((await apiSweepKickHandler(kickRequest(header), deps, sweep, nextDue)).status).toBe(202);
    expect((await apiSweepKickHandler(kickRequest(header), deps, sweep, nextDue)).status).toBe(202);
    expect(scheduled).toHaveLength(1);
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1)); // the sweep starts after the bounded cache reads settle
    release();
    await Promise.all(scheduled);
  });
});

describe("run-action-sweep", () => {
  const getWorker = vi.fn(async (): Promise<RunActionsWorker | null> => null);
  const startWorkflow = vi.fn(async () => {});
  const deps = () => ({ cronSecret: SECRET, getWorker, startWorkflow, log: vi.fn() });
  const workerWith = (ids: string[]): RunActionsWorker =>
    ({ listDueRunActions: vi.fn(async () => ids), purgeRunActions: vi.fn(async () => 0) }) as unknown as RunActionsWorker;
  beforeEach(() => {
    getWorker.mockReset();
    startWorkflow.mockClear();
  });

  it("with no pending work builds no worker (so opens no connection) and starts nothing", async () => {
    getWorker.mockResolvedValue(workerWith([]));
    await runActionSweepHandler(cronRequest("run-action-sweep"), deps());
    getWorker.mockClear();
    const res = await runActionSweepHandler(cronRequest("run-action-sweep"), deps());
    expect(await res.json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(getWorker).not.toHaveBeenCalled();
  });

  it("a marked action is listed by the next tick, and a listed action keeps the next tick coming until it is gone", async () => {
    getWorker.mockResolvedValue(workerWith([]));
    await runActionSweepHandler(cronRequest("run-action-sweep"), deps());
    advance(10 * MIN);
    await markWorkPending("run-action-sweep");
    advance(2 * MIN);
    getWorker.mockResolvedValue(workerWith(["a1"]));
    expect(await (await runActionSweepHandler(cronRequest("run-action-sweep"), deps())).json()).toMatchObject({ listed: 1, started: 1 });
    advance(5 * MIN);
    getWorker.mockResolvedValue(workerWith([]));
    expect(await (await runActionSweepHandler(cronRequest("run-action-sweep"), deps())).json()).toMatchObject({ listed: 0 });
    advance(5 * MIN);
    getWorker.mockClear();
    await runActionSweepHandler(cronRequest("run-action-sweep"), deps());
    expect(getWorker).not.toHaveBeenCalled();
  });

  it("connects on the backstop with no marker", async () => {
    getWorker.mockResolvedValue(workerWith([]));
    await runActionSweepHandler(cronRequest("run-action-sweep"), deps());
    advance(31 * MIN);
    getWorker.mockClear();
    await runActionSweepHandler(cronRequest("run-action-sweep"), deps());
    expect(getWorker).toHaveBeenCalledTimes(1);
  });

  it("an unauthenticated call builds no worker and reads no cache", async () => {
    const res = await runActionSweepHandler(new NextRequest("https://example.test/api/cron/run-action-sweep"), deps());
    expect(res.status).toBe(401);
    expect(getWorker).not.toHaveBeenCalled();
    expect(region.calls).toEqual({ get: 0, set: 0, delete: 0 });
  });
});

describe("compute-settle-sweep", () => {
  const sweepComputeSettle = vi.fn(async () => ({ listed: 0, settled: 0, deleted: 0, failed: 0, skipped: 0 }));
  const getWorker = vi.fn(async () => ({ sweepComputeSettle }) as { sweepComputeSettle: typeof sweepComputeSettle } | null);
  const deps = () => ({ cronSecret: SECRET, getWorker, log: vi.fn() });
  beforeEach(() => {
    getWorker.mockClear();
    sweepComputeSettle.mockClear();
  });

  it("with no pending work builds no worker and settles nothing", async () => {
    await computeSettleSweepHandler(cronRequest("compute-settle-sweep"), deps());
    getWorker.mockClear();
    const res = await computeSettleSweepHandler(cronRequest("compute-settle-sweep"), deps());
    expect(await res.json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(getWorker).not.toHaveBeenCalled();
  });

  it("a marked run is settled by the next tick; a run still waiting for figures keeps the next tick coming", async () => {
    await computeSettleSweepHandler(cronRequest("compute-settle-sweep"), deps());
    advance(20 * MIN);
    await markWorkPending("compute-settle-sweep");
    advance(2 * MIN);
    sweepComputeSettle.mockResolvedValueOnce({ listed: 1, settled: 0, deleted: 0, failed: 0, skipped: 0 });
    await computeSettleSweepHandler(cronRequest("compute-settle-sweep"), deps());
    advance(10 * MIN);
    sweepComputeSettle.mockResolvedValueOnce({ listed: 1, settled: 1, deleted: 1, failed: 0, skipped: 0 });
    await computeSettleSweepHandler(cronRequest("compute-settle-sweep"), deps());
    expect(sweepComputeSettle).toHaveBeenCalledTimes(3);
    advance(10 * MIN);
    getWorker.mockClear();
    await computeSettleSweepHandler(cronRequest("compute-settle-sweep"), deps());
    expect(getWorker).not.toHaveBeenCalled();
  });

  it("a running run keeps every tick connecting, with no compute settle due anywhere, until its sandbox is found lost and settled; then the ticks skip again", async () => {
    const none = { listed: 0, settled: 0, deleted: 0, failed: 0, skipped: 0 };
    await computeSettleSweepHandler(cronRequest("compute-settle-sweep"), deps()); // first tick: overdue, connects, nothing to do
    advance(20 * MIN);
    await markWorkPending("compute-settle-sweep"); // what a run reaching `running` does (startAgentRun)
    advance(2 * MIN);
    // A run is running (listed by the lost-run sweep) and its sandbox is alive: nothing settled, yet the marker stays.
    for (let tick = 0; tick < 3; tick++) {
      sweepComputeSettle.mockResolvedValueOnce({ ...none, lost: { listed: 1 } } as never);
      const before = getWorker.mock.calls.length;
      await computeSettleSweepHandler(cronRequest("compute-settle-sweep"), deps());
      expect(getWorker.mock.calls.length).toBe(before + 1);
      advance(10 * MIN);
    }
    // The tick that finds its sandbox gone settles it: no running run remains, so the marker clears...
    sweepComputeSettle.mockResolvedValueOnce({ ...none, lost: { listed: 0 } } as never);
    await computeSettleSweepHandler(cronRequest("compute-settle-sweep"), deps());
    advance(10 * MIN);
    getWorker.mockClear();
    const res = await computeSettleSweepHandler(cronRequest("compute-settle-sweep"), deps());
    // ...and the tick after it is skipped again.
    expect(await res.json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(getWorker).not.toHaveBeenCalled();
  });

  it("an unauthenticated call builds no worker and reads no cache", async () => {
    const res = await computeSettleSweepHandler(new NextRequest("https://example.test/api/cron/compute-settle-sweep"), deps());
    expect(res.status).toBe(401);
    expect(getWorker).not.toHaveBeenCalled();
    expect(region.calls).toEqual({ get: 0, set: 0, delete: 0 });
  });
});

describe("runner-sweeper (D#6 R2b)", () => {
  const HOUR = 60 * MIN;
  const none = { listed: 0, expired: 0, waiting: 0, skipped: 0, failed: 0, nextDueAt: null as number | null };
  const noLeases = { leasesListed: 0, lost: 0, followUpsCreated: 0, followUpsExhausted: 0, followUpsFailed: 0, joblessRetried: 0, joblessFailed: 0, joblessErrors: 0, revoked: 0, wallClockTimedOut: 0, held: 0, leasesSkipped: 0, leasesFailed: 0, nextDueAt: null as number | null };
  const sweepRunnerQueue = vi.fn(async () => none);
  const sweepRunnerLeases = vi.fn(async () => noLeases);
  const getWorker = vi.fn(async () => ({ sweepRunnerQueue, sweepRunnerLeases }) as { sweepRunnerQueue: typeof sweepRunnerQueue; sweepRunnerLeases: typeof sweepRunnerLeases } | null);
  const deps = () => ({ cronSecret: SECRET, getWorker, log: vi.fn() });
  beforeEach(() => {
    getWorker.mockClear();
    sweepRunnerQueue.mockReset();
    sweepRunnerQueue.mockResolvedValue(none);
    sweepRunnerLeases.mockReset();
    sweepRunnerLeases.mockResolvedValue(noLeases);
  });

  it("with no pending work builds no worker and sweeps nothing", async () => {
    await runnerSweeperHandler(cronRequest("runner-sweeper"), deps());
    getWorker.mockClear();
    sweepRunnerQueue.mockClear();
    const res = await runnerSweeperHandler(cronRequest("runner-sweeper"), deps());
    expect(await res.json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(getWorker).not.toHaveBeenCalled();
    expect(sweepRunnerQueue).not.toHaveBeenCalled();
  });

  it("a dispatched run is swept when its queue time ends: ticks before then skip, the due tick expires it, and the ticks after skip again", async () => {
    await runnerSweeperHandler(cronRequest("runner-sweeper"), deps()); // the first tick is overdue and connects with nothing to do
    sweepRunnerQueue.mockClear();
    advance(20 * MIN);
    const dueAt = clock.value + 72 * HOUR;
    await markWorkPending("runner-sweeper", { since: dueAt }); // what RunnerTarget.dispatch does
    // The backstop tick (30 minutes since the last connection) looks, finds the run still waiting and keeps the marker at its due time.
    advance(15 * MIN);
    sweepRunnerQueue.mockResolvedValueOnce({ ...none, listed: 1, waiting: 1, nextDueAt: dueAt });
    await runnerSweeperHandler(cronRequest("runner-sweeper"), deps());
    expect(sweepRunnerQueue).toHaveBeenCalledTimes(1);
    // Ticks until the next backstop and the due time end without a connection.
    advance(10 * MIN);
    getWorker.mockClear();
    expect(await (await runnerSweeperHandler(cronRequest("runner-sweeper"), deps())).json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(getWorker).not.toHaveBeenCalled();
    // Not before: a tick 29 minutes ahead connects only through the backstop and keeps the marker; a tick 1 ms before the due
    // time is skipped, so nothing is looked at early.
    clock.value = dueAt - 29 * MIN;
    vi.setSystemTime(clock.value);
    sweepRunnerQueue.mockResolvedValueOnce({ ...none, listed: 1, waiting: 1, nextDueAt: dueAt });
    await runnerSweeperHandler(cronRequest("runner-sweeper"), deps());
    clock.value = dueAt - 1;
    vi.setSystemTime(clock.value);
    getWorker.mockClear();
    expect(await (await runnerSweeperHandler(cronRequest("runner-sweeper"), deps())).json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(getWorker).not.toHaveBeenCalled();
    // The first tick at or after the due time connects through the marker, expires the run and, with nothing left waiting, clears it.
    clock.value = dueAt;
    vi.setSystemTime(clock.value);
    sweepRunnerQueue.mockResolvedValueOnce({ ...none, listed: 1, expired: 1 });
    const due = await runnerSweeperHandler(cronRequest("runner-sweeper"), deps());
    expect(await due.json()).toEqual({ configured: true, listed: 1, expired: 1, waiting: 0, skipped: 0, failed: 0, leases: (({ nextDueAt: _n, ...rest }) => rest)(noLeases) });
    // A marker younger than a minute is kept, as its writer may not have committed; the next tick finds nothing and clears it.
    advance(6 * MIN);
    await runnerSweeperHandler(cronRequest("runner-sweeper"), deps());
    advance(6 * MIN);
    getWorker.mockClear();
    expect(await (await runnerSweeperHandler(cronRequest("runner-sweeper"), deps())).json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(getWorker).not.toHaveBeenCalled();
  });

  describe("the two halves of the tick do not stop each other (review suggestion on the cron handler)", () => {
    const run = async (log = vi.fn()) => runnerSweeperHandler(cronRequest("runner-sweeper"), { cronSecret: SECRET, getWorker, log });

    it("a queue sweep that throws still lets the lease sweep run, and the failure is named, not described", async () => {
      await run(); // the first tick is overdue and connects with nothing to do
      sweepRunnerQueue.mockClear();
      sweepRunnerLeases.mockClear();
      advance(20 * MIN);
      await markWorkPending("runner-sweeper");
      advance(2 * MIN);
      sweepRunnerQueue.mockRejectedValueOnce(new Error("connection reset: secret-detail"));
      sweepRunnerLeases.mockResolvedValueOnce({ ...noLeases, leasesListed: 2, lost: 1, held: 1, nextDueAt: null });
      const log = vi.fn();
      const res = await run(log);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(sweepRunnerLeases).toHaveBeenCalledTimes(1);
      expect(body).toMatchObject({ configured: true, failed: 1, sweepFailures: ["queue"], leases: { leasesListed: 2, lost: 1 } });
      expect(JSON.stringify(body)).not.toContain("secret-detail");
      expect(log).toHaveBeenCalledWith("runner sweeper: queue sweep failed");
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret-detail");
      // The tick comes back soon: not yet at 3 minutes, again after 5.
      advance(3 * MIN);
      getWorker.mockClear();
      await run();
      expect(getWorker).not.toHaveBeenCalled();
      advance(3 * MIN);
      await run();
      expect(getWorker).toHaveBeenCalledTimes(1);
    });

    it("a lease sweep that throws leaves the queue sweep's work reported", async () => {
      await run();
      sweepRunnerQueue.mockClear();
      sweepRunnerLeases.mockClear();
      advance(20 * MIN);
      await markWorkPending("runner-sweeper");
      advance(2 * MIN);
      sweepRunnerQueue.mockResolvedValueOnce({ ...none, listed: 3, expired: 3 });
      sweepRunnerLeases.mockRejectedValueOnce(new Error("lease list failed"));
      const log = vi.fn();
      const body = (await (await run(log)).json()) as Record<string, unknown>;
      expect(sweepRunnerQueue).toHaveBeenCalledTimes(1);
      expect(body).toMatchObject({ configured: true, listed: 3, expired: 3, sweepFailures: ["leases"], leases: { leasesFailed: 1 } });
      expect(log).toHaveBeenCalledWith("runner sweeper: lease sweep failed");
    });

    it("when both throw the tick fails as before: the marker is untouched and the next tick connects", async () => {
      await run();
      sweepRunnerQueue.mockClear();
      sweepRunnerLeases.mockClear();
      advance(20 * MIN);
      await markWorkPending("runner-sweeper");
      advance(2 * MIN);
      sweepRunnerQueue.mockRejectedValueOnce(new Error("queue down"));
      sweepRunnerLeases.mockRejectedValueOnce(new Error("lease down"));
      await expect(run()).rejects.toThrow("queue down");
      expect(sweepRunnerLeases).toHaveBeenCalledTimes(1);
      advance(1 * MIN);
      getWorker.mockClear();
      await run();
      expect(getWorker).toHaveBeenCalledTimes(1);
    });

    it("a clean tick is unchanged: no failure key in the result", async () => {
      await run();
      sweepRunnerQueue.mockClear();
      sweepRunnerLeases.mockClear();
      advance(20 * MIN);
      await markWorkPending("runner-sweeper");
      advance(2 * MIN);
      const body = (await (await run()).json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("sweepFailures");
    });
  });

  it("a failed run keeps the next tick coming soon instead of dropping the marker", async () => {
    await runnerSweeperHandler(cronRequest("runner-sweeper"), deps());
    advance(20 * MIN);
    await markWorkPending("runner-sweeper");
    advance(2 * MIN);
    sweepRunnerQueue.mockResolvedValueOnce({ ...none, listed: 1, failed: 1, nextDueAt: clock.value + 5 * MIN });
    await runnerSweeperHandler(cronRequest("runner-sweeper"), deps());
    advance(3 * MIN);
    getWorker.mockClear();
    await runnerSweeperHandler(cronRequest("runner-sweeper"), deps());
    expect(getWorker).not.toHaveBeenCalled(); // not yet
    advance(3 * MIN);
    await runnerSweeperHandler(cronRequest("runner-sweeper"), deps());
    expect(getWorker).toHaveBeenCalledTimes(1); // after the delay it tries again
  });

  it("a claimed run's lease end is a marker: the tick before it skips, the first tick at or after it sweeps the leases and keeps the next end due", async () => {
    await runnerSweeperHandler(cronRequest("runner-sweeper"), deps());
    advance(20 * MIN);
    const leaseEnd = clock.value + 90_000;
    await markWorkPending("runner-sweeper", { since: leaseEnd }); // what a claim does
    clock.value = leaseEnd - 1;
    vi.setSystemTime(clock.value);
    getWorker.mockClear();
    sweepRunnerLeases.mockClear();
    sweepRunnerQueue.mockClear();
    expect(await (await runnerSweeperHandler(cronRequest("runner-sweeper"), deps())).json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(getWorker).not.toHaveBeenCalled();
    clock.value = leaseEnd;
    vi.setSystemTime(clock.value);
    const nextEnd = leaseEnd + 90_000;
    sweepRunnerLeases.mockResolvedValueOnce({ ...noLeases, leasesListed: 1, held: 1, nextDueAt: nextEnd });
    const res = await runnerSweeperHandler(cronRequest("runner-sweeper"), deps());
    expect(sweepRunnerLeases).toHaveBeenCalledTimes(1);
    expect(sweepRunnerQueue).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ configured: true, leases: { leasesListed: 1, held: 1 } });
    // The earliest of the two sweeps' due times is kept: nothing connects before it.
    clock.value = nextEnd - 1;
    vi.setSystemTime(clock.value);
    getWorker.mockClear();
    expect(await (await runnerSweeperHandler(cronRequest("runner-sweeper"), deps())).json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(getWorker).not.toHaveBeenCalled();
  });

  it("an unauthenticated call builds no worker and reads no cache", async () => {
    const res = await runnerSweeperHandler(new NextRequest("https://example.test/api/cron/runner-sweeper"), deps());
    expect(res.status).toBe(401);
    expect(getWorker).not.toHaveBeenCalled();
    expect(region.calls).toEqual({ get: 0, set: 0, delete: 0 });
  });

  it("a worker that is not configured answers 200 with zeros", async () => {
    const d = { cronSecret: SECRET, getWorker: async () => null, log: vi.fn() };
    const res = await runnerSweeperHandler(cronRequest("runner-sweeper"), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, listed: 0, expired: 0, waiting: 0, skipped: 0, failed: 0 });
    expect(d.log).toHaveBeenCalledWith("runner sweeper: worker not configured");
  });
});
