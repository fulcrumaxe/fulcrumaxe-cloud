/**
 * The verified bundle for a VM-mode install (D#587 B-2a-2 PR-2). Everything the root phase will put under /opt/fx-vmhelper is chosen from
 * the signed release listing, downloaded through `TufClient.fetchTarget` (which checks the signed length and SHA-256), checked once more
 * here, and staged as the ordinary user in a fresh 0700 directory. Nothing unsigned is ever fetched, and nothing here runs a downloaded
 * file, calls sudo or reads the machine's package state: the root phase (a later row) installs what this returns.
 *
 * The signed names are `vmhelper-<arch>-<sha256>`, `jailer-<arch>-<sha256>` and `firecracker-<arch>-<sha256>` at the top of the
 * targets, and `vm-<template>-<id12>/<kind>-<arch>-<sha256>` for each template file (as `scripts/vm-manifest.mjs` writes them). A name that
 * is not listed fails closed with "not listed". The image lock's upstream pin is not signed metadata and is never read here.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliError } from "../cliError.js";
import type { TufClient } from "../update/tuf.js";
import { LAYOUT } from "./installPlan.js";
import { ARCHES, TEMPLATES, type Arch } from "./lock.js";

export const BINARIES = ["vmhelper", "jailer", "firecracker"] as const;
export type BinaryName = (typeof BINARIES)[number];
export const TEMPLATE_KINDS = ["kernel", "rootfs"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export interface StagedFile {
  /** Absolute path in the staging directory. */
  readonly file: string;
  readonly sha256: string;
  readonly length: number;
  /** Where the root phase puts it (from the install plan's layout). */
  readonly dest: string;
}

export interface StagedBundle {
  readonly dir: string;
  readonly arch: Arch;
  readonly binaries: Readonly<Record<BinaryName, StagedFile>>;
  readonly templates: Readonly<Record<string, Readonly<Record<TemplateKind, StagedFile>>>>;
  /** The pinned template manifest: `{"<id>":{"kernel":"<sha256>","rootfs":"<sha256>"}}`, built from the verified digests. */
  readonly manifest: { readonly file: string; readonly text: string; readonly dest: string };
  /** Removes the staging directory. The root phase calls it once it has installed (or refused) the bundle. */
  cleanup(): void;
}

export interface StageOptions {
  readonly tuf: Pick<TufClient, "listTargets" | "fetchTarget">;
  readonly arch: Arch;
  readonly templates?: readonly string[];
  /** Where the 0700 staging directory is made. Tests only; the default is the system temp directory. */
  readonly tmpRoot?: string;
}

/** The architecture the signed names use for a Node `os.arch()` value; anything else is not a VM host. The caller reads the machine. */
export function hostArch(nodeArch: string): Arch {
  const arch = nodeArch === "x64" ? "amd64" : nodeArch === "arm64" ? "arm64" : undefined;
  if (arch === undefined) throw new CliError("install: this machine's architecture has no signed VM files", 2);
  return arch;
}

interface Pick1 {
  readonly path: string;
  readonly sha256: string;
}

/** The one listed path matching `pattern`, with the sha256 its name carries. Zero or several is a refusal that names the file, never a digest. */
function pickOne(paths: readonly string[], pattern: RegExp, label: string): Pick1 {
  const found = paths.flatMap((p) => {
    const m = p.match(pattern);
    // the patterns only match 64 lower-case hex digits
    return m !== null ? [{ path: p, sha256: m[1]! }] : [];
  });
  if (found.length === 0) throw new CliError(`install: ${label} is not listed in the signed release metadata`);
  if (found.length > 1) throw new CliError(`install: ${label} is listed more than once in the signed release metadata`);
  return found[0]!;
}

export interface Selection {
  readonly binaries: Readonly<Record<BinaryName, Pick1>>;
  readonly templates: Readonly<Record<string, Readonly<Record<TemplateKind, Pick1>>>>;
}

/** Chooses this architecture's three binaries and each template's kernel and root disk from a verified listing. Pure. */
export function selectTargets(paths: readonly string[], arch: Arch, templates: readonly string[] = TEMPLATES): Selection {
  if (!(ARCHES as readonly string[]).includes(arch)) throw new CliError("install: unknown architecture", 2);
  if (templates.length === 0) throw new CliError("install: no template was asked for", 2);
  for (const id of templates) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) throw new CliError("install: a template name is not a plain lower-case name", 2);
  }
  const binaries = Object.fromEntries(BINARIES.map((b) => [b, pickOne(paths, new RegExp(`^${b}-${arch}-([0-9a-f]{64})$`), `the ${b} for ${arch}`)])) as Record<BinaryName, Pick1>;
  const picked: Record<string, Record<TemplateKind, Pick1>> = {};
  for (const id of templates) {
    const kinds = Object.fromEntries(TEMPLATE_KINDS.map((k) => [k, pickOne(paths, new RegExp(`^vm-${id}-[0-9a-f]{12}/${k}-${arch}-([0-9a-f]{64})$`), `the ${k} of template ${id} for ${arch}`)])) as Record<TemplateKind, Pick1>;
    picked[id] = kinds;
  }
  return { binaries, templates: picked };
}

/** A fresh directory only this user can enter: `mkdtemp` makes it 0700 and owned by the caller, and the name is unpredictable. */
function makeStagingDir(root: string): string {
  return mkdtempSync(path.join(root, "fx-vm-bundle-"));
}

/** Reads a file without following a final symlink (a directory or device fails the read). */
function readNoFollow(file: string): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Writes a new file; O_EXCL refuses anything already at the path, a symlink, hard link or file alike. */
function writeNew(file: string, bytes: Buffer): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Downloads one listed file through the verifying client and stages a copy whose bytes are hashed again. */
async function stageOne(tuf: StageOptions["tuf"], pick: Pick1, to: string, dest: string, label: string): Promise<StagedFile> {
  const got = await tuf.fetchTarget(pick.path);
  if (!got.ok) throw new CliError(`install: ${label} could not be downloaded and verified (${got.state})`);
  // The name carries the digest, the metadata carries the digest: they must agree, and so must the bytes on disk.
  if (got.sha256 !== pick.sha256) throw new CliError(`install: ${label} does not match the digest in its signed name`);
  const bytes = readNoFollow(got.file);
  if (sha256Of(bytes) !== pick.sha256) throw new CliError(`install: ${label} does not match the signed length and hash`);
  writeNew(to, bytes);
  rmSync(got.file, { force: true });
  return { file: to, sha256: pick.sha256, length: bytes.length, dest };
}

/**
 * Selects, downloads, verifies and stages the bundle. On any failure the staging directory is removed and a CliError (exit 1, or 2 for a
 * bad request) is thrown; nothing has been installed and nothing privileged has run.
 */
export async function stageBundle(options: StageOptions): Promise<StagedBundle> {
  const listing = await options.tuf.listTargets();
  if (!listing.ok) {
    const state = /^[a-z_]{1,20}$/.test(listing.state) ? listing.state : "unverified";
    throw new CliError(`install: the signed release metadata could not be verified (${state})`);
  }
  const selection = selectTargets(listing.paths, options.arch, options.templates);
  const dir = makeStagingDir(options.tmpRoot ?? tmpdir());
  try {
    const binaries = {} as Record<BinaryName, StagedFile>;
    const dests: Record<BinaryName, string> = { vmhelper: LAYOUT.helperBinary, jailer: LAYOUT.jailerBinary, firecracker: LAYOUT.firecrackerBinary };
    for (const name of BINARIES) binaries[name] = await stageOne(options.tuf, selection.binaries[name], path.join(dir, name), dests[name], `the ${name}`);
    const templates: Record<string, Record<TemplateKind, StagedFile>> = {};
    const manifest: Record<string, Record<TemplateKind, string>> = {};
    for (const [id, kinds] of Object.entries(selection.templates)) {
      mkdirSync(path.join(dir, "templates", id), { recursive: true, mode: 0o700 });
      const staged = {} as Record<TemplateKind, StagedFile>;
      for (const kind of TEMPLATE_KINDS) staged[kind] = await stageOne(options.tuf, kinds[kind], path.join(dir, "templates", id, kind), path.posix.join(LAYOUT.templateDir, id, kind), `the ${kind} of template ${id}`);
      templates[id] = staged;
      manifest[id] = { kernel: staged.kernel.sha256, rootfs: staged.rootfs.sha256 };
    }
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestFile = path.join(dir, "template-manifest.json");
    writeNew(manifestFile, Buffer.from(text));
    return { dir, arch: options.arch, binaries, templates, manifest: { file: manifestFile, text, dest: LAYOUT.templateManifest }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
