import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { createRunnerLeaseFacade, type RunnerLeaseFacade } from "../src/runnerLeases.js";
import { RunActionRefusedError } from "../src/index.js";

/** [pg] failRunnerLeases against the real agent_run_set_status, on a real run-writer login. */
describe("failRunnerLeases [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let facade: RunnerLeaseFacade;
  let A: SeedRefs;
  let B: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    facade = createRunnerLeaseFacade(writerPool);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  const revoke = (runnerId: string) => admin.query("UPDATE runners SET revoked_at = now(), revoked_reason = 'revoked' WHERE id = $1", [runnerId]);
  /** A run on `runnerId`, inserted by the superuser (exempt from the write guard) in any status. */
  async function run(accountId: string, runnerId: string | null, status: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, runner_id) VALUES ($1, $2, 'executor', 'runner', $3, $4)`, [id, accountId, status, runnerId]);
    return id;
  }
  const rows = async (ids: string[]) => (await admin.query("SELECT id, status, updated_at, envelope FROM agent_runs WHERE id = ANY($1) ORDER BY id", [ids])).rows;
  const events = async (runId: string) => (await admin.query("SELECT kind, payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq", [runId])).rows;
  const eventCount = async (accountId: string) => (await admin.query("SELECT count(*)::int AS n FROM run_events WHERE account_id = $1", [accountId])).rows[0].n as number;

  it("moves a revoked runner's running and pending runs to failed and records runner_revoked on each event", async () => {
    const runner = await insertRunner(admin, A.accountId, A.userId);
    await revoke(runner);
    const running = await run(A.accountId, runner, "running");
    const pending = await run(A.accountId, runner, "pending");
    const result = await facade.failRunnerLeases({ accountId: A.accountId, runnerId: runner, reason: "runner_revoked" });
    expect([...result.runIds].sort()).toEqual([running, pending].sort());
    expect(result.complete).toBe(true);
    expect((await rows([running, pending])).map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(await events(running)).toEqual([{ kind: "run.status_changed", payload: { from: "running", to: "failed", failureReason: "runner_revoked" } }]);
    expect(await events(pending)).toEqual([{ kind: "run.status_changed", payload: { from: "pending", to: "failed", failureReason: "runner_revoked" } }]);
    // Doing it again finds nothing to move.
    expect(await facade.failRunnerLeases({ accountId: A.accountId, runnerId: runner, reason: "runner_revoked" })).toEqual({ runIds: [], complete: true });
  });

  it("leaves paused and terminal runs, the same account's other runners and other accounts alone", async () => {
    const runner = await insertRunner(admin, A.accountId, A.userId);
    const otherRunner = await insertRunner(admin, A.accountId, A.userId);
    const foreignRunner = await insertRunner(admin, B.accountId, B.userId);
    await revoke(runner);
    const live = await run(A.accountId, runner, "running");
    const untouched = [
      await run(A.accountId, runner, "paused"),
      await run(A.accountId, runner, "succeeded"),
      await run(A.accountId, runner, "failed"),
      await run(A.accountId, runner, "cancelled"),
      await run(A.accountId, runner, "timed_out"),
      await run(A.accountId, runner, "killed_spend"),
      await run(A.accountId, runner, "refused_spend"),
      await run(A.accountId, otherRunner, "running"),
      await run(A.accountId, null, "running"),
      await run(B.accountId, foreignRunner, "running"),
    ];
    const before = await rows(untouched);
    const eventsBefore = await eventCount(B.accountId);
    expect((await facade.failRunnerLeases({ accountId: A.accountId, runnerId: runner, reason: "runner_revoked" })).runIds).toEqual([live]);
    expect(await rows(untouched)).toEqual(before);
    expect(await eventCount(B.accountId)).toBe(eventsBefore);
  });

  it("refuses another account's runner, naming the wrong account, and changes nothing", async () => {
    const foreignRunner = await insertRunner(admin, B.accountId, B.userId);
    await revoke(foreignRunner);
    const foreignRun = await run(B.accountId, foreignRunner, "running");
    const ownRun = await run(A.accountId, null, "running");
    const before = await rows([foreignRun, ownRun]);
    await expect(facade.failRunnerLeases({ accountId: A.accountId, runnerId: foreignRunner, reason: "runner_revoked" })).rejects.toMatchObject({ name: "RunActionRefusedError", code: "P0002" });
    await expect(facade.failRunnerLeases({ accountId: A.accountId, runnerId: foreignRunner, reason: "runner_revoked" })).rejects.toBeInstanceOf(RunActionRefusedError);
    expect(await rows([foreignRun, ownRun])).toEqual(before);
    // The runner's own account does fail it, so the refusal above was the account check.
    expect((await facade.failRunnerLeases({ accountId: B.accountId, runnerId: foreignRunner, reason: "runner_revoked" })).runIds).toEqual([foreignRun]);
  });

  it("refuses a runner that does not exist", async () => {
    await expect(facade.failRunnerLeases({ accountId: A.accountId, runnerId: randomUUID(), reason: "runner_revoked" })).rejects.toMatchObject({ code: "P0002" });
  });

  it("a revoked runner with no leases succeeds with nothing moved", async () => {
    const runner = await insertRunner(admin, A.accountId, A.userId);
    await revoke(runner);
    expect(await facade.failRunnerLeases({ accountId: A.accountId, runnerId: runner, reason: "runner_revoked" })).toEqual({ runIds: [], complete: true });
  });

  it("refuses a runner that has not been revoked, and moves nothing", async () => {
    const runner = await insertRunner(admin, A.accountId, A.userId);
    const live = await run(A.accountId, runner, "running");
    const before = await rows([live]);
    await expect(facade.failRunnerLeases({ accountId: A.accountId, runnerId: runner, reason: "runner_revoked" })).rejects.toMatchObject({ code: "55000" });
    expect(await rows([live])).toEqual(before);
  });

  it("works through more than one page of leases", async () => {
    const runner = await insertRunner(admin, A.accountId, A.userId);
    await revoke(runner);
    const ids: string[] = [];
    for (let i = 0; i < 105; i++) ids.push(await run(A.accountId, runner, i % 2 === 0 ? "running" : "pending"));
    const result = await facade.failRunnerLeases({ accountId: A.accountId, runnerId: runner, reason: "runner_revoked" });
    expect(result.runIds).toHaveLength(105);
    expect(result.complete).toBe(true);
    expect((await rows(ids)).every((r) => r.status === "failed")).toBe(true);
  });
});
