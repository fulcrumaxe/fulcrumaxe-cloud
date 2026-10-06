import type { Pool } from "pg";
import { resolveChecked } from "@fx/net-guard";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import {
  createIssueAuthorLookup,
  createRepoInstallationResolver,
  InstallationTokenCache,
  loadAppCredentials,
  type RepoInstallationResolver,
} from "@fx/github";
import type { AuthorCheckProvider, IssueAuthorLookup } from "@fx/core/src/runActions/authorCheck.js";
import { buildAccessTokenRequester, nodeHttpsPinnedRequester } from "../../app/api/gh-proxy/[...path]/handler";
import { intakeAllowlist } from "./intakeTrust";

/**
 * D#31 AUTHOR-CHECK-WIRE: the production retry author check, one function used by both the
 * /api/v1 route (runActionDeps.getAuthorCheck) and the worker (ports.authorCheck).
 *
 * The GitHub lookup is built once per process. The allowlist is NOT: it is re-read on every call
 * (permission and trust are re-resolved on every event). This never throws: if the lookup cannot
 * be built (say the platform_ops URL is missing) it answers null for that call, does not keep the
 * failure, and the caller treats null as unavailable, never trusted. Missing GitHub App
 * credentials do not make it null: they fail at token mint, which the check also reads as unavailable.
 */
const cache = new InstallationTokenCache();
let lookup: IssueAuthorLookup | undefined;
let resolverOverride: RepoInstallationResolver | undefined;

function build(): IssueAuthorLookup {
  const pool: Pool = platformOpsPool();
  return createIssueAuthorLookup({
    resolveInstallation: resolverOverride ?? createRepoInstallationResolver(pool),
    appCredentials: loadAppCredentials(process.env),
    requester: buildAccessTokenRequester({
      resolveUpstream: (host, lookupFn) => resolveChecked(host, lookupFn),
      forwardPinned: nodeHttpsPinnedRequester,
    }),
    cache,
  });
}

export const getAuthorCheck: AuthorCheckProvider = () => {
  try {
    lookup ??= build();
    return { lookup, allowlist: intakeAllowlist() ?? [] };
  } catch {
    return null;
  }
};

/** Test seam: swap the repo-to-installation resolver and drop the memoised lookup; call with no argument to restore. */
export function setAuthorCheckSeamForTests(seam?: { resolveInstallation?: RepoInstallationResolver }): void {
  lookup = undefined;
  resolverOverride = seam?.resolveInstallation;
}
