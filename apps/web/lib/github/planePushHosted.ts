import { parseGate1AttestRepos } from "@fx/pipeline";
import { reportError } from "@fx/telemetry";
import { resolveChecked } from "@fx/net-guard";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import { AppCredentialsError, InstallationTokenCache, createHostedPlanePush, createPlanePushApi, createTeamInstallationOwnership, loadAppCredentials, type HostedPlanePush } from "@fx/github";
import type { PlanePushHostedPort } from "@fx/runner-cloud";
import { buildAccessTokenRequester, nodeHttpsPinnedRequester } from "../../app/api/gh-proxy/[...path]/handler";

/**
 * D#598 P1f-2: the live GitHub side of the runner's public-push routes. A restricted `plane_push` token (one public repository, contents and
 * pull requests write) is minted per call and never cached; the reads that check a runner's report each mint their own and revoke it before
 * they return. It needs no setting of its own: the App credentials are the ones the other GitHub calls use, and a missing App answers the
 * routes' fixed `not_configured`/`public_unavailable`, never a stack.
 */
/**
 * The repositories `ci:full` is put on, read from `FX_GATE1_ATTEST_REPOS` on the first label call (never while a route is wired). A malformed value means labelling is OFF and is reported once
 * (no value text); the worker's own start check is what refuses to start on it. Building this port never throws because of it.
 */
export function lazyFullCiRepos(env: NodeJS.ProcessEnv): () => ReadonlySet<string> {
  let parsed: ReadonlySet<string> | undefined;
  return () => {
    if (parsed === undefined) {
      try {
        parsed = parseGate1AttestRepos(env.FX_GATE1_ATTEST_REPOS);
      } catch (err) {
        parsed = new Set();
        reportError(err, { stage: "plane_push.ci_full_repos_config" });
      }
    }
    return parsed;
  };
}

export function createLivePlanePushPort(env: NodeJS.ProcessEnv = process.env): PlanePushHostedPort & Pick<HostedPlanePush, "openPullRequest" | "ensureFullCiLabel" | "findOpenPullRequest" | "commitAuthors" | "branchHead" | "pullRequestState" | "pullRequestBase" | "closeRefusedPullRequest"> {
  const api = createPlanePushApi({
    appCredentials: loadAppCredentials(env),
    requester: buildAccessTokenRequester({ resolveUpstream: (host, lookupFn) => resolveChecked(host, lookupFn), forwardPinned: nodeHttpsPinnedRequester }),
    // A `plane_push` token never enters a cache; the type wants one.
    cache: new InstallationTokenCache(),
  });
  // The pool is taken on first use, so a missing platform_ops setting is a refused mint (fail closed), not a crash at wiring time.
  const hosted = createHostedPlanePush(api, { ownsInstallation: (accountId, ghInstallationId) => createTeamInstallationOwnership(platformOpsPool())(accountId, ghInstallationId), fullCiRepos: lazyFullCiRepos(env) });
  // An App that is not configured (or configured twice) is "not configured" to the route, not a crash: the message names no key.
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AppCredentialsError) throw Object.assign(new Error("not_configured"), { code: "not_configured" });
      throw error;
    }
  };
  return {
    mintToken: (codeRepo, accountId) => guard(() => hosted.mintToken(codeRepo, accountId)),
    // D#6 PUBLIC-MERGE PR2b: a merge order's read credential (claim) and its one write credential (go); neither is cached or kept.
    mintMergeToken: (codeRepo, accountId, kind) => guard(() => hosted.mintMergeToken(codeRepo, accountId, kind)),
    verifyPushed: (input) => guard(() => hosted.verifyPushed(input)),
    verifyPullRequest: (input) => guard(() => hosted.verifyPullRequest(input)),
    findOpenPullRequest: (input) => guard(() => hosted.findOpenPullRequest(input)),
    commitAuthors: (input) => guard(() => hosted.commitAuthors(input)),
    pullRequestState: (input) => guard(() => hosted.pullRequestState(input)),
    pullRequestBase: (input) => guard(() => hosted.pullRequestBase(input)),
    closeRefusedPullRequest: (input) => guard(() => hosted.closeRefusedPullRequest(input)),
    revokeToken: (token) => hosted.revokeToken(token),
    openPullRequest: (input) => guard(() => hosted.openPullRequest(input)),
    ensureFullCiLabel: (input) => hosted.ensureFullCiLabel(input),
    // FIXROUND-REFRESH-HEAD: the public branch head a fix round checks before it starts (its own token, revoked before this returns).
    branchHead: (input) => guard(() => hosted.branchHead(input)),
  };
}
