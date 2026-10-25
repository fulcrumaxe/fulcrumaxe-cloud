import type { PrCloseOpen } from "@fx/worker";
import { openInstallationHttp } from "./installationHttp";
import { openFencedPrCloseClient } from "./runnerPullRequest";

/**
 * The GitHub client the branch cleanup sweep lists and closes a paired item's private pull request with (packages/worker/src/privatePrClose.ts). It is
 * the pull request port's installation client (pull_requests write on the one repository) opened by runnerPullRequest.ts already behind the local-only
 * fence, for every mode: the only calls that reach GitHub are the allowlisted A3 (list) and A5 (close).
 */
export function createPrCloseOpener(open: typeof openInstallationHttp = openInstallationHttp): PrCloseOpen {
  return (_executionMode, target) => openFencedPrCloseClient(open, target);
}
