#!/usr/bin/env node
// The Playwright sidecar of the single executable (D#749 V2c-2c). playwright-core cannot be bundled into the executable (it loads its protocol packages by path), so a release carries it as a
// folder laid down NEXT TO the binary:
//
//     <folder of the binary>/fx-runner-playwright/node_modules/playwright-core/...
//
// The folder is exactly one package at the exact pinned version, its runtime files only, and no browser (Chromium comes from `verify.browser.executable`). This file is the one place that knows how it is
// made, listed, digested, packed, unpacked, checked and swapped in, for the build (scripts/build-sea.mjs), the release (scripts/release-manifest.mjs, release-render.mjs, release-check.mjs), the loader
// (bin/sidecarLibrary.mjs) and the updater (src/update/updater.ts, through bin/fx-runner.mjs, which hands it over: nothing under src/ imports a script).
//
// Trust: the binary carries the digest of the whole tree (build-sea.mjs bakes it in), so a folder that was swapped, extended or edited after it was laid down is not the sidecar this binary was built
// with and the loader refuses it. On the release path the packed archive is a TUF target, so the signed metadata covers its digest like the binary's; unpacking checks every file against the header and
// refuses anything that is not a plain file under node_modules/playwright-core.
//
// Out of scope: a writer of the sidecar folder who is the same user as the runner. That user could just as well replace the binary itself, so the digest, the loader fence and the updater checks defend
// against everything else (a planted parent folder, NODE_PATH, a tampered download, a stale or foreign folder), not against the account that owns the install.
//
//   node scripts/sidecar-cli.mjs build   --out-dir <dir>              lays <dir>/fx-runner-playwright down from the installed pinned package
//   node scripts/sidecar-cli.mjs install --binary-dir <dir> [--digest <hex>]  (re)lays it next to a binary that was built or installed another way; atomic, with rollback
//   node scripts/sidecar-cli.mjs verify  --binary-dir <dir> [--digest <hex>]
//                                                                  the folder is a whole, plain tree (and has this digest, when given)
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Looked up when it is needed (build time only): the single executable's bundle has no import.meta, and bin/ imports this file.
const packageDir = () => path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SIDECAR_DIR = "fx-runner-playwright";
export const SIDECAR_LIBRARY = "playwright-core";
/** The release file name, and the target `v<version>/<name>` the signed metadata lists it under. */
export const SIDECAR_ARCHIVE = "fx-runner-playwright.fxsc";
const LIBRARY_ROOT = `node_modules/${SIDECAR_LIBRARY}`;
const MAGIC = "FXSC1\n";

export const MAX_FILES = 2000;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;

/** What is left out of the copy: the type declarations and the readme. Everything the library loads at run time, and its LICENSE, NOTICE and third-party notices, stay. */
const OMITTED = [/^types(\/|$)/, /^index\.d\.ts$/, /^README\.md$/];
/** Names that would mean a browser (or a browser download) got into the folder. */
const BROWSER_NAME = /(^|\/)(\.local-browsers|ms-playwright|chrome-linux[^/]*|chrome-mac[^/]*|chrome-win[^/]*|chromium-\d+|chromium_headless_shell[^/]*|headless_shell|chrome|chromium|chrome\.exe|Chromium\.app|Google Chrome[^/]*)(\/|$)/i;

export class SidecarError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "SidecarError";
    this.code = code;
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The pinned version: the exact `playwright-core` dependency of this package, which must be x.y.z with no range. */
export function pinnedVersion() {
  const wanted = JSON.parse(readFileSync(path.join(packageDir(), "package.json"), "utf8")).dependencies?.[SIDECAR_LIBRARY];
  if (typeof wanted !== "string" || !/^\d+\.\d+\.\d+$/.test(wanted)) throw new SidecarError("version_not_pinned", `package.json must pin ${SIDECAR_LIBRARY} to one exact x.y.z version`);
  return wanted;
}

/** The installed package this build copies from (links resolved), checked to be the pinned version. */
export function installedLibrary(from = packageDir()) {
  let dir;
  try {
    dir = path.dirname(realpathSync(createRequire(path.join(from, "package.json")).resolve(`${SIDECAR_LIBRARY}/package.json`)));
  } catch {
    throw new SidecarError("library_missing", `${SIDECAR_LIBRARY} is not installed here (run pnpm install)`);
  }
  const version = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version;
  if (version !== pinnedVersion()) throw new SidecarError("version_mismatch", `the installed ${SIDECAR_LIBRARY} is ${String(version).slice(0, 20)}, not the pinned ${pinnedVersion()}`);
  return { dir, version };
}

/** The sorted, plain-file listing of a tree: `{ path, size, sha256 }`. A link, a device or anything else that is not a plain file or folder is an error: it cannot be part of the sidecar. */
export function listTree(root) {
  const out = [];
  let total = 0;
  const walk = (relative) => {
    const here = path.join(root, relative);
    const info = lstatSync(here);
    if (info.isDirectory()) {
      for (const name of readdirSync(here).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) walk(relative === "" ? name : `${relative}/${name}`);
      return;
    }
    if (!info.isFile()) throw new SidecarError("not_plain", "the sidecar holds something that is not a plain file or folder");
    if (info.size > MAX_FILE_BYTES) throw new SidecarError("file_too_large", "the sidecar holds a file over the size limit");
    total += info.size;
    if (out.length >= MAX_FILES || total > MAX_TOTAL_BYTES) throw new SidecarError("tree_too_large", "the sidecar holds too many or too large files");
    out.push({ path: relative, size: info.size, sha256: sha256(readFileSync(here)) });
  };
  if (!lstatSync(root).isDirectory()) throw new SidecarError("not_plain", "the sidecar is not a folder");
  walk("");
  return out;
}

/** A cheap fingerprint of a folder (names, sizes, times, inodes; no content), to tell "nothing changed since it was last verified". Throws like listTree on anything that is not plain. */
export function treeSignature(root) {
  const lines = [];
  const walk = (relative) => {
    const info = lstatSync(path.join(root, relative));
    lines.push(`${relative}\0${info.size}\0${info.mtimeMs}\0${info.ino}\0${info.mode}`);
    if (info.isDirectory()) for (const name of readdirSync(path.join(root, relative)).sort()) walk(relative === "" ? name : `${relative}/${name}`);
    else if (!info.isFile()) throw new SidecarError("not_plain", "the sidecar holds something that is not a plain file or folder");
  };
  walk("");
  return lines.join("\n");
}

/** One digest for a whole listing (paths, sizes and file digests, in order). The binary carries this value. */
export function treeDigest(entries) {
  return sha256(entries.map((entry) => `${entry.sha256}  ${entry.size}  ${entry.path}\n`).join(""));
}

/** Throws when a listing could hold a browser: a browser-like name or one oversized file (the library's biggest file is a few MB). */
export function assertNoBrowsers(entries) {
  for (const entry of entries) {
    if (BROWSER_NAME.test(entry.path) && !entry.path.startsWith(`${LIBRARY_ROOT}/lib/`)) throw new SidecarError("browser_inside", "the sidecar must hold no browser; Chromium comes from verify.browser.executable");
    if (entry.size > MAX_FILE_BYTES) throw new SidecarError("browser_inside", "the sidecar holds a file too large to be library code");
  }
}

/** The shape every sidecar has: only `node_modules/playwright-core/...`, with a package.json of that name. */
export function assertShape(entries) {
  if (entries.length === 0) throw new SidecarError("empty", "the sidecar is empty");
  for (const entry of entries) {
    if (!entry.path.startsWith(`${LIBRARY_ROOT}/`)) throw new SidecarError("outside_library", "the sidecar may hold only node_modules/playwright-core");
  }
  if (!entries.some((entry) => entry.path === `${LIBRARY_ROOT}/package.json`)) throw new SidecarError("no_package_json", "the sidecar has no playwright-core package.json");
}

const keep = (relative) => !OMITTED.some((pattern) => pattern.test(relative));

function copyTree(from, to, relative = "") {
  const here = path.join(from, relative);
  for (const name of readdirSync(here).sort()) {
    const child = relative === "" ? name : `${relative}/${name}`;
    if (!keep(child)) continue;
    const info = lstatSync(path.join(from, child));
    if (info.isDirectory()) copyTree(from, to, child);
    else if (info.isFile()) {
      const target = path.join(to, child);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      copyFileSync(path.join(from, child), target, constants.COPYFILE_EXCL);
      chmodSync(target, 0o644);
    } else throw new SidecarError("not_plain", "the installed library holds something that is not a plain file or folder");
  }
}

/**
 * @param {{ dest: string, source?: { dir: string, version: string }, epoch?: number | undefined }} options
 *
 * Lays `<dest>` (the folder that will be called fx-runner-playwright) down from the installed, pinned library, with no browser in it. `epoch` (seconds) stamps every file so two builds match.
 * Returns the listing, its digest and the version. Nothing is written to `dest` if the library is wrong.
 */
export function buildSidecar({ dest, source = installedLibrary(), epoch = undefined }) {
  if (existsSync(dest)) throw new SidecarError("dest_exists", "the sidecar folder already exists; build into a fresh folder");
  if (source.version !== pinnedVersion()) throw new SidecarError("version_mismatch", `the library to copy is ${String(source.version).slice(0, 20)}, not the pinned ${pinnedVersion()}`);
  const target = path.join(dest, LIBRARY_ROOT);
  try {
    copyTree(source.dir, target);
    if (epoch !== undefined) stamp(dest, epoch);
    const entries = listTree(dest);
    assertShape(entries);
    assertNoBrowsers(entries);
    return { entries, digest: treeDigest(entries), version: source.version };
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

function stamp(root, epoch) {
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (lstatSync(file).isDirectory()) walk(file);
      else utimesSync(file, epoch, epoch);
    }
    utimesSync(dir, epoch, epoch);
  };
  walk(root);
}

/** True when `dir` is a whole, plain sidecar tree (and has `digest`, when one is given). Never throws. */
export function verifySidecar(dir, digest) {
  try {
    const entries = listTree(dir);
    assertShape(entries);
    assertNoBrowsers(entries);
    return digest === undefined || treeDigest(entries) === digest;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------- the archive

const SAFE_SEGMENT = /^[A-Za-z0-9_.@+=~-]+$/;

/** The one archive of a sidecar folder: `FXSC1\n`, one JSON header line, then the files' bytes in header order. Deterministic: the same tree gives the same bytes. */
export function packSidecar(dir) {
  const entries = listTree(dir);
  assertShape(entries);
  assertNoBrowsers(entries);
  const version = JSON.parse(readFileSync(path.join(dir, LIBRARY_ROOT, "package.json"), "utf8")).version;
  const header = JSON.stringify({ library: SIDECAR_LIBRARY, version, digest: treeDigest(entries), files: entries.map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 })) });
  const parts = [Buffer.from(MAGIC), Buffer.from(`${header}\n`)];
  for (const entry of entries) parts.push(readFileSync(path.join(dir, entry.path)));
  return Buffer.concat(parts);
}

function parseArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < MAGIC.length || bytes.subarray(0, MAGIC.length).toString("latin1") !== MAGIC) throw new SidecarError("bad_archive", "not a sidecar archive");
  const end = bytes.indexOf(0x0a, MAGIC.length);
  if (end === -1 || end - MAGIC.length > MAX_HEADER_BYTES) throw new SidecarError("bad_archive", "the archive header is missing or too large");
  let header;
  try {
    header = JSON.parse(bytes.subarray(MAGIC.length, end).toString("utf8"));
  } catch {
    throw new SidecarError("bad_archive", "the archive header is not JSON");
  }
  if (header === null || typeof header !== "object" || header.library !== SIDECAR_LIBRARY || typeof header.version !== "string" || !/^[0-9a-f]{64}$/.test(String(header.digest)) || !Array.isArray(header.files)) throw new SidecarError("bad_archive", "the archive header is not a sidecar header");
  if (header.files.length === 0 || header.files.length > MAX_FILES) throw new SidecarError("bad_archive", "the archive lists no files or too many");
  const seen = new Set();
  let total = 0;
  for (const file of header.files) {
    if (file === null || typeof file !== "object" || typeof file.path !== "string" || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES || !/^[0-9a-f]{64}$/.test(String(file.sha256))) throw new SidecarError("bad_archive", "a file entry is malformed");
    const segments = file.path.split("/");
    if (!file.path.startsWith(`${LIBRARY_ROOT}/`) || segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment === "." || segment === "..")) throw new SidecarError("bad_archive", "a file entry names a path outside node_modules/playwright-core");
    if (seen.has(file.path)) throw new SidecarError("bad_archive", "a file is listed twice");
    seen.add(file.path);
    total += file.size;
  }
  if (total > MAX_TOTAL_BYTES) throw new SidecarError("bad_archive", "the archive is over the size limit");
  if (end + 1 + total !== bytes.length) throw new SidecarError("bad_archive", "the archive is not exactly its header and its files");
  return { header, offset: end + 1 };
}

/**
 * Unpacks a packed sidecar into `dest` (which must not exist). Every file is checked against the header's digest, the written tree is listed again and must have the header's tree digest, and
 * nothing is left behind on any failure. Returns the tree digest and the version.
 */
export function unpackSidecar(bytes, dest) {
  const { header, offset } = parseArchive(bytes);
  if (existsSync(dest)) throw new SidecarError("dest_exists", "the folder to unpack into already exists");
  try {
    let at = offset;
    for (const file of header.files) {
      const data = bytes.subarray(at, at + file.size);
      at += file.size;
      if (sha256(data) !== file.sha256) throw new SidecarError("file_mismatch", "a file in the sidecar archive does not match its listed digest");
      const target = path.join(dest, file.path);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      const fd = openSync(target, "wx", 0o644);
      try {
        writeSync(fd, data);
      } finally {
        closeSync(fd);
      }
    }
    const entries = listTree(dest);
    assertShape(entries);
    assertNoBrowsers(entries);
    const digest = treeDigest(entries);
    if (digest !== header.digest) throw new SidecarError("digest_mismatch", "the unpacked sidecar does not have the digest its archive names");
    const written = JSON.parse(readFileSync(path.join(dest, LIBRARY_ROOT, "package.json"), "utf8")).version;
    if (written !== header.version) throw new SidecarError("version_mismatch", "the archive's version is not the package's version");
    return { digest, version: header.version };
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

// -------------------------------------------------------------------------------------------------------------------------------------- the swap

/**
 * Puts the folder `next` in place of `final` (which may be absent) beside the binary, atomically: the old folder is renamed aside, the new one renamed in, and if the second rename fails the first
 * is undone, so there is always a whole folder (the old or the new) and never a half-written one. `rename` is a seam for a test that makes the second step fail. Returns nothing; throws on failure with
 * the old folder back in place.
 */
export function swapSidecar(next, final, rename = /** @type {(from: string, to: string) => void} */ (renameSync)) {
  clearStaleAside(final);
  const aside = `${final}.old-${randomBytes(6).toString("hex")}`;
  const hadOld = existsSync(final);
  if (hadOld) rename(final, aside);
  try {
    rename(next, final);
  } catch (error) {
    if (hadOld) {
      try {
        rename(aside, final);
      } catch (rollbackError) {
        // Never leave the place empty without saying so: both failures are reported, and the old folder stays where it was moved to (the next swap or cleanup removes it).
        throw new SidecarError("rollback_failed", `${errorText(error)}; and putting the old folder back failed too (${errorText(rollbackError)}): the sidecar folder is ABSENT at its place, the previous one is kept at ${aside}`, { cause: error });
      }
    }
    throw error;
  }
  if (hadOld) rmSync(aside, { recursive: true, force: true });
}

const errorText = (error) => (error instanceof Error ? error.message : "failed").slice(0, 200);

/** Removes the `<final>.old-<hex>` folders a swap that died half-way left beside `final` (the way the updater clears `.staging-*`). */
export function clearStaleAside(final) {
  const prefix = `${path.basename(final)}.old-`;
  try {
    for (const name of readdirSync(path.dirname(final))) if (name.startsWith(prefix)) rmSync(path.join(path.dirname(final), name), { recursive: true, force: true });
  } catch {
    // no folder to look in: nothing is stale
  }
}

/**
 * Lays the sidecar next to a binary that was not built by build-sea.mjs (for example a copy kept somewhere else): builds it beside the binary under a temporary name, checks it, and swaps it in.
 * `expectedDigest` is the digest the binary carries, when known.
 */
export function installBeside({ binaryDir, source = installedLibrary(), expectedDigest = /** @type {string | undefined} */ (undefined), rename = /** @type {(from: string, to: string) => void} */ (renameSync) }) {
  if (!statSync(binaryDir).isDirectory()) throw new SidecarError("not_a_folder", "the binary folder is not a folder");
  const staging = path.join(binaryDir, `.${SIDECAR_DIR}.new-${randomBytes(6).toString("hex")}`);
  try {
    const built = buildSidecar({ dest: staging, source });
    if (expectedDigest !== undefined && built.digest !== expectedDigest) throw new SidecarError("digest_mismatch", "the installed library is not the one this binary was built with");
    swapSidecar(staging, path.join(binaryDir, SIDECAR_DIR), rename);
    return built;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
