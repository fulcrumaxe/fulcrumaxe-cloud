import { resolveChecked } from "@fx/net-guard";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import { createInstallationHttp, createRepoInstallationResolver, InstallationTokenCache, loadAppCredentials, type InstallationHttp, type InstallationHttpKind, type InstallationHttpTarget } from "@fx/github";
import { buildAccessTokenRequester, nodeHttpsPinnedRequester } from "../../app/api/gh-proxy/[...path]/handler";

/**
 * D#483 P3: the production GitHub client the stage driver uses for its own calls (find the executor's pull request and its
 * changed files with a read token; run the merge gate with the `merge_gate` token). One cache per process, one client per
 * repository per call.
 *
 * Every call is logged as one line: method, path with the repository masked, status and, for an error status, GitHub's own
 * message cut short. Never a token, a header or a body.
 */
const cache = new InstallationTokenCache();
type Open = (kind: InstallationHttpKind, target: InstallationHttpTarget) => Promise<InstallationHttp>;
let open: Open | undefined;

function build(): Open {
  return createInstallationHttp({
    resolveInstallation: createRepoInstallationResolver(platformOpsPool()),
    appCredentials: loadAppCredentials(process.env),
    requester: buildAccessTokenRequester({ resolveUpstream: (host, lookupFn) => resolveChecked(host, lookupFn), forwardPinned: nodeHttpsPinnedRequester }),
    cache,
    log: (e) => console.info(JSON.stringify({ event: "advance.github_http", method: e.method, path: e.path, status: e.status, message: e.message })),
  });
}

export function openInstallationHttp(kind: InstallationHttpKind, target: InstallationHttpTarget): Promise<InstallationHttp> {
  open ??= build();
  return open(kind, target);
}

/** Test seam: swap the opener; call with no argument to restore the production one. */
export function setInstallationHttpForTests(next?: Open): void {
  open = next;
}
