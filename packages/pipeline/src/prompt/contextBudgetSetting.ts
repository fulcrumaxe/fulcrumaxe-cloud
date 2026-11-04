import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { ContextRuleError, type ContextRuleTarget } from "@fx/core/src/context/contextRules.js";
import { CONTEXT_BUDGET_MIN_BYTES, CONTEXT_BUDGET_ROLES, consumesContextBudget, itemBudgetMax, readBudgetLevels, resolveContextBudget, roleBudgetMax, type ContextBudgetRole, type ContextBudgetSource } from "./contextBudget.js";
import { DEFAULT_CONTEXT_RULE_TIMEOUTS, boundTransaction, pinBytes, readBudgetedSets, readRepoFacts, readTreeSizes, type SaveContextRuleDeps } from "./contextRulesSave.js";

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
  /** The repository's stored size, or null for "use the role's default". */
  contextBudgetBytes: number | null;
  roleBudgets: Record<ContextBudgetRole, number | null>;
  /** What each role's prompt is held to now (role, else repository, else default; an item's own is in the item view) and which level said so. */
  effectiveByRole: Record<ContextBudgetRole, number>;
  sourceByRole: Record<ContextBudgetRole, ContextBudgetSource>;
}
export interface ItemBudgetView { itemBudgetBytes: number | null; effectiveByRole: Record<ContextBudgetRole, number>; sourceByRole: Record<ContextBudgetRole, ContextBudgetSource> }

function resolveAll(repo: number | null, roles: Partial<Record<ContextBudgetRole, number | null>>, item: number | null) {
  const effectiveByRole = {} as Record<ContextBudgetRole, number>, sourceByRole = {} as Record<ContextBudgetRole, ContextBudgetSource>;
  for (const role of CONTEXT_BUDGET_ROLES) {
    const r = resolveContextBudget(role, { item, role: roles[role] ?? null, repo });
    effectiveByRole[role] = r.bytes;
    sourceByRole[role] = r.source;
  }
  return { effectiveByRole, sourceByRole };
}

export function contextBudgetView(stored: number | null, roleBudgets: Partial<Record<ContextBudgetRole, number | null>> = {}): ContextBudgetView {
  const full = {} as Record<ContextBudgetRole, number | null>;
  for (const role of CONTEXT_BUDGET_ROLES) full[role] = roleBudgets[role] ?? null;
  return { contextBudgetBytes: stored, roleBudgets: full, ...resolveAll(stored, full, null) };
}

export async function readContextBudget(deps: Pick<SaveContextRuleDeps, "pool">, who: { accountId: string; userId: string }, repoId: string): Promise<ContextBudgetView> {
  return withTenant(deps.pool, who.accountId, who.userId, async (client) => {
    const { rows } = await client.query<{ context_budget_bytes: number | null }>(
      "SELECT s.context_budget_bytes FROM repos r LEFT JOIN repo_context_settings s ON s.account_id = r.account_id AND s.repo_id = r.id WHERE r.account_id = $1 AND r.id = $2",
      [who.accountId, repoId],
    );
    if (rows[0] === undefined) throw new NotFoundError("not found");
    const roles = await client.query<{ role: ContextBudgetRole; bytes: number }>("SELECT role, bytes FROM context_budget_overrides WHERE account_id = $1 AND scope = 'role' AND repo_id = $2", [who.accountId, repoId]);
    const stored = Object.fromEntries(roles.rows.filter((r) => CONTEXT_BUDGET_ROLES.includes(r.role)).map((r) => [r.role, Number(r.bytes)]));
    return contextBudgetView(rows[0].context_budget_bytes === null ? null : Number(rows[0].context_budget_bytes), stored);
  });
}

/** One item's own budget and what each role's run on it is held to now (the item's value held to each role's limit; else the role, repository and default levels). */
export async function readItemContextBudget(deps: Pick<SaveContextRuleDeps, "pool">, who: { accountId: string; userId: string }, workItemId: string): Promise<ItemBudgetView> {
  return withTenant(deps.pool, who.accountId, who.userId, async (client) => {
    const w = (await client.query<{ repo_id: string | null }>("SELECT repo_id FROM work_items WHERE account_id = $1 AND id = $2", [who.accountId, workItemId])).rows[0];
    if (w === undefined) throw new NotFoundError("not found");
    const roles: Partial<Record<ContextBudgetRole, number | null>> = {};
    // The item's own row is read directly, so an item with no repository still reads what is stored for it.
    const own = (await client.query<{ bytes: number }>("SELECT bytes FROM context_budget_overrides WHERE account_id = $1 AND scope = 'item' AND work_item_id = $2", [who.accountId, workItemId])).rows[0];
    const item = own === undefined ? null : Number(own.bytes);
    let repo: number | null = null;
    for (const role of CONTEXT_BUDGET_ROLES) {
      const l = w.repo_id === null ? { repo: null, role: null } : await readBudgetLevels(client, who.accountId, w.repo_id, null, role);
      roles[role] = l.role; repo = l.repo;
    }
    return { itemBudgetBytes: item, ...resolveAll(repo, roles, item) };
  });
}

/** A value below the minimum or over the level's bound (the role default times 2 for a role; the largest of those for an item). Carries the bounds for the message. */
export class BudgetOutOfRangeError extends Error {
  constructor(readonly min: number, readonly max: number) { super("budget_out_of_range"); this.name = "BudgetOutOfRangeError"; }
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
  return { ...(await readContextBudget(deps, who, repoId)), changed, pinsStatus: await measurePins(deps, who, { scope: "repo", repoId }, timeouts.githubMs) };
}

/**
 * D#600 CX-12: sets or resets one role's budget in a repository, or one item's budget (it applies to every role's runs on that item). The range is checked first
 * (4096 to the role default times 2, or to the largest of those for an item). A value under a pin set is accepted and reported with `pinsStatus`, as for the repository.
 */
export async function writeBudgetOverride(
  deps: SaveContextRuleDeps,
  who: { accountId: string; userId: string },
  target: { scope: "role"; repoId: string; role: ContextBudgetRole } | { scope: "item"; workItemId: string },
  bytes: number | null,
): Promise<{ changed: boolean; pinsStatus: PinsStatus | null }> {
  const max = target.scope === "role" ? roleBudgetMax(target.role) : itemBudgetMax();
  if (bytes !== null && (!Number.isInteger(bytes) || bytes < CONTEXT_BUDGET_MIN_BYTES || bytes > max)) throw new BudgetOutOfRangeError(CONTEXT_BUDGET_MIN_BYTES, max);
  const timeouts = deps.timeouts ?? DEFAULT_CONTEXT_RULE_TIMEOUTS;
  const changed = await withTenant(deps.pool, who.accountId, who.userId, async (client) => {
    await boundTransaction(client, timeouts);
    const before = (await client.query<{ bytes: number }>(
      target.scope === "role" ? "SELECT bytes FROM context_budget_overrides WHERE account_id = $1 AND scope = 'role' AND repo_id = $2 AND role = $3" : "SELECT bytes FROM context_budget_overrides WHERE account_id = $1 AND scope = 'item' AND work_item_id = $2",
      target.scope === "role" ? [who.accountId, target.repoId, target.role] : [who.accountId, target.workItemId],
    )).rows[0];
    await client.query("SELECT context_budget_override_apply($1, $2::uuid, $3::uuid, $4, $5::int)", [target.scope, target.scope === "role" ? target.repoId : null, target.scope === "item" ? target.workItemId : null, target.scope === "role" ? target.role : null, bytes]);
    return (before === undefined ? null : Number(before.bytes)) !== bytes;
  });
  const pinTarget = target.scope === "role" ? ({ scope: "repo", repoId: target.repoId } as const) : ({ scope: "item", workItemId: target.workItemId } as const);
  // Pins serve the build, so a role that consumes no budget has nothing to report: null, and the answer says the budget does not apply to runs yet.
  if (target.scope === "role" && !consumesContextBudget(target.role)) return { changed, pinsStatus: null };
  return { changed, pinsStatus: await measurePins({ ...deps, budgetRole: target.scope === "role" ? target.role : deps.budgetRole }, who, pinTarget, timeouts.githubMs) };
}

/** Whether the repository's pins (in its own set and in every item's) fit `bytes`. Reads the rules first and GitHub after, so no transaction is open across the call. */
export async function measurePins(deps: SaveContextRuleDeps, who: { accountId: string; userId: string }, target: ContextRuleTarget, githubMs: number): Promise<PinsStatus> {
  try {
    // The budget is read back from what is stored now (an item target includes its own override), so the answer cannot disagree with the screen.
    const { sets, facts } = await withTenant(deps.pool, who.accountId, who.userId, async (client) => {
      const facts = await readRepoFacts(client, who.accountId, target);
      return { sets: await readBudgetedSets(client, who.accountId, target, deps.budgetRole ?? "executor", facts), facts };
    });
    if (!sets.some((s) => s.rules.some((r) => r.kind === "pin"))) return "fit";
    const sizes = await readTreeSizes(deps, who.accountId, facts, githubMs);
    // Each set against its own budget: an item with a budget of its own is measured against that one.
    return sets.some((s) => pinBytes(s.rules, sizes) > s.budget) ? "over_budget" : "fit";
  } catch (err) {
    // fx-swallow-ok: a measurement that cannot be made is reported as not_measured and never blocks the write (the code is fixed; GitHub's text is dropped)
    if (err instanceof ContextRuleError) return "not_measured";
    throw err;
  }
}
