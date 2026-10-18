import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * D#600 CX-5a: pins and excludes, the rules that keep a repository path in or out of a run's context (migration 0871). This module holds the
 * rules' shape, the path check, the read side and the thin calls to the two definer functions that are the only writers. It enforces nothing
 * on a run: the sandbox (CX-5b) and the runner daemon (CX-5c) read these rules.
 *
 * An item rule overrides a repo rule for the same path. That is worked out here when the rules are read (`resolveContextRules`), never stored,
 * so removing the item rule falls back to the repo rule with no other change.
 */

export const CONTEXT_RULE_KINDS = ['pin', 'exclude'] as const;
export type ContextRuleKind = (typeof CONTEXT_RULE_KINDS)[number];
export type ContextRuleScope = 'repo' | 'item';

export interface ContextRule {
  id: string;
  scope: ContextRuleScope;
  kind: ContextRuleKind;
  path: string;
  repoId: string | null;
  workItemId: string | null;
}

export const CONTEXT_RULE_PATH_MAX_CHARS = 512;

/** A refused rule. The code is the one the database's definer raises for the same input, or one the application's own check adds. */
export type ContextRuleErrorCode = 'invalid_path' | 'pins_exceed_budget' | 'tree_truncated' | 'tree_unavailable' | 'repo_not_connected';

export class ContextRuleError extends Error {
  readonly code: ContextRuleErrorCode;
  constructor(code: ContextRuleErrorCode) {
    super(code);
    this.name = 'ContextRuleError';
    this.code = code;
  }
}

const CONTROL_RE = /[\p{Cc}\u{85}\u{2028}\u{2029}\\]/u;
// A pin is a literal path: only * and ? are refused. [ ] { } are ordinary characters in a file name (app/[id]/page.tsx). CX-5b must escape them (and parentheses) when it builds tool rules from a pin or an exclude.
const GLOB_RE = /[*?]/;

/**
 * The same refusal as the definer's, made before the database (and GitHub) is asked. A path must be repository-relative: not empty, at most 512
 * characters, no control character or backslash, not absolute (a leading slash, a drive letter, or `~`), and no empty, `.` or `..` segment. A pin
 * is an exact path, so a glob character in a pin is refused; an exclude may be a glob.
 */
export function assertContextRulePath(kind: ContextRuleKind, path: unknown): asserts path is string {
  if (typeof path !== 'string' || path === '' || [...path].length > CONTEXT_RULE_PATH_MAX_CHARS || CONTROL_RE.test(path)) throw new ContextRuleError('invalid_path');
  if (path.startsWith('/') || /^~(\/|$)/.test(path) || /^[A-Za-z]:\//.test(path)) throw new ContextRuleError('invalid_path');
  if (path.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new ContextRuleError('invalid_path');
  if (kind === 'pin' && GLOB_RE.test(path)) throw new ContextRuleError('invalid_path');
}

const byPath = (a: ContextRule, b: ContextRule): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The rules in force for an item: its own, and the repo's for every path the item has no rule on. Sorted by path, so a list reads the same each time. */
export function resolveContextRules(repoRules: readonly ContextRule[], itemRules: readonly ContextRule[]): ContextRule[] {
  const overridden = new Set(itemRules.map((r) => r.path));
  return [...itemRules, ...repoRules.filter((r) => !overridden.has(r.path))].sort(byPath);
}

interface Row {
  id: string;
  scope: ContextRuleScope;
  kind: ContextRuleKind;
  path: string;
  repo_id: string | null;
  work_item_id: string | null;
}
const toRule = (r: Row): ContextRule => ({ id: r.id, scope: r.scope, kind: r.kind, path: r.path, repoId: r.repo_id, workItemId: r.work_item_id });
const COLUMNS = 'id, scope, kind, path, repo_id, work_item_id';

/** The rules of one repository (its repo scope), read on an open tenant client. The account filter is explicit on top of the forced row security. */
export async function readRepoRules(client: PoolClient, accountId: string, repoId: string): Promise<ContextRule[]> {
  const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM context_rules WHERE account_id = $1 AND scope = 'repo' AND repo_id = $2 ORDER BY path`, [accountId, repoId]);
  return rows.map(toRule).sort(byPath);
}

/** The rules in force for one item: the item's own over the repo's. An item of another account, or one that does not exist, has none. */
export async function readItemRules(client: PoolClient, accountId: string, workItemId: string): Promise<ContextRule[]> {
  const own = await client.query<Row>(`SELECT ${COLUMNS} FROM context_rules WHERE account_id = $1 AND scope = 'item' AND work_item_id = $2 ORDER BY path`, [accountId, workItemId]);
  const repo = await client.query<Row>(
    `SELECT c.id, c.scope, c.kind, c.path, c.repo_id, c.work_item_id FROM context_rules c
       JOIN work_items w ON w.account_id = c.account_id AND w.repo_id = c.repo_id
      WHERE c.account_id = $1 AND c.scope = 'repo' AND w.id = $2 ORDER BY c.path`,
    [accountId, workItemId],
  );
  return resolveContextRules(repo.rows.map(toRule), own.rows.map(toRule));
}

/**
 * The pin-budget view of one repository: its own rules, and the rules of every item of the repository that has any, grouped by item. A repo-scope
 * pin save must measure each item's resolved set (`resolveContextRules(repo, item)`), because the new repo pin lands in all of them.
 */
export async function readRepoPinSets(client: PoolClient, accountId: string, repoId: string): Promise<{ repo: ContextRule[]; items: Map<string, ContextRule[]> }> {
  const repo = await readRepoRules(client, accountId, repoId);
  const { rows } = await client.query<Row>(
    `SELECT c.id, c.scope, c.kind, c.path, c.repo_id, c.work_item_id FROM context_rules c
       JOIN work_items w ON w.account_id = c.account_id AND w.id = c.work_item_id
      WHERE c.account_id = $1 AND c.scope = 'item' AND w.repo_id = $2`,
    [accountId, repoId],
  );
  const items = new Map<string, ContextRule[]>();
  for (const r of rows.map(toRule)) items.set(r.workItemId!, [...(items.get(r.workItemId!) ?? []), r]);
  return { repo, items };
}

/** The read API: the rules of a repository, or the rules in force for an item. Another account's repository or item reads as an empty list. */
export async function listContextRules(pool: Pool, who: { accountId: string; userId: string }, target: { repoId: string } | { workItemId: string }): Promise<ContextRule[]> {
  return withTenant(pool, who.accountId, who.userId, (client) =>
    'repoId' in target ? readRepoRules(client, who.accountId, target.repoId) : readItemRules(client, who.accountId, target.workItemId),
  );
}

interface PgLikeError {
  code?: unknown;
  message?: unknown;
}

/** The definer's `invalid_path` becomes a ContextRuleError; every other database error (42501, P0002, 22023 invalid_message) passes through as it is. */
export function mapRuleDbError(err: unknown): unknown {
  const e = err as PgLikeError | null;
  return e !== null && typeof e === 'object' && e.code === '22023' && e.message === 'invalid_path' ? new ContextRuleError('invalid_path') : err;
}

export type ContextRuleTarget = { scope: 'repo'; repoId: string } | { scope: 'item'; workItemId: string };

/** Calls the definer on an open tenant client. Returns the rule's id. Saving the other kind for a path that has a rule in the same scope replaces it. */
export async function saveContextRuleOn(client: PoolClient, target: ContextRuleTarget, kind: ContextRuleKind, path: string): Promise<string> {
  assertContextRulePath(kind, path);
  try {
    const { rows } = await client.query<{ id: string }>('SELECT context_rule_save($1::text, $2::uuid, $3::uuid, $4::text, $5::text) AS id', [
      target.scope,
      target.scope === 'repo' ? target.repoId : null,
      target.scope === 'item' ? target.workItemId : null,
      kind,
      path,
    ]);
    return rows[0]!.id;
  } catch (err) {
    throw mapRuleDbError(err);
  }
}

/** Removes a rule: the next run no longer has the deny entry or the pin. A run already started keeps the rules it began with. */
export async function removeContextRule(pool: Pool, who: { accountId: string; userId: string }, ruleId: string): Promise<void> {
  await withTenant(pool, who.accountId, who.userId, async (client) => {
    await client.query('SELECT context_rule_remove($1::uuid)', [ruleId]);
  });
}
