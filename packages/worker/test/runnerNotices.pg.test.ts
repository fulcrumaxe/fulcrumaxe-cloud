import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { RUNNER_TTL_REMINDER_MS, RUNNER_WAITING_NOTICE_MS } from "@fx/runner";
import { createRunnerNoticeSweeper } from "../src/runnerNotices.js";

/** [pg] D#6 R2b: the 15 minute `runner.waiting` notice and the 48 hour `runner.ttl_reminder`, on a fake clock. */
describe("runner notices [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  const MIN = 60_000;
  const T0 = Date.parse("2026-10-10T12:00:00Z"); // dispatch
  let clock = T0;
  const sweep = () => createRunnerNoticeSweeper(writerPool, { now: () => clock }).sweepRunnerNotices();

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
  });
  beforeEach(async () => {
    clock = T0;
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND execution_mode = 'runner_local' AND status = 'pending'`);
    await admin.query(`DELETE FROM runners WHERE account_id IN ($1, $2)`, [A.accountId, B.accountId]);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  const repoOf = (accountId: string): string => (accountId === A.accountId ? A.repoId : B.repoId);
  async function waiting(accountId: string, o: { status?: string; repoId?: string; createdAt?: number } = {}): Promise<string> {
    const id = randomUUID();
    const repoId = o.repoId ?? repoOf(accountId);
    // The notice is owed only while the run's repo is still on a runner (C24 section 2's second check).
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [repoId]);
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, created_at) VALUES ($1, $2, 'code-reviewer', 'runner', $3, 'runner_local', $4, to_timestamp($5 / 1000.0))`,
      [id, accountId, o.status ?? "pending", repoId, o.createdAt ?? T0],
    );
    return id;
  }
  /** A second repo of the account, for a run of another repo. */
  async function newRepo(account: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, floor(random() * 2000000000)::bigint + 1, 'team')", [id, account.accountId, account.installationId]);
    return id;
  }
  const kinds = async (id: string): Promise<string[]> =>
    (await admin.query("SELECT kind FROM run_events WHERE run_id = $1 AND kind LIKE 'runner.%' ORDER BY seq", [id])).rows.map((r) => r.kind as string);
  /** A runner heard from `ageMs` ago. It may take the account's own repo unless `repos` says otherwise. */
  async function runnerSeen(accountId: string, userId: string, ageMs: number, repos: string[] = [repoOf(accountId)]): Promise<string> {
    const id = await insertRunner(admin, accountId, userId);
    await admin.query("UPDATE runners SET last_seen_at = to_timestamp($2 / 1000.0), allowed_repo_ids = $3::uuid[] WHERE id = $1", [id, clock - ageMs, repos]);
    return id;
  }

  it("the waiting notice is absent at 14:59 and sent exactly once by the first tick at or after 15:00", async () => {
    expect(RUNNER_WAITING_NOTICE_MS).toBe(15 * MIN);
    const id = await waiting(A.accountId);
    clock = T0 + 15 * MIN - 1000;
    const before = await sweep();
    expect(before).toMatchObject({ listed: 1, waitingEmitted: 0, reminderEmitted: 0, failed: 0, nextDueAt: T0 + 15 * MIN });
    expect(await kinds(id)).toEqual([]);
    clock = T0 + 15 * MIN;
    expect(await sweep()).toMatchObject({ waitingEmitted: 1, reminderEmitted: 0, nextDueAt: T0 + RUNNER_TTL_REMINDER_MS });
    expect(await kinds(id)).toEqual(["runner.waiting"]);
    clock = T0 + 20 * MIN;
    expect(await sweep()).toMatchObject({ waitingEmitted: 0 });
    expect(await kinds(id)).toEqual(["runner.waiting"]);
    const payload = (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'runner.waiting'", [id])).rows[0].payload;
    expect(Object.keys(payload).sort()).toEqual(["repo_id", "waited_since"]);
  });

  it("a pending run whose repo is no longer runner_local gets no notice, at 15 minutes or at 48 hours; the same run on a runner again does", async () => {
    const id = await waiting(A.accountId);
    await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [A.repoId]);
    try {
      clock = T0 + 20 * MIN;
      expect(await sweep()).toMatchObject({ waitingEmitted: 0, reminderEmitted: 0, failed: 0 });
      clock = T0 + 49 * 60 * MIN;
      expect(await sweep()).toMatchObject({ waitingEmitted: 0, reminderEmitted: 0, failed: 0 });
      expect(await kinds(id)).toEqual([]);
    } finally {
      await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
    }
    expect(await sweep()).toMatchObject({ waitingEmitted: 1, reminderEmitted: 1 });
    expect(await kinds(id)).toEqual(["runner.waiting", "runner.ttl_reminder"]);
  });

  it("the 48 hour reminder is absent at 47:59 and sent exactly once at or after 48:00, and sits alongside the earlier notice", async () => {
    expect(RUNNER_TTL_REMINDER_MS).toBe(48 * 60 * MIN);
    const id = await waiting(A.accountId);
    clock = T0 + 48 * 60 * MIN - 1000;
    await sweep();
    expect(await kinds(id)).toEqual(["runner.waiting"]);
    clock = T0 + 48 * 60 * MIN;
    expect(await sweep()).toMatchObject({ waitingEmitted: 0, reminderEmitted: 1, nextDueAt: null });
    clock += 5 * MIN;
    expect(await sweep()).toMatchObject({ reminderEmitted: 0 });
    expect(await kinds(id)).toEqual(["runner.waiting", "runner.ttl_reminder"]);
  });

  it("a runner online holds the waiting notice back, and it is sent once the runner has been quiet for 120 seconds", async () => {
    const id = await waiting(A.accountId);
    clock = T0 + 30 * MIN;
    const runner = await runnerSeen(A.accountId, A.userId, 119_000);
    expect(await sweep()).toMatchObject({ waitingEmitted: 0 });
    expect(await kinds(id)).toEqual([]);
    await admin.query("UPDATE runners SET last_seen_at = to_timestamp($2 / 1000.0) WHERE id = $1", [runner, clock - 121_000]);
    expect(await sweep()).toMatchObject({ waitingEmitted: 1 });
    expect(await kinds(id)).toEqual(["runner.waiting"]);
  });

  // "No runner online" is for the run's repo, as the wait reason says: a live runner counts only if the run's repo is in its own list.
  // An empty list is not "every repo": the claim reads it as no repo (only allowed_roles reads empty as all), so such a runner can
  // never take the run and must not hold the notice back.
  it("a live runner whose repo list leaves out the run's repo does not hold the notice back", async () => {
    const id = await waiting(A.accountId);
    clock = T0 + 16 * MIN;
    await runnerSeen(A.accountId, A.userId, 1000, [randomUUID(), randomUUID()]);
    expect(await sweep()).toMatchObject({ waitingEmitted: 1 });
    expect(await kinds(id)).toEqual(["runner.waiting"]);
  });

  it("a live runner whose repo list includes the run's repo holds the notice back, among other repos", async () => {
    const id = await waiting(A.accountId);
    clock = T0 + 16 * MIN;
    await runnerSeen(A.accountId, A.userId, 1000, [randomUUID(), A.repoId]);
    expect(await sweep()).toMatchObject({ waitingEmitted: 0 });
    expect(await kinds(id)).toEqual([]);
  });

  it("a live runner with an empty repo list takes no repo, so it does not hold the notice back", async () => {
    const id = await waiting(A.accountId);
    clock = T0 + 16 * MIN;
    await runnerSeen(A.accountId, A.userId, 1000, []);
    expect(await sweep()).toMatchObject({ waitingEmitted: 1 });
    expect(await kinds(id)).toEqual(["runner.waiting"]);
  });

  it("the repo that counts is each run's own: a runner for repo A holds back the notice of a run of A and not that of a run of A's other repo", async () => {
    const other = await newRepo(A);
    const mine = await waiting(A.accountId);
    const theirs = await waiting(A.accountId, { repoId: other });
    clock = T0 + 16 * MIN;
    await runnerSeen(A.accountId, A.userId, 1000, [A.repoId]);
    expect(await sweep()).toMatchObject({ waitingEmitted: 1 });
    expect(await kinds(mine)).toEqual([]);
    expect(await kinds(theirs)).toEqual(["runner.waiting"]);
  });

  it("a revoked runner, and another account's runner, do not count as online", async () => {
    const id = await waiting(A.accountId);
    clock = T0 + 16 * MIN;
    const gone = await runnerSeen(A.accountId, A.userId, 1000);
    await admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [gone]);
    await runnerSeen(B.accountId, B.userId, 1000);
    expect(await sweep()).toMatchObject({ waitingEmitted: 1 });
    expect(await kinds(id)).toEqual(["runner.waiting"]);
  });

  it("a run that is no longer waiting gets no notice, and a run that is not a runner run is not looked at", async () => {
    const done = await waiting(A.accountId, { status: "running" });
    const other = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, created_at) VALUES ($1, $2, 'executor', 'production', 'pending', to_timestamp($3 / 1000.0))`, [other, A.accountId, T0]);
    clock = T0 + 60 * MIN;
    expect(await sweep()).toMatchObject({ listed: 0, waitingEmitted: 0, nextDueAt: null });
    expect(await kinds(done)).toEqual([]);
    expect(await kinds(other)).toEqual([]);
  });

  it("overlapping ticks send each notice once", async () => {
    const id = await waiting(A.accountId);
    clock = T0 + 49 * 60 * MIN;
    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect(a.waitingEmitted + b.waitingEmitted).toBe(1);
    expect(a.reminderEmitted + b.reminderEmitted).toBe(1);
    expect(await kinds(id)).toEqual(["runner.waiting", "runner.ttl_reminder"]);
  });

  // Starvation: the list the tick reads must not fill up with runs that owe nothing. A run whose two notices are both written stays
  // pending until its queue time ends, so with enough of them the oldest-N window would hide every newer run.
  it("more than 50 runs with both notices already written do not hide newer runs that owe one", async () => {
    for (let i = 0; i < 52; i++) {
      const done = await waiting(A.accountId, { createdAt: T0 - 60 * MIN * 24 + i * 1000 });
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'runner.waiting', '{}'::jsonb), ($1, $2, 2, 'runner.ttl_reminder', '{}'::jsonb)`, [A.accountId, done]);
    }
    const fresh = [await waiting(B.accountId), await waiting(A.accountId), await waiting(B.accountId)];
    clock = T0 + 20 * MIN;
    const result = await sweep();
    expect(result).toMatchObject({ listed: 3, waitingEmitted: 3, reminderEmitted: 0, failed: 0 });
    for (const id of fresh) expect(await kinds(id)).toEqual(["runner.waiting"]);
  });

  it("with more than 50 runs owing a notice, a tick takes the oldest 50 and asks to be run again at once; the next takes the rest", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) ids.push(await waiting(i % 2 === 0 ? A.accountId : B.accountId, { createdAt: T0 + i * 1000 }));
    clock = T0 + 30 * MIN;
    const first = await sweep();
    expect(first).toMatchObject({ listed: 50, waitingEmitted: 50, failed: 0, nextDueAt: clock });
    for (const id of ids.slice(0, 50)) expect(await kinds(id)).toEqual(["runner.waiting"]);
    for (const id of ids.slice(50)) expect(await kinds(id)).toEqual([]);
    // The 50 that have their 15 minute notice still owe the 48 hour reminder, but it is later than the 5 that are due now.
    const second = await sweep();
    expect(second).toMatchObject({ listed: 50, waitingEmitted: 5, reminderEmitted: 0, failed: 0 });
    for (const id of ids.slice(50)) expect(await kinds(id)).toEqual(["runner.waiting"]);
  });

  it("with nothing waiting it reports no due time", async () => {
    expect(await sweep()).toEqual({ listed: 0, waitingEmitted: 0, reminderEmitted: 0, failed: 0, nextDueAt: null });
  });
});
