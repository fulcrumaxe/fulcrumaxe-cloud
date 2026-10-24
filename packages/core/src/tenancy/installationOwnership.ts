import type { Pool } from 'pg';
import { withPlatformOps } from './withPlatformOps.js';

/**
 * Whether a GitHub installation id is a team-App installation of exactly one given account: its `installations` row carries that account, and its
 * installer record is neither deleted nor suspended. Used before a token for a paired public repository is minted, and before the pairing screens report
 * the App as installed, so the installation GitHub names for a repository is only ever used for, or reported to, the account whose installation it is.
 * A database error throws; the caller turns that into a refusal.
 */
const QUERY = `
  SELECT 1
    FROM installations i
    JOIN installation_installers ii
      ON ii.gh_installation_id = i.gh_installation_id AND ii.app_kind = i.app_kind AND ii.deleted_at IS NULL AND ii.suspended_at IS NULL
   WHERE i.account_id = $1 AND i.gh_installation_id = $2 AND i.app_kind = 'team'
`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TeamInstallationOwnership = (accountId: string, ghInstallationId: number) => Promise<boolean>;

export function createTeamInstallationOwnership(platformOpsPool: Pool): TeamInstallationOwnership {
  return async (accountId, ghInstallationId) => {
    // A malformed account id is "not owned", not a database cast error.
    if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) return false;
    if (!Number.isSafeInteger(ghInstallationId) || ghInstallationId <= 0) return false;
    const rows = await withPlatformOps(platformOpsPool, async (client) => (await client.query(QUERY, [accountId, ghInstallationId])).rows);
    return rows.length === 1;
  };
}
