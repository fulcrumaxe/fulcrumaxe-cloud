import type { Pool } from "pg";
import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";

/**
 * D#31 AUTHOR-CHECK-WIRE: which installation serves a repo, from our own rows,
 * for the retry author check's token mint. The installation id is the value that
 * crosses into GitHub, so the same guards the sandbox-run resolver (runResolver.ts)
 * and repo sync apply are applied here:
 *  - the repo and the installation belong to one account (explicit, beside the FK);
 *  - no OTHER installations row carries the same gh_installation_id (CWE-639: a
 *    collision elsewhere would let one account mint a token for another's install);
 *  - the installer record for (gh_installation_id, app_kind) exists and is neither
 *    deleted nor suspended.
 * Every miss is null. A database error THROWS: the lookup adapter throws on it and
 * the check answers `unavailable`, never `trusted`. Nothing here logs a repo or owner.
 */
const QUERY = `
  SELECT i.gh_installation_id, i.app_kind
    FROM repos r
    JOIN installations i
      ON i.id = r.installation_id
     AND i.account_id = r.account_id
    JOIN installation_installers ii
      ON ii.gh_installation_id = i.gh_installation_id
     AND ii.app_kind = i.app_kind
     AND ii.deleted_at IS NULL
     AND ii.suspended_at IS NULL
   WHERE r.id = $1
     AND NOT EXISTS (
       SELECT 1 FROM installations i2
        WHERE i2.gh_installation_id = i.gh_installation_id
          AND i2.id <> i.id
     )
`;

export type RepoInstallationResolver = (repoId: string) => Promise<{ installationId: number; appKind: string } | null>;

export function createRepoInstallationResolver(platformOpsPool: Pool): RepoInstallationResolver {
  return async (repoId) => {
    const rows = await withPlatformOps(platformOpsPool, async (client) => {
      const result = await client.query<{ gh_installation_id: string; app_kind: string }>(QUERY, [repoId]);
      return result.rows;
    });
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    // bigint columns come back as strings from node-postgres.
    const installationId = Number(row.gh_installation_id);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return null;
    return { installationId, appKind: row.app_kind };
  };
}
