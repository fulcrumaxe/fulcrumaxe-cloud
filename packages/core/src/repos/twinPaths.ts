import type { Pool, PoolClient } from 'pg';
import { uncoveredRuleFiles } from '@fulcrumaxe/runner-protocol/repoPairing';
import { InvalidRoleSettingsInputError } from '../role-settings/errors.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { requireOwnerOrAdmin, type MembershipRole } from '../tenancy/authorize.js';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { assertRepoIdShape } from './read.js';
import { GLOB_CHARS_RE, MAX_OVERLAY_GLOBS, pathOk } from './pairing.js';
import type { RepoTwinCtx } from './twins.js';

/**
 * D#845 ON-27a3: what the person and the install merge write about a twin's private paths, and the plan a public repo carries to its twin. The writes are the
 * SECURITY DEFINER functions of migration 1103 (each audited); this module checks the parts that need the glob compiler first and maps the answers.
 * Nothing here is reachable from a route yet: the twin routes answer 503 until the kill switch turns on.
 */

/** Always private on a twin, before anything the person or the install adds (the Spec's fixed roots and secret defaults). */
export const TWIN_FIXED_PRIVATE: readonly string[] = ['.autonomous-team/**', '.claude/**', 'CLAUDE.md', 'CLAUDE.project.md', 'docs/PRD.md', 'epics/**', '.env', '.env.*', '**/*.pem', '**/*.key'];
export const MAX_TWIN_BINARY_GLOBS = 100;
export const MAX_TWIN_INSTALL_PATHS = 5000;

export interface TwinPaths {
  overlayGlobs: string[];
  binaryGlobs: string[];
  /** Exact paths the install added; they only ever grow. */
  installPaths: string[];
  identifierRulesPath: string | null;
  planDataRulesPath: string | null;
  /** The value `setTwinPaths` must send back: a write against any other revision is a TwinPathsConflictError. */
  revision: string;
}

export type TwinPathsPatch = Partial<Pick<TwinPaths, 'overlayGlobs' | 'binaryGlobs' | 'identifierRulesPath' | 'planDataRulesPath'>>;

/** The paths that never reach the public repo: the fixed roots and secret defaults, the person's globs and the install's files. */
export function twinPrivateGlobs(p: Pick<TwinPaths, 'overlayGlobs' | 'installPaths'>): string[] {
  return [...TWIN_FIXED_PRIVATE, ...p.overlayGlobs, ...p.installPaths];
}

/** The twin was removed, so its paths cannot change. */
export class TwinRemovedError extends Error {
  constructor() {
    super('twin: the twin was removed');
    this.name = 'TwinRemovedError';
  }
}

/** The twin's paths changed between the read and the write; nothing was written. Read again and retry. */
export class TwinPathsConflictError extends Error {
  constructor() {
    super('twin: the private paths changed since they were read');
    this.name = 'TwinPathsConflictError';
  }
}

const REVISION_SQL = `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface PathsRow {
  overlay_globs: string[];
  binary_globs: string[];
  install_paths: string[];
  identifier_rules_path: string | null;
  plan_data_rules_path: string | null;
  revision: string;
}

const toPaths = (r: PathsRow): TwinPaths => ({
  overlayGlobs: r.overlay_globs, binaryGlobs: r.binary_globs, installPaths: r.install_paths,
  identifierRulesPath: r.identifier_rules_path, planDataRulesPath: r.plan_data_rules_path, revision: r.revision,
});

function invalid(message: string, field: string): never {
  throw new InvalidRoleSettingsInputError(message, field);
}

async function requireAdmin(client: PoolClient, accountId: string, userId: string): Promise<void> {
  await assertActiveMembership(client, accountId, userId);
  const { rows } = await client.query<{ role: MembershipRole }>('SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
  requireOwnerOrAdmin(rows[0]?.role ?? null);
}

async function readPaths(client: PoolClient, accountId: string, twinId: string): Promise<{ paths: TwinPaths; state: string }> {
  const { rows } = await client.query<PathsRow & { state: string }>(
    `SELECT overlay_globs, binary_globs, install_paths, identifier_rules_path, plan_data_rules_path, state, ${REVISION_SQL} AS revision FROM repo_twins WHERE account_id = $1 AND id = $2`,
    [accountId, twinId],
  );
  if (!rows[0]) throw new NotFoundError(`twins ${twinId} not found`);
  return { paths: toPaths(rows[0]), state: rows[0].state };
}

/** Owner or admin. The twin's private paths and the revision to write against. Another tenant's twin is a NotFoundError. */
export async function getTwinPaths(ctx: RepoTwinCtx, twinId: string): Promise<TwinPaths> {
  assertRepoIdShape(twinId);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await requireAdmin(client, accountId, userId);
    return (await readPaths(client, accountId, twinId)).paths;
  });
}

/**
 * Owner or admin. Changes the fields of `patch` (the rest keep their value) against the revision the caller read. The shape is the pairing's; a rule file must be
 * covered by the private set the twin would have after the change, so a glob that covers one cannot be dropped while the file is still declared. One audit row.
 */
export async function setTwinPaths(ctx: RepoTwinCtx, twinId: string, expectedRevision: string, patch: TwinPathsPatch): Promise<TwinPaths> {
  assertRepoIdShape(twinId);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await requireAdmin(client, accountId, userId);
    const { paths: cur, state } = await readPaths(client, accountId, twinId);
    if (state === 'removed') throw new TwinRemovedError();
    const next = { ...cur, ...patch };
    for (const [globs, field, max] of [[next.overlayGlobs, 'overlay_globs', MAX_OVERLAY_GLOBS], [next.binaryGlobs, 'binary_globs', MAX_TWIN_BINARY_GLOBS]] as const) {
      if (!Array.isArray(globs) || globs.length > max) invalid(`at most ${max} paths`, field);
      if (!globs.every(pathOk)) invalid('a path is empty, too long, absolute, climbs out of the repo or has a character that is not allowed', field);
      if (new Set(globs).size !== globs.length) invalid('a path is listed twice', field);
    }
    for (const [value, field] of [[next.identifierRulesPath, 'identifier_rules_path'], [next.planDataRulesPath, 'plan_data_rules_path']] as const) {
      if (value !== null && (!pathOk(value) || GLOB_CHARS_RE.test(value))) invalid('a rule file must be one plain path inside the private repo', field);
    }
    const uncovered = uncoveredRuleFiles({ overlayGlobs: twinPrivateGlobs(next), identifierRulesPath: next.identifierRulesPath, planDataRulesPath: next.planDataRulesPath });
    if (uncovered.length > 0) invalid('rule files must be private paths: list the file, or a folder that holds it, under private paths', uncovered[0] === 'identifierRulesPath' ? 'identifier_rules_path' : 'plan_data_rules_path');
    const { rows } = await client.query<{ o_result: 'ok' | 'not_found' | 'bad_state' | 'conflict' }>('SELECT o_result FROM twin_set_paths($1, $2, $3, $4, $5, $6)', [
      twinId, expectedRevision, next.overlayGlobs, next.binaryGlobs, next.identifierRulesPath, next.planDataRulesPath,
    ]);
    const r = rows[0]?.o_result;
    if (r === 'not_found' || !r) throw new NotFoundError(`twins ${twinId} not found`);
    if (r === 'bad_state') throw new TwinRemovedError();
    if (r === 'conflict') throw new TwinPathsConflictError();
    return (await readPaths(client, accountId, twinId)).paths;
  });
}

/** The install's files would take the list past 5,000. Nothing was written; the install merge must record the failure, not cut the list. */
export class TwinInstallPathsFullError extends Error {
  constructor() {
    super('twin: more than 5000 install paths');
    this.name = 'TwinInstallPathsFullError';
  }
}

/**
 * The install merge: adds the files the install added to the twin's private set. It never removes one. No person is needed (the caller is the system's own
 * session); a session that has a person must be an owner or admin. Returns the list's length now.
 */
export async function addTwinInstallPaths(pool: Pool, accountId: string, twinId: string, paths: readonly string[]): Promise<number> {
  assertRepoIdShape(twinId);
  if (paths.length > MAX_TWIN_INSTALL_PATHS) throw new TwinInstallPathsFullError();
  if (!paths.every((p) => pathOk(p) && !GLOB_CHARS_RE.test(p))) invalid('an install path is not one plain path inside the repo', 'install_paths');
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ o_result: 'ok' | 'not_found' | 'bad_state' | 'too_many'; o_count: number | null }>('SELECT o_result, o_count FROM twin_add_install_paths($1, $2)', [twinId, [...paths]]);
    const r = rows[0];
    if (!r || r.o_result === 'not_found') throw new NotFoundError(`twins ${twinId} not found`);
    if (r.o_result === 'bad_state') throw new TwinRemovedError();
    if (r.o_result === 'too_many') throw new TwinInstallPathsFullError();
    return r.o_count!;
  });
}

export type AdoptTwinDraftResult = { ok: true; draftId: string } | { ok: false; reason: 'no_draft' | 'bad_state' };

/**
 * Owner or admin. "Use my approved plan": the public repo's latest plan draft (approved or still being edited) becomes the twin setup's next draft and the setup
 * moves to the plan step with no survey. The copy is a draft again, so the plan is approved afresh on the twin. `reason`: no_draft (nothing to carry) or bad_state
 * (a removed twin, or the setup is past the survey step or has one started).
 */
export async function adoptTwinDraft(ctx: RepoTwinCtx, twinId: string, setupId: string): Promise<AdoptTwinDraftResult> {
  assertRepoIdShape(twinId);
  assertRepoIdShape(setupId);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<{ o_result: 'ok' | 'not_found' | 'bad_state' | 'no_draft'; o_draft: string | null }>('SELECT o_result, o_draft FROM twin_adopt_draft($1, $2)', [twinId, setupId]);
    const r = rows[0];
    if (!r || r.o_result === 'not_found') throw new NotFoundError(`twins ${twinId} not found`);
    return r.o_result === 'ok' ? { ok: true, draftId: r.o_draft! } : { ok: false, reason: r.o_result };
  });
}
