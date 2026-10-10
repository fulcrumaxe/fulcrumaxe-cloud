import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNNER_MAX_RUN_WALL_CLOCK_MS, sha256Text, signJob, type ClaimCapacity, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { resetPlanDataCache } from "@fx/plan-data";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "../src/runnerClaims.js";
import { resetHeavyFigureWarning, runnerLimits } from "../src/runnerLimits.js";

/**
 * [pg] D#6 C43-2b: the per-runner and per-class caps on the claim, taken from the capacity a runner declares, under the account's own caps
 * (total 4, heavy 1 here), against the real definers and a real run-writer login.
 */
describe("claim caps from the runner's declared capacity [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const key = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let A: SeedRefs;
  let facade: RunnerClaimFacade;
  let seq = 0;

  const caps = { maxConcurrentRunnerJobs: 4, maxConcurrentHeavyRunnerJobs: 1, maxRunWallClockMs: 7_200_000 };
  const make = (limits: () => typeof caps): RunnerClaimFacade => createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => T0, randomBetween: (min) => min, limits });

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    facade = make(() => caps);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });
  beforeEach(async () => {
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
  });

  async function newRunner(): Promise<string> {
    const id = await insertRunner(admin, A.accountId, A.userId, { credentialMode: "api_key" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = $3::text[] WHERE id = $1", [id, [A.repoId], ["executor", "code-reviewer"]]);
    return id;
  }
  /** A pending runner run with a real signed job; `light` is a code-reviewer run, else an executor run. Older runs are handed out first. */
  async function pending(light: boolean): Promise<string> {
    const id = randomUUID();
    const role = light ? "code-reviewer" : "executor";
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: A.repoId, owner: "acme", name: "app", private: true },
      role,
      mode: "local",
      spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") },
      role_card: { text: "c", sha256: sha256Text("c") },
      role_tools_sha256: "a".repeat(64),
      continues: null,
      branch_prefix: "fx/",
      model_hint: null,
      issued_at: new Date(T0 - 1000).toISOString(),
      expires_at: new Date(T0 + 72 * 3_600_000).toISOString(),
      key_id: "k1",
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, created_at)
       VALUES ($1, $2, $3, 'runner', 'pending', 'runner_local', $4, $5::jsonb, $6, to_timestamp($7 / 1000.0))`,
      [id, A.accountId, role, A.repoId, JSON.stringify(signJob(job, key)), A.userId, T0 - 100_000 + seq++],
    );
    return id;
  }
  const cap = (light: [number, number], heavy: [number, number]): ClaimCapacity => ({ light: { limit: light[0], in_use: light[1] }, heavy: { limit: heavy[0], in_use: heavy[1] } });
  const claim = (runnerId: string, capacity?: ClaimCapacity, f = facade) => f.claimRunnerRun({ accountId: A.accountId, runnerId, ...(capacity ? { capacity } : {}) });
  const held = async (runnerId: string) =>
    (await admin.query<{ role: string }>("SELECT role FROM agent_runs WHERE runner_id = $1 AND status = 'running'", [runnerId])).rows.map((r) => r.role).sort();
  const claimedRole = async (r: Awaited<ReturnType<typeof claim>>): Promise<string | null> =>
    r.kind === "claimed" ? (await admin.query<{ role: string }>("SELECT role FROM agent_runs WHERE id = $1", [r.runId])).rows[0]!.role : null;

  it("with an account total of 4 and heavy 1, a runner declaring light 3 and heavy 1 holds 3 light and 1 heavy; a 5th claim and a 2nd heavy get nothing", async () => {
    const runner = await newRunner();
    for (let i = 0; i < 3; i++) await pending(true);
    await pending(false);
    await pending(true); // a fourth light run, and a second heavy one
    await pending(false);
    // The runner declares what it holds on each claim, as the real one does.
    const roles: Array<string | null> = [];
    let light = 0;
    let heavy = 0;
    for (let i = 0; i < 4; i++) {
      const role = await claimedRole(await claim(runner, cap([3, light], [1, heavy])));
      roles.push(role);
      if (role === "code-reviewer") light++;
      if (role === "executor") heavy++;
    }
    expect(roles.filter((r) => r === "code-reviewer")).toHaveLength(3);
    expect(roles.filter((r) => r === "executor")).toHaveLength(1);
    expect(await held(runner)).toEqual(["code-reviewer", "code-reviewer", "code-reviewer", "executor"]);
    // A fifth claim: the runner is full in both classes, and the account is at its total.
    expect((await claim(runner, cap([3, 3], [1, 1]))).kind).toBe("idle");
    expect(await held(runner)).toHaveLength(4);
  });

  it("the account's heavy cap leaves a second heavy run unclaimed while light runs still go out", async () => {
    const roomy = cap([3, 0], [4, 0]);
    const first = await newRunner();
    const second = await newRunner();
    await pending(false);
    await pending(false);
    const lightRun = await pending(true);
    expect(await claimedRole(await claim(first, roomy))).toBe("executor");
    // The older pending run is heavy and the account is at its heavy cap, so the claim passes it over and takes the light one.
    const next = await claim(second, roomy);
    expect(next).toMatchObject({ kind: "claimed", runId: lightRun });
    expect(await held(second)).toEqual(["code-reviewer"]);
  });

  it("a runner declaring heavy 0 is never given a heavy run, and one declaring light 0 never a light one", async () => {
    const lightOnly = await newRunner();
    const heavyOnly = await newRunner();
    const h = await pending(false);
    const l = await pending(true);
    expect(await claim(lightOnly, cap([2, 0], [0, 0]))).toMatchObject({ kind: "claimed", runId: l });
    expect(await claim(lightOnly, cap([2, 1], [0, 0]))).toMatchObject({ kind: "idle" });
    expect(await claim(heavyOnly, cap([0, 0], [1, 0]))).toMatchObject({ kind: "claimed", runId: h });
  });

  it("free slots are limit minus in_use, never below zero: a runner whose limit fell below what it holds is given nothing", async () => {
    const runner = await newRunner();
    await pending(true);
    expect((await claim(runner, cap([1, 3], [1, 0]))).kind).toBe("idle");
    expect((await claim(runner, cap([0, 0], [0, 0]))).kind).toBe("idle");
    expect((await claim(runner, cap([1, 0], [0, 0]))).kind).toBe("claimed");
  });

  it("counts what it holds from the rows as well as from what the runner says, so a runner behind on its in_use opens no slot", async () => {
    const runner = await newRunner();
    await pending(true);
    await pending(true);
    expect((await claim(runner, cap([1, 0], [0, 0]))).kind).toBe("claimed");
    // The runner still says in_use 0 for light; the cloud counts one running light run against a limit of one.
    expect((await claim(runner, cap([1, 0], [0, 0]))).kind).toBe("idle");
    // And the other way round: it says it holds one that the cloud does not count.
    const other = await newRunner();
    expect((await claim(other, cap([1, 1], [0, 0]))).kind).toBe("idle");
  });

  it("holds the runner to the total ceiling of 8 even when its class limits add up to more", async () => {
    const big = make(() => ({ maxConcurrentRunnerJobs: 20, maxConcurrentHeavyRunnerJobs: 20, maxRunWallClockMs: 7_200_000 }));
    const runner = await newRunner();
    for (let i = 0; i < 10; i++) await pending(i % 2 === 0);
    for (let i = 0; i < 10; i++) await claim(runner, cap([8, 0], [4, 0]), big);
    expect(await held(runner)).toHaveLength(8);
    expect((await held(runner)).filter((r) => r === "executor").length).toBeLessThanOrEqual(4);
  });

  it("a claim without capacity behaves as today: one run in total, in any class, while another runner can still take work", async () => {
    const old = await newRunner();
    const other = await newRunner();
    await pending(false);
    await pending(true);
    await pending(true);
    expect((await claim(old)).kind).toBe("claimed");
    expect((await claim(old)).kind).toBe("idle");
    expect((await claim(other)).kind).toBe("claimed");
    expect(await held(old)).toHaveLength(1);
  });

  it("two runners share the account caps: 8 claims made at once never exceed a total of 4 or a heavy count of 1", async () => {
    const runners: string[] = [];
    for (let i = 0; i < 8; i++) runners.push(await newRunner());
    for (let i = 0; i < 5; i++) await pending(true);
    for (let i = 0; i < 3; i++) await pending(false);
    const results = await Promise.all(runners.map((r) => claim(r, cap([3, 0], [1, 0]))));
    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(4);
    const running = await admin.query<{ role: string }>("SELECT role FROM agent_runs WHERE account_id = $1 AND runtime = 'runner' AND status = 'running'", [A.accountId]);
    expect(running.rows).toHaveLength(4);
    expect(running.rows.filter((r) => r.role === "executor").length).toBeLessThanOrEqual(1);
  });

  it("8 parallel claims from one runner never take it past its own class limits", async () => {
    const wide = make(() => ({ maxConcurrentRunnerJobs: 8, maxConcurrentHeavyRunnerJobs: 4, maxRunWallClockMs: 7_200_000 }));
    const runner = await newRunner();
    for (let i = 0; i < 8; i++) await pending(i < 5);
    await Promise.all(Array.from({ length: 8 }, () => claim(runner, cap([2, 0], [1, 0]), wide)));
    const roles = await held(runner);
    expect(roles.filter((r) => r === "code-reviewer").length).toBeLessThanOrEqual(2);
    expect(roles.filter((r) => r === "executor").length).toBeLessThanOrEqual(1);
  });

  describe("the account's heavy figure", () => {
    const saved = process.env.FX_PLAN_DATA;
    afterEach(() => {
      if (saved === undefined) delete process.env.FX_PLAN_DATA;
      else process.env.FX_PLAN_DATA = saved;
      resetPlanDataCache();
      resetHeavyFigureWarning();
      vi.restoreAllMocks();
    });
    it("missing from the plan data fails closed to 1, and is said once", () => {
      const data = JSON.parse(saved!);
      delete data.runnerPlan.limits.maxConcurrentHeavyRunnerJobs;
      process.env.FX_PLAN_DATA = JSON.stringify(data);
      resetPlanDataCache();
      resetHeavyFigureWarning();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(runnerLimits(A.accountId)).toEqual({ maxConcurrentRunnerJobs: data.runnerPlan.limits.maxConcurrentRunnerJobs, maxConcurrentHeavyRunnerJobs: 1, maxRunWallClockMs: data.runnerPlan.limits.maxRunWallClockMs });
      runnerLimits(A.accountId);
      expect(warn).toHaveBeenCalledTimes(1);
    });
    it("present in the plan data, it is followed; missing plan data still hands out nothing", () => {
      const data = JSON.parse(saved!);
      data.runnerPlan.limits.maxConcurrentHeavyRunnerJobs = 2;
      process.env.FX_PLAN_DATA = JSON.stringify(data);
      resetPlanDataCache();
      expect(runnerLimits(A.accountId).maxConcurrentHeavyRunnerJobs).toBe(2);
      delete process.env.FX_PLAN_DATA;
      resetPlanDataCache();
      expect(runnerLimits(A.accountId)).toEqual({ maxConcurrentRunnerJobs: 0, maxConcurrentHeavyRunnerJobs: 0, maxRunWallClockMs: RUNNER_MAX_RUN_WALL_CLOCK_MS });
    });
    it("a plan with heavy 1 and a runner declaring heavy 4 still holds one heavy run (the figure is read from the data, not defaulted)", async () => {
      const runner = await newRunner();
      await pending(false);
      await pending(false);
      expect((await claim(runner, cap([3, 0], [4, 0]))).kind).toBe("claimed");
      expect((await claim(runner, cap([3, 0], [4, 1]))).kind).toBe("idle");
    });
  });
});
