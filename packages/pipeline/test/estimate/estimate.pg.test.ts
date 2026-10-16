import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { effectiveRoleModel, modelRunPrice, loadModelRunMedians } from "@fx/core/src/role-settings/runPrice.js";
import { sandboxComputeUsdFor } from "@fx/runner";
import { estimateItem, priceRunPlan } from "../../src/estimate/estimateItem.js";
import { runPlanFor } from "../../src/estimate/runPlan.js";
import { SLOT_HOLD_SEED_MINUTES, slotHoldMinutes } from "../../src/estimate/slotHold.js";
import { seedAccount } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/** D#483 S5-p [pg]: the estimate and the slot-hold time over real rows, through the app_user pool so RLS decides what is visible. */
const h = pgHarness();

async function account(): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  return id;
}
async function repo(accountId: string, mode = "sandbox"): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', $4, 'acme', $5)`, [id, accountId, Math.floor(Math.random() * 1_000_000_000), mode, `e${id.slice(0, 8)}`]);
  return id;
}
/** `n` finished runs of a role on a model, each with the given model and compute spend (compute only when given). */
async function runs(accountId: string, role: string, n: number, spend: { model: number; compute?: number }): Promise<void> {
  const model = effectiveRoleModel(role, null);
  for (let i = 0; i < n; i++) {
    const runId = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, model) VALUES ($1, $2, $3, 'production', 'succeeded', $4)`, [runId, accountId, role, model]);
    await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id) VALUES ($1, 'model', 'customer_gateway', $2, $3)`, [accountId, spend.model, runId]);
    if (spend.compute !== undefined) await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'compute', 'sandbox', $2, $3, 'foreground_compute')`, [accountId, spend.compute, runId]);
  }
}
const estimate = (accountId: string, repoId: string, category: string | null, extra: { title?: string } = {}) =>
  withTenant(h.pureAppUserPool, accountId, (client) => estimateItem(client, { accountId, repoId, category, ...extra }));
const modelPrice = (accountId: string, role: string) =>
  withTenant(h.pureAppUserPool, accountId, async (client) => modelRunPrice(await loadModelRunMedians(client, accountId), role, effectiveRoleModel(role, null)));

describe("S5p-2: seed below 10 runs, the tenant's median at 10, never another account's runs", () => {
  it("9 runs of a role use the seed and the 10th switches the model part to the tenant median", async () => {
    const a = await account();
    await runs(a, "executor", 9, { model: 7 });
    const seed = await modelPrice(a, "executor");
    expect(seed.source).toBe("seed");
    await runs(a, "executor", 1, { model: 7 });
    expect(await modelPrice(a, "executor")).toEqual({ usd: 7, source: "ledger" });
  });

  it("the estimate on a runner repo is the model medians alone (compute 0), and its basis follows the roles' run counts", async () => {
    const a = await account();
    const r = await repo(a, "runner_local");
    for (const role of ["project-manager", "executor", "code-reviewer", "acceptance-tester"]) await runs(a, role, role === "acceptance-tester" ? 9 : 10, { model: 2 });
    const nine = await estimate(a, r, "small");
    // 2 + 1 + 1 + 1 runs, three roles at $2 and the acceptance tester on the seed
    const seedAcceptance = (await modelPrice(a, "acceptance-tester")).usd;
    expect(nine.basis).toBe("seed");
    expect(nine.total_usd).toBeCloseTo(2 * 2 + 2 + 2 + seedAcceptance, 6);
    expect(nine.slot_phase_usd).toBeCloseTo(2 + 2 + seedAcceptance, 6);
    expect(nine.modelPartEstimated).toBe(true);
    await runs(a, "acceptance-tester", 1, { model: 2 });
    const ten = await estimate(a, r, "small");
    expect(ten).toMatchObject({ basis: "history", reason: null });
    expect(ten.total_usd).toBeCloseTo(2 * 2 + 2 + 2 + 2, 6);
  });

  it("another account's runs never count (RLS)", async () => {
    const a = await account();
    const b = await account();
    await runs(b, "executor", 12, { model: 99 });
    expect((await modelPrice(a, "executor")).source).toBe("seed");
    const medians = await withTenant(h.pureAppUserPool, a, (client) => loadModelRunMedians(client, a));
    expect(medians.size).toBe(0);
    const ra = await repo(a, "runner_local");
    const rb = await repo(b, "runner_local");
    // account a has no runs of its own, so it prices exactly like an account that has never run anything
    const c = await account();
    const rc = await repo(c, "runner_local");
    expect((await estimate(a, ra, "small")).total_usd).toBe((await estimate(c, rc, "small")).total_usd);
    expect((await estimate(a, ra, "small")).basis).toBe("seed");
    // and a repo of another account is not visible at all
    await expect(estimate(a, rb, "small")).rejects.toThrow("repo not found");
  });

  it("a hosted repo seeds its compute from the role's own run limits, and an override moves the seed", async () => {
    const a = await account();
    const r = await repo(a);
    const plan = runPlanFor({ category: "small" });
    if (!plan.ok) throw new Error("expected a plan");
    const defaults = await estimate(a, r, "small");
    // 60 minutes + 2 extensions of a half slice = 7200 s at the pinned size, for each of the 5 runs
    const bound = sandboxComputeUsdFor(7200 * 1000);
    const modelOnly = await withTenant(h.pureAppUserPool, a, async (client) => {
      const medians = await loadModelRunMedians(client, a);
      return priceRunPlan(plan.runs, (role) => ({ usd: modelRunPrice(medians, role, effectiveRoleModel(role, null)).usd, history: true })).total_usd;
    });
    expect(defaults.basis).toBe("seed");
    expect(defaults.modelPartEstimated).toBe(false);
    expect(defaults.total_usd).toBeCloseTo(modelOnly + 5 * bound, 6);

    await h.admin.query(`INSERT INTO run_limits (account_id, role, max_run_minutes, max_extensions) VALUES ($1, '*', 120, 0)`, [a]);
    const overridden = await estimate(a, r, "small");
    expect(overridden.total_usd).toBeCloseTo(modelOnly + 5 * sandboxComputeUsdFor(120 * 60 * 1000), 6);
    expect(overridden.total_usd).toBeGreaterThan(defaults.total_usd - 1e-9);
    // never past the 240-minute ceiling
    await h.admin.query(`UPDATE run_limits SET max_run_minutes = 240, max_extensions = 4 WHERE account_id = $1`, [a]);
    const capped = await estimate(a, r, "small");
    expect(capped.total_usd).toBeCloseTo(modelOnly + 5 * sandboxComputeUsdFor(240 * 60 * 1000), 6);
  });

  it("a hosted role with 10 runs that booked compute prices from their median, not the bound", async () => {
    const a = await account();
    const r = await repo(a);
    for (const role of ["project-manager", "executor", "code-reviewer", "acceptance-tester"]) await runs(a, role, 10, { model: 1, compute: 0.25 });
    const e = await estimate(a, r, "small");
    expect(e.basis).toBe("history");
    expect(e.total_usd).toBeCloseTo(5 * 1.25, 6);
    expect(e.slot_phase_usd).toBeCloseTo(3 * 1.25, 6);
  });

  it("runs on a runner (no compute row) do not pull a hosted role's compute median to zero", async () => {
    const a = await account();
    const r = await repo(a);
    // 10 runs with no compute row at all: the role has no compute history, so the bound is used
    await runs(a, "executor", 10, { model: 1 });
    const e = await estimate(a, r, "small");
    expect(e.basis).toBe("seed");
    expect(e.total_usd).toBeGreaterThan(5 * sandboxComputeUsdFor(7200 * 1000) * 0.99);
  });

  it("project, question and no category are none with their reasons and zero sums", async () => {
    const a = await account();
    const r = await repo(a);
    expect(await estimate(a, r, "project")).toEqual({ total_usd: 0, slot_phase_usd: 0, basis: "none", reason: "project_not_specified", modelPartEstimated: false });
    expect(await estimate(a, r, "question")).toMatchObject({ basis: "none", reason: "question_not_built", total_usd: 0 });
    expect(await estimate(a, r, null)).toMatchObject({ basis: "none", reason: "no_category", total_usd: 0 });
  });

  it("the debater setting adds its run for a feature, and a critical item adds the security reviewer", async () => {
    const a = await account();
    const r = await repo(a, "runner_local");
    const off = await estimate(a, r, "feature");
    await h.admin.query(`INSERT INTO role_settings (account_id, repo_id, role, mode) VALUES ($1, $2, 'debater', 'feature_critical')`, [a, r]);
    const on = await estimate(a, r, "feature");
    const debaterSeed = (await modelPrice(a, "debater")).usd;
    expect(on.total_usd - off.total_usd).toBeCloseTo(debaterSeed, 6);
    expect(on.slot_phase_usd - off.slot_phase_usd).toBeCloseTo(debaterSeed, 6);
    const small = await estimate(a, r, "small");
    expect(small.total_usd).toBeLessThan(off.total_usd);
  });
});

describe("S5p-3: slotHoldMinutes", () => {
  async function item(accountId: string, repoId: string): Promise<string> {
    const id = randomUUID();
    await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number) VALUES ($1, $2, $3, 'feature', 'running', 'internal', $4)`, [id, accountId, repoId, Math.floor(Math.random() * 1_000_000) + 1]);
    return id;
  }
  async function transition(accountId: string, itemId: string, from: string, to: string, at: Date, ref: string): Promise<void> {
    const reviewer = to === "changes_requested" || to === "review_passed" ? "code" : null;
    await h.admin.query(
      `INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, reviewer, at, source, source_ref) VALUES ($1, $2, $3, $4, $5, $6, 'control_plane', $7)`,
      [accountId, itemId, from, to, reviewer, at, ref],
    );
  }
  /** An item that holds a slot for `minutes`, through the in-slot moves, and leaves it at `leftAt` into `merged`. */
  async function held(accountId: string, repoId: string, minutes: number, leftAt: Date): Promise<void> {
    const id = await item(accountId, repoId);
    const entered = new Date(leftAt.getTime() - minutes * 60_000);
    await transition(accountId, id, "spec_ready", "in_progress", entered, "a");
    // moves inside the slot stages do not end the hold
    await transition(accountId, id, "in_progress", "pr_opened", new Date(entered.getTime() + 30_000), "b");
    await transition(accountId, id, "pr_opened", "review_passed", new Date(entered.getTime() + 60_000), "c");
    await transition(accountId, id, "review_passed", "merged", leftAt, "d");
  }
  const slotHold = (accountId: string) => withTenant(h.pureAppUserPool, accountId, (client) => slotHoldMinutes(client, accountId));

  it("equals the hand-computed median over fixture transitions, and 9 items give the seed", async () => {
    const a = await account();
    const r = await repo(a);
    const base = Date.now() - 24 * 3_600_000;
    for (let i = 1; i <= 9; i++) await held(a, r, i * 10, new Date(base + i * 60_000));
    expect(await slotHold(a)).toEqual({ minutes: SLOT_HOLD_SEED_MINUTES, basis: "seed" });
    await held(a, r, 100, new Date(base + 10 * 60_000));
    // 10, 20, ..., 100: the median is (50 + 60) / 2
    const ten = await slotHold(a);
    expect(ten.basis).toBe("history");
    expect(ten.minutes).toBeCloseTo(55, 3);
  });

  it("counts only the last 50 items to leave, by when they left", async () => {
    const a = await account();
    const r = await repo(a);
    const base = Date.now() - 100 * 3_600_000;
    for (let k = 1; k <= 52; k++) await held(a, r, k, new Date(base + k * 3_600_000));
    // the two oldest leavers (1 and 2 minutes) fall out: 3..52 has the median (27 + 28) / 2
    expect((await slotHold(a)).minutes).toBeCloseTo(27.5, 3);
  });

  it("the first move out of the slot ends the hold, even if the item comes back; an item still in a slot is not counted", async () => {
    const a = await account();
    const r = await repo(a);
    const base = Date.now() - 48 * 3_600_000;
    for (let i = 0; i < 10; i++) {
      const id = await item(a, r);
      const t = new Date(base + i * 3_600_000);
      await transition(a, id, "spec_ready", "in_progress", t, "a");
      await transition(a, id, "in_progress", "needs_human", new Date(t.getTime() + 20 * 60_000), "b");
      // it comes back and stays 500 minutes more: only the first hold counts
      await transition(a, id, "needs_human", "in_progress", new Date(t.getTime() + 25 * 60_000), "c");
      await transition(a, id, "in_progress", "merged", new Date(t.getTime() + 525 * 60_000), "d");
    }
    const stillIn = await item(a, r);
    await transition(a, stillIn, "spec_ready", "in_progress", new Date(base), "a");
    expect((await slotHold(a)).minutes).toBeCloseTo(20, 3);
  });

  it("another account's items never count (RLS)", async () => {
    const a = await account();
    const b = await account();
    const rb = await repo(b);
    const base = Date.now() - 24 * 3_600_000;
    for (let i = 1; i <= 12; i++) await held(b, rb, 5, new Date(base + i * 60_000));
    expect(await slotHold(b)).toMatchObject({ basis: "history" });
    expect(await slotHold(a)).toEqual({ minutes: SLOT_HOLD_SEED_MINUTES, basis: "seed" });
  });
});
