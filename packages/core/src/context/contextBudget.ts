import type { Pool } from "pg";
import { withTenant } from "../tenancy/withTenant.js";

/**
 * D#600 CX-4a: the budget for the bytes of an assembled prompt (migration 0870). A repository may store its own size in
 * `repo_context_settings.context_budget_bytes`; NULL (or no row) means the role's default below. Nothing is stamped, so the effective budget is derived
 * at assembly from the current setting and a later change of a default reaches every repository that never chose a size. This module only READS the
 * setting: writing and resetting it is CX-9 and CX-12.
 */

export const CONTEXT_BUDGET_MIN_BYTES = 4096;
export const CONTEXT_BUDGET_MAX_BYTES = 2_097_152;

/** The roles that have a default: the executor's build, its fix round and the four reviewers. */
export type ContextBudgetRole = "executor" | "fix" | "code-reviewer" | "acceptance-tester" | "security-reviewer" | "debater";

/**
 * PROVISIONAL until CX-10 measures 30 runs/role. Bytes of assembled prompt. Each is the fixed text the builder's snapshot fixture produces (rounded up
 * to a KiB), plus room for what a prompt can also carry: a Spec of 16 KiB (the Spec is never cut, so a larger one only makes the budget bind sooner),
 * the memory slot (4096, MEMORY_SLOT_DEFAULT_BYTES), notes (4096), and the role's own large part (the repo map's 8 KiB cap; the findings of a fix round;
 * the reviewers' summaries for the debater). The measured first turn of the two staging runs (about 12.6k tokens) is the CLI's own system prompt and
 * tools, not these bytes, so it sets no number here. The test pins this arithmetic to the fixtures.
 */
export const ROLE_CONTEXT_DEFAULTS: Readonly<Record<ContextBudgetRole, number>> = Object.freeze({
  executor: 35_840,
  fix: 43_008,
  "code-reviewer": 26_624,
  "acceptance-tester": 27_648,
  "security-reviewer": 26_624,
  debater: 34_816,
});

/** The effective budget: the repository's stored size when it has one, else the role's default. */
export function effectiveContextBudget(role: ContextBudgetRole, stored: number | null): number {
  return stored !== null && Number.isInteger(stored) && stored >= CONTEXT_BUDGET_MIN_BYTES && stored <= CONTEXT_BUDGET_MAX_BYTES ? stored : ROLE_CONTEXT_DEFAULTS[role];
}

/** The repository's stored budget, or null (no row, or the column is NULL). The account's own RLS-scoped select: another account's row is not visible. */
export async function readContextBudgetBytes(pool: Pool, accountId: string, repoId: string): Promise<number | null> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ context_budget_bytes: number | null }>("SELECT context_budget_bytes FROM repo_context_settings WHERE account_id = $1 AND repo_id = $2", [accountId, repoId]);
    const value = rows[0]?.context_budget_bytes;
    return value === null || value === undefined ? null : Number(value);
  });
}
