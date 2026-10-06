import { ROLE_MANIFEST } from '@fx/roles';

/** The minimal client shape the helper needs: a tenant-scoped pg client. */
interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/**
 * D#2 H08-followup: a role_settings row's presence carries the meaning, so a
 * repo gets one row per manifest role the moment it is created -- mode =
 * the role's manifest `defaultMode` at this moment, model NULL. Call it with
 * the tenant-scoped client, inside the same transaction as the `repos` insert
 * (so a repo never exists without its rows). ON CONFLICT DO NOTHING keeps any
 * row that is already there.
 */
export async function materializeRoleDefaults(client: Queryable, accountId: string, repoId: string): Promise<void> {
  await client.query(
    `INSERT INTO role_settings (account_id, repo_id, role, mode)
     SELECT $1, $2, d.role, d.mode FROM unnest($3::text[], $4::text[]) AS d(role, mode)
     ON CONFLICT (repo_id, role) DO NOTHING`,
    [accountId, repoId, ROLE_MANIFEST.map((r) => r.name), ROLE_MANIFEST.map((r) => r.defaultMode)],
  );
}
