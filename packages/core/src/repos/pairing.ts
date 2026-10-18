import type { Pool, PoolClient } from 'pg';
import { InvalidRoleSettingsInputError } from '../role-settings/errors.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { requireOwnerOrAdmin, type MembershipRole } from '../tenancy/authorize.js';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { assertRepoIdShape } from './read.js';

/**
 * A repository's optional pairing with a public code repo. NO ROW MEANS OFF: the state is derived from the current row, never
 * stamped on items, and clearing the row returns the repository to the single-repo path. Nothing reads this to route a push yet.
 */
export interface RepoPairingCtx {
  /** app_user pool -- every read and write here goes through withTenant/RLS. */
  pool: Pool;
  principal: { accountId: string; userId: string };
}

/** Defined once, beside the push route that reads it, in the runner protocol package. */
import type { RepoPairing } from '@fulcrumaxe/runner-protocol/repoPairing';
export type { RepoPairing };

export interface SetRepoPairingInput {
  codeRepo: string;
  overlayGlobs: string[];
  identifierRulesPath?: string | null;
  planDataRulesPath?: string | null;
}

// These three mirror the CHECK constraints in migration 0799, so a bad value is a 422 with its field instead of a database error.
const CODE_REPO_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
const PATH_RE = /^[A-Za-z0-9._/*?{},@+=~-]{1,200}$/;
const GLOB_CHARS_RE = /[*?{},]/;
export const MAX_OVERLAY_GLOBS = 100;

function pathOk(p: unknown): p is string {
  return typeof p === 'string' && PATH_RE.test(p) && !p.startsWith('/') && !p.includes('//') && !/(^|\/)\.\.(\/|$)/.test(p);
}

function invalid(message: string, field: string): never {
  throw new InvalidRoleSettingsInputError(message, field);
}

function validate(input: SetRepoPairingInput): void {
  if (typeof input.codeRepo !== 'string' || !CODE_REPO_RE.test(input.codeRepo) || ['.', '..'].includes(input.codeRepo.split('/')[1]!)) {
    invalid('the paired repo must be written owner/name', 'code_repo');
  }
  const globs = input.overlayGlobs;
  if (!Array.isArray(globs) || globs.length < 1) invalid('at least one private path is required', 'overlay_globs');
  if (globs.length > MAX_OVERLAY_GLOBS) invalid(`at most ${MAX_OVERLAY_GLOBS} private paths`, 'overlay_globs');
  if (!globs.every(pathOk)) invalid('a private path is empty, too long, absolute, climbs out of the repo or has a character that is not allowed', 'overlay_globs');
  if (new Set(globs).size !== globs.length) invalid('a private path is listed twice', 'overlay_globs');
  for (const [value, field] of [
    [input.identifierRulesPath, 'identifier_rules_path'],
    [input.planDataRulesPath, 'plan_data_rules_path'],
  ] as const) {
    if (value !== undefined && value !== null && (!pathOk(value) || GLOB_CHARS_RE.test(value))) {
      invalid('a rule file must be one plain path inside the private repo', field);
    }
  }
}

interface PairingRow {
  code_repo: string;
  overlay_globs: string[];
  identifier_rules_path: string | null;
  plan_data_rules_path: string | null;
}

function toPairing(row: PairingRow | undefined): RepoPairing {
  if (!row) return { enabled: false, codeRepo: null, overlayGlobs: [], identifierRulesPath: null, planDataRulesPath: null };
  return {
    enabled: true,
    codeRepo: row.code_repo,
    overlayGlobs: row.overlay_globs,
    identifierRulesPath: row.identifier_rules_path,
    planDataRulesPath: row.plan_data_rules_path,
  };
}

/** The audit payload keeps the API's snake_case names, so the log reads the same as the response. */
function auditShape(p: RepoPairing): Record<string, unknown> {
  return { enabled: p.enabled, code_repo: p.codeRepo, overlay_globs: p.overlayGlobs, identifier_rules_path: p.identifierRulesPath, plan_data_rules_path: p.planDataRulesPath };
}

const PAIRING_COLUMNS = 'code_repo, overlay_globs, identifier_rules_path, plan_data_rules_path';

/** The repo's own `owner/name` (null before a sync), also proving the repo is the caller's: a missing or other-tenant repo is a NotFoundError. */
async function ownFullName(client: PoolClient, repoId: string): Promise<string | null> {
  const { rows } = await client.query<{ gh_owner: string | null; gh_name: string | null }>('SELECT gh_owner, gh_name FROM repos WHERE id = $1', [repoId]);
  const row = rows[0];
  if (!row) throw new NotFoundError(`repos ${repoId} not found`);
  return row.gh_owner && row.gh_name ? `${row.gh_owner}/${row.gh_name}` : null;
}

async function requireAdmin(client: PoolClient, accountId: string, userId: string): Promise<void> {
  await assertActiveMembership(client, accountId, userId);
  const { rows } = await client.query<{ role: MembershipRole }>('SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
  requireOwnerOrAdmin(rows[0]?.role ?? null);
}

async function audit(client: PoolClient, action: 'repo_pairing.set' | 'repo_pairing.cleared', payload: Record<string, unknown>): Promise<void> {
  await client.query('SELECT audit_write_repo_pairing($1::text, $2::jsonb)', [action, JSON.stringify(payload)]);
}

/** Any active member may read. A repo with no row reads as off. */
export async function getRepoPairing(ctx: RepoPairingCtx, repoId: string): Promise<RepoPairing> {
  assertRepoIdShape(repoId);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    await ownFullName(client, repoId);
    const { rows } = await client.query<PairingRow>(`SELECT ${PAIRING_COLUMNS} FROM repo_pairing WHERE repo_id = $1`, [repoId]);
    return toPairing(rows[0]);
  });
}

/** Owner or admin. Turns pairing on, or replaces the existing row; one audit row. Changing it affects only items started afterwards. */
export async function setRepoPairing(ctx: RepoPairingCtx, repoId: string, input: SetRepoPairingInput): Promise<RepoPairing> {
  assertRepoIdShape(repoId);
  validate(input);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await requireAdmin(client, accountId, userId);
    const own = await ownFullName(client, repoId);
    if (own !== null && own.toLowerCase() === input.codeRepo.toLowerCase()) {
      invalid('the paired public repo must be a different repo from this one', 'code_repo');
    }
    const { rows: beforeRows } = await client.query<PairingRow>(`SELECT ${PAIRING_COLUMNS} FROM repo_pairing WHERE repo_id = $1 FOR UPDATE`, [repoId]);
    const { rows } = await client.query<PairingRow>(
      `INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs, identifier_rules_path, plan_data_rules_path, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (repo_id) DO UPDATE
          SET code_repo = EXCLUDED.code_repo, overlay_globs = EXCLUDED.overlay_globs,
              identifier_rules_path = EXCLUDED.identifier_rules_path, plan_data_rules_path = EXCLUDED.plan_data_rules_path,
              updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING ${PAIRING_COLUMNS}`,
      [repoId, accountId, input.codeRepo, input.overlayGlobs, input.identifierRulesPath ?? null, input.planDataRulesPath ?? null, userId],
    );
    const after = toPairing(rows[0]);
    await audit(client, 'repo_pairing.set', { repo_id: repoId, before: auditShape(toPairing(beforeRows[0])), after: auditShape(after) });
    return after;
  });
}

/**
 * Owner or admin. Removes the pairing: new items go back to the single-repo path. Public PRs already open stay open. Clearing a repo
 * that is already off changes nothing and writes no audit row. Returns whether a pairing was removed.
 */
export async function clearRepoPairing(ctx: RepoPairingCtx, repoId: string): Promise<boolean> {
  assertRepoIdShape(repoId);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await requireAdmin(client, accountId, userId);
    await ownFullName(client, repoId);
    const { rows } = await client.query<PairingRow>(`DELETE FROM repo_pairing WHERE repo_id = $1 RETURNING ${PAIRING_COLUMNS}`, [repoId]);
    if (rows.length === 0) return false;
    await audit(client, 'repo_pairing.cleared', { repo_id: repoId, before: auditShape(toPairing(rows[0])) });
    return true;
  });
}
