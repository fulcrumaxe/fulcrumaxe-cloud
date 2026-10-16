import type { Pool, PoolClient } from 'pg';
import { validateRuleSet, type RuleError, type RuleSet } from '@fx/decisions';
import { withTenant } from './withTenant.js';

/**
 * The customer's approval rules for tool calls (D#7 AAP-a2), over migrations/0847_action_rules.sql.
 *
 * Append-only (C8): every change is a new version row, and the audit row naming the previous and the new versions and both hashes is
 * written in the same transaction. Nothing here issues an UPDATE or a DELETE, and app_user holds neither. A scope is `(account)` or
 * `(account, repo)`. The current set for a scope is its highest version, so an edit applies to the next request. Undo is a new version:
 * a rollback copies an earlier version, and "delete all rules" is a new empty version where everything asks.
 *
 * The `app.user_id` of the transaction is the actor and `changed_by`, never an input (the table policy requires them to be equal and to be
 * an owner or admin of the account).
 */

export type ActionRulesErrorCode = 'action_rules_invalid' | 'action_rules_repo_invalid' | 'action_rules_version_not_found' | 'action_rules_version_conflict';

/** Thrown before any write, or on a lost version race. `code` is the named error; branch on it, not on the message. */
export class ActionRulesError extends Error {
  constructor(
    readonly code: ActionRulesErrorCode,
    /** For `action_rules_invalid`: the validator's own codes and paths, unchanged. */
    readonly errors: readonly RuleError[] = [],
  ) {
    super(code);
    this.name = 'ActionRulesError';
  }
}

export interface ActionRulesVersion {
  id: string;
  accountId: string;
  repoId: string | null;
  version: number;
  rules: RuleSet;
  ruleCount: number;
  rulesSha256: string;
  restoredFromVersion: number | null;
  changedBy: string;
  createdAt: Date;
}

/** A history line: no rules, and the author as a name. */
export interface ActionRulesHistoryEntry {
  version: number;
  ruleCount: number;
  rulesSha256: string;
  restoredFromVersion: number | null;
  /** The author's name; a person with no name on file reads as a team member, never as an id. */
  changedByName: string;
  createdAt: Date;
}

/** The existing wording used where a member has no name on file (packages/core/src/runs/read.ts). */
const UNNAMED_MEMBER = 'A team member';

interface Row {
  id: string;
  account_id: string;
  repo_id: string | null;
  version: number;
  rules: RuleSet;
  rule_count: number;
  rules_sha256: string;
  restored_from_version: number | null;
  changed_by: string;
  created_at: Date;
}

const map = (r: Row): ActionRulesVersion => ({
  id: r.id,
  accountId: r.account_id,
  repoId: r.repo_id,
  version: r.version,
  rules: r.rules,
  ruleCount: r.rule_count,
  rulesSha256: r.rules_sha256,
  restoredFromVersion: r.restored_from_version,
  changedBy: r.changed_by,
  createdAt: r.created_at,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY: RuleSet = { rules: [] };

/** The highest version of one scope, or null when nothing was ever written there. RLS scopes it to the transaction's account. */
export async function currentActionRules(client: PoolClient, repoId: string | null): Promise<ActionRulesVersion | null> {
  const { rows } = await client.query<Row>(
    `SELECT * FROM action_rules WHERE repo_id IS NOT DISTINCT FROM $1::uuid ORDER BY version DESC LIMIT 1`,
    [repoId],
  );
  return rows[0] ? map(rows[0]) : null;
}

export interface ResolvedActionRules {
  /** The set that decides: the repo's own when the repo has one, else the account's, else the empty set (everything asks). */
  rules: RuleSet;
  /** The scope the set came from; `none` (version 0) when there is no row at all. */
  scope: 'repo' | 'account' | 'none';
  version: number;
}

/**
 * The set that applies to a request on `repoId`. A repo-scoped version overrides the account's, even when it is empty (an empty repo set
 * means "everything asks on this repo"). No row anywhere is the empty set, so every call asks a person.
 */
export async function resolveActionRules(client: PoolClient, repoId: string | null): Promise<ResolvedActionRules> {
  if (repoId !== null) {
    const own = await currentActionRules(client, repoId);
    if (own) return { rules: own.rules, scope: 'repo', version: own.version };
  }
  const account = await currentActionRules(client, null);
  return account ? { rules: account.rules, scope: 'account', version: account.version } : { rules: EMPTY, scope: 'none', version: 0 };
}

/** Every version ever written for one scope, newest first, with the author's name. */
export async function listActionRulesHistory(client: PoolClient, repoId: string | null): Promise<ActionRulesHistoryEntry[]> {
  const { rows } = await client.query<{
    version: number;
    rule_count: number;
    rules_sha256: string;
    restored_from_version: number | null;
    author: string;
    created_at: Date;
  }>(
    `SELECT r.version, r.rule_count, r.rules_sha256, r.restored_from_version, r.created_at,
            COALESCE(NULLIF(u.name, ''), NULLIF(u.github_login, ''), $2) AS author
       FROM action_rules r LEFT JOIN users u ON u.id = r.changed_by
      WHERE r.repo_id IS NOT DISTINCT FROM $1::uuid
      ORDER BY r.version DESC`,
    [repoId, UNNAMED_MEMBER],
  );
  return rows.map((r) => ({
    version: r.version,
    ruleCount: r.rule_count,
    rulesSha256: r.rules_sha256,
    restoredFromVersion: r.restored_from_version,
    changedByName: r.author,
    createdAt: r.created_at,
  }));
}

export interface AppendActionRulesInput {
  accountId: string;
  /** Null is the account scope. */
  repoId: string | null;
  /** The whole set, unvalidated: it is validated here before anything is written. */
  rules: unknown;
  changedBy: string;
}

async function insertVersion(
  client: PoolClient,
  input: { accountId: string; repoId: string | null; rules: RuleSet; restoredFrom: number | null; changedBy: string },
): Promise<ActionRulesVersion> {
  const { accountId, repoId, restoredFrom, changedBy } = input;
  // One writer at a time per scope: the lock is held to commit, so the "previous" read below is still the previous at insert time and
  // two concurrent appends take two different versions instead of one failing. (No FOR UPDATE: that needs UPDATE, which app_user lacks.)
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`action_rules:${accountId}:${repoId ?? ''}`]);
  const previous = await currentActionRules(client, repoId);
  let inserted: ActionRulesVersion;
  try {
    const { rows } = await client.query<Row>(
      `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, restored_from_version, changed_by)
       VALUES ($1, $2, $3, $4::jsonb, jsonb_array_length($4::jsonb -> 'rules'),
               encode(sha256(convert_to(($4::jsonb)::text, 'UTF8')), 'hex'), $5, $6)
       RETURNING *`,
      [accountId, repoId, previous ? previous.version + 1 : 1, JSON.stringify(input.rules), restoredFrom, changedBy],
    );
    inserted = map(rows[0]!);
  } catch (err) {
    // Only reachable if something wrote without taking the lock: the loser fails on the UNIQUE key (23505) or the next-version trigger.
    const e = err as { code?: string; message?: string } | null;
    if (e?.code === '23505' || (e?.code === '23514' && /^action_rules\.version must be/.test(e.message ?? ''))) {
      throw new ActionRulesError('action_rules_version_conflict');
    }
    throw err;
  }
  await client.query(`SELECT audit_write_action_rules('action_rules.changed', $1::jsonb)`, [
    JSON.stringify({
      actor: changedBy,
      repo_id: repoId,
      previous_version: previous?.version ?? null,
      new_version: inserted.version,
      previous_rules_sha256: previous?.rulesSha256 ?? null,
      new_rules_sha256: inserted.rulesSha256,
      restored_from_version: restoredFrom,
    }),
  ]);
  return inserted;
}

/** A lone UTF-16 surrogate: JSON can carry one, Postgres jsonb (UTF-8) cannot store it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * The JSON-pointer path of the first string (value or object key) Postgres jsonb cannot store: one holding a NUL character or a lone
 * surrogate. The validator accepts such a value as an ordinary string, so the writer refuses it here, as invalid input, instead of letting
 * the database fail the insert (which would surface as a server error).
 */
function findUnstorableString(value: unknown, path = ''): string | null {
  if (typeof value === 'string') return value.includes('\u0000') || LONE_SURROGATE.test(value) ? path : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findUnstorableString(value[i], `${path}/${i}`);
      if (hit !== null) return hit;
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (k.includes('\u0000') || LONE_SURROGATE.test(k)) return `${path}/${k.replace(/[\u0000\ud800-\udfff]/g, '?')}`;
      const hit = findUnstorableString(v, `${path}/${k}`);
      if (hit !== null) return hit;
    }
  }
  return null;
}

function assertStorable(set: RuleSet): void {
  const at = findUnstorableString(set);
  if (at !== null) throw new ActionRulesError('action_rules_invalid', [{ code: 'value_invalid', path: at }]);
}

function assertRepo(repoId: string | null): void {
  if (repoId !== null && !UUID_RE.test(repoId)) throw new ActionRulesError('action_rules_repo_invalid');
}

/**
 * Validates the set (refusing with the validator's own codes, inserting nothing) and appends it as the next version of its scope, with
 * its audit row, on a client that already holds a `withTenant` transaction opened as `changedBy`.
 */
export async function appendRuleSet(client: PoolClient, input: AppendActionRulesInput): Promise<ActionRulesVersion> {
  assertRepo(input.repoId);
  const result = validateRuleSet(input.rules);
  if (!result.ok) throw new ActionRulesError('action_rules_invalid', result.errors);
  assertStorable(result.set);
  return insertVersion(client, { accountId: input.accountId, repoId: input.repoId, rules: result.set, restoredFrom: null, changedBy: input.changedBy });
}

/**
 * Rollback to version `toVersion` of one scope: a NEW version holding that version's rules, naming it in `restored_from_version`. Older
 * rows are not touched. The restored rules are validated again, so a set stored under older limits cannot come back through here.
 */
export async function rollbackRuleSet(
  client: PoolClient,
  input: { accountId: string; repoId: string | null; toVersion: number; changedBy: string },
): Promise<ActionRulesVersion> {
  assertRepo(input.repoId);
  const { rows } = await client.query<Row>(`SELECT * FROM action_rules WHERE repo_id IS NOT DISTINCT FROM $1::uuid AND version = $2`, [
    input.repoId,
    input.toVersion,
  ]);
  if (!rows[0]) throw new ActionRulesError('action_rules_version_not_found');
  const result = validateRuleSet(rows[0].rules);
  if (!result.ok) throw new ActionRulesError('action_rules_invalid', result.errors);
  return insertVersion(client, {
    accountId: input.accountId,
    repoId: input.repoId,
    rules: result.set,
    restoredFrom: rows[0].version,
    changedBy: input.changedBy,
  });
}

export interface WriteActionRulesContext {
  pool: Pool;
  /** The AUTHENTICATED caller's user id; never a request field. */
  principal: string;
}

/** One rule change as one transaction: the version row and its audit row commit together, or neither does. */
export async function writeActionRules(ctx: WriteActionRulesContext, input: Omit<AppendActionRulesInput, 'changedBy'>): Promise<ActionRulesVersion> {
  return withTenant(ctx.pool, input.accountId, ctx.principal, (client) => appendRuleSet(client, { ...input, changedBy: ctx.principal }));
}
