import { resolveChecked } from "@fx/net-guard";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import type { PlanImportDeps } from "@fx/api/src/routes/plan.js";
import { createPlanSourceFactory, createRepoInstallationResolver, loadAppCredentials, type PlanSourceShape } from "@fx/github";
import { buildAccessTokenRequester, nodeHttpsPinnedRequester } from "../../app/api/gh-proxy/[...path]/handler";

/**
 * D#483 S3 (live build L1): the production read side of a plan import. Built once per process, on first use, from the existing
 * read-App credentials (no new environment variable): when they are missing the first read fails at the token mint and the
 * import ends `github_unavailable`, never a crash at load. Every client it opens is read-only by construction (see
 * packages/github/src/planReadClient.ts) and mints its own `plan_read` token, one repository, permissions checked read-only.
 */
let factory: ((target: { repoId: string; owner: string; name: string }) => PlanSourceShape) | undefined;

export const openPlanSource: NonNullable<PlanImportDeps["openSource"]> = (target) => {
  factory ??= createPlanSourceFactory({
    resolveInstallation: createRepoInstallationResolver(platformOpsPool()),
    appCredentials: loadAppCredentials(process.env),
    requester: buildAccessTokenRequester({ resolveUpstream: (host, lookupFn) => resolveChecked(host, lookupFn), forwardPinned: nodeHttpsPinnedRequester }),
  });
  return factory(target);
};
