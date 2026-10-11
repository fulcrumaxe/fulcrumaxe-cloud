/**
 * The boot gate (D#587 B-1): a kernel, root disk or agent whose digest is not in the signed release metadata is not booted.
 *
 * The metadata lists each file under a path that carries its own digest, `vm-<template>-<id>/<kind>-<arch>-<sha256>`, so the question
 * "is this digest listed" is a lookup in the paths the verified targets metadata names (`TufClient.listTargets`). The download of a
 * listed file is verified against its signed length and SHA-256 by `TufClient.fetchTarget`, as for the runner itself.
 */
import { CliError } from "../cliError.js";
import type { TufClient } from "../update/tuf.js";
import type { Arch } from "./lock.js";

/** What `TufClient.listTargets()` answers: the verified listing, or the reason there is none (not configured, paused, refused). */
export type TargetListing = Awaited<ReturnType<TufClient["listTargets"]>>;

export const VM_KINDS = ["kernel", "rootfs", "agent"] as const;
export type VmKind = (typeof VM_KINDS)[number];

/** The sha256 (64 lowercase hex digits) of each file the guest boots from. */
export type BootDigests = Readonly<Record<VmKind, string>>;

const SHA256 = /^[0-9a-f]{64}$/;

/** The part of the target path after the release tag: `rootfs-amd64-<sha256>`. */
export const vmAssetName = (kind: VmKind, arch: Arch, sha256: string): string => `${kind}-${arch}-${sha256}`;

/** The kinds whose digest is not listed for this template and architecture. Empty means the whole set may boot. */
export function unlistedKinds(listedPaths: readonly string[], template: string, arch: Arch, digests: BootDigests): VmKind[] {
  const listed = new Set<string>();
  for (const listedPath of listedPaths) {
    const named = listedPath.match(/^vm-([a-z][a-z0-9-]*)-[0-9a-f]{12}\/([^/]+)$/);
    if (named !== null && named[1] === template) listed.add(named[2]!);
  }
  return VM_KINDS.filter((kind) => !SHA256.test(digests[kind]) || !listed.has(vmAssetName(kind, arch, digests[kind])));
}

/**
 * Throws unless the metadata verified AND every digest is listed. It takes the outcome of `listTargets()` itself rather than a list of
 * paths, so a caller cannot hand it a listing that was never verified, and cannot carry on after an expired, refused or unconfigured
 * answer: anything that is not `ok` refuses, with a fixed message that names the state and carries no server text. The message names
 * the kinds and never a digest or a path.
 */
export function assertBootable(listing: TargetListing, template: string, arch: Arch, digests: BootDigests): void {
  if (typeof listing !== "object" || listing === null || listing.ok !== true || !Array.isArray(listing.paths)) {
    const state = typeof listing === "object" && listing !== null && "state" in listing && typeof listing.state === "string" && /^[a-z_]{1,20}$/.test(listing.state) ? listing.state : "unverified";
    throw new CliError(`refusing to boot: the signed release metadata could not be verified (${state})`);
  }
  const missing = unlistedKinds(listing.paths, template, arch, digests);
  if (missing.length > 0) throw new CliError(`refusing to boot: the signed release metadata does not list this ${missing.join(", ")}`);
}
