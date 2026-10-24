import type { Pool } from "pg";
import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";

/**
 * D#598 PAIR-INSTALL-CHECK: is this GitHub installation id one of THIS account's write-App (`team`) installations, from our own rows? The id
 * comes from GitHub (the installation lookup on a typed repo), so it proves nothing about who may learn of it: only an id our own
 * `installations` table holds for the caller's account, with a live installer record (not deleted, not suspended), counts. Any other
 * answer, including another account's installation and a database miss, is false. A database error throws; the caller fails closed.
 */
export type TeamInstallationOwnership = (accountId: string, ghInstallationId: number) => Promise<boolean>;

const QUERY = `
  SELECT 1
    FROM installations i
    JOIN installation_installers ii
      ON ii.gh_installation_id = i.gh_installation_id
     AND ii.app_kind = i.app_kind
     AND ii.deleted_at IS NULL
     AND ii.suspended_at IS NULL
   WHERE i.account_id = $1
     AND i.gh_installation_id = $2
     AND i.app_kind = 'team'
   LIMIT 1
`;

export function createTeamInstallationOwnership(platformOpsPool: Pool): TeamInstallationOwnership {
  return async (accountId, ghInstallationId) => {
    if (!Number.isSafeInteger(ghInstallationId) || ghInstallationId <= 0 || !/^[0-9a-f-]{36}$/i.test(accountId)) return false;
    const rows = await withPlatformOps(platformOpsPool, async (client) => (await client.query(QUERY, [accountId, ghInstallationId])).rows);
    return rows.length > 0;
  };
}
