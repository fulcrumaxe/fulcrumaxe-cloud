import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { resetPlanDataCache } from "@fx/plan-data";
import { RunnerTarget, type ExecutionRun } from "@fx/runner";
import { runsPerDayOfAccountPlan } from "../src/runnerLimits.js";

/** [pg] The daily cap on runner runs follows the account's own plan: a subscription plan has none, the runner-only tier keeps its figure. */
type AccountState = "active" | "unsubscribed" | "hold" | "suspended" | "paused" | `past_due_${number}d`;

describe("runner daily limit by account plan [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const saved = process.env.FX_PLAN_DATA;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await writerPool.end();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FX_PLAN_DATA;
    else process.env.FX_PLAN_DATA = saved;
    resetPlanDataCache();
  });

  const target = () =>
    new RunnerTarget({ pool: writerPool, issuer: { issue: async () => {} }, visibility: { visibility: async () => "private" }, limits: { runsPerDay: runsPerDayOfAccountPlan(writerPool) } }, "runner_local");

  /** An account on `plan` with `n` runner runs today; returns the n-th as the run being admitted. */
  async function accountWith(plan: string, n: number, state: AccountState = "active"): Promise<ExecutionRun> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE accounts SET plan = $2 WHERE id = $1", [a.accountId, plan]);
    if (state === "unsubscribed") await admin.query("UPDATE accounts SET stripe_customer_id = NULL WHERE id = $1", [a.accountId]);
    if (state === "hold") await admin.query("UPDATE accounts SET platform_hold_at = now() WHERE id = $1", [a.accountId]);
    if (state === "suspended") await admin.query("UPDATE accounts SET partner_suspended_at = now() WHERE id = $1", [a.accountId]);
    if (state === "paused") await admin.query("UPDATE accounts SET owner_paused_at = now() WHERE id = $1", [a.accountId]);
    const days = /^past_due_(\d+)d$/.exec(state);
    if (days) await admin.query("UPDATE accounts SET past_due_since = now() - ($2 || ' days')::interval WHERE id = $1", [a.accountId, days[1]]);
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [a.repoId]);
    let id = "";
    for (let i = 0; i < n; i++) {
      id = randomUUID();
      await admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'runner', 'pending')", [id, a.accountId]);
    }
    return { id, accountId: a.accountId, role: "code-reviewer", product: "team", repoId: a.repoId, roleCard: "card", prompt: "prompt", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" } } as ExecutionRun;
  }

  const cap = () => Number(JSON.parse(saved!).runnerPlan.limits.runsPerDay);

  it.each(["starter", "team", "scale"])("an account on %s that is active is admitted well past the runner tier's cap", async (plan) => {
    expect(await target().admit(await accountWith(plan, cap() + 10, "active"), admin)).toEqual({ admitted: true });
  });

  it("past_due inside the grace window (2 days) is uncapped", async () => {
    expect(await target().admit(await accountWith("scale", cap() + 10, "past_due_2d"), admin)).toEqual({ admitted: true });
  });

  it.each(["past_due_8d", "unsubscribed", "hold", "suspended", "paused"] as const)("a scale account that is %s keeps the runner tier's cap (admitted at it, refused past it)", async (state) => {
    expect(await target().admit(await accountWith("scale", cap(), state), admin)).toEqual({ admitted: true });
    expect(await target().admit(await accountWith("scale", cap() + 1, state), admin)).toEqual({ admitted: false, reason: "runner_daily_limit" });
  });

  it("an unpaid default signup (starter, never checked out) is capped at the runner tier's figure", async () => {
    expect(await target().admit(await accountWith("starter", cap() + 1, "unsubscribed"), admin)).toEqual({ admitted: false, reason: "runner_daily_limit" });
  });

  it("the grace window is read at the clock the resolver is given", async () => {
    const run = await accountWith("scale", cap() + 10, "past_due_2d");
    const later = new RunnerTarget({ pool: writerPool, issuer: { issue: async () => {} }, visibility: { visibility: async () => "private" }, limits: { runsPerDay: runsPerDayOfAccountPlan(writerPool, () => new Date(Date.now() + 6 * 24 * 3600_000)) } }, "runner_local");
    expect(await later.admit(run, admin)).toEqual({ admitted: false, reason: "runner_daily_limit" });
  });

  it("a status that cannot be read refuses (fails closed)", async () => {
    const run = await accountWith("scale", 1, "active");
    const down = { connect: async () => { throw new Error("db down"); } } as unknown as Pool;
    const broken = new RunnerTarget({ pool: writerPool, issuer: { issue: async () => {} }, visibility: { visibility: async () => "private" }, limits: { runsPerDay: runsPerDayOfAccountPlan(down) } }, "runner_local");
    expect(await broken.admit(run, admin)).toEqual({ admitted: false, reason: "runner_daily_limit" });
  });

  it("a runner-tier account is admitted at its cap and refused past it, as runner_daily_limit", async () => {
    expect(await target().admit(await accountWith("runner", cap()), admin)).toEqual({ admitted: true });
    expect(await target().admit(await accountWith("runner", cap() + 1), admin)).toEqual({ admitted: false, reason: "runner_daily_limit" });
  });

  it("an unknown plan is refused (fails closed)", async () => {
    expect(await target().admit(await accountWith("no-such-plan", 1), admin)).toEqual({ admitted: false, reason: "runner_daily_limit" });
  });

  it("missing plan data refuses every account, subscription or runner tier", async () => {
    const scale = await accountWith("scale", 1);
    const tier = await accountWith("runner", 1);
    delete process.env.FX_PLAN_DATA;
    resetPlanDataCache();
    expect(await target().admit(scale, admin)).toEqual({ admitted: false, reason: "runner_daily_limit" });
    expect(await target().admit(tier, admin)).toEqual({ admitted: false, reason: "runner_daily_limit" });
  });
});
