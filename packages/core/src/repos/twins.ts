import type { Pool, PoolClient } from 'pg';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { assertRepoIdShape } from './read.js';

/**
 * D#845 ON-27a: the private twin of a public repo. The row is `repo_twins` (migration 1097): app users read it under RLS and every write is one of two
 * SECURITY DEFINER functions (`twin_record` at the create's callback, `twin_change` for pause, resume and remove), each owner/admin only and each audited.
 * We never delete a GitHub repo: "remove" ends the row's life here and leaves the private repo on GitHub for the person to delete there.
 */

/** The kill switch (a server constant). Until ON-27d turns it on, every twin route answers 503 `not_configured` and no card shows. */
export const TWIN_ENABLED = false;

export type TwinState = 'creating' | 'not_connected' | 'seeding' | 'ready' | 'paused' | 'conflict' | 'refused' | 'failed' | 'removed';
export type TwinAction = 'pause' | 'resume' | 'remove';

export interface RepoTwin {
  id: string;
  publicRepoId: string;
  privateRepoId: string | null;
  /** The private repo's name (the owner is the public repo's), for the links the card shows. */
  privateName: string;
  state: TwinState;
  overlayGlobs: string[];
  publishedPrivateSha: string | null;
  syncedPublicSha: string | null;
  publishPr: number | null;
  syncPr: number | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RepoTwinCtx {
  /** app_user pool: every read and write goes through withTenant/RLS. */
  pool: Pool;
  principal: { accountId: string; userId: string };
}

/** `twin_change` refused: the twin's state does not allow the action (`state` is what it is now). */
export class TwinStateError extends Error {
  constructor(readonly state: TwinState | null, readonly action: TwinAction) {
    super(`twin: cannot ${action} a twin that is ${state}`);
    this.name = 'TwinStateError';
  }
}

/** A live twin holds this repo (or the public repo it would be paired with), so it cannot be paired (D#598): one repo never has two publishers. */
export class TwinExistsError extends Error {
  constructor() {
    super('twin: the repo belongs to a live private twin');
    this.name = 'TwinExistsError';
  }
}

const COLUMNS = `id, public_repo_id, private_repo_id, private_name, state, overlay_globs, published_private_sha, synced_public_sha, publish_pr, sync_pr, failure_code,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`;

interface Row {
  id: string;
  public_repo_id: string;
  private_repo_id: string | null;
  private_name: string;
  state: TwinState;
  overlay_globs: string[];
  published_private_sha: string | null;
  synced_public_sha: string | null;
  publish_pr: number | null;
  sync_pr: number | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

const toTwin = (r: Row): RepoTwin => ({
  id: r.id, publicRepoId: r.public_repo_id, privateRepoId: r.private_repo_id, privateName: r.private_name, state: r.state, overlayGlobs: r.overlay_globs,
  publishedPrivateSha: r.published_private_sha, syncedPublicSha: r.synced_public_sha, publishPr: r.publish_pr, syncPr: r.sync_pr, failureCode: r.failure_code,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Any active member. The live twin of a public repo (a removed one reads as none), or null. The repo must be the caller's own: another tenant's is a NotFoundError. */
export async function getRepoTwin(ctx: RepoTwinCtx, publicRepoId: string): Promise<RepoTwin | null> {
  assertRepoIdShape(publicRepoId);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    if ((await client.query('SELECT 1 FROM repos WHERE account_id = $1 AND id = $2', [accountId, publicRepoId])).rows.length === 0) throw new NotFoundError(`repos ${publicRepoId} not found`);
    const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM repo_twins WHERE account_id = $1 AND public_repo_id = $2 AND state <> 'removed'`, [accountId, publicRepoId]);
    return rows[0] ? toTwin(rows[0]) : null;
  });
}

/**
 * Throws TwinExistsError when a live twin holds `repoId`, or the repo `codeRepo` names (`owner/name`, in this account), as either of its repos. It first takes the one lock on those
 * repo rows (FOR UPDATE, in id order, the same lock `twin_record` takes), so a pairing and a twin made at the same moment cannot both pass. Runs in the caller's transaction, so the pairing write and this check commit together.
 */
export async function assertNoLiveTwin(client: PoolClient, accountId: string, repoId: string, codeRepo: string): Promise<void> {
  const locked = await client.query<{ id: string }>(
    `SELECT id FROM repos WHERE account_id = $1 AND (id = $2 OR lower(gh_owner || '/' || gh_name) = lower($3)) ORDER BY id FOR UPDATE`,
    [accountId, repoId, codeRepo],
  );
  const { rows } = await client.query(
    `SELECT 1 FROM repo_twins WHERE account_id = $1 AND state <> 'removed' AND (public_repo_id = ANY($2::uuid[]) OR private_repo_id = ANY($2::uuid[]))`,
    [accountId, locked.rows.map((r) => r.id)],
  );
  if (rows.length > 0) throw new TwinExistsError();
}

/**
 * Owner or admin. Pause, resume or remove (Stop publishing, or a cancel before the seed). The answer is the twin as it now is. A twin that is not the caller's is a
 * NotFoundError; a state that does not allow the action is a TwinStateError and changes nothing.
 */
export async function changeRepoTwin(ctx: RepoTwinCtx, twinId: string, action: TwinAction): Promise<RepoTwin> {
  assertRepoIdShape(twinId);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows } = await client.query<{ o_result: 'ok' | 'not_found' | 'bad_state'; o_state: TwinState | null }>('SELECT o_result, o_state FROM twin_change($1, $2)', [twinId, action]);
    const r = rows[0];
    if (!r || r.o_result === 'not_found') throw new NotFoundError(`twins ${twinId} not found`);
    if (r.o_result === 'bad_state') throw new TwinStateError(r.o_state, action);
    const after = await client.query<Row>(`SELECT ${COLUMNS} FROM repo_twins WHERE account_id = $1 AND id = $2`, [accountId, twinId]);
    return toTwin(after.rows[0]!);
  });
}

export interface TwinCreateFacts {
  /** `owner/name` of the public repo from the last sync, or null before one. */
  fullName: string | null;
  hasTwin: boolean;
  hasPairing: boolean;
}

/** Owner or admin. What the create needs to know about one of the caller's own repos before GitHub is asked anything. Another tenant's repo is a NotFoundError. */
export async function getTwinCreateFacts(ctx: RepoTwinCtx, publicRepoId: string): Promise<TwinCreateFacts> {
  assertRepoIdShape(publicRepoId);
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const { rows } = await client.query<{ gh_owner: string | null; gh_name: string | null; has_twin: boolean; has_pairing: boolean }>(
      `SELECT r.gh_owner, r.gh_name,
              EXISTS (SELECT 1 FROM repo_twins t WHERE t.account_id = r.account_id AND t.state <> 'removed' AND (t.public_repo_id = r.id OR t.private_repo_id = r.id)) AS has_twin,
              EXISTS (SELECT 1 FROM repo_pairing p WHERE p.account_id = r.account_id AND p.repo_id = r.id) AS has_pairing
         FROM repos r WHERE r.account_id = $1 AND r.id = $2`,
      [accountId, publicRepoId],
    );
    const r = rows[0];
    if (!r) throw new NotFoundError(`repos ${publicRepoId} not found`);
    return { fullName: r.gh_owner && r.gh_name ? `${r.gh_owner}/${r.gh_name}` : null, hasTwin: r.has_twin, hasPairing: r.has_pairing };
  });
}
