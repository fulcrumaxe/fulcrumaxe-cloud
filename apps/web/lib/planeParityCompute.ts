import { computePlaneParity } from "@fx/pipeline";
import type { ParityCompute, ParityOutcome } from "@fx/core/src/repos/planeParityChecks.js";
import { openInstallationHttp } from "./github/installationHttp";

/**
 * D#598 P1d-3: the plane parity check as the setup-request sweep runs it. Two read-only `plane_parity` clients, one per repository, each with its own
 * short-lived token (revoked on close): the private repo's own installation, and the installation of the account's own row for the paired public repo.
 * A pairing whose public repo the account has no row for cannot be read here and is `unavailable` (nothing changes, and it backs off).
 */
const UNAVAILABLE: ParityOutcome = { result: "unavailable", privateSha: null, publicSha: null, syncSha: null, paths: [], pathCount: 0, limitSide: null };

export const computeParityForJob: ParityCompute = async (job) => {
  if (job.publicRepoId === null) return UNAVAILABLE;
  const opened: Array<{ close?: () => Promise<void> }> = [];
  try {
    const privateHttp = await openInstallationHttp("plane_parity", { repoId: job.repoId, owner: job.privateRepo.owner, name: job.privateRepo.name });
    opened.push(privateHttp);
    const publicHttp = await openInstallationHttp("plane_parity", { repoId: job.publicRepoId, owner: job.publicRepo.owner, name: job.publicRepo.name });
    opened.push(publicHttp);
    const out = await computePlaneParity({ privateHttp, publicHttp, pairing: { privateRepo: job.privateRepo, publicRepo: job.publicRepo, overlayGlobs: job.overlayGlobs } });
    return { ...out };
  } catch {
    // fx-swallow-ok: a client that could not be opened (no installation, a token the platform could not mint) is "could not know"; its text can carry a URL
    return UNAVAILABLE;
  } finally {
    await Promise.allSettled(opened.map((h) => h.close?.()));
  }
};
