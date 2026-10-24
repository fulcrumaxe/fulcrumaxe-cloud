import type { Pool } from "pg";
import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";

/**
 * Whether a GitHub installation id is a team-App installation of exactly one given account: its `installations` row carries that account, and its
 * installer record is neither deleted nor suspended. Used before a token for a paired public repository is minted, so the installation GitHub names for
 * that repository is only used for the account whose pairing it is. A database error throws; the caller turns that into a refusal to mint.
 */
const QUERY = `
  SELECT 1
    FROM installations i
    JOIN installation_installers ii
      ON ii.gh_installation_id = i.gh_installation_id AND ii.app_kind = i.app_kind AND ii.deleted_at IS NULL AND ii.suspended_at IS NULL
   WHERE i.account_id = $1 AND i.gh_installation_id = $2 AND i.app_kind = 'team'
`;

export type TeamInstallationOwnership = (accountId: string, ghInstallationId: number) => Promise<boolean>;

export function createTeamInstallationOwnership(platformOpsPool: Pool): TeamInstallationOwnership {
  return async (accountId, ghInstallationId) => {
    if (!Number.isSafeInteger(ghInstallationId) || ghInstallationId <= 0) return false;
    const rows = await withPlatformOps(platformOpsPool, async (client) => (await client.query(QUERY, [accountId, ghInstallationId])).rows);
    return rows.length === 1;
  };
}
