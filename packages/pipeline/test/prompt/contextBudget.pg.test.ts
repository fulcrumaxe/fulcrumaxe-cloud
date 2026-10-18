import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { ROLE_CONTEXT_DEFAULTS, effectiveContextBudget, readContextBudgetBytes } from "../../src/prompt/contextBudget.js";

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
});
