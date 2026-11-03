import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { ContextRuleError } from "@fx/core/src/context/contextRules.js";
import { ROLE_CONTEXT_DEFAULTS, effectiveContextBudget, type ContextBudgetRole } from "./contextBudget.js";
import { DEFAULT_CONTEXT_RULE_TIMEOUTS, boundTransaction, pinBytes, readRepoFacts, readResolvedSets, readTreeSizes, type SaveContextRuleDeps } from "./contextRulesSave.js";

/**
 * D#600 CX-9a: reading and writing a repository's context budget (migration 0974; the column is 0870's). NULL is "use the role's default": a reset is a
 * write of NULL, and the effective budget is worked out from the current setting whenever it is read or used, never stored. The write is owner or admin
 * only (the definer re-derives the role) and writes one audit row per real change.
 *
 * A budget lowered below the repository's pins is accepted: pins are never cut at run time (C4 ruling 5). The answer says so with `pins_status`, measured
 * against the executor's budget with the same sizes the save check uses: `fit`, `over_budget`, or `not_measured` when there is no GitHub answer to
 * measure with. The measurement happens after the write has committed and never blocks or undoes it.
 */
export type PinsStatus = "fit" | "over_budget" | "not_measured";

export interface ContextBudgetView {
  /** The stored size, or null for "use the role's default". */
  contextBudgetBytes: number | null;
  /** What each role's prompt is held to now: the stored size, else the role's default. */
  effectiveByRole: Record<ContextBudgetRole, number>;
}

export function contextBudgetView(stored: number | null): ContextBudgetView {
  const effectiveByRole = {} as Record<ContextBudgetRole, number>;
  for (const role of Object.keys(ROLE_CONTEXT_DEFAULTS) as ContextBudgetRole[]) effectiveByRole[role] = effectiveContextBudget(role, stored);
  return { contextBudgetBytes: stored, effectiveByRole };
}

export async function readContextBudget(deps: Pick<SaveContextRuleDeps, "pool">, who: { accountId: string; userId: string }, repoId: string): Promise<ContextBudgetView> {
  return withTenant(deps.pool, who.accountId, who.userId, async (client) => {
    const { rows } = await client.query<{ context_budget_bytes: number | null }>(
      "SELECT s.context_budget_bytes FROM repos r LEFT JOIN repo_context_settings s ON s.account_id = r.account_id AND s.repo_id = r.id WHERE r.account_id = $1 AND r.id = $2",
      [who.accountId, repoId],
    );
    if (rows[0] === undefined) throw new NotFoundError("not found");
    return contextBudgetView(rows[0].context_budget_bytes === null ? null : Number(rows[0].context_budget_bytes));
  });
}

/** Writes the budget (`null` resets it). Throws the database's 42501 (not an owner or admin) and P0002 (no such repository) as they are. */
export async function writeContextBudget(
  deps: SaveContextRuleDeps,
  who: { accountId: string; userId: string },
  repoId: string,
  bytes: number | null,
): Promise<ContextBudgetView & { changed: boolean; pinsStatus: PinsStatus }> {
  const timeouts = deps.timeouts ?? DEFAULT_CONTEXT_RULE_TIMEOUTS;
  const changed = await withTenant(deps.pool, who.accountId, who.userId, async (client) => {
    await boundTransaction(client, timeouts);
    const before = (await client.query<{ context_budget_bytes: number | null }>("SELECT context_budget_bytes FROM repo_context_settings WHERE account_id = $1 AND repo_id = $2", [who.accountId, repoId])).rows[0];
    await client.query("SELECT repo_context_budget_apply($1::uuid, $2::int)", [repoId, bytes]);
    return (before?.context_budget_bytes ?? null) !== bytes;
  });
  return { ...contextBudgetView(bytes), changed, pinsStatus: await measurePins(deps, who, repoId, bytes, timeouts.githubMs) };
}

/** Whether the repository's pins (in its own set and in every item's) fit `bytes`. Reads the rules first and GitHub after, so no transaction is open across the call. */
async function measurePins(deps: SaveContextRuleDeps, who: { accountId: string; userId: string }, repoId: string, bytes: number | null, githubMs: number): Promise<PinsStatus> {
  try {
    const target = { scope: "repo", repoId } as const;
    const { sets, facts } = await withTenant(deps.pool, who.accountId, who.userId, async (client) => ({ sets: await readResolvedSets(client, who.accountId, target), facts: await readRepoFacts(client, who.accountId, target) }));
    if (!sets.some((rules) => rules.some((r) => r.kind === "pin"))) return "fit";
    const sizes = await readTreeSizes(deps, who.accountId, facts, githubMs);
    const budget = effectiveContextBudget(deps.budgetRole ?? "executor", bytes);
    return sets.some((rules) => pinBytes(rules, sizes) > budget) ? "over_budget" : "fit";
  } catch (err) {
    // fx-swallow-ok: a measurement that cannot be made is reported as not_measured and never blocks the write (the code is fixed; GitHub's text is dropped)
    if (err instanceof ContextRuleError) return "not_measured";
    throw err;
  }
}
