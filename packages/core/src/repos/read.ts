import type { Pool } from 'pg';
import { getRoleEntry } from '@fx/roles';
import { NotFoundError } from '../tenancy/errors.js';
import type { InstallationAppKind } from './appKinds.js';
import { withTenant } from '../tenancy/withTenant.js';

/** D#31 API-8a: `(ctx:{pool, principal}, input)`, the same local ctx shape every domain module here keeps its own copy of. */
export interface ReposReadCtx {
  /** app_user pool -- every read here goes through withTenant/RLS. */
  pool: Pool;
  principal: { accountId: string; userId: string };
}

export type InstallState = 'installed' | 'not_installed';

/** One repo as the API lists it. `installState` is derived, never stored. */
export interface RepoDTO {
  id: string;
  product: string;
  ghRepoId: number;
  installState: InstallState;
  /** The joined `installations.app_kind`, or null when not installed. */
  appKind: InstallationAppKind | null;
  /** `owner/name` from the last sync, or null before one. */
  fullName: string | null;
}

interface RepoRow {
  id: string;
  product: string;
  gh_repo_id: string;
  installation_id: string | null;
  app_kind: InstallationAppKind | null;
  gh_owner: string | null;
  gh_name: string | null;
  created_at_cursor: string;
}

const REPO_SELECT = `SELECT r.id, r.product, r.gh_repo_id, r.installation_id, i.app_kind, r.gh_owner, r.gh_name,
       to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
  FROM repos r
  LEFT JOIN installations i ON i.account_id = r.account_id AND i.id = r.installation_id`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A repo id that is not a uuid must take the same NotFoundError path as a
 * missing or cross-tenant one: bound to a uuid column it would raise a
 * Postgres cast error (22P02), which the API would map to 500.
 */
export function assertRepoIdShape(repoId: string): void {
  if (!UUID_RE.test(repoId)) {
    throw new NotFoundError(`repos ${repoId} not found`);
  }
}

/** True when `role` is one of the manifest's 26 roles. Lets the API 404 an unknown role in a URL without depending on `@fx/roles` itself. */
export function isManifestRole(role: string): boolean {
  return getRoleEntry(role) !== undefined;
}

function toRepoDTO(row: RepoRow): RepoDTO {
  const installed = row.installation_id !== null;
  return {
    id: row.id,
    product: row.product,
    ghRepoId: Number(row.gh_repo_id),
    installState: installed ? 'installed' : 'not_installed',
    appKind: installed ? row.app_kind : null,
    fullName: row.gh_owner && row.gh_name ? `${row.gh_owner}/${row.gh_name}` : null,
  };
}

export async function getRepo(ctx: ReposReadCtx, repoId: string): Promise<RepoDTO> {
  assertRepoIdShape(repoId);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<RepoRow>(`${REPO_SELECT} WHERE r.id = $1`, [repoId]);
    if (!rows[0]) {
      throw new NotFoundError(`repos ${repoId} not found`);
    }
    return toRepoDTO(rows[0]);
  });
}

export interface ListReposInput {
  /** Already validated (1..MAX_LIMIT) by the API's `parseLimit`. */
  limit: number;
  /** Already decoded by the API's `decodeCursor`; `createdAt` is raw full-precision text. */
  cursor?: { createdAt: string; id: string };
}

export interface ListReposResult {
  data: RepoDTO[];
  nextCursor: { createdAt: string; id: string } | null;
}

/** Keyset pagination on `(created_at, id)` descending, `limit + 1` rows to learn whether another page exists. */
export async function listRepos(ctx: ReposReadCtx, input: ListReposInput): Promise<ListReposResult> {
  const { accountId, userId } = ctx.principal;
  const { limit, cursor } = input;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<RepoRow>(
      `${REPO_SELECT}
        WHERE ($1::timestamptz IS NULL OR (r.created_at, r.id) < ($1::timestamptz, $2::uuid))
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $3::int`,
      [cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      data: page.map(toRepoDTO),
      nextCursor: hasMore && last ? { createdAt: last.created_at_cursor, id: last.id } : null,
    };
  });
}
