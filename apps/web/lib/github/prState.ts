import type { PrStateOpen } from "@fx/worker";
import { openInstallationHttp } from "./installationHttp";
import { openForRepo } from "./localOnlyHttp";

/**
 * D#598: the GitHub client the worker reads a pull request's real state with, when an item sits in a pull-request stage after its pull request was closed
 * or merged without the webhook (packages/worker/src/prSlotReconcile.ts). It is the `read` installation client (a token scoped to the one repository with
 * `metadata: read` and `pull_requests: read`; GET only), behind the local-only fence for a `runner_local` repository, as the review's own lookups are. It
 * can write nothing to GitHub.
 */
export function createPrStateReader(open: typeof openInstallationHttp = openInstallationHttp): PrStateOpen {
  return (executionMode, target) => openForRepo(open, executionMode, "read", { repoId: target.repoId, owner: target.owner, name: target.name });
}
