import type { Pool, PoolClient } from "pg";
import { MAX_JOB_PINS } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { CONTEXT_EXCLUDES_MAX, ContextRuleError, mapRuleDbError, readItemRules, readRepoPinSets, resolveContextRules, saveContextRuleOn, type ContextRule, type ContextRuleKind, type ContextRuleTarget } from "@fx/core/src/context/contextRules.js";
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
 *
 * D#600 CX-9a: the GitHub read happens OUTSIDE any transaction, so no pooled tenant connection is held while GitHub is slow. A pin is saved in two steps:
 * a first transaction runs the definer (every privilege, path and lookup refusal) and the facts read, then is rolled back on purpose; the tree is read with
 * nothing held (capped at `githubMs`; a cap is `tree_unavailable`); a second transaction repeats the definer write, takes the repository lock
 * (`lock_timeout`; a timeout is `context_rules_busy`), reads the rules and measures. The sizes are those of the head read before the lock: a file that
 * changed in that gap (bounded by the lock wait) is measured at its earlier size, which is the same staleness every save has against later pushes, since
 * a lowered budget or a grown file never cuts a saved pin at run time. Rules are always read under the lock, so concurrent saves cannot both pass.
 * `idle_in_transaction_session_timeout` is short (`idleMs`): the transaction only ever waits on the database. Inside the lock the save also refuses a
 * resolved set with more than MAX_JOB_PINS pins (`pins_exceed_ceiling`, the signed Job's own limit) or more than CONTEXT_EXCLUDES_MAX excludes
 * (`excludes_exceed_cap`), measured against every set the new rule lands in.
 */

/** The first key of the per-repository advisory lock that serialises pin measurement (the second is `hashtext(repo id)`). Tests take the same lock. */
export const CONTEXT_RULES_LOCK_CLASS_SQL = "hashtext('fx.context_rules')";

/** The GitHub reads the budget check needs (structurally the `RepoTreeSource` of @fx/github). */
export interface PinTreeSource {
  headSha(): Promise<string | null>;
  tree(sha: string): Promise<{ truncated: boolean; entries: ReadonlyArray<{ path: string; type: "blob" | "tree" | "commit"; size?: number }> } | null>;
}

export interface ContextRuleTimeouts {
  /** How long a statement may wait for a lock (the repository's advisory lock, or a rule row another save holds). */
  lockMs: number;
  /** The most the whole GitHub phase (token, head, tree) may take. */
  githubMs: number;
  /** How long the write transaction may sit idle between its own statements. */
  idleMs: number;
}
/** The web catch-all answers within 30 s, so the GitHub phase stays under it. */
export const DEFAULT_CONTEXT_RULE_TIMEOUTS: ContextRuleTimeouts = { lockMs: 5_000, githubMs: 20_000, idleMs: 10_000 };

export interface SaveContextRuleDeps {
  pool: Pool;
  /** Opens the one-repository read client for the repository; throws when there is no installation. */
  openTree: (repo: { accountId: string; repoId: string; owner: string; name: string }) => Promise<PinTreeSource>;
  /** Whose default budget applies when the repository stored none. Pins serve the build, so the executor's. */
  budgetRole?: ContextBudgetRole;
  timeouts?: ContextRuleTimeouts;
}

export interface RepoFacts {
  repo_id: string | null;
  gh_owner: string | null;
  gh_name: string | null;
  installation_id: string | null;
  context_budget_bytes: number | null;
}

/** Sets the transaction's `lock_timeout` and `idle_in_transaction_session_timeout` (local to it). */
export async function boundTransaction(client: PoolClient, t: ContextRuleTimeouts): Promise<void> {
  await client.query("SELECT set_config('lock_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)", [`${t.lockMs}ms`, `${t.idleMs}ms`]);
}

/** The repository behind a rule target, with its connection facts and stored budget; undefined when the target does not exist. `repo_id` is null for an item with no repository. */
export async function readRepoFacts(client: PoolClient, accountId: string, target: ContextRuleTarget): Promise<RepoFacts | undefined> {
  const { rows } = await client.query<RepoFacts>(
    target.scope === "repo"
      ? `SELECT r.id AS repo_id, r.gh_owner, r.gh_name, r.installation_id, s.context_budget_bytes
           FROM repos r LEFT JOIN repo_context_settings s ON s.account_id = r.account_id AND s.repo_id = r.id
          WHERE r.account_id = $1 AND r.id = $2`
      : `SELECT r.id AS repo_id, r.gh_owner, r.gh_name, r.installation_id, s.context_budget_bytes
           FROM work_items w LEFT JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
           LEFT JOIN repo_context_settings s ON s.account_id = r.account_id AND s.repo_id = r.id
          WHERE w.account_id = $1 AND w.id = $2`,
    [accountId, target.scope === "repo" ? target.repoId : target.workItemId],
  );
  return rows[0];
}

/** Blob sizes at the default branch's head. Fail closed: any problem is a ContextRuleError. The whole GitHub phase is capped at `githubMs`. */
export async function readTreeSizes(deps: Pick<SaveContextRuleDeps, "openTree">, accountId: string, facts: RepoFacts | undefined, githubMs: number): Promise<Map<string, number>> {
  if (!facts || facts.repo_id === null || !facts.gh_owner || !facts.gh_name || facts.installation_id === null) throw new ContextRuleError("repo_not_connected");
  const repo = { accountId, repoId: facts.repo_id, owner: facts.gh_owner, name: facts.gh_name };
  const read = (async () => {
    try {
      const source = await deps.openTree(repo);
      const head = await source.headSha();
      const tree = head === null ? null : await source.tree(head);
      if (tree === null) throw new ContextRuleError("tree_unavailable");
      if (tree.truncated) throw new ContextRuleError("tree_truncated");
      const sizes = new Map<string, number>();
      for (const e of tree.entries) if (e.type === "blob") sizes.set(e.path, e.size ?? 0);
      return sizes;
    } catch (err) {
      if (err instanceof ContextRuleError) throw err;
      // fx-swallow-ok: a GitHub failure refuses the pin with a fixed code; the error text is not passed on (it may carry repository names)
      throw new ContextRuleError("tree_unavailable");
    }
  })();
  // fx-swallow-ok: when the cap below wins, the read is abandoned (the client bounds each call at 15 s); its later failure has no one left to report to
  read.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ContextRuleError("tree_unavailable")), githubMs);
  });
  try {
    return await Promise.race([read, cap]);
  } finally {
    clearTimeout(timer);
  }
}

/** Serialises measurement per repository (CWE-367). Released at commit or rollback; the wait is bounded by the transaction's `lock_timeout`. */
export async function lockRepoRules(client: PoolClient, repoId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(${CONTEXT_RULES_LOCK_CLASS_SQL}, hashtext($1::text))`, [repoId]);
}

/**
 * The resolved rule sets a rule on `target` lands in. A repo rule lands in the repo's own set and in every item's resolved set (an item rule overrides a
 * repo rule for its path); an item rule lands in that item's set only. Every one of them must fit (CWE-840: the check runs in both directions).
 */
export async function readResolvedSets(client: PoolClient, accountId: string, target: ContextRuleTarget): Promise<ContextRule[][]> {
  if (target.scope === "item") return [await readItemRules(client, accountId, target.workItemId)];
  const v = await readRepoPinSets(client, accountId, target.repoId);
  return [v.repo, ...[...v.items.values()].map((itemRules) => resolveContextRules(v.repo, itemRules))];
}

class RolledBack<T> extends Error {
  constructor(readonly value: T) {
    super("rolled_back");
  }
}
/** Runs `body` in a bounded tenant transaction and rolls it back, returning what it read. Its writes (and their audit rows) never persist. */
export async function rolledBack<T>(deps: Pick<SaveContextRuleDeps, "pool">, who: { accountId: string; userId: string }, t: ContextRuleTimeouts, body: (client: PoolClient) => Promise<T>): Promise<T> {
  try {
    await withTenant(deps.pool, who.accountId, who.userId, async (client) => {
      await boundTransaction(client, t);
      throw new RolledBack(await body(client));
    });
  } catch (err) {
    if (err instanceof RolledBack) return err.value as T;
    throw err;
  }
  throw new Error("rolledBack: the transaction did not roll back");
}

/** The bytes of the set's pins (a pin whose path is not a file in the tree counts 0). */
export const pinBytes = (rules: readonly ContextRule[], sizes: ReadonlyMap<string, number>): number => rules.reduce((t, r) => (r.kind === "pin" ? t + (sizes.get(r.path) ?? 0) : t), 0);

/** Saves a rule. Returns its id. Throws ContextRuleError (`invalid_path`, `pins_exceed_budget`, `pins_exceed_ceiling`, `excludes_exceed_cap`, `context_rules_busy`, `tree_truncated`, `tree_unavailable`, `repo_not_connected`) or the database's own error. */
export async function saveContextRule(
  deps: SaveContextRuleDeps,
  who: { accountId: string; userId: string },
  target: ContextRuleTarget,
  kind: ContextRuleKind,
  path: string,
): Promise<{ id: string }> {
  const timeouts = deps.timeouts ?? DEFAULT_CONTEXT_RULE_TIMEOUTS;
  try {
    // Only a pin needs GitHub. Its refusals (privilege, path, lookup) come first, in a transaction that is rolled back; the tree is then read with no
    // connection held (see the header), and the write below repeats the definer call.
    const sizes =
      kind === "pin"
        ? await readTreeSizes(
            deps,
            who.accountId,
            await rolledBack(deps, who, timeouts, async (client) => {
              await saveContextRuleOn(client, target, kind, path);
              return readRepoFacts(client, who.accountId, target);
            }),
            timeouts.githubMs,
          )
        : null;
    return await withTenant(deps.pool, who.accountId, who.userId, async (client) => {
      await boundTransaction(client, timeouts);
      const id = await saveContextRuleOn(client, target, kind, path);
      const facts = await readRepoFacts(client, who.accountId, target);
      // The second save waits for the first to commit and then reads its row. An item with no repository shares its sets with no one.
      if (facts?.repo_id) await lockRepoRules(client, facts.repo_id);
      const sets = await readResolvedSets(client, who.accountId, target);
      if (sizes === null) {
        if (sets.some((rules) => rules.filter((r) => r.kind === "exclude").length > CONTEXT_EXCLUDES_MAX)) throw new ContextRuleError("excludes_exceed_cap");
        return { id };
      }
      if (sets.some((rules) => rules.filter((r) => r.kind === "pin").length > MAX_JOB_PINS)) throw new ContextRuleError("pins_exceed_ceiling");
      const budget = effectiveContextBudget(deps.budgetRole ?? "executor", facts?.context_budget_bytes == null ? null : Number(facts.context_budget_bytes));
      if (sets.some((rules) => pinBytes(rules, sizes) > budget)) throw new ContextRuleError("pins_exceed_budget");
      return { id };
    });
  } catch (err) {
    throw mapRuleDbError(err);
  }
}
