import { resolveChecked } from "@fx/net-guard";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import type { PlanImportDeps } from "@fx/api/src/routes/plan.js";
import { createPlanReadClient, createPlanSourceFactory, createRepoInstallationResolver, loadAppCredentials, readRepoHead, readRepoInstructionFile, type PlanReadDeps, type PlanReadTarget, type PlanSourceShape } from "@fx/github";
import { fileReaderFromContents } from "@fx/pipeline";
import type { VerifyHostPort, VerifyRepoReader } from "@fx/worker";
import type { RepoFileRead } from "@fx/core/src/memory/repoFileSweep.js";
import { createVerifyHost } from "./verifyHost";
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

/** The full read-only source: the plan import narrows it to `PlanSource`, and the discovery drain (D#483 S4-c2) also reads `recentOpen`. */
export function openDiscoverySource(target: { repoId: string; owner: string; name: string }): PlanSourceShape {
  factory ??= createPlanSourceFactory(planReadDeps());
  return factory(target);
}

export const openPlanSource: NonNullable<PlanImportDeps["openSource"]> = (target) => openDiscoverySource(target);

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

/**
 * D#601 MEM-5b: the repo instruction file import's reader. One read-only client per file: the default branch's head commit, then the file at that commit through the
 * contents API (a regular file only, 1.5 MB at most). A failure is a `PlanReadError` whose fixed `code` the sweep records.
 */
export const readRepoFileForImport: RepoFileRead = async (job) => {
  verifyClients ??= createPlanReadClient(planReadDeps());
  const client = verifyClients({ repoId: job.repoId, owner: job.owner, name: job.name });
  const repo = { owner: job.owner, name: job.name };
  const commit = (await readRepoHead(client, repo)).sha;
  return { commit, file: await readRepoInstructionFile(client, repo, job.path, commit) };
};

/**
 * D#749 V3a-2: the post-merge verify stage's host reader (a merged pull request's commit, a commit's parents, how two commits relate), on the same read-only client
 * and the same read-App credentials as the plan import. The client is built on the first read, so a deployment without the credentials answers "no answer" (which the stage retries),
 * never an error at load or in the tick.
 */
export const openVerifyHost: VerifyHostPort = createVerifyHost(planReadDeps);
