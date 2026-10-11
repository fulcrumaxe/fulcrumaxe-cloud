import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Text, signJob, type ClaimCapacity, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "../src/runnerClaims.js";
import { accountCeiling, hostedLimitsFromPlanData, type HostedLimitsSource } from "../src/runnerAccountCeiling.js";

/**
 * [pg] D#605 FL-12a: the claim's account ceiling by plan. A hosted plan runs the account's setting (the plan data's defaults until an owner
 * or admin accepts a figure) under the capacity of the runners that are online and not holding back their claims; the runner plan runs its
 * flat plan figure whatever its runners declare. Plan data that cannot give a hosted account its figures hands out nothing. The hosted
 * defaults here are the public fixture's (4 per account, 2 per repository), the figures the Spec names.
 */
describe("the account ceiling by plan [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const key = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let A: SeedRefs;
  let repos: string[];
  let seq = 0;

  const flat = { maxConcurrentRunnerJobs: 16, maxConcurrentHeavyRunnerJobs: 8, maxRunWallClockMs: 7_200_000 };
  const make = (over: { hostedLimits?: HostedLimitsSource } = {}): RunnerClaimFacade =>
    createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => T0, randomBetween: (min) => min, limits: () => flat, ...over });
  const eight: ClaimCapacity = { light: { limit: 4, in_use: 0 }, heavy: { limit: 4, in_use: 0 } };

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });
  beforeEach(async () => {
    A = await seedAccount(admin, randomUUID());
    repos = [A.repoId];
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      await admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, execution_mode) VALUES ($1, $2, $3, $4, 'team', 'runner_local')", [id, A.accountId, A.installationId, 9100 + i]);
      repos.push(id);
    }
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
  });

  /** A runner of this account that has declared a capacity of 8 (4 light, 4 heavy) and was heard from at T0, unless told otherwise. */
  async function newRunner(over: { declared?: [number, number]; seenMsAgo?: number | null; pausedUntilMs?: number } = {}): Promise<string> {
    const id = await insertRunner(admin, A.accountId, A.userId, { credentialMode: "api_key", keepPlan: true });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = $3::text[], last_seen_at = $4 WHERE id = $1", [id, repos, ["executor", "code-reviewer"], over.seenMsAgo === null ? null : new Date(T0 - (over.seenMsAgo ?? 0))]);
    const [light, heavy] = over.declared ?? [4, 4];
    await admin.query("INSERT INTO runner_capacity (runner_id, account_id, declared, light_limit, heavy_limit, claim_paused_until) VALUES ($1, $2, true, $3, $4, $5)", [id, A.accountId, light, heavy, over.pausedUntilMs === undefined ? null : new Date(over.pausedUntilMs)]);
    return id;
  }
  async function pending(repoId: string, light: boolean): Promise<string> {
    const id = randomUUID();
    const role = light ? "code-reviewer" : "executor";
    const job: Job = {
      schema_version: 1, job_id: randomUUID(), run_id: id, repo: { id: repoId, owner: "acme", name: "app", private: true }, role, mode: "local", spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") }, role_card: { text: "c", sha256: sha256Text("c") }, role_tools_sha256: "a".repeat(64),
      continues: null, branch_prefix: "fx/", model_hint: null, issued_at: new Date(T0 - 1000).toISOString(), expires_at: new Date(T0 + 72 * 3_600_000).toISOString(), key_id: "k1",
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, created_at)
       VALUES ($1, $2, $3, 'runner', 'pending', 'runner_local', $4, $5::jsonb, $6, to_timestamp($7 / 1000.0))`,
      [id, A.accountId, role, repoId, JSON.stringify(signJob(job, key)), A.userId, T0 - 100_000 + seq++],
    );
    return id;
  }
  /** The runners claim in turn until none gets anything; how many runs are running and where. */
  async function drain(f: RunnerClaimFacade, runners: string[], capacity: ClaimCapacity = eight): Promise<{ running: number; heavy: number; perRepo: Map<string, number> }> {
    for (let round = 0; round < 40; round++) {
      let any = false;
      for (const runnerId of runners) {
        if ((await f.claimRunnerRun({ accountId: A.accountId, runnerId, capacity })).kind === "claimed") any = true;
      }
      if (!any) break;
    }
    const rows = (await admin.query<{ role: string; dispatch_repo_id: string }>("SELECT role, dispatch_repo_id FROM agent_runs WHERE account_id = $1 AND runtime = 'runner' AND status = 'running'", [A.accountId])).rows;
    const perRepo = new Map<string, number>();
    for (const r of rows) perRepo.set(r.dispatch_repo_id, (perRepo.get(r.dispatch_repo_id) ?? 0) + 1);
    return { running: rows.length, heavy: rows.filter((r) => r.role === "executor").length, perRepo };
  }
  const setting = (total: number, perRepo: number) =>
    admin.query("INSERT INTO account_runner_concurrency (account_id, total_jobs, per_repo_jobs, updated_by) VALUES ($1, $2, $3, $4)", [A.accountId, total, perRepo, A.userId]);
  const fill = async (perRepo: number): Promise<void> => {
    for (const repoId of repos) for (let i = 0; i < perRepo; i++) await pending(repoId, i % 2 === 0);
  };

  describe("a hosted plan", () => {
    it("with the default setting and two online runners of capacity 8, never has more than 4 running, nor more than 2 on one repository", async () => {
      const runners = [await newRunner(), await newRunner()];
      await fill(6);
      const result = await drain(make(), runners);
      expect(result.running).toBe(4);
      for (const n of result.perRepo.values()) expect(n).toBeLessThanOrEqual(2);
    });

    it("keeps to 2 on one repository when all the work is on it, however many runners ask", async () => {
      const runners = [await newRunner(), await newRunner()];
      for (let i = 0; i < 8; i++) await pending(repos[0]!, true);
      const result = await drain(make(), runners);
      expect(result.running).toBe(2);
    });

    it("adding a runner does not raise the ceiling", async () => {
      const first = await newRunner();
      await fill(6);
      const f = make();
      expect((await drain(f, [first])).running).toBe(4);
      const more = [await newRunner(), await newRunner()];
      expect((await drain(f, [first, ...more])).running).toBe(4);
    });

    it("after an accepted raise to 12 it has up to 12; with one runner paused, up to the other's 8; with it offline, the same", async () => {
      await setting(12, 12);
      const a = await newRunner();
      const b = await newRunner();
      await fill(6);
      expect((await drain(make(), [a, b])).running).toBe(12);

      await admin.query("DELETE FROM agent_runs WHERE account_id = $1", [A.accountId]);
      await admin.query("UPDATE runner_capacity SET claim_paused_until = $2 WHERE runner_id = $1", [b, new Date(T0 + 3_600_000)]);
      await fill(6);
      expect((await drain(make(), [a])).running).toBe(8);

      await admin.query("DELETE FROM agent_runs WHERE account_id = $1", [A.accountId]);
      await admin.query("UPDATE runner_capacity SET claim_paused_until = NULL WHERE runner_id = $1", [b]);
      await admin.query("UPDATE runners SET last_seen_at = $2 WHERE id = $1", [b, new Date(T0 - 10 * 60_000)]);
      await fill(6);
      expect((await drain(make(), [a])).running).toBe(8);
    });

    it("never exceeds what its live runners can hold, even when the setting is higher: one runner of capacity 2 under a default of 4", async () => {
      const small = await newRunner({ declared: [1, 1] });
      await fill(6);
      expect((await drain(make(), [small])).running).toBe(2);
    });

    it("a revoked runner adds nothing; a runner that has declared nothing counts as 1", async () => {
      await setting(12, 12);
      const live = await newRunner({ declared: [4, 4] });
      const gone = await newRunner();
      await admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [gone]);
      const undeclared = await insertRunner(admin, A.accountId, A.userId, { credentialMode: "api_key", keepPlan: true });
      await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = $3::text[], last_seen_at = $4 WHERE id = $1", [undeclared, repos, ["executor", "code-reviewer"], new Date(T0)]);
      await fill(6);
      // 8 from the live runner plus 1 for the undeclared one.
      expect((await drain(make(), [live, undeclared])).running).toBe(9);
    });

    it("a deep backlog on a full repository does not starve the others: 10 pending on A and 2 on B end with 4 running", async () => {
      const runners = [await newRunner(), await newRunner()];
      for (let i = 0; i < 10; i++) await pending(repos[0]!, true);
      for (let i = 0; i < 2; i++) await pending(repos[1]!, true);
      const result = await drain(make(), runners);
      expect(result.running).toBe(4);
      expect(result.perRepo.get(repos[0]!)).toBe(2);
      expect(result.perRepo.get(repos[1]!)).toBe(2);
    });

    it("counts a runner that declares 8 light and 4 heavy as 8 in all, however high the setting is (the ceiling itself, not the runner's own cap)", async () => {
      await setting(20, 20);
      const wide = await newRunner({ declared: [8, 4] });
      const ceiling = await accountCeiling(admin, { accountId: A.accountId, claimingRunnerId: wide, nowMs: T0, runnerPlan: flat, hosted: hostedLimitsFromPlanData });
      expect(ceiling).toEqual({ total: 8, heavy: 8, perRepo: 8 });
      const second = await newRunner({ declared: [8, 4] });
      expect((await accountCeiling(admin, { accountId: A.accountId, claimingRunnerId: second, nowMs: T0, runnerPlan: flat, hosted: hostedLimitsFromPlanData })).total).toBe(16);
    });

    it("hands out nothing when the plan data cannot give the account its figures, or does not know its plan", async () => {
      const runner = await newRunner();
      await fill(3);
      const broken = make({ hostedLimits: () => { throw new Error("no figures"); } });
      expect((await drain(broken, [runner])).running).toBe(0);
      await admin.query("UPDATE accounts SET plan = 'mystery' WHERE id = $1", [A.accountId]);
      expect((await drain(make(), [runner])).running).toBe(0);
    });
  });

  describe("the runner plan", () => {
    it("with two online runners of capacity 8 has up to 16 running, of which up to 8 heavy, whatever the hosted setting says", async () => {
      await admin.query("UPDATE accounts SET plan = 'runner' WHERE id = $1", [A.accountId]);
      await setting(2, 1);
      const runners = [await newRunner(), await newRunner()];
      for (let i = 0; i < 12; i++) await pending(repos[i % 3]!, false);
      for (let i = 0; i < 12; i++) await pending(repos[i % 3]!, true);
      const result = await drain(make(), runners);
      expect(result.running).toBe(16);
      expect(result.heavy).toBe(8);
    });

    it("is held to its flat figure when its runners declare more than the figure between them", async () => {
      await admin.query("UPDATE accounts SET plan = 'runner' WHERE id = $1", [A.accountId]);
      const runners = [await newRunner(), await newRunner(), await newRunner(), await newRunner(), await newRunner()];
      for (let i = 0; i < 30; i++) await pending(repos[i % 3]!, true);
      expect((await drain(make(), runners)).running).toBe(16);
    });
  });
});
