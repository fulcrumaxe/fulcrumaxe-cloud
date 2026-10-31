import type { ReversalGitOpeners } from "@fx/worker";
import { openInstallationHttp } from "./installationHttp";
import { openFencedPrCloseClient } from "./runnerPullRequest";

/**
 * D#7 DP7-2d: the GitHub clients a reversal works through (packages/worker/src/reversalCompensate.ts). Server-only, and nothing here imports the receipts package.
 *  - The close of the original pull request uses the branch sweep's client: the pull-request installation client already behind the local-only fence, so the
 *    only calls that can reach GitHub are the list of one head branch and the close of one pull request.
 *  - The revert is opened through the installation opener itself; `openRevertPullRequest` (packages/github revertPr.ts) asks it for its one revert client,
 *    pinned to the merged pull request. No kind is named here.
 * No route, cron, file read or environment variable is added.
 */
export function createReversalGitOpeners(open: typeof openInstallationHttp = openInstallationHttp): ReversalGitOpeners {
  return {
    openPulls: (target) => openFencedPrCloseClient(open, target),
    openRevert: (kind, target) => open(kind, target),
  };
}
