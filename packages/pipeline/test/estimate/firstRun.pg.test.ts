import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { RUN_LIMIT_BOUNDS } from "@fx/core/src/run-limits/limits.js";
import { sandboxComputeUsdFor } from "@fx/runner";
import { FIRST_RUN_ROLE, firstRunReservationUsd } from "../../src/estimate/firstRun.js";
import { seedAccount } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/** D#483 S5-e1 [pg]: what the first run of an item reserves, the floor under every envelope write. */
const h = pgHarness();

async function account(): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  return id;
}
async function repo(accountId: string, mode = "sandbox"): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', $4, 'acme', $5)`, [id, accountId, Math.floor(Math.random() * 1_000_000_000), mode, `f${id.slice(0, 8)}`]);
  return id;
}
const first = (accountId: string, repoId: string) => withTenant(h.pureAppUserPool, accountId, (client) => firstRunReservationUsd(client, { accountId, repoId }));
const up4 = (n: number) => Math.ceil(n * 1e4 - 1e-9) / 1e4;
/** The defaults: 60 minutes, two extensions of half a slice each, so 60 + 2 x 30 minutes. */
const DEFAULT_MAX_POSSIBLE_RUN_MS = 120 * 60 * 1000;

describe("firstRunReservationUsd", () => {
  it("the first run is triage's classify, a project-manager run", () => {
    expect(FIRST_RUN_ROLE).toBe("project-manager");
  });

  it("hosted: the per-run model cap plus the compute upper bound of the role's limits, rounded up to the money unit", async () => {
    const a = await account();
    const r = await repo(a);
    const cap = RUN_LIMIT_BOUNDS.per_run_usd.default;
    expect(await first(a, r)).toBe(up4(cap + sandboxComputeUsdFor(DEFAULT_MAX_POSSIBLE_RUN_MS)));
    expect(await first(a, r)).toBeGreaterThan(cap);
  });

  it("a runner repo has no compute of ours: the model cap alone", async () => {
    const a = await account();
    const r = await repo(a, "runner_local");
    expect(await first(a, r)).toBe(up4(RUN_LIMIT_BOUNDS.per_run_usd.default));
  });

  it("follows the role's own limits: a per-run cap and a shorter run time lower it, and the account default applies to a role with none", async () => {
    const a = await account();
    const r = await repo(a);
    await h.admin.query(`INSERT INTO run_limits (account_id, role, per_run_usd, max_run_minutes, max_extensions) VALUES ($1, $2, 7.5, 10, 0)`, [a, FIRST_RUN_ROLE]);
    expect(await first(a, r)).toBe(up4(7.5 + sandboxComputeUsdFor(10 * 60 * 1000)));
    const b = await account();
    const rb = await repo(b);
    await h.admin.query(`INSERT INTO run_limits (account_id, role, per_run_usd) VALUES ($1, '*', 3)`, [b]);
    expect(await first(b, rb)).toBe(up4(3 + sandboxComputeUsdFor(DEFAULT_MAX_POSSIBLE_RUN_MS)));
  });

  it("another account's limits never count (RLS), and a repo that is not the account's is not found", async () => {
    const a = await account();
    const b = await account();
    const r = await repo(a);
    await h.admin.query(`INSERT INTO run_limits (account_id, role, per_run_usd) VALUES ($1, $2, 99)`, [b, FIRST_RUN_ROLE]);
    expect(await first(a, r)).toBe(up4(RUN_LIMIT_BOUNDS.per_run_usd.default + sandboxComputeUsdFor(DEFAULT_MAX_POSSIBLE_RUN_MS)));
    await expect(first(b, r)).rejects.toThrow("repo not found");
  });
});
