import type { PoolClient } from 'pg';

/**
 * A project's GitHub identity (migration 1121): `app` (the default; no row) or `personal`. The write is one SECURITY DEFINER function that checks, inside the database,
 * that the session is a verified owner or admin of an active account. The token never reaches the cloud: this stores the choice and nothing else.
 */
export type GithubIdentity = 'app' | 'personal';

/** The repo is not one of the session account's. The route answers 404. */
export class GithubIdentityRepoNotFound extends Error {
  constructor() {
    super('repoGithubIdentity: no such repo');
    this.name = 'GithubIdentityRepoNotFound';
  }
}

/** The session is not an owner or admin of an active account (42501 from the definer). The route answers 403. */
export class GithubIdentityForbidden extends Error {
  constructor() {
    super('repoGithubIdentity: only an owner or admin can change the GitHub identity');
    this.name = 'GithubIdentityForbidden';
  }
}

/** The repo's identity, `app` when nothing was ever set. Names the account as well as the repo, on top of row security. */
export async function readRepoGithubIdentity(client: Pick<PoolClient, 'query'>, accountId: string, repoId: string): Promise<GithubIdentity> {
  const { rows } = await client.query<{ identity: GithubIdentity }>('SELECT identity FROM repo_github_identity WHERE account_id = $1::uuid AND repo_id = $2::uuid', [accountId, repoId]);
  return rows[0]?.identity ?? 'app';
}

/**
 * What the setting shows for a repo of the account: the identity and the name of the machine that serves the repo (the runner of its newest engine session, by the name
 * the person gave it), null when no session ever ran or the runner has no name. null when the repo is not the account's. Account predicates are explicit on every table.
 */
export async function readRepoIdentityView(client: Pick<PoolClient, 'query'>, accountId: string, repoId: string): Promise<{ github_identity: GithubIdentity; machine: string | null } | null> {
  const { rows } = await client.query<{ identity: GithubIdentity | null; machine: string | null }>(
    `SELECT i.identity,
            (SELECT NULLIF(rs.name, '') FROM engine_sessions y JOIN runners rn ON rn.id = y.runner_id AND rn.account_id = y.account_id
               LEFT JOIN runner_settings rs ON rs.runner_id = rn.id AND rs.account_id = rn.account_id
              WHERE y.account_id = r.account_id AND y.repo_id = r.id ORDER BY y.first_event_at DESC NULLS LAST, y.created_at DESC LIMIT 1) AS machine
       FROM repos r LEFT JOIN repo_github_identity i ON i.account_id = r.account_id AND i.repo_id = r.id
      WHERE r.account_id = $1::uuid AND r.id = $2::uuid`,
    [accountId, repoId],
  );
  return rows[0] ? { github_identity: rows[0].identity ?? 'app', machine: rows[0].machine } : null;
}

/** Sets the identity on the caller's tenant transaction. `changed` is false for a repeat: the caller writes the audit row only when it is true. */
export async function setRepoGithubIdentity(client: Pick<PoolClient, 'query'>, repoId: string, identity: GithubIdentity): Promise<{ previous: GithubIdentity; changed: boolean }> {
  try {
    const { rows } = await client.query<{ previous: GithubIdentity; changed: boolean }>('SELECT previous, changed FROM repo_github_identity_set($1::uuid, $2::text)', [repoId, identity]);
    return rows[0]!;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'P0002') throw new GithubIdentityRepoNotFound();
    if (code === '42501') throw new GithubIdentityForbidden();
    throw error;
  }
}

/** The ids among `repoIds` of the account whose identity is `personal` (every other repo is `app`), in one read that names the account on top of row security. */
export async function readPersonalRepoIds(client: Pick<PoolClient, 'query'>, accountId: string, repoIds: string[]): Promise<Set<string>> {
  const { rows } = await client.query<{ repo_id: string }>("SELECT repo_id FROM repo_github_identity WHERE account_id = $1::uuid AND repo_id = ANY($2::uuid[]) AND identity = 'personal'", [accountId, repoIds]);
  return new Set(rows.map((r) => r.repo_id));
}
