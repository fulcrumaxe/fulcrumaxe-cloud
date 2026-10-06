import type { Pool } from "pg";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";
import { createGithubRepoVisibility, type RepoReadHttp } from "@fx/worker";
import { openInstallationHttp } from "./installationHttp";

/**
 * D#6 R3b: the live GitHub read behind `RepoVisibilityPort`. Whether a repository is private is asked of GitHub on every
 * call (through our App's read token for the repository's installation), never remembered, and anything that is not a
 * clear "private" is "unknown" (see `createGithubRepoVisibility`). The repository's owner and name come from our own `repos`
 * row, matched on the account as well as the id, so one account cannot ask about another's repository.
 */
export function createAppRepoVisibility(deps: { pool?: () => Pool; open?: typeof openInstallationHttp } = {}) {
  const pool = deps.pool ?? platformOpsPool;
  const open = deps.open ?? openInstallationHttp;
  return createGithubRepoVisibility({
    async resolveRepo({ accountId, repoId }) {
      const rows = await withPlatformOps(pool(), async (client) => {
        const { rows } = await client.query<{ gh_owner: string | null; gh_name: string | null }>("SELECT gh_owner, gh_name FROM repos WHERE id = $1 AND account_id = $2", [repoId, accountId]);
        return rows;
      });
      const row = rows[0];
      return row && row.gh_owner && row.gh_name ? { owner: row.gh_owner, name: row.gh_name } : null;
    },
    open: (repo): Promise<RepoReadHttp> => open("read", { repoId: repo.repoId, owner: repo.owner, name: repo.name }),
  });
}
