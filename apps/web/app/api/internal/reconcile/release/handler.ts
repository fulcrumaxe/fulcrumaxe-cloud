import type { Pool } from "pg";
import { createPool } from "@fx/db/src/pool";
import { loadAppCredentials, restoreInstallation, type AppCredentialsSource } from "@fx/github";
import { handleReleaseRequest, type ReleaseApiDeps } from "@fx/reconcile";
import { appApiFor, appUserPool } from "../../../../../lib/github/installationReconcile";
import { buildSyncRepos } from "../../../../../lib/github/repoSync";

/**
 * D#454 H2b2: the owner's breaker release and installation restore. The logic and its tests are @fx/reconcile's
 * (`handleReleaseRequest`); this file only builds its dependencies from the environment.
 *
 * Auth is FX_RECONCILE_RELEASE_TOKEN, a bearer secret of its own and never CRON_SECRET: a cron caller must not be able to
 * release a breaker. Unset: 503 and nothing happens. Wrong or missing header: 401. The platform_ops pool and the App
 * credentials are built only after the header has matched.
 */
let cachedPool: Pool | undefined;

function platformOpsPool(): Pool {
  if (!cachedPool) {
    const url = process.env.DATABASE_URL_PLATFORM_OPS;
    if (!url) throw new Error("DATABASE_URL_PLATFORM_OPS must be set");
    cachedPool = createPool(url);
  }
  return cachedPool;
}

export function releaseDepsFromEnv(env: Record<string, string | undefined> = process.env): ReleaseApiDeps {
  let credentials: AppCredentialsSource | undefined;
  const creds = (): AppCredentialsSource => (credentials ??= loadAppCredentials(env));
  return {
    token: env.FX_RECONCILE_RELEASE_TOKEN?.trim() || undefined,
    pool: platformOpsPool,
    api: (kind) => appApiFor(creds(), kind),
    // The webhook path's own lifecycle code (lock, state change, event, then the repo re-sync), not a second copy.
    restore: (kind, id, meter) => {
      const appUser = appUserPool();
      return restoreInstallation(
        {
          platformOpsPool: platformOpsPool(),
          appUserPool: appUser,
          appCredentials: creds(),
          syncRepos: buildSyncRepos({ platformOpsPool: platformOpsPool(), appUserPool: appUser, appCredentials: creds() }),
        },
        kind,
        id,
        meter,
      );
    },
  };
}

export async function releaseHandler(req: Request, deps: ReleaseApiDeps = releaseDepsFromEnv()): Promise<Response> {
  return handleReleaseRequest(req, deps);
}
