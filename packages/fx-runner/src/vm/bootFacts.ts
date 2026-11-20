/**
 * Production boot facts (D#587 B-5a-BF): what `Sandboxd` boots from, derived from two things only, the template the machine has installed and
 * the signed release listing the runner's TUF client verified. Nothing is stored and nothing can be overridden: no setting, variable or
 * argument skips the listing, trusts an unsigned digest or reads digests from a file the user can edit.
 *
 * The installed manifest (`stageBundle` writes it at install) names the kernel and root-disk digests of the template that will boot. Exactly one
 * signed release `vm-<template>-<id12>/` must list both for this architecture, and the agent digest is taken from that same release. A
 * withdrawn release therefore stops booting once the cache lapses, and a machine with no verified release boots nothing. The agent file is
 * inside the root disk, so its digest is a cross-check the release carries, not a second install record.
 *
 * Every failure is one `BootFactsRefused` with a closed code and a fixed sentence: never a digest, a path, an address or server text.
 */
import { CliError } from "../cliError.js";
import { parseVmTarget, VM_KINDS, type BootDigests, type TargetListing, type VmKind } from "./bootGate.js";
import { hostArch } from "./bundle.js";
import type { Arch } from "./lock.js";

export const BOOT_FACTS_CODES = ["image_not_configured", "image_metadata_expired", "image_metadata_refused", "image_not_installed", "image_not_listed", "image_listed_ambiguous", "image_incomplete", "arch_unsupported"] as const;
export type BootFactsCode = (typeof BOOT_FACTS_CODES)[number];

const MESSAGES: Readonly<Record<BootFactsCode, string>> = {
  image_not_configured: "this build has no signed VM image release to check against, so no microVM can start",
  image_metadata_expired: "the signed VM image release metadata has expired, so no microVM can start",
  image_metadata_refused: "the signed VM image release metadata could not be verified, so no microVM can start",
  image_not_installed: "the installed VM image record is missing or unreadable, so no microVM can start",
  image_not_listed: "the installed VM image is not in the signed release metadata, so no microVM can start",
  image_listed_ambiguous: "the signed release metadata lists the installed VM image more than once, so no microVM can start",
  image_incomplete: "the signed release for the installed VM image has no agent entry, so no microVM can start",
  arch_unsupported: "this machine's architecture has no signed VM image, so no microVM can start",
};

/** The only error this module throws. The message is fixed per code and carries nothing else. */
export class BootFactsRefused extends Error {
  readonly code: BootFactsCode;
  constructor(code: BootFactsCode) {
    super(MESSAGES[code]);
    this.name = "BootFactsRefused";
    this.code = code;
  }
}

export type BootFactsResult = { readonly ok: true; readonly release: string; readonly arch: Arch; readonly digests: BootDigests } | { readonly ok: false; readonly code: BootFactsCode };

const SHA256 = /^[0-9a-f]{64}$/;
const ENTRY = new RegExp(`^(${VM_KINDS.join("|")})-([a-z0-9]+)-([0-9a-f]{64})$`);

/** Pure: the one release of `template` whose kernel and root disk are the installed ones, with the digests of all three from it. */
export function selectRelease(paths: readonly string[], template: string, arch: Arch, installed: { readonly kernel: string; readonly rootfs: string }): { release: string; digests: BootDigests } {
  const releases = new Map<string, Record<VmKind, string[]>>();
  for (const listed of paths) {
    const target = parseVmTarget(listed);
    if (target === undefined || target.template !== template) continue;
    const entry = target.name.match(ENTRY);
    if (entry === null || entry[2] !== arch) continue;
    const key = `vm-${target.template}-${target.id}`;
    const kinds = releases.get(key) ?? { kernel: [], rootfs: [], agent: [] };
    kinds[entry[1] as VmKind].push(entry[3]!);
    releases.set(key, kinds);
  }
  const matches = [...releases].filter(([, kinds]) => kinds.kernel.includes(installed.kernel) && kinds.rootfs.includes(installed.rootfs));
  if (matches.length === 0) throw new BootFactsRefused("image_not_listed");
  if (matches.length > 1) throw new BootFactsRefused("image_listed_ambiguous");
  const [release, kinds] = matches[0]!;
  if (kinds.kernel.length > 1 || kinds.rootfs.length > 1 || kinds.agent.length > 1) throw new BootFactsRefused("image_listed_ambiguous");
  if (kinds.agent.length === 0) throw new BootFactsRefused("image_incomplete");
  return { release, digests: { kernel: kinds.kernel[0]!, rootfs: kinds.rootfs[0]!, agent: kinds.agent[0]! } };
}

/** The installed kernel and root-disk digests of `template` from the manifest text, or undefined for anything not exactly that shape. */
function installedDigests(text: string, template: string): { kernel: string; rootfs: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // fx-swallow-ok: damaged text is the image_not_installed answer; the parser's message could echo the file
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Object.hasOwn(parsed, template)) return undefined;
  const entry = (parsed as Record<string, unknown>)[template];
  if (typeof entry !== "object" || entry === null) return undefined;
  const { kernel, rootfs } = entry as Record<string, unknown>;
  return typeof kernel === "string" && SHA256.test(kernel) && typeof rootfs === "string" && SHA256.test(rootfs) ? { kernel, rootfs } : undefined;
}

export interface BootFactsOptions {
  readonly tuf: { listTargets(): Promise<TargetListing> };
  /** The template the machine boots from; `facts()` with no argument uses it. */
  readonly template: string;
  /** The node architecture name (x64, arm64), read once at the bin edge. */
  readonly nodeArch: string;
  /** The installed manifest's text. Throwing (absent, unreadable) is `image_not_installed`. */
  readonly readManifest: () => string | Promise<string>;
  readonly now: () => number;
  /** How long a verified listing is reused; a failure is never kept. Default 60 s. */
  readonly ttlMs?: number;
}

export interface BootFactsSource {
  /** The verified listing, reused for `ttlMs` and shared by concurrent callers. This is also what `Sandboxd` hands the gate. */
  listTargets(): Promise<TargetListing>;
  /** Never throws: the facts of the one signed release, or the closed code. */
  inspect(template?: string): Promise<BootFactsResult>;
  /** The `Sandboxd` boot facts: throws `BootFactsRefused`. */
  facts(template?: string): Promise<{ arch: Arch; digests: BootDigests }>;
}

export function createBootFactsSource(options: BootFactsOptions): BootFactsSource {
  const ttlMs = options.ttlMs ?? 60_000;
  let kept: { at: number; listing: TargetListing } | undefined;
  let inflight: Promise<TargetListing> | undefined;

  const listTargets = (): Promise<TargetListing> => {
    if (kept !== undefined) {
      const age = options.now() - kept.at;
      if (age >= 0 && age < ttlMs) return Promise.resolve(kept.listing);
    }
    inflight ??= options.tuf
      .listTargets()
      .then((listing) => {
        if (listing.ok === true) kept = { at: options.now(), listing };
        return listing;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };

  const inspect = async (template: string = options.template): Promise<BootFactsResult> => {
    const refuse = (code: BootFactsCode): BootFactsResult => ({ ok: false, code });
    let arch: Arch;
    try {
      arch = hostArch(options.nodeArch);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      return refuse("arch_unsupported");
    }
    let listing: TargetListing;
    try {
      listing = await listTargets();
    } catch {
      // fx-swallow-ok: the transport's error text is not shown; the closed code says it was refused
      return refuse("image_metadata_refused");
    }
    if (listing.ok !== true) return refuse(listing.state === "not_configured" ? "image_not_configured" : listing.state === "paused" ? "image_metadata_expired" : "image_metadata_refused");
    let text: string;
    try {
      text = await options.readManifest();
    } catch {
      // fx-swallow-ok: the read error names a path; the closed code stands in for it
      return refuse("image_not_installed");
    }
    const installed = installedDigests(text, template);
    if (installed === undefined) return refuse("image_not_installed");
    try {
      return { ok: true, arch, ...selectRelease(listing.paths, template, arch, installed) };
    } catch (error) {
      if (!(error instanceof BootFactsRefused)) throw error;
      return refuse(error.code);
    }
  };

  return {
    listTargets,
    inspect,
    facts: async (template) => {
      const result = await inspect(template);
      if (!result.ok) throw new BootFactsRefused(result.code);
      return { arch: result.arch, digests: result.digests };
    },
  };
}

const DOCTOR_FIX: Readonly<Record<BootFactsCode, string>> = {
  image_not_configured: "this build has no signed VM image release yet, so microVM jobs cannot start; nothing falls back to the OS sandbox",
  image_metadata_expired: "the release metadata is expired; microVM jobs are paused until it is renewed",
  image_metadata_refused: "the release metadata could not be verified; microVM jobs cannot start until it can",
  image_not_installed: "the installed VM image record is missing or damaged; run: fx-runner vm install",
  image_not_listed: "the installed image is not the current signed release: run fx-runner vm install",
  image_listed_ambiguous: "the signed release metadata lists the installed image more than once; microVM jobs cannot start until the release is corrected",
  image_incomplete: "the signed release for the installed image has no agent entry; microVM jobs cannot start until the release is corrected",
  arch_unsupported: "this machine's architecture has no signed VM image, so microVM jobs cannot run here",
};

/** The doctor's "VM image" line, from the same result the runner boots from. FAIL when the person asked for microvm, WARN otherwise. */
export function describeBootFacts(result: BootFactsResult, microvm: boolean): { level: "PASS" | "WARN" | "FAIL"; detail: string } {
  if (!result.ok) return { level: microvm ? "FAIL" : "WARN", detail: DOCTOR_FIX[result.code] };
  const short = (sha: string): string => sha.slice(0, 12);
  const d = result.digests;
  return { level: "PASS", detail: `release ${result.release} for ${result.arch}: kernel ${short(d.kernel)}, root disk ${short(d.rootfs)} and agent ${short(d.agent)} are listed in the signed metadata (checked just now)` };
}
