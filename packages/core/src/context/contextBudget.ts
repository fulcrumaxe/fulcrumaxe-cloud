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
  "code-reviewer": 27_648,
  "acceptance-tester": 27_648,
  "security-reviewer": 27_648,
  debater: 34_816,
});

/** The effective budget: the repository's stored size when it has one, else the role's default. */
export function effectiveContextBudget(role: ContextBudgetRole, stored: number | null): number {
  return stored !== null && Number.isInteger(stored) && stored >= CONTEXT_BUDGET_MIN_BYTES && stored <= CONTEXT_BUDGET_MAX_BYTES ? stored : ROLE_CONTEXT_DEFAULTS[role];
}

export const CONTEXT_BUDGET_ROLES = Object.keys(ROLE_CONTEXT_DEFAULTS) as readonly ContextBudgetRole[];
/** The roles whose runs really assemble a prompt under a budget today (the build's). A role that starts to consume one adds itself here and nowhere else; screens and write answers follow this list. */
export const CONTEXT_BUDGET_CONSUMERS: readonly ContextBudgetRole[] = ["executor"];
export const consumesContextBudget = (role: ContextBudgetRole): boolean => CONTEXT_BUDGET_CONSUMERS.includes(role);
export type ContextBudgetSource = "item" | "role" | "repo" | "default";
export interface ContextBudgetLevels { item: number | null; role: number | null; repo: number | null }

/** The most a role's own budget may be: its default times 2. An item budget may be at most the largest of those (it applies to every role). */
export const roleBudgetMax = (role: ContextBudgetRole): number => ROLE_CONTEXT_DEFAULTS[role] * 2;
export const itemBudgetMax = (): number => Math.max(...CONTEXT_BUDGET_ROLES.map(roleBudgetMax));

const inRange = (n: number | null): n is number => n !== null && Number.isInteger(n) && n >= CONTEXT_BUDGET_MIN_BYTES && n <= CONTEXT_BUDGET_MAX_BYTES;

/**
 * D#600 CX-12: the ONE precedence, item then role then repository then the role's default, derived from the current settings and never stamped. An item value is held
 * to the running role's default times 2 (the smaller applies), so an item cannot lift a small role past its own limit; a role value is held to the same limit.
 */
export function resolveContextBudget(role: ContextBudgetRole, levels: ContextBudgetLevels): { bytes: number; source: ContextBudgetSource } {
  const cap = roleBudgetMax(role);
  if (inRange(levels.item)) return { bytes: Math.min(levels.item, cap), source: "item" };
  if (inRange(levels.role)) return { bytes: Math.min(levels.role, cap), source: "role" };
  if (inRange(levels.repo)) return { bytes: levels.repo, source: "repo" };
  return { bytes: ROLE_CONTEXT_DEFAULTS[role], source: "default" };
}

type Queryable = { query: (sql: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
const levelOf = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The three stored levels for one role, in one read. An unset item (or none) reads null; a stored role that is not on the closed list reads null. */
export async function readBudgetLevels(client: Queryable, accountId: string, repoId: string, workItemId: string | null, role: ContextBudgetRole): Promise<ContextBudgetLevels> {
  const { rows } = await client.query(
    `SELECT (SELECT s.context_budget_bytes FROM repo_context_settings s WHERE s.account_id = $1 AND s.repo_id = $2) AS repo,
            (SELECT o.bytes FROM context_budget_overrides o WHERE o.account_id = $1 AND o.scope = 'role' AND o.repo_id = $2 AND o.role = $3) AS role,
            (SELECT o.bytes FROM context_budget_overrides o WHERE o.account_id = $1 AND o.scope = 'item' AND o.work_item_id = $4::uuid) AS item`,
    [accountId, repoId, role, workItemId],
  );
  return { repo: levelOf(rows[0]?.repo), role: CONTEXT_BUDGET_ROLES.includes(role) ? levelOf(rows[0]?.role) : null, item: levelOf(rows[0]?.item) };
}

/** What a run of `role` on this item is held to now, and which level said so. The one read every consumer uses. */
export async function resolveRunContextBudget(pool: Pool, accountId: string, repoId: string, workItemId: string | null, role: ContextBudgetRole): Promise<{ bytes: number; source: ContextBudgetSource }> {
  return resolveContextBudget(role, await withTenant(pool, accountId, (client) => readBudgetLevels(client, accountId, repoId, workItemId, role)));
}

/** The repository's stored budget, or null (no row, or the column is NULL). The account's own RLS-scoped select: another account's row is not visible. */
export async function readContextBudgetBytes(pool: Pool, accountId: string, repoId: string): Promise<number | null> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ context_budget_bytes: number | null }>("SELECT context_budget_bytes FROM repo_context_settings WHERE account_id = $1 AND repo_id = $2", [accountId, repoId]);
    const value = rows[0]?.context_budget_bytes;
    return value === null || value === undefined ? null : Number(value);
  });
}
