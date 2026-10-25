import type { Pool, PoolClient } from 'pg';
import { InvalidRoleSettingsInputError } from '../role-settings/errors.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { requireOwnerOrAdmin, type MembershipRole } from '../tenancy/authorize.js';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { assertRepoIdShape } from './read.js';
import { redactEventText } from '../events/redact.js';
import { checkPrFooter } from '@fulcrumaxe/runner-protocol/planePushText';
import { uncoveredRuleFiles } from '@fulcrumaxe/runner-protocol/repoPairing';

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
  /** Optional pull request body footer template; omitted, null or empty means none. */
  prFooter?: string | null;
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

/** The shape rules alone (no database, no GitHub); `setRepoPairing` runs them again, so a caller may check first and spend nothing on a bad input. */
export function validatePairingInput(input: SetRepoPairingInput): void {
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
  // A rule file decides what may be published, so it must itself be a private path (matched as the push scan matches them). The push route
  // refuses the same for a pairing stored before this check.
  const uncovered = uncoveredRuleFiles({ overlayGlobs: globs, identifierRulesPath: input.identifierRulesPath ?? null, planDataRulesPath: input.planDataRulesPath ?? null });
  if (uncovered.length > 0) {
    invalid('rule files must be private paths: list the file, or a folder that holds it, under private paths', uncovered[0] === 'identifierRulesPath' ? 'identifier_rules_path' : 'plan_data_rules_path');
  }
  const footer = footerOrNull(input.prFooter);
  if (footer !== null) {
    const why = checkPrFooter(footer, input.codeRepo);
    if (why !== null) invalid(why, 'pr_footer');
    // A public pull request body: nothing shaped like a credential, in a known format or as a long unbroken token.
    if (redactEventText(footer) !== footer || /[A-Za-z0-9+_=-]{32,}/.test(footer)) invalid('the footer looks like it contains a secret', 'pr_footer');
  }
}

/** Empty (or only spaces) is "none"; anything else is kept exactly, and `validate` refuses what it dislikes. */
function footerOrNull(v: string | null | undefined): string | null {
  return typeof v === 'string' && v.trim() === '' ? null : (v ?? null);
}

interface PairingRow {
  code_repo: string;
  overlay_globs: string[];
  identifier_rules_path: string | null;
  plan_data_rules_path: string | null;
  pr_footer: string | null;
}

function toPairing(row: PairingRow | undefined): RepoPairing {
  if (!row) return { enabled: false, codeRepo: null, overlayGlobs: [], identifierRulesPath: null, planDataRulesPath: null, prFooter: null };
  return {
    enabled: true,
    codeRepo: row.code_repo,
    overlayGlobs: row.overlay_globs,
    identifierRulesPath: row.identifier_rules_path,
    planDataRulesPath: row.plan_data_rules_path,
    prFooter: row.pr_footer,
  };
}

/** The audit payload keeps the API's snake_case names, so the log reads the same as the response. */
function auditShape(p: RepoPairing): Record<string, unknown> {
  return { enabled: p.enabled, code_repo: p.codeRepo, overlay_globs: p.overlayGlobs, identifier_rules_path: p.identifierRulesPath, plan_data_rules_path: p.planDataRulesPath, pr_footer: p.prFooter };
}

const PAIRING_COLUMNS = 'code_repo, overlay_globs, identifier_rules_path, plan_data_rules_path, pr_footer';

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

/** How many of the account's other repositories the picker looks at. */
export const MAX_PAIRING_CANDIDATES = 30;

export interface PairingCandidate {
  fullName: string;
  /** The GitHub installation our own rows say serves this repo, and which App it belongs to: what a read of the repo may be made with. */
  installationId: number;
  appKind: 'team' | 'team_readonly';
}

/**
 * Owner or admin. The account's OTHER repositories that have a write or read-only App installation, for the pairing picker (the screen then asks
 * GitHub which of them are public, with the installation recorded here). Repos are the caller's own through RLS; the repo asked about must be one
 * of them. A repo on both Apps is listed once, with the write App. Capped, and `truncated` says more existed.
 */
export async function listPairingCandidates(ctx: RepoPairingCtx, repoId: string): Promise<{ candidates: PairingCandidate[]; truncated: boolean }> {
  assertRepoIdShape(repoId);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await requireAdmin(client, accountId, userId);
    const own = (await ownFullName(client, repoId))?.toLowerCase() ?? '';
    const { rows } = await client.query<{ full_name: string; gh_installation_id: string; app_kind: 'team' | 'team_readonly' }>(
      `SELECT DISTINCT ON (lower(r.gh_owner || '/' || r.gh_name)) r.gh_owner || '/' || r.gh_name AS full_name, i.gh_installation_id, i.app_kind
         FROM repos r
         JOIN installations i ON i.id = r.installation_id AND i.account_id = r.account_id
        WHERE i.app_kind IN ('team', 'team_readonly') AND r.gh_owner IS NOT NULL AND r.gh_name IS NOT NULL AND lower(r.gh_owner || '/' || r.gh_name) <> $1
        ORDER BY lower(r.gh_owner || '/' || r.gh_name), (i.app_kind = 'team') DESC
        LIMIT $2`,
      [own, MAX_PAIRING_CANDIDATES + 1],
    );
    return {
      candidates: rows.slice(0, MAX_PAIRING_CANDIDATES).map((r) => ({ fullName: r.full_name, installationId: Number(r.gh_installation_id), appKind: r.app_kind })),
      truncated: rows.length > MAX_PAIRING_CANDIDATES,
    };
  });
}

/** Owner or admin. Turns pairing on, or replaces the existing row; one audit row. Changing it affects only items started afterwards. */
export async function setRepoPairing(ctx: RepoPairingCtx, repoId: string, input: SetRepoPairingInput): Promise<RepoPairing> {
  assertRepoIdShape(repoId);
  validatePairingInput(input);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await requireAdmin(client, accountId, userId);
    const own = await ownFullName(client, repoId);
    if (own !== null && own.toLowerCase() === input.codeRepo.toLowerCase()) {
      invalid('the paired public repo must be a different repo from this one', 'code_repo');
    }
    const { rows: beforeRows } = await client.query<PairingRow>(`SELECT ${PAIRING_COLUMNS} FROM repo_pairing WHERE repo_id = $1 FOR UPDATE`, [repoId]);
    const { rows } = await client.query<PairingRow>(
      `INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs, identifier_rules_path, plan_data_rules_path, pr_footer, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (repo_id) DO UPDATE
          SET code_repo = EXCLUDED.code_repo, overlay_globs = EXCLUDED.overlay_globs,
              identifier_rules_path = EXCLUDED.identifier_rules_path, plan_data_rules_path = EXCLUDED.plan_data_rules_path, pr_footer = EXCLUDED.pr_footer,
              updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING ${PAIRING_COLUMNS}`,
      [repoId, accountId, input.codeRepo, input.overlayGlobs, input.identifierRulesPath ?? null, input.planDataRulesPath ?? null, footerOrNull(input.prFooter), userId],
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
