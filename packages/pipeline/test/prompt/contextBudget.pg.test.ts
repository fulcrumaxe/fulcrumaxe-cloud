import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { ROLE_CONTEXT_DEFAULTS, effectiveContextBudget, readContextBudgetBytes, resolveRunContextBudget } from "../../src/prompt/contextBudget.js";

/** [pg] D#600 CX-4a acceptance 6: a NULL context_budget_bytes uses the role default, a stored one is used instead, and another account sees no row. */
describe("readContextBudgetBytes [pg]", () => {
  const h = pgHarness();
  async function world() {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const userId = randomUUID();
    await seedAccount(h.admin, accountId);
    await seedRepo(h.admin, accountId, repoId);
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    return { accountId, repoId, userId };
  }
  const setRow = (w: { accountId: string; repoId: string; userId: string }, budget: number | null) =>
    h.admin.query("INSERT INTO repo_context_settings (account_id, repo_id, memory_slot_bytes, updated_by, context_budget_bytes) VALUES ($1, $2, 2048, $3, $4)", [w.accountId, w.repoId, w.userId, budget]);

  it("no row, or a row with a NULL budget, reads null and the role default applies; a stored value is used instead", async () => {
    const w = await world();
    expect(await readContextBudgetBytes(h.pureAppUserPool, w.accountId, w.repoId)).toBeNull();
    expect(effectiveContextBudget("executor", await readContextBudgetBytes(h.pureAppUserPool, w.accountId, w.repoId))).toBe(ROLE_CONTEXT_DEFAULTS.executor);
    await setRow(w, null);
    expect(await readContextBudgetBytes(h.pureAppUserPool, w.accountId, w.repoId)).toBeNull();
    await h.admin.query("UPDATE repo_context_settings SET context_budget_bytes = 12345 WHERE repo_id = $1", [w.repoId]);
    const stored = await readContextBudgetBytes(h.pureAppUserPool, w.accountId, w.repoId);
    expect(stored).toBe(12345);
    expect(effectiveContextBudget("executor", stored)).toBe(12345);
  });

  it("an account-B read of an account-A setting returns no rows, so null", async () => {
    const a = await world();
    const b = await world();
    await setRow(a, 54321);
    expect(await readContextBudgetBytes(h.pureAppUserPool, b.accountId, a.repoId)).toBeNull();
    expect(await readContextBudgetBytes(h.pureAppUserPool, a.accountId, a.repoId)).toBe(54321);
  });

  it("D#600 CX-12: resolveRunContextBudget reads item, role and repository in one call, names the level, and never sees another account's overrides", async () => {
    const a = await world();
    const b = await world();
    const item = randomUUID();
    await h.admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')", [item, a.accountId, a.repoId]);
    const read = (acct: typeof a, role: "executor" | "fix", withItem = true) => resolveRunContextBudget(h.pureAppUserPool, acct.accountId, acct.repoId, withItem ? item : null, role);
    expect(await read(a, "executor")).toEqual({ bytes: ROLE_CONTEXT_DEFAULTS.executor, source: "default" });
    await setRow(a, 12345);
    expect(await read(a, "executor")).toEqual({ bytes: 12345, source: "repo" });
    await h.admin.query("INSERT INTO context_budget_overrides (account_id, scope, repo_id, role, bytes, updated_by) VALUES ($1, 'role', $2, 'executor', 9000, $3)", [a.accountId, a.repoId, a.userId]);
    expect(await read(a, "executor")).toEqual({ bytes: 9000, source: "role" });
    expect(await read(a, "fix")).toEqual({ bytes: 12345, source: "repo" }); // the role's own budget is for that role only
    await h.admin.query("INSERT INTO context_budget_overrides (account_id, scope, work_item_id, bytes, updated_by) VALUES ($1, 'item', $2, 6000, $3)", [a.accountId, item, a.userId]);
    expect(await read(a, "executor")).toEqual({ bytes: 6000, source: "item" });
    expect(await read(a, "fix")).toEqual({ bytes: 6000, source: "item" }); // an item's budget applies to every role's runs on it
    expect(await read(a, "executor", false)).toEqual({ bytes: 9000, source: "role" }); // no item named: the item level is skipped
    await h.admin.query("UPDATE context_budget_overrides SET bytes = 2000000 WHERE scope = 'item'");
    expect(await read(a, "fix")).toEqual({ bytes: ROLE_CONTEXT_DEFAULTS.fix * 2, source: "item" }); // held to the running role's default times 2
    // Another account's read of this repository and item finds no override and no repository setting.
    expect(await resolveRunContextBudget(h.pureAppUserPool, b.accountId, a.repoId, item, "executor")).toEqual({ bytes: ROLE_CONTEXT_DEFAULTS.executor, source: "default" });
  });
});
