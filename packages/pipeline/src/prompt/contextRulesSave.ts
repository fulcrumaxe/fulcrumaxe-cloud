import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { ContextRuleError, readItemRules, readRepoPinSets, resolveContextRules, saveContextRuleOn, type ContextRule, type ContextRuleKind, type ContextRuleTarget } from "@fx/core/src/context/contextRules.js";
import { effectiveContextBudget, type ContextBudgetRole } from "./contextBudget.js";

/**
 * D#600 CX-5a: saving a pin or an exclude. The database's definer (migration 0871) decides who may write and what a path may be; this adds the one
 * check a function cannot make, whether the pins still fit the repository's budget, because it needs GitHub. The sizes come from the git trees API at
 * the default branch's head (a blob's `size`), measured against the repository's stored budget or, with none, the executor's default.
 *
 * Order: the definer writes first, inside the caller's transaction, so every privilege, path and lookup refusal comes before any GitHub call; the
 * pin set (the rules in force after the write) is then measured, and a set over the budget throws, which rolls the write back: nothing is written.
 * Fail closed: no installation, no head, no tree, a truncated tree (GitHub cut it, so the sizes cannot be trusted) or a GitHub error refuses the pin
 * with a clear code and writes nothing. A pin whose path is not a file in the tree counts 0 bytes (it reads as missing at run time and never blocks).
 * Saving an exclude makes no GitHub call.
 */

/** The first key of the per-repository advisory lock that serialises pin measurement (the second is `hashtext(repo id)`). Tests take the same lock. */
export const CONTEXT_RULES_LOCK_CLASS_SQL = "hashtext('fx.context_rules')";

/** The GitHub reads the budget check needs (structurally the `RepoTreeSource` of @fx/github). */
export interface PinTreeSource {
  headSha(): Promise<string | null>;
  tree(sha: string): Promise<{ truncated: boolean; entries: ReadonlyArray<{ path: string; type: "blob" | "tree" | "commit"; size?: number }> } | null>;
}

export interface SaveContextRuleDeps {
  pool: Pool;
  /** Opens the one-repository read client for the repository; throws when there is no installation. */
  openTree: (repo: { accountId: string; repoId: string; owner: string; name: string }) => Promise<PinTreeSource>;
  /** Whose default budget applies when the repository stored none. Pins serve the build, so the executor's. */
  budgetRole?: ContextBudgetRole;
}

interface RepoFacts {
  repo_id: string | null;
  gh_owner: string | null;
  gh_name: string | null;
  installation_id: string | null;
  context_budget_bytes: number | null;
}

/** Saves a rule. Returns its id. Throws ContextRuleError (`invalid_path`, `pins_exceed_budget`, `tree_truncated`, `tree_unavailable`, `repo_not_connected`) or the database's own error. */
export async function saveContextRule(
  deps: SaveContextRuleDeps,
  who: { accountId: string; userId: string },
  target: ContextRuleTarget,
  kind: ContextRuleKind,
  path: string,
): Promise<{ id: string }> {
  // CX-9's write route should run this under `lock_timeout` and `idle_in_transaction_session_timeout`: the transaction stays open across the GitHub
  // reads (each bounded at 15 s by the client) and then may wait on the per-repository lock.
  return withTenant(deps.pool, who.accountId, who.userId, async (client) => {
    const id = await saveContextRuleOn(client, target, kind, path);
    if (kind !== "pin") return { id };

    const facts = (
      await client.query<RepoFacts>(
        target.scope === "repo"
          ? `SELECT r.id AS repo_id, r.gh_owner, r.gh_name, r.installation_id, s.context_budget_bytes
               FROM repos r LEFT JOIN repo_context_settings s ON s.account_id = r.account_id AND s.repo_id = r.id
              WHERE r.account_id = $1 AND r.id = $2`
          : `SELECT r.id AS repo_id, r.gh_owner, r.gh_name, r.installation_id, s.context_budget_bytes
               FROM work_items w LEFT JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
               LEFT JOIN repo_context_settings s ON s.account_id = r.account_id AND s.repo_id = r.id
              WHERE w.account_id = $1 AND w.id = $2`,
        [who.accountId, target.scope === "repo" ? target.repoId : target.workItemId],
      )
    ).rows[0];
    if (!facts || facts.repo_id === null || !facts.gh_owner || !facts.gh_name || facts.installation_id === null) throw new ContextRuleError("repo_not_connected");

    let entries: ReadonlyArray<{ path: string; type: string; size?: number }>;
    try {
      const source = await deps.openTree({ accountId: who.accountId, repoId: facts.repo_id, owner: facts.gh_owner, name: facts.gh_name });
      const head = await source.headSha();
      const tree = head === null ? null : await source.tree(head);
      if (tree === null) throw new ContextRuleError("tree_unavailable");
      if (tree.truncated) throw new ContextRuleError("tree_truncated");
      entries = tree.entries;
    } catch (err) {
      if (err instanceof ContextRuleError) throw err;
      // fx-swallow-ok: a GitHub failure refuses the pin with a fixed code; the error text is not passed on (it may carry repository names)
      throw new ContextRuleError("tree_unavailable");
    }
    // Serialise the measurement per repository (CWE-367): two saves of different paths do not conflict on the unique index, and under READ COMMITTED
    // neither sees the other's uncommitted row, so without this both could pass. Taken after the GitHub fetch and before the rule read, so it is held
    // for milliseconds; the second save waits for the first to commit and then reads its row. Released at commit or rollback.
    await client.query(`SELECT pg_advisory_xact_lock(${CONTEXT_RULES_LOCK_CLASS_SQL}, hashtext($1::text))`, [facts.repo_id]);
    // The pin sets the new rule lands in. A repo pin lands in the repo's own set and in every item's resolved set (an item rule overrides a repo rule
    // for its path); an item pin lands in that item's set only. Every one of them must fit (CWE-840: the check runs in both directions).
    const sets: ContextRule[][] =
      target.scope === "item"
        ? [await readItemRules(client, who.accountId, target.workItemId)]
        : await readRepoPinSets(client, who.accountId, target.repoId).then((v) => [v.repo, ...[...v.items.values()].map((itemRules) => resolveContextRules(v.repo, itemRules))]);
    const sizes = new Map<string, number>();
    for (const e of entries) if (e.type === "blob") sizes.set(e.path, e.size ?? 0);
    const budget = effectiveContextBudget(deps.budgetRole ?? "executor", facts.context_budget_bytes === null ? null : Number(facts.context_budget_bytes));
    for (const rules of sets) {
      let total = 0;
      for (const r of rules) if (r.kind === "pin") total += sizes.get(r.path) ?? 0;
      if (total > budget) throw new ContextRuleError("pins_exceed_budget");
    }
    return { id };
  });
}
