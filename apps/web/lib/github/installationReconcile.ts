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
 * D#454 H2b/H2b2: the production wiring of the GitHub installation-state job.
 *
 *  - Each kind's client signs with that kind's own App key (`appCredentials(kind)`); a kind that is not configured has no
 *    client and is skipped. There is no fallback from one kind's key to another.
 *  - A change goes through `recordInstallationLifecycle`, the function the webhook path runs for a delivery, with the
 *    payload that delivery would carry. So detaching repos, the refresh events, the advisory lock and the re-sync on
 *    unsuspend are the webhook path's, not a second copy.
 *  - The slug each kind's App must report on `GET /app` comes from GITHUB_APP_{TEAM,TEAM_READONLY,SITEKIT}_SLUG; the job
 *    refuses to change anything for a kind whose setting is unset.
 *  - The app_user pool (the detach is the tenant's write) is created only when a change has to be applied.
 */
let cachedAppUserPool: Pool | undefined;

export function appUserPool(): Pool {
  if (!cachedAppUserPool) {
    const url = process.env.DATABASE_URL_APP_USER;
    if (!url) throw new Error("DATABASE_URL_APP_USER must be set");
    cachedAppUserPool = createPool(url);
  }
  return cachedAppUserPool;
}

/** The slug each kind's App must report (GITHUB_APP_*_SLUG); null when unset or blank, which makes that kind change nothing. */
const SLUG_ENV: Record<InstallationKind, string> = {
  team: "GITHUB_APP_TEAM_SLUG",
  team_readonly: "GITHUB_APP_TEAM_READONLY_SLUG",
  sitekit: "GITHUB_APP_SITEKIT_SLUG",
};

export function appSlugFromEnv(kind: InstallationKind, env: Record<string, string | undefined> = process.env): string | null {
  const value = env[SLUG_ENV[kind]]?.trim();
  return value ? value : null;
}

const ACTION_NAME: Record<InstallationChange["action"], string> = { deleted: "deleted", suspend: "suspend", unsuspend: "unsuspend" };

/** One kind's App client, signing with that kind's own key; null when the kind is not configured. Also used by the owner's restore. */
export function appApiFor(credentials: AppCredentialsSource, kind: InstallationKind): GithubAppApi | null {
  let creds;
  try {
    creds = credentials(kind);
  } catch {
    // fx-swallow-ok: an unconfigured kind is skipped by design; loadAppCredentials already warned once about a half-set one
    return null;
  }
  return createGithubAppApi(() => mintAppJwt(creds.appId, creds.privateKeyPem));
}

export function githubInstallationsJobFromEnv(
  platformOpsPool: Pool,
  report: ReportError,
  credentials: AppCredentialsSource = loadAppCredentials(process.env),
): ReconcileJob {
  const api = (kind: InstallationKind): GithubAppApi | null => appApiFor(credentials, kind);
  return createGithubInstallationsJob({
    api,
    slug: (kind) => appSlugFromEnv(kind),
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
