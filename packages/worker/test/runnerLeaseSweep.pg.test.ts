import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { RUNNER_LEASE_SWEEP_BATCH, createRunnerLeaseSweeper, type RunnerLeaseSweepDeps } from "../src/runnerLeaseSweep.js";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { runnerLimitsFor } from "@fx/spend";

/**
 * [pg] D#6 R2b-3: the lease and wall-clock sweep against the real lister and fence (0754), the real compare-and-set writer and a
 * real run-writer login. The clock is injected, so the lease end and the two hours are fixed instants and nothing waits.
 */
describe("runner lease sweep [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let runnerA: string;
  let runnerB: string;
  const T0 = Date.parse("2026-10-10T12:00:00Z");
  const HOUR = 3_600_000;
  const WALL = runnerLimitsFor('runner').maxRunWallClockMs; // the runner plan's figure (the public fixture's here)
  const sweeper = (now: number, over: RunnerLeaseSweepDeps = {}) => createRunnerLeaseSweeper(writerPool, { now: () => now, ...over });

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    runnerA = await insertRunner(admin, A.accountId, A.userId);
    runnerB = await insertRunner(admin, B.accountId, B.userId);
  });
  beforeEach(async () => {
    // The sweep is cross-tenant and other files leave running (and, for the no-job work, pending) runner runs behind.
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
    await admin.query("UPDATE runners SET revoked_at = NULL WHERE id = ANY($1)", [[runnerA, runnerB]]);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  /** A running runner run. `start` is when it started; `lease` when its lease ends (epoch ms). */
  async function running(o: { account?: SeedRefs; runner?: string; lease: number; start: number; status?: string; generation?: number }): Promise<string> {
    const account = o.account ?? A;
    const id = randomUUID();
    await admin.query("SET session_replication_role = replica"); // the start stamp and the lease guard are for live sessions, not fixtures
    try {
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, runner_id, lease_generation, lease_expires_at, started_at)
         VALUES ($1, $2, 'executor', 'runner', $3, 'runner_local', $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0))`,
        [id, account.accountId, o.status ?? "running", o.runner ?? (account === A ? runnerA : runnerB), o.generation ?? 1, o.lease, o.start],
      );
    } finally {
      await admin.query("SET session_replication_role = DEFAULT");
    }
    return id;
  }
  const row = async (id: string) => (await admin.query("SELECT status, lease_expires_at FROM agent_runs WHERE id = $1", [id])).rows[0];
  const events = async (id: string) => (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq", [id])).rows.map((r) => r.payload);

  it("fails a run whose lease has ended with runner_lost, AT lease_expires_at and not 1 ms before, with no heartbeat or sweep needed", async () => {
    const early = await running({ lease: T0 + 1, start: T0 - 60_000 });
    const result = await sweeper(T0).sweepRunnerLeases();
    expect(result).toMatchObject({ leasesListed: 1, held: 1, lost: 0, nextDueAt: T0 + 1 });
    expect((await row(early)).status).toBe("running");
    const second = await sweeper(T0 + 1).sweepRunnerLeases();
    expect(second).toMatchObject({ lost: 1, held: 0 });
    expect((await row(early)).status).toBe("failed");
    expect(await events(early)).toEqual([{ from: "running", to: "failed", failureReason: "runner_lost" }]);
  });

  it("times a run out two hours after its start, whatever its lease says, and not 1 ms before", async () => {
    const start = T0 - WALL + 1;
    const id = await running({ lease: T0 + HOUR, start });
    expect(await sweeper(T0).sweepRunnerLeases()).toMatchObject({ held: 1, wallClockTimedOut: 0, nextDueAt: start + WALL });
    expect((await row(id)).status).toBe("running");
    expect(await sweeper(start + WALL).sweepRunnerLeases()).toMatchObject({ wallClockTimedOut: 1 });
    expect((await row(id)).status).toBe("timed_out");
    expect(await events(id)).toEqual([{ from: "running", to: "timed_out", failureReason: "wall_clock_limit" }]);
  });

  it("a lease that has ended wins over the wall clock, and a revoked runner's run is failed runner_revoked", async () => {
    const both = await running({ lease: T0 - 1000, start: T0 - WALL - 1000 });
    const revokedRun = await running({ lease: T0 + HOUR, start: T0 - 1000 });
    await admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerA]);
    const result = await sweeper(T0).sweepRunnerLeases();
    expect(result).toMatchObject({ leasesListed: 2, lost: 0, revoked: 2 });
    expect((await events(both))[0]).toMatchObject({ failureReason: "runner_revoked" });
    expect((await row(revokedRun)).status).toBe("failed");
  });

  it("leaves a run alone that a heartbeat has kept alive, and runs of other statuses", async () => {
    const alive = await running({ lease: T0 + 60_000, start: T0 - 60_000 });
    const done = await running({ lease: T0 - 5000, start: T0 - 60_000, status: "succeeded" });
    const stale = await running({ lease: T0 - 5000, start: T0 - 60_000, status: "pending" });
    // A pending run that has its job is waiting for a runner and is not the lease sweep's; one with no job is (C22 section 3, tested in runnerFollowUp.pg.test.ts).
    await admin.query(`UPDATE agent_runs SET job_signed = '{"job":{}}'::jsonb WHERE id = $1`, [stale]);
    const result = await sweeper(T0).sweepRunnerLeases();
    expect(result).toMatchObject({ leasesListed: 1, held: 1, lost: 0, nextDueAt: T0 + 60_000 });
    expect([(await row(alive)).status, (await row(done)).status, (await row(stale)).status]).toEqual(["running", "succeeded", "pending"]);
    expect(await events(alive)).toEqual([]);
  });

  it("works every tenant under its own context, and reports the earliest end still ahead", async () => {
    const lostA = await running({ lease: T0 - 1, start: T0 - 1000 });
    const lostB = await running({ account: B, lease: T0 - 1, start: T0 - 1000 });
    await running({ lease: T0 + 30_000, start: T0 - 1000 });
    await running({ account: B, lease: T0 + HOUR, start: T0 - 1000 });
    const result = await sweeper(T0).sweepRunnerLeases();
    expect(result).toMatchObject({ leasesListed: 4, lost: 2, held: 2, nextDueAt: T0 + 30_000 });
    expect([(await row(lostA)).status, (await row(lostB)).status]).toEqual(["failed", "failed"]);
  });

  it("with nothing running reports no due time; after a failure it comes back in five minutes", async () => {
    expect(await sweeper(T0).sweepRunnerLeases()).toMatchObject({ leasesListed: 0, nextDueAt: null });
    const id = await running({ lease: T0 - 1, start: T0 - 1000 });
    const errors: string[] = [];
    // The list works; settling a run does not (no connection for the tenant transaction).
    const half = { query: writerPool.query.bind(writerPool), connect: () => Promise.reject(new Error("connection refused")) } as unknown as Pool;
    const result = await createRunnerLeaseSweeper(half, { now: () => T0, onError: (runId) => errors.push(runId) }).sweepRunnerLeases();
    expect(result).toMatchObject({ leasesListed: 1, leasesFailed: 1, lost: 0, nextDueAt: T0 + 5 * 60_000 });
    expect(errors).toEqual([id]);
    expect((await row(id)).status).toBe("running");
  });

  it("a full batch asks to be run again at once", async () => {
    for (let i = 0; i < RUNNER_LEASE_SWEEP_BATCH; i++) await running({ lease: T0 - 1, start: T0 - 1000 });
    const result = await sweeper(T0).sweepRunnerLeases();
    expect(result).toMatchObject({ leasesListed: RUNNER_LEASE_SWEEP_BATCH, lost: RUNNER_LEASE_SWEEP_BATCH, nextDueAt: T0 });
  });

  it("is idempotent: a second tick finds nothing to do", async () => {
    await running({ lease: T0 - 1, start: T0 - 1000 });
    await sweeper(T0).sweepRunnerLeases();
    expect(await sweeper(T0).sweepRunnerLeases()).toMatchObject({ leasesListed: 0, lost: 0 });
  });

  it("the heartbeat and the sweep agree: a lease the claim facade extends is held, one it does not is lost", async () => {
    const facade = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => T0 });
    const id = await running({ lease: T0 + 1000, start: T0 - 1000 });
    expect(await facade.heartbeatRunnerRun({ accountId: A.accountId, runnerId: runnerA, runId: id, leaseGeneration: 1 })).toMatchObject({ verdict: "ok" });
    expect(await sweeper(T0 + 1000).sweepRunnerLeases()).toMatchObject({ held: 1, lost: 0 });
    expect(await sweeper(T0 + 90_000).sweepRunnerLeases()).toMatchObject({ lost: 1 });
  });

  it("only the run-writer login may list the running runner runs", async () => {
    const app = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    const ops = createPool(process.env.WORKER_DATABASE_URL_PLATFORM_OPS!);
    try {
      await expect(app.query("SELECT * FROM agent_run_list_running_runner_runs(10, 7200000)")).rejects.toThrow(/permission denied/);
      await expect(ops.query("SELECT * FROM agent_run_list_running_runner_runs(10, 7200000)")).rejects.toThrow(/permission denied/);
      await expect(writerPool.query("SELECT * FROM agent_run_list_running_runner_runs(0, 7200000)")).rejects.toThrow(/bad argument/);
    } finally {
      await app.end();
      await ops.end();
    }
  });
});
