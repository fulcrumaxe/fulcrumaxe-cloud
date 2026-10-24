import { resolveChecked } from "@fx/net-guard";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import { createPublicRepoInspector, createTeamInstallationOwnership, InstallationTokenCache, loadAppCredentials, type PublicRepoInspector } from "@fx/github";
import { buildAccessTokenRequester, nodeHttpsPinnedRequester } from "../../app/api/gh-proxy/[...path]/handler";

/**
 * D#598 PAIR-PICKER-API: the production reader behind the pairing routes' questions about a repo (is it public, which branch is its default,
 * is the caller's own write App installed on it). It needs no setting of its own: the App credentials are the ones every other GitHub call uses,
 * and a missing App answers the routes' fixed `github_app_not_configured`. Built once per process, on first use, so a missing credential is never
 * a crash at load. Reads of a repo the account has installed use a one-repo `metadata: read` token that is minted per read and never cached.
 */
let inspector: PublicRepoInspector | undefined;

export function getPairingInspector(env: NodeJS.ProcessEnv = process.env): PublicRepoInspector {
  inspector ??= createPublicRepoInspector({
    appCredentials: loadAppCredentials(env),
    requester: buildAccessTokenRequester({ resolveUpstream: (host, lookupFn) => resolveChecked(host, lookupFn), forwardPinned: nodeHttpsPinnedRequester }),
    cache: new InstallationTokenCache(),
    ownsTeamInstallation: createTeamInstallationOwnership(platformOpsPool()),
  });
  return inspector;
}
