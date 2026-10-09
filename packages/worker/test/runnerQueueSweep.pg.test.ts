import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { RUNNER_QUEUE_TTL_MS } from "@fx/runner";
import { RUNNER_QUEUE_SWEEP_BATCH, createRunnerQueueSweeper, type RunnerQueueSweepDeps } from "../src/runnerQueueSweep.js";

/**
 * [pg] D#6 R2b: the runner queue sweep against the real lister (0734), the real compare-and-set writer and a real
 * run-writer login. The clock is injected, so the 72 hours are fixed instants and nothing waits.
 */
describe("runner queue sweep [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  const HOUR = 3_600_000;
  const NOW = Date.parse("2026-10-10T12:00:00Z");
  const sweeper = (over: RunnerQueueSweepDeps = {}, pool: Pool = writerPool) => createRunnerQueueSweeper(pool, { now: () => NOW, ...over });

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
  });
  beforeEach(async () => {
    // Other files of this package leave waiting runner runs in the shared database; the sweep is cross-tenant, so clear them.
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND execution_mode IN ('runner_local', 'runner_verified') AND status = 'pending'`);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  /** A waiting runner run. `expiresAt` is the job's expires_at; null means no job was ever written. */
  async function waiting(accountId: string, o: { expiresAt: number | null; createdAt?: number; status?: string; runtime?: string; mode?: string | null }): Promise<string> {
    const id = randomUUID();
    const job = o.expiresAt === null ? null : JSON.stringify({ job: { expires_at: new Date(o.expiresAt).toISOString() }, signature: "x" });
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, job_signed, created_at)
       VALUES ($1, $2, 'code-reviewer', $3, $4, $5, $6::jsonb, to_timestamp($7 / 1000.0))`,
      [id, accountId, o.runtime ?? "runner", o.status ?? "pending", o.mode === undefined ? "runner_local" : o.mode, job, o.createdAt ?? NOW - 80 * HOUR],
    );
    return id;
  }
  const status = async (id: string): Promise<string> => (await admin.query("SELECT status FROM agent_runs WHERE id = $1", [id])).rows[0].status as string;
  const events = async (id: string) => (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq", [id])).rows.map((r) => r.payload);

  it("times out a run whose job has expired, with queue_ttl on its status event, and leaves one still inside its queue time", async () => {
    const expired = await waiting(A.accountId, { expiresAt: NOW - 1000 });
    const exactly = await waiting(A.accountId, { expiresAt: NOW });
    const young = await waiting(A.accountId, { expiresAt: NOW + 5 * HOUR, createdAt: NOW - 67 * HOUR });
    const result = await sweeper().sweepRunnerQueue();
    expect(result).toEqual({ listed: 3, expired: 2, cancelled: 0, waiting: 1, skipped: 0, failed: 0, nextDueAt: NOW + 5 * HOUR });
    expect(await status(expired)).toBe("timed_out");
    expect(await status(exactly)).toBe("timed_out");
    expect(await status(young)).toBe("pending");
    expect(await events(expired)).toEqual([{ from: "pending", to: "timed_out", failureReason: "queue_ttl" }]);
    expect(await events(young)).toEqual([]);
  });

  it("is not before: a run is still waiting 1 ms before its job's expires_at and expired at it", async () => {
    const early = await waiting(A.accountId, { expiresAt: NOW + 1 });
    const result = await sweeper().sweepRunnerQueue();
    expect(result).toMatchObject({ listed: 1, expired: 0, waiting: 1, nextDueAt: NOW + 1 });
    expect(await status(early)).toBe("pending");
    expect(await sweeper({ now: () => NOW + 1 }).sweepRunnerQueue()).toMatchObject({ expired: 1 });
    expect(await status(early)).toBe("timed_out");
  });

  it("reads the expiry from the job, not from the creation time: a job issued later keeps the run waiting past created_at plus 72 hours", async () => {
    const created = NOW - 73 * HOUR; // created_at + 72h has passed...
    const run = await waiting(A.accountId, { expiresAt: NOW + 2 * HOUR, createdAt: created }); // ...but the job expires in two hours
    const result = await sweeper().sweepRunnerQueue();
    expect(result).toMatchObject({ listed: 1, expired: 0, waiting: 1, nextDueAt: NOW + 2 * HOUR });
    expect(await status(run)).toBe("pending");
  });

  it("a run with no job yet falls back to its creation time plus the queue time", async () => {
    expect(RUNNER_QUEUE_TTL_MS).toBe(72 * HOUR);
    const stale = await waiting(A.accountId, { expiresAt: null, createdAt: NOW - 73 * HOUR });
    const fresh = await waiting(A.accountId, { expiresAt: null, createdAt: NOW - 70 * HOUR });
    const result = await sweeper().sweepRunnerQueue();
    expect(result).toEqual({ listed: 2, expired: 1, cancelled: 0, waiting: 1, skipped: 0, failed: 0, nextDueAt: NOW - 70 * HOUR + RUNNER_QUEUE_TTL_MS });
    expect(await status(stale)).toBe("timed_out");
    expect(await status(fresh)).toBe("pending");
  });

  it("works across tenants, each run under its own account", async () => {
    const a = await waiting(A.accountId, { expiresAt: NOW - HOUR });
    const b = await waiting(B.accountId, { expiresAt: NOW - HOUR });
    expect(await sweeper().sweepRunnerQueue()).toMatchObject({ listed: 2, expired: 2 });
    expect([await status(a), await status(b)]).toEqual(["timed_out", "timed_out"]);
  });

  it("touches only waiting runner_local runs: not a claimed run, a sandbox run, a finished run or a run in another mode", async () => {
    const claimed = await waiting(A.accountId, { expiresAt: NOW - HOUR, status: "running" });
    const sandbox = await waiting(A.accountId, { expiresAt: NOW - HOUR, runtime: "production", mode: "sandbox" });
    const unmoded = await waiting(A.accountId, { expiresAt: NOW - HOUR, mode: null });
    const done = await waiting(A.accountId, { expiresAt: NOW - HOUR, status: "succeeded" });
    const paused = await waiting(A.accountId, { expiresAt: NOW - HOUR, status: "paused" });
    expect(await sweeper().sweepRunnerQueue()).toEqual({ listed: 0, expired: 0, cancelled: 0, waiting: 0, skipped: 0, failed: 0, nextDueAt: null });
    expect([claimed, sandbox, unmoded, done, paused].length).toBe(5);
    expect([await status(claimed), await status(sandbox), await status(unmoded), await status(done), await status(paused)]).toEqual(["running", "pending", "pending", "succeeded", "paused"]);
  });

  it("is idempotent: a second tick finds nothing and records no second event", async () => {
    const run = await waiting(A.accountId, { expiresAt: NOW - HOUR });
    await sweeper().sweepRunnerQueue();
    expect(await sweeper().sweepRunnerQueue()).toEqual({ listed: 0, expired: 0, cancelled: 0, waiting: 0, skipped: 0, failed: 0, nextDueAt: null });
    expect(await events(run)).toHaveLength(1);
  });

  it("leaves a run a runner claimed between the list and the write, counting it as skipped", async () => {
    const run = await waiting(A.accountId, { expiresAt: NOW - HOUR });
    // The list is read, then the run is claimed before this tick looks at it again.
    const racing = new Proxy(writerPool, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return async (...args: unknown[]) => {
          const out = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
          if (typeof args[0] === "string" && args[0].includes("agent_run_list_pending_runner_runs")) await admin.query(`UPDATE agent_runs SET status = 'running' WHERE id = $1`, [run]);
          return out;
        };
      },
    });
    expect(await sweeper({}, racing).sweepRunnerQueue()).toMatchObject({ listed: 1, expired: 0, skipped: 1 });
    expect(await status(run)).toBe("running");
  });

  it("a full batch takes the oldest first and asks for another tick at once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < RUNNER_QUEUE_SWEEP_BATCH + 1; i++) ids.push(await waiting(A.accountId, { expiresAt: NOW - HOUR, createdAt: NOW - 100 * HOUR + i * 1000 }));
    const first = await sweeper().sweepRunnerQueue();
    expect(first).toMatchObject({ listed: RUNNER_QUEUE_SWEEP_BATCH, expired: RUNNER_QUEUE_SWEEP_BATCH, nextDueAt: NOW });
    expect(await status(ids[RUNNER_QUEUE_SWEEP_BATCH]!)).toBe("pending"); // the newest is left for the next tick
    expect(await sweeper().sweepRunnerQueue()).toMatchObject({ listed: 1, expired: 1, nextDueAt: null });
    expect(await status(ids[RUNNER_QUEUE_SWEEP_BATCH]!)).toBe("timed_out");
  });

  it("a failure on one run is reported and does not stop the others; the tick asks to be run again after the retry delay", async () => {
    const [first, second, third] = [
      await waiting(A.accountId, { expiresAt: NOW - HOUR, createdAt: NOW - 100 * HOUR }),
      await waiting(A.accountId, { expiresAt: NOW - HOUR, createdAt: NOW - 99 * HOUR }),
      await waiting(A.accountId, { expiresAt: NOW - HOUR, createdAt: NOW - 98 * HOUR }),
    ];
    let connects = 0;
    const flaky = new Proxy(writerPool, {
      get(target, prop, receiver) {
        if (prop !== "connect") return Reflect.get(target, prop, receiver);
        // Per run the sweep connects twice, promise style (the read, then the write); the lister's own query uses the callback
        // form inside pg and passes through. The third promise-style connection is the second run's read.
        return (...args: unknown[]) => {
          if (args.length > 0) return (target.connect as (...a: unknown[]) => unknown)(...args);
          if (++connects === 3) return Promise.reject(new Error("connection lost"));
          return target.connect();
        };
      },
    });
    const errors: string[] = [];
    const result = await sweeper({ retryDelayMs: 90_000, onError: (runId) => errors.push(runId) }, flaky).sweepRunnerQueue();
    expect(result).toEqual({ listed: 3, expired: 2, cancelled: 0, waiting: 0, skipped: 0, failed: 1, nextDueAt: NOW + 90_000 });
    expect(errors).toEqual([second]);
    expect([await status(first), await status(second), await status(third)]).toEqual(["timed_out", "pending", "timed_out"]);
  });

  it("is refused by the lister for app_user and for a direct platform_ops login, which cannot read the job", async () => {
    const appUser = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    const ops = createPool(process.env.WORKER_DATABASE_URL_PLATFORM_OPS!);
    try {
      for (const pool of [appUser, ops]) {
        await expect(pool.query("SELECT * FROM agent_run_list_pending_runner_runs(10)")).rejects.toMatchObject({ code: "42501" });
      }
      await expect(ops.query("SELECT job_signed FROM agent_runs LIMIT 1")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await Promise.all([appUser.end(), ops.end()]);
    }
  });

  describe("race backstop (C24 section 2): a pending runner run whose repo left runner_local", () => {
    async function inRepo(accountId: string, repoId: string | null, createdAt: number, mode = "runner_local"): Promise<string> {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, created_at)
         VALUES ($1, $2, 'code-reviewer', 'runner', 'pending', $5, $3, to_timestamp($4 / 1000.0))`,
        [id, accountId, repoId, createdAt, mode],
      );
      return id;
    }
    it("cancels it on the next tick whatever its age, with execution_mode_changed; runs of a repo still on a runner, and a run with no repo, are left alone", async () => {
      await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
      await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [B.repoId]);
      try {
        const late = await inRepo(B.accountId, B.repoId, NOW - 60_000); // inserted a minute ago, after the switch
        const old = await inRepo(B.accountId, B.repoId, NOW - 70 * HOUR);
        const stays = await inRepo(A.accountId, A.repoId, NOW - 60_000);
        const noRepo = await inRepo(A.accountId, null, NOW - 60_000);
        const result = await sweeper().sweepRunnerQueue();
        expect(result).toMatchObject({ listed: 4, expired: 0, cancelled: 2, waiting: 2, failed: 0 });
        for (const r of [late, old]) {
          expect(await status(r)).toBe("cancelled");
          expect(await events(r)).toEqual([{ from: "pending", to: "cancelled", failureReason: "execution_mode_changed" }]);
        }
        expect(await status(stays)).toBe("pending");
        expect(await status(noRepo)).toBe("pending");
        expect(await sweeper().sweepRunnerQueue()).toMatchObject({ cancelled: 0 });
      } finally {
        await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [B.repoId]);
      }
    });

    // D#6 R5b-1 (C26 section 3, C38): the backstop acts only when the repo's new mode is not a runner mode.
    it("a verified run is cancelled when its repo is on sandbox, and is NOT cancelled on a verified or a runner_local repo (a move between the runner modes cancels nothing)", async () => {
      try {
        await admin.query("UPDATE repos SET execution_mode = 'runner_verified' WHERE id = $1", [A.repoId]);
        await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [B.repoId]);
        const onVerified = await inRepo(A.accountId, A.repoId, NOW - 70 * HOUR, "runner_verified");
        const toSandbox = await inRepo(B.accountId, B.repoId, NOW - 60_000, "runner_verified");
        expect(await sweeper().sweepRunnerQueue()).toMatchObject({ listed: 2, cancelled: 1, waiting: 1 });
        expect(await status(toSandbox)).toBe("cancelled");
        expect(await events(toSandbox)).toEqual([{ from: "pending", to: "cancelled", failureReason: "execution_mode_changed" }]);
        expect(await status(onVerified)).toBe("pending");
        await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
        expect(await sweeper().sweepRunnerQueue()).toMatchObject({ listed: 1, cancelled: 0 });
        expect(await status(onVerified)).toBe("pending");
      } finally {
        await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id IN ($1, $2)", [A.repoId, B.repoId]);
      }
    });
  });
});
