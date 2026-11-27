import { resolveChecked } from "@fx/net-guard";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import { InstallationTokenCache, createRepoInstallationResolver, createSetupPushPort, loadAppCredentials, type SetupPushPort } from "@fx/github";
import { buildAccessTokenRequester, nodeHttpsPinnedRequester } from "../../app/api/gh-proxy/[...path]/handler";

/** D#845 ON-18: the live side of a running session's repo token (an `engine_session` token: one repository, the five permissions). The same App credentials and requester as the setup push; minted fresh per ask, never cached. */
export function createLiveEngineRepoTokenPort(env: NodeJS.ProcessEnv = process.env): SetupPushPort {
  return createSetupPushPort(
    {
      resolveInstallation: (repoId) => createRepoInstallationResolver(platformOpsPool())(repoId),
      appCredentials: loadAppCredentials(env),
      requester: buildAccessTokenRequester({ resolveUpstream: (host, lookupFn) => resolveChecked(host, lookupFn), forwardPinned: nodeHttpsPinnedRequester }),
      cache: new InstallationTokenCache(),
    },
    "engine_session",
  );
}

/**
 * D#845 ON-8f: the live side of a project setup's push credential. A `setup_push` token (one customer repository, contents write and metadata read) is minted per call, never cached, and handed to the runner, which
 * revokes it after the push. It needs no setting of its own: the App credentials are the ones the other GitHub calls use, and a missing App makes the mint fail closed.
 */
export function createLiveSetupPushPort(env: NodeJS.ProcessEnv = process.env): SetupPushPort {
  return createSetupPushPort({
    resolveInstallation: (repoId) => createRepoInstallationResolver(platformOpsPool())(repoId),
    appCredentials: loadAppCredentials(env),
    requester: buildAccessTokenRequester({ resolveUpstream: (host, lookupFn) => resolveChecked(host, lookupFn), forwardPinned: nodeHttpsPinnedRequester }),
    cache: new InstallationTokenCache(),
  });
}
