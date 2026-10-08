import type { Pool } from "pg";
import { createPool } from "@fx/db/src/pool";
import { loadAppCredentials, mintAppJwt, recordInstallationLifecycle, type AppCredentialsSource } from "@fx/github";
import {
  createGithubAppApi,
  createGithubInstallationsJob,
  type GithubAppApi,
  type InstallationChange,
  type InstallationKind,
  type ReconcileJob,
  type ReportError,
} from "@fx/reconcile";
import { buildSyncRepos } from "./repoSync";

/**
 * D#454 H2b: the production wiring of the GitHub installation-state job.
 *
 *  - Each kind's client signs with that kind's own App key (`appCredentials(kind)`); a kind that is not configured has no
 *    client and is skipped. There is no fallback from one kind's key to another.
 *  - A change goes through `recordInstallationLifecycle`, the function the webhook path runs for a delivery, with the
 *    payload that delivery would carry. So detaching repos, the refresh events, the advisory lock and the re-sync on
 *    unsuspend are the webhook path's, not a second copy.
 *  - The app_user pool (the detach is the tenant's write) is created only when a change has to be applied.
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

const ACTION_NAME: Record<InstallationChange["action"], string> = { deleted: "deleted", suspend: "suspend", unsuspend: "unsuspend" };

export function githubInstallationsJobFromEnv(
  platformOpsPool: Pool,
  report: ReportError,
  credentials: AppCredentialsSource = loadAppCredentials(process.env),
): ReconcileJob {
  const api = (kind: InstallationKind): GithubAppApi | null => {
    let creds;
    try {
      creds = credentials(kind);
    } catch {
      // fx-swallow-ok: an unconfigured kind is skipped by design; loadAppCredentials already warned once about a half-set one
      return null;
    }
    return createGithubAppApi(() => mintAppJwt(creds.appId, creds.privateKeyPem));
  };
  return createGithubInstallationsJob({
    api,
    apply: async (change, meter) => {
      const appUser = appUserPool();
      await recordInstallationLifecycle(
        {
          platformOpsPool,
          appUserPool: appUser,
          appCredentials: credentials,
          syncRepos: buildSyncRepos({ platformOpsPool, appUserPool: appUser, appCredentials: credentials }),
        },
        change.kind,
        { action: ACTION_NAME[change.action], installation: { id: change.ghInstallationId } },
        meter,
      );
    },
    reportError: report,
  });
}
