import type { Pool } from "pg";
import { createPool } from "@fx/db/src/pool";
import { loadAppCredentials, syncInstallationRepos, type AppCredentialsSource } from "@fx/github";
import { createGithubReposJob, type ReconcileJob, type ReportError } from "@fx/reconcile";
import { buildRepoSyncDeps } from "./repoSync";

/**
 * D#454 H2c: the production wiring of the GitHub repo re-sync job.
 *
 *  - It runs `syncInstallationRepos`, the function the webhook path runs, so inserting, re-pointing and detaching repos, the
 *    advisory lock, the inactive checks and the `repos.changed` event are the webhook path's, not a second copy.
 *  - Each installation is minted for with ITS kind's App key (`syncInstallationRepos` reads the kind from our own row); a
 *    kind that is not configured is skipped, never borrowed from another kind.
 *  - The app_user pool (repos are the tenant's) is created only when the first installation is synced.
 */
let cachedAppUserPool: Pool | undefined;

function appUserPool(): Pool {
  if (!cachedAppUserPool) {
    const url = process.env.DATABASE_URL_APP_USER;
    if (!url) throw new Error("DATABASE_URL_APP_USER must be set");
    cachedAppUserPool = createPool(url);
  }
  return cachedAppUserPool;
}

export function githubReposJobFromEnv(
  platformOpsPool: Pool,
  report: ReportError,
  credentials: AppCredentialsSource = loadAppCredentials(process.env),
): ReconcileJob {
  return createGithubReposJob({
    sync: async (target, conditional) => {
      try {
        credentials(target.kind);
      } catch {
        // fx-swallow-ok: an unconfigured kind is skipped by design; loadAppCredentials already warned once about a half-set one
        return { status: "skipped", reason: "not_configured" };
      }
      const deps = buildRepoSyncDeps({ platformOpsPool, appUserPool: appUserPool(), appCredentials: credentials });
      const result = await syncInstallationRepos({ ...deps, conditional }, target.installationId);
      return result.status === "synced" ? { status: "synced", ...(result.etags ? { etags: result.etags } : {}) } : { status: "skipped", reason: result.reason };
    },
    reportError: report,
  });
}
