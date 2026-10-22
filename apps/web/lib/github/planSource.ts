import { resolveChecked } from "@fx/net-guard";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import type { PlanImportDeps } from "@fx/api/src/routes/plan.js";
import { createPlanReadClient, createPlanSourceFactory, createRepoInstallationResolver, loadAppCredentials, readRepoHead, type PlanReadDeps, type PlanReadTarget, type PlanSourceShape } from "@fx/github";
import { fileReaderFromContents } from "@fx/pipeline";
import type { VerifyRepoReader } from "@fx/worker";
import { buildAccessTokenRequester, nodeHttpsPinnedRequester } from "../../app/api/gh-proxy/[...path]/handler";

/**
 * D#483 S3 (live build L1): the production read side of a plan import. Built once per process, on first use, from the existing
 * read-App credentials (no new environment variable): when they are missing the first read fails at the token mint and the
 * import ends `github_unavailable`, never a crash at load. Every client it opens is read-only by construction (see
 * packages/github/src/planReadClient.ts) and mints its own `plan_read` token, one repository, permissions checked read-only.
 */
let factory: ((target: { repoId: string; owner: string; name: string }) => PlanSourceShape) | undefined;
let verifyClients: ReturnType<typeof createPlanReadClient> | undefined;

const planReadDeps = (): PlanReadDeps => ({
  resolveInstallation: createRepoInstallationResolver(platformOpsPool()),
  appCredentials: loadAppCredentials(process.env),
  requester: buildAccessTokenRequester({ resolveUpstream: (host, lookupFn) => resolveChecked(host, lookupFn), forwardPinned: nodeHttpsPinnedRequester }),
});

export const openPlanSource: NonNullable<PlanImportDeps["openSource"]> = (target) => {
  factory ??= createPlanSourceFactory(planReadDeps());
  return factory(target);
};

/**
 * D#483 S4-b2b: the claim verifier's GitHub reader, on the same read-only client as the plan import: the default branch's head (the sha a
 * check is pinned to) and a file at a commit through the contents API (S4-b1's reader, which accepts only a regular file).
 */
export function openVerifyReader(target: PlanReadTarget): VerifyRepoReader {
  verifyClients ??= createPlanReadClient(planReadDeps());
  const client = verifyClients(target);
  const repo = { owner: target.owner, name: target.name };
  const files = fileReaderFromContents((req) => client.request(req), repo);
  return { headSha: async () => (await readRepoHead(client, repo)).sha, readFile: (path, sha) => files.readFile(path, sha) };
}
