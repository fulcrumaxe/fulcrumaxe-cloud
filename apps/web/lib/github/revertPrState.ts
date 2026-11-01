import type { Pool } from "pg";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import { createPrStateReader, type PrStateReader } from "@fx/api/src/routes/reversalPrState.js";
import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";
import { openInstallationHttp } from "./installationHttp";

/**
 * D#7 DP7-2g: the live GitHub read behind a revert row's `pr_state` on the receipts list. One `GET /pulls/<n>` through our App's read token for the
 * repository's installation, on every list, never remembered. The repository's owner and name come from our own `repos` row, matched on the account as
 * well as the id, so one account cannot ask about another's repository. The client is the `read` kind: metadata and pull requests, GET only.
 */
export function createAppPrStateReader(deps: { pool?: () => Pool; open?: typeof openInstallationHttp } = {}): PrStateReader {
  const pool = deps.pool ?? platformOpsPool;
  const open = deps.open ?? openInstallationHttp;
  return createPrStateReader({
    async resolveRepo({ accountId, repoId }) {
      const rows = await withPlatformOps(pool(), async (client) => {
        const { rows } = await client.query<{ gh_owner: string | null; gh_name: string | null }>("SELECT gh_owner, gh_name FROM repos WHERE id = $1 AND account_id = $2", [repoId, accountId]);
        return rows;
      });
      const row = rows[0];
      return row && row.gh_owner && row.gh_name ? { owner: row.gh_owner, name: row.gh_name } : null;
    },
    open: (repo) => open("read", { repoId: repo.repoId, owner: repo.owner, name: repo.name }) as Promise<{ request(req: { method: "GET"; path: string }): Promise<{ status: number; body: unknown }> }>,
  });
}
