import { computeTwinParity } from "@fx/pipeline";
import type { TwinParityCompute, TwinParityOutcome } from "@fx/core/src/repos/twinSweep.js";
import { openInstallationHttp } from "./github/installationHttp";

/**
 * D#845 ON-27d4b: a private twin's parity check as the setup-request sweep runs it, the twin's side of `planeParityCompute`. Two read-only `plane_parity` clients, one per repository, each with its own short-lived token (revoked on close):
 * the installation of the twin's private repository and the installation of the account's own row for its public one (a twin's two repositories are both rows of the account). A client that cannot be opened is "could not know": `unavailable`,
 * nothing is stored, and the claim's five minutes are the back-off.
 */
const UNAVAILABLE: TwinParityOutcome = { result: "unavailable", privateSha: null, publicSha: null, paths: [], pathCount: 0, publishCount: 0, syncCount: 0, conflictCount: 0, advanceSyncedTo: null };

export const computeTwinParityForJob: TwinParityCompute = async (job) => {
  const opened: Array<{ close?: () => Promise<void> }> = [];
  try {
    const privateHttp = await openInstallationHttp("plane_parity", { repoId: job.privateRepoId, owner: job.privateRepo.owner, name: job.privateRepo.name });
    opened.push(privateHttp);
    const publicHttp = await openInstallationHttp("plane_parity", { repoId: job.publicRepoId, owner: job.publicRepo.owner, name: job.publicRepo.name });
    opened.push(publicHttp);
    const out = await computeTwinParity({
      privateHttp,
      publicHttp,
      twin: { privateRepo: job.privateRepo, publicRepo: job.publicRepo, publishedPrivateSha: job.publishedPrivateSha, syncedPublicSha: job.syncedPublicSha, overlayGlobs: job.overlayGlobs, installPaths: job.installPaths },
    });
    return { ...out };
  } catch {
    // fx-swallow-ok: a client that could not be opened (no installation, a token the platform could not mint) is "could not know"; its text can carry a URL
    return UNAVAILABLE;
  } finally {
    await Promise.allSettled(opened.map((h) => h.close?.()));
  }
};
