import type { Pool } from "pg";
import { resolveChecked } from "@fx/net-guard";
import { InstallationTokenCache, syncInstallationRepos, type AppCredentialsSource, type SyncDeps, type SyncRepos } from "@fx/github";
import { buildAccessTokenRequester, nodeHttpsPinnedRequester } from "../../app/api/gh-proxy/[...path]/handler";

/** D#2 H17b-2: production `syncRepos`, minting through the proxy's pinned, timeout-wrapped requester. */
const cache = new InstallationTokenCache();

export function buildRepoSyncDeps(deps: { platformOpsPool: Pool; appUserPool: Pool; appCredentials: AppCredentialsSource }): SyncDeps {
  const requester = buildAccessTokenRequester({
    resolveUpstream: (host, lookup) => resolveChecked(host, lookup),
    forwardPinned: nodeHttpsPinnedRequester,
  });
  return { ...deps, requester, cache };
}

export function buildSyncRepos(deps: { platformOpsPool: Pool; appUserPool: Pool; appCredentials: AppCredentialsSource }): SyncRepos {
  const full = buildRepoSyncDeps(deps);
  return (installationId) => syncInstallationRepos(full, installationId);
}
