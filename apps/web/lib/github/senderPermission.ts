import { resolveChecked } from "@fx/net-guard";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import { createLoginPermissionLookup, createRepoInstallationResolver, InstallationTokenCache, loadAppCredentials, type GithubWebhookDbDeps, type LoginPermissionLookup } from "@fx/github";
import { buildAccessTokenRequester, nodeHttpsPinnedRequester } from "../../app/api/gh-proxy/[...path]/handler";

/**
 * D#483: the real repository permission of whoever applied or removed the `fulcrumaxe:product` label (asked only for that label, used for that
 * one delivery), with the author check's read-only installation token. Any throw reaches the webhook, which then does not honour the label;
 * the call is bounded so a slow GitHub cannot hold a delivery open.
 */
export const SENDER_LOOKUP_DEADLINE_MS = 8_000;

const cache = new InstallationTokenCache();
let lookup: LoginPermissionLookup | undefined;

function build(): LoginPermissionLookup {
  return createLoginPermissionLookup({
    resolveInstallation: createRepoInstallationResolver(platformOpsPool()),
    appCredentials: loadAppCredentials(process.env),
    requester: buildAccessTokenRequester({
      resolveUpstream: (host, lookupFn) => resolveChecked(host, lookupFn),
      forwardPinned: nodeHttpsPinnedRequester,
    }),
    cache,
  });
}

export const senderPermission: NonNullable<GithubWebhookDbDeps["senderPermission"]> = async (input) => {
  lookup ??= build();
  return lookup({ ...input, signal: AbortSignal.timeout(SENDER_LOOKUP_DEADLINE_MS) });
};
