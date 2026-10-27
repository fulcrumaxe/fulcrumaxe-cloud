import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { effectiveRoleModel } from "@fx/core/src/role-settings/runPrice.js";
import { CHILD_BUILD_SUPPORTED } from "../../src/advance/childBuild.js";
import { childFirstRunUsd, estimateItem, rolePriceUsd } from "../../src/estimate/estimateItem.js";
import { seedAccount } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#483 S5-b2c-1 [pg]: the price of a planned PR child's first run is p(executor), the same price S5-p's estimate uses for that role, not a new formula; and the
 * pairing guard is a code constant that is false until the build supports a child.
 */
const h = pgHarness();

async function account(): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  return id;
}
async function repo(accountId: string, mode = "sandbox"): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', $4, 'acme', $5)`, [id, accountId, Math.floor(Math.random() * 1_000_000_000), mode, `c${id.slice(0, 8)}`]);
  return id;
}
async function runs(accountId: string, role: string, n: number, spend: { model: number; compute?: number }): Promise<void> {
  const model = effectiveRoleModel(role, null);
  for (let i = 0; i < n; i++) {
    const runId = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, model) VALUES ($1, $2, $3, 'production', 'succeeded', $4)`, [runId, accountId, role, model]);
    await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id) VALUES ($1, 'model', 'customer_gateway', $2, $3)`, [accountId, spend.model, runId]);
    if (spend.compute !== undefined) await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'compute', 'sandbox', $2, $3, 'foreground_compute')`, [accountId, spend.compute, runId]);
  }
}
const inTenant = <T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> => withTenant(h.pureAppUserPool, accountId, fn);

describe("the child's first run is priced as one executor run", () => {
  it("the pairing guard is false in code until the build supports a child", () => {
    expect(CHILD_BUILD_SUPPORTED).toBe(false);
  });

  it("equals the executor's price in the estimate: a runner repo with 10 executor runs at $3 prices at $3", async () => {
    const a = await account();
    const r = await repo(a, "runner_local");
    await runs(a, "executor", 10, { model: 3 });
    expect(await inTenant(a, (c) => rolePriceUsd(c, { accountId: a, repoId: r, role: "executor" }))).toEqual({ usd: 3, history: true });
    expect(await inTenant(a, (c) => childFirstRunUsd(c, { accountId: a, repoId: r }))).toBe(3);
    // The estimate of a small item counts exactly one executor run at that same price (its slot phase is the executor plus the reviews).
    for (const role of ["code-reviewer", "acceptance-tester"]) await runs(a, role, 10, { model: 1 });
    const est = await inTenant(a, (c) => estimateItem(c, { accountId: a, repoId: r, category: "small" }));
    const reviewers = (await inTenant(a, (c) => rolePriceUsd(c, { accountId: a, repoId: r, role: "code-reviewer" }))).usd + (await inTenant(a, (c) => rolePriceUsd(c, { accountId: a, repoId: r, role: "acceptance-tester" }))).usd;
    expect(est.slot_phase_usd).toBeCloseTo(3 + reviewers, 6);
  });

  it("a hosted repo adds the compute part (the median at 10 runs)", async () => {
    const a = await account();
    const r = await repo(a);
    await runs(a, "executor", 10, { model: 0.1234, compute: 0.2 });
    const p = await inTenant(a, (c) => rolePriceUsd(c, { accountId: a, repoId: r, role: "executor" }));
    expect(p.usd).toBeCloseTo(0.3234, 6);
    expect(p.history).toBe(true);
    expect(await inTenant(a, (c) => childFirstRunUsd(c, { accountId: a, repoId: r }))).toBe(0.3234);
  });

  it("on the seed a hosted repo is priced from the role's own run limits and rounds UP to the unit the money columns hold", async () => {
    const a = await account();
    const r = await repo(a);
    const p = await inTenant(a, (c) => rolePriceUsd(c, { accountId: a, repoId: r, role: "executor" }));
    const child = await inTenant(a, (c) => childFirstRunUsd(c, { accountId: a, repoId: r }));
    expect(p.history).toBe(false);
    expect(child).toBeGreaterThanOrEqual(p.usd - 1e-9);
    expect(child).toBeLessThan(p.usd + 0.0001);
    expect(Math.round(child * 1e4) / 1e4).toBe(child);
    expect(child).toBeGreaterThan(0);
  });

  it("another account's runs never count, and a repo of another account is not visible", async () => {
    const a = await account();
    const b = await account();
    const rb = await repo(b, "runner_local");
    const ra = await repo(a, "runner_local");
    await runs(b, "executor", 12, { model: 99 });
    expect((await inTenant(a, (c) => rolePriceUsd(c, { accountId: a, repoId: ra, role: "executor" }))).history).toBe(false);
    expect((await inTenant(a, (c) => childFirstRunUsd(c, { accountId: a, repoId: ra }))) < 99).toBe(true);
    await expect(inTenant(a, (c) => rolePriceUsd(c, { accountId: a, repoId: rb, role: "executor" }))).rejects.toThrow("repo not found");
  });
});
