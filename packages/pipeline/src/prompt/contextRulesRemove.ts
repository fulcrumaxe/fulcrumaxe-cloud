import { MAX_JOB_PINS, splitPinsByExcludes } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { CONTEXT_EXCLUDES_MAX, ContextRuleError, mapRuleDbError, readItemRules, readRepoRules, resolveContextRules, type ContextRule } from "@fx/core/src/context/contextRules.js";
import { effectiveContextBudget } from "./contextBudget.js";
import { DEFAULT_CONTEXT_RULE_TIMEOUTS, boundTransaction, lockRepoRules, readRepoFacts, readTreeSizes, rolledBack, type RepoFacts, type SaveContextRuleDeps } from "./contextRulesSave.js";

/**
 * D#600 CX-9a: removing a rule, with the one warning C4 asks for. An exclude wins over a pin (ruling 7), so taking an item's exclude away can bring a
 * repo-scope pin back into that item's run; if the pins then no longer fit the repository's budget, the removal is refused with `exclude_readds_pins`
 * and nothing is removed, until the person repeats it with `confirm` (the budget is never enforced at run time, ruling 5, so confirming is allowed).
 *
 * The measure is what a run would read: the pins no exclude of the set covers (the protocol's own matcher, with its work bound). It is taken before and
 * after, and the warning fires only when the removal adds bytes AND the result is over budget. Sizes are needed only when the repository has a pin at all.
 * Like a save, the GitHub read is made with no connection held: a first transaction reads what decides whether to ask (and is rolled back), the tree is
 * read, and a second transaction takes the repository lock, measures and removes. If GitHub cannot be asked the warning is skipped and the removal goes
 * ahead (it is advice). The counts are not advice: a removal that would leave a set over MAX_JOB_PINS pins or CONTEXT_EXCLUDES_MAX excludes is refused whatever `confirm` says. The audit row ('context_rule.removed') is written by the definer, only on a real removal, in the removing transaction.
 */
const liveBytes = (rules: readonly ContextRule[], sizes: ReadonlyMap<string, number>): number =>
  splitPinsByExcludes(rules.filter((r) => r.kind === "pin").map((r) => r.path), rules.filter((r) => r.kind === "exclude").map((r) => r.path)).readable.reduce((t, p) => t + (sizes.get(p) ?? 0), 0);

export async function removeContextRuleChecked(deps: SaveContextRuleDeps, who: { accountId: string; userId: string }, ruleId: string, confirm: boolean): Promise<void> {
  const timeouts = deps.timeouts ?? DEFAULT_CONTEXT_RULE_TIMEOUTS;
  try {
    // Does this removal need advice at all: an item's exclude, in a repository that has a repo-scope pin?
    const ask = confirm
      ? null
      : await rolledBack(deps, who, timeouts, async (client) => {
          const rule = (await client.query<{ work_item_id: string }>(`SELECT work_item_id FROM context_rules WHERE account_id = $1 AND id = $2 AND scope = 'item' AND kind = 'exclude'`, [who.accountId, ruleId])).rows[0];
          const facts = rule === undefined ? undefined : await readRepoFacts(client, who.accountId, { scope: "item", workItemId: rule.work_item_id });
          return rule !== undefined && facts?.repo_id && (await readRepoRules(client, who.accountId, facts.repo_id)).some((r) => r.kind === "pin") ? { itemId: rule.work_item_id, facts } : null;
        });
    let sizes: Map<string, number> | null = null;
    if (ask !== null) {
      try {
        sizes = await readTreeSizes(deps, who.accountId, ask.facts as RepoFacts, timeouts.githubMs);
      } catch (err) {
        // fx-swallow-ok: the warning is advice; with GitHub unreachable the removal proceeds (the code is fixed, the text never logged)
        if (!(err instanceof ContextRuleError)) throw err;
      }
    }
    await withTenant(deps.pool, who.accountId, who.userId, async (client) => {
      await boundTransaction(client, timeouts);
      // Counts, for any item rule: removing it can bring a same-path repository rule back. A set over the signed job's limits can never run, so this is refused
      // outright, `confirm` or not, under the same lock as the byte measure.
      const item = (await client.query<{ work_item_id: string }>(`SELECT work_item_id FROM context_rules WHERE account_id = $1 AND id = $2 AND scope = 'item'`, [who.accountId, ruleId])).rows[0];
      const fresh = item === undefined ? undefined : await readRepoFacts(client, who.accountId, { scope: "item", workItemId: item.work_item_id });
      if (item !== undefined && fresh?.repo_id) {
        await lockRepoRules(client, fresh.repo_id);
        const before = await readItemRules(client, who.accountId, item.work_item_id);
        const after = resolveContextRules(await readRepoRules(client, who.accountId, fresh.repo_id), before.filter((r) => r.scope === "item" && r.id !== ruleId));
        if (after.filter((r) => r.kind === "pin").length > MAX_JOB_PINS) throw new ContextRuleError("pins_exceed_ceiling");
        if (after.filter((r) => r.kind === "exclude").length > CONTEXT_EXCLUDES_MAX) throw new ContextRuleError("excludes_exceed_cap");
        if (ask !== null && sizes !== null) {
          const budget = effectiveContextBudget(deps.budgetRole ?? "executor", fresh.context_budget_bytes == null ? null : Number(fresh.context_budget_bytes));
          const added = liveBytes(after, sizes);
          if (added > budget && added > liveBytes(before, sizes)) throw new ContextRuleError("exclude_readds_pins");
        }
      }
      await client.query("SELECT context_rule_remove($1::uuid)", [ruleId]);
    });
  } catch (err) {
    throw mapRuleDbError(err);
  }
}
