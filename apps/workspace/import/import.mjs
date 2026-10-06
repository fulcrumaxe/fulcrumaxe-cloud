#!/usr/bin/env node
// apps/workspace/import/import.mjs
//
// D#37 WS-A1: the secure importer. Extracts an allowlisted subset of files
// from a `git archive` tar -- pinned to a 40-hex commit id recorded in the
// tar's own pax global header, and to a required sha256 of the tar's own
// bytes (W1) -- into a destination directory, and records what it did in
// BUILD-INFO.json. Reads no environment (Node 22 built-ins only, no npm
// runtime dependency).
//
// Usage:
//   node import.mjs --tar <file> --sha <40-hex> --tar-sha256 <64-hex> \
//                    --origin <url> --out <dir>
//                    [--build-info <path>] [--allowlist <path>] [--checked-by <name>]
//   node import.mjs --status [--build-info <path>] [--root <dir>]
//   node import.mjs --verify --tar <file> --tar-sha256 <64-hex> \
//                    [--build-info <path>] [--root <dir>] [--allowlist <path>]
//
// See IMPORT.md for the full procedure (who produces the tar, and how a
// re-import is reviewed).

import { createHash, randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  statSync,
  readdirSync,
  renameSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readTar, looksLikeTar, isRegularFile } from "./tar.mjs";
import { pathIsSecretShaped, checkContent } from "./rules.mjs";

// Anchor inside the tar under which every extractable file lives.
export const TAR_ANCHOR = "crates/fulc-shell/assets/";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ALLOWLIST_PATH = join(SCRIPT_DIR, "allowlist.txt");
const DEFAULT_OUT_DIR = join(SCRIPT_DIR, "..", "shell");
const DEFAULT_BUILD_INFO_PATH = join(SCRIPT_DIR, "..", "BUILD-INFO.json");

export class ImportRefused extends Error {}

// ---------------------------------------------------------------------------
// Allowlist: a small glob matcher. `*` matches within one path segment,
// `**` matches across segments (including zero). Shared with checks.mjs.
// ---------------------------------------------------------------------------

function globToRegExp(pattern) {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else if ("\\^$+?.()|[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function loadAllowlist(allowlistPath) {
  const raw = readFileSync(allowlistPath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => ({ raw: line, regex: globToRegExp(line) }));
}

export function isAllowlisted(patterns, relPath) {
  return patterns.some((p) => p.regex.test(relPath));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// W4b (security review): every segment must be a real path component.
// Empty segments ("core//a.js" -> ["core", "", "a.js"]) and "." segments
// ("core/./a.js") used to slip through here as "safe" -- Node's own
// join()/path handling then silently collapsed them onto the same on-disk
// path as the un-decorated spelling ("core/a.js"), so the duplicate-path
// refusal (which compares the raw, undecorated relPath strings) never saw
// them as colliding. Rejecting every segment that is empty, ".", or ".."
// means a path spelled with either trick is never selected at all, so it
// can never collide with -- or silently overwrite -- the file at the
// plain spelling.
function isSafeRelPath(relPath) {
  if (!relPath || relPath.startsWith("/") || relPath.includes("\0")) return false;
  const segments = relPath.split("/");
  return segments.every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function walkFiles(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(abs, base, acc);
    } else if (entry.isFile()) {
      acc.push(relative(base, abs).split(sep).join("/"));
    }
  }
  return acc;
}

// V1 (security review): walks the WHOLE --root tree for --verify, using
// lstatSync on every entry so a symlink is identified by its own type and
// never dereferenced -- existsSync/readFileSync (what the old --verify used)
// both follow a symlink transparently, so a file swapped for a symlink to
// identical bytes held outside the tree passed byte-for-byte undetected.
// Returns every regular-file relPath found and every non-regular relPath
// found (symlinks, FIFOs, sockets, device files, ...), so the caller can
// refuse on either: a file present on disk that the tar/BUILD-INFO.json
// never selected, or any entry that isn't a plain file at all.
function walkRootForVerify(dir, base = dir, files = [], nonRegular = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOTDIR") {
      // `dir` turned out to be a file/symlink by the time we tried to
      // descend into it (TOCTOU on a hostile tree) -- the caller already
      // lstat'd it as a directory to get here; treat this the same as a
      // non-regular entry rather than crashing.
      nonRegular.push(relative(base, dir).split(sep).join("/"));
      return { files, nonRegular };
    }
    throw err;
  }
  for (const name of names) {
    const abs = join(dir, name);
    const relPath = relative(base, abs).split(sep).join("/");
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      walkRootForVerify(abs, base, files, nonRegular);
    } else if (st.isFile()) {
      files.push(relPath);
    } else {
      // Symlink (to a file OR a directory -- never descended into),
      // FIFO, socket, device, or anything else that isn't a plain file.
      nonRegular.push(relPath);
    }
  }
  return { files, nonRegular };
}

// E5 (security review): scans every entry in the tar (not just the ones
// that pass the anchor/allowlist filter) and refuses the whole tar if any
// *regular file* lives outside TAR_ANCHOR. Previously such entries were
// silently skipped, so a tar that was not narrowed at its source (e.g. the
// IMPORT.md git-archive command run without the anchor pathspec) was
// quietly accepted instead of being rejected as the un-narrowed archive it
// is. Directories, symlinks, and other non-regular entries outside the
// anchor are not regular files and are not flagged here.
function assertNoRegularFilesOutsideAnchor(entries) {
  const outside = [];
  for (const entry of entries) {
    if (isRegularFile(entry.type) && !entry.path.startsWith(TAR_ANCHOR)) {
      outside.push(entry.path);
    }
  }
  if (outside.length > 0) {
    const shown = outside.slice(0, 5).join(", ");
    const more = outside.length > 5 ? ` (+${outside.length - 5} more)` : "";
    throw new ImportRefused(
      `tar contains ${outside.length} regular file(s) outside the anchor ${TAR_ANCHOR}: ${shown}${more} -- ` +
        `the tar was not narrowed at its source (see IMPORT.md's git archive command)`,
    );
  }
}

// Applies the allowlist + safe-path filter to a tar's entries and returns
// the entries that would be written, keyed by their post-anchor relative
// path. Shared between runImport and runVerify so the two can never select
// a different set of files from the same tar.
function selectAllowlistedEntries(entries, patterns) {
  const selected = [];
  for (const entry of entries) {
    if (!isRegularFile(entry.type)) continue; // never written: dirs, symlinks, etc.
    if (!entry.path.startsWith(TAR_ANCHOR)) continue; // outside the anchor: never written
    const relPath = entry.path.slice(TAR_ANCHOR.length);
    if (!isSafeRelPath(relPath)) continue; // defense in depth against path traversal
    if (!isAllowlisted(patterns, relPath)) continue; // not on the allowlist: never written
    selected.push({ relPath, data: entry.data });
  }
  return selected;
}

// E2 (security review): applied to every selected entry BEFORE any write.
// A hit on any entry refuses the *whole* import -- nothing is written, not
// even the entries that would otherwise have been clean. Path matching is
// case-insensitive (rules.mjs's PATH_SECRET_RE carries the `i` flag); a
// security review probe found 11 of 17 synthetic secret fixtures passed
// the old checks-mjs-only, case-sensitive, post-write rules by varying
// case alone (core/SECRET.js, core/server.PEM, ...).
function assertNoSecretShapedEntries(selected) {
  const violations = [];
  for (const { relPath, data } of selected) {
    if (pathIsSecretShaped(relPath)) {
      violations.push(`path-dotfile-or-secret: ${relPath}`);
      continue; // one violation per entry is enough to report
    }
    const contentHits = checkContent(data);
    for (const rule of contentHits) {
      violations.push(`${rule}: ${relPath}`);
    }
  }
  if (violations.length > 0) {
    const shown = violations.slice(0, 10).join("; ");
    const more = violations.length > 10 ? ` (+${violations.length - 10} more)` : "";
    throw new ImportRefused(
      `refusing to import -- ${violations.length} entry(ies) matched a secret/dotfile rule before any write: ${shown}${more}`,
    );
  }
}

// W4 (security review): refuse a tar whose selected entries collide on the
// same post-anchor relative path (case-sensitive collision only -- the
// filesystem this writes to is case-sensitive). The old code silently took
// last-write-wins.
function assertNoDuplicatePaths(selected) {
  const seen = new Set();
  const dupes = new Set();
  for (const { relPath } of selected) {
    if (seen.has(relPath)) dupes.add(relPath);
    seen.add(relPath);
  }
  if (dupes.size > 0) {
    throw new ImportRefused(`refusing to import -- duplicate path(s) in the tar's allowlisted set: ${[...dupes].join(", ")}`);
  }
}

// W4 (security review): stage every write into a fresh temporary directory
// (created next to --out, so the final rename is same-filesystem and
// therefore atomic) and only then swap it into place. A mid-run failure
// (disk full, an over-long filename, ...) now leaves --out completely
// untouched instead of a partial tree that could pass checks.mjs by
// accident. This also closes the "removed upstream files persist" half of
// W4: swapping the whole directory in one step means the previous tree's
// leftover files can never survive alongside the new ones.
function stageAndSwap(outDir, selected) {
  const parentDir = dirname(outDir);
  mkdirSync(parentDir, { recursive: true });
  const stageDir = mkdtempSync(join(parentDir, `.${basename(outDir)}.stage-`));

  try {
    const files = {};
    for (const { relPath, data } of selected) {
      const dest = join(stageDir, relPath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      files[relPath] = sha256Hex(data);
    }

    let oldDir = null;
    if (existsSync(outDir)) {
      oldDir = `${outDir}.old-${randomBytes(6).toString("hex")}`;
      renameSync(outDir, oldDir);
    }
    renameSync(stageDir, outDir);
    if (oldDir) {
      rmSync(oldDir, { recursive: true, force: true });
    }

    return files;
  } catch (err) {
    rmSync(stageDir, { recursive: true, force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// import mode
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   tarPath: string, sha: string, tarSha256: string, origin: string, outDir: string,
 *   buildInfoPath?: string, allowlistPath?: string, checkedBy?: string,
 * }} opts
 */
export function runImport(opts) {
  const {
    tarPath,
    sha,
    tarSha256,
    origin,
    outDir,
    buildInfoPath = DEFAULT_BUILD_INFO_PATH,
    allowlistPath = DEFAULT_ALLOWLIST_PATH,
    checkedBy = "",
  } = opts;

  if (!existsSync(tarPath)) {
    throw new ImportRefused(`--tar path does not exist: ${tarPath}`);
  }
  if (statSync(tarPath).isDirectory()) {
    throw new ImportRefused(`--tar must be a file, not a directory: ${tarPath}`);
  }

  const buffer = readFileSync(tarPath);

  // W1 (security review): checked before any tar parsing. A tar's producer
  // records sha256(tar) at creation time (see IMPORT.md); import.mjs
  // refuses on any mismatch, so a tar swapped in transit -- even one that
  // still carries the expected --sha commit id in its own pax header,
  // which the producer of a forged tar also controls -- is caught here.
  if (!/^[0-9a-f]{64}$/i.test(tarSha256 ?? "")) {
    throw new ImportRefused(`--tar-sha256 must be exactly 64 hex characters, got: ${JSON.stringify(tarSha256)}`);
  }
  const actualTarSha256 = sha256Hex(buffer);
  if (actualTarSha256.toLowerCase() !== tarSha256.toLowerCase()) {
    throw new ImportRefused(`tar sha256 ${actualTarSha256} does not match --tar-sha256 ${tarSha256}`);
  }

  if (!looksLikeTar(buffer)) {
    throw new ImportRefused(`--tar does not look like a tar file (missing ustar magic): ${tarPath}`);
  }

  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new ImportRefused(`--sha must be exactly 40 hex characters, got: ${JSON.stringify(sha)}`);
  }

  const { globalRecords, entries } = readTar(buffer);
  const commitId = globalRecords.comment;
  if (!commitId) {
    throw new ImportRefused(
      "tar is missing the pax global header commit id (the \"comment\" record `git archive` writes) -- " +
        "refusing to import a tar that is not pinned to a commit",
    );
  }
  if (commitId.toLowerCase() !== sha.toLowerCase()) {
    throw new ImportRefused(`tar commit id ${commitId} does not match --sha ${sha}`);
  }

  // E5: refuse the whole tar if it wasn't narrowed to the anchor at its
  // source, rather than silently skipping the out-of-anchor entries.
  assertNoRegularFilesOutsideAnchor(entries);

  const patterns = loadAllowlist(allowlistPath);
  const selected = selectAllowlistedEntries(entries, patterns);

  // W4: refuse duplicate paths before any write.
  assertNoDuplicatePaths(selected);

  // E2: refuse the whole import on any secret/dotfile hit, before any write.
  assertNoSecretShapedEntries(selected);

  // W4: stage into a temp dir and rename atomically into place.
  const sortedInput = [...selected].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const files = stageAndSwap(outDir, sortedInput);
  const sortedFiles = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));

  const buildInfo = {
    jpos_sha: sha.toLowerCase(),
    origin_url: origin,
    ancestor_of_main_checked_by: checkedBy,
    tar_sha256: actualTarSha256,
    imported_at: new Date().toISOString(),
    files: sortedFiles,
    added: [],
  };

  mkdirSync(dirname(buildInfoPath), { recursive: true });
  writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2) + "\n");

  return { written: Object.keys(sortedFiles), outDir, buildInfoPath, buildInfo };
}

// ---------------------------------------------------------------------------
// --status mode
// ---------------------------------------------------------------------------

/**
 * @param {{ buildInfoPath?: string, root?: string }} opts
 */
export function runStatus(opts = {}) {
  const { buildInfoPath = DEFAULT_BUILD_INFO_PATH, root = DEFAULT_OUT_DIR } = opts;

  if (!existsSync(buildInfoPath)) {
    throw new ImportRefused(`BUILD-INFO.json not found at ${buildInfoPath} -- run an import first`);
  }
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8"));
  const known = buildInfo.files || {};
  const addedList = new Set(buildInfo.added || []);

  const modified = [];
  const removed = [];
  for (const [relPath, expectedSha] of Object.entries(known)) {
    const abs = join(root, relPath);
    if (!existsSync(abs)) {
      removed.push(relPath);
      continue;
    }
    const actualSha = sha256Hex(readFileSync(abs));
    if (actualSha !== expectedSha) modified.push(relPath);
  }

  const added = [];
  if (existsSync(root)) {
    for (const relPath of walkFiles(root)) {
      if (!(relPath in known) && !addedList.has(relPath)) added.push(relPath);
    }
  }

  return { modified: modified.sort(), removed: removed.sort(), added: added.sort() };
}

// ---------------------------------------------------------------------------
// --verify mode (W1)
// ---------------------------------------------------------------------------

/**
 * Re-checks an already-imported tree against BUILD-INFO.json and the tar
 * it claims to have come from: the tar's own sha256 must match the
 * independently-supplied --tar-sha256 (W1b), the tar's pax global header
 * commit id must match BUILD-INFO.json's jpos_sha, the tar must not
 * contain a regular file outside the anchor, every path BUILD-INFO.json or
 * the tar's allowlisted set knows about must be a regular file on disk that
 * is byte-identical to the tar's copy of it, and -- V1 -- the WHOLE --root
 * tree is walked so any on-disk path that isn't in BUILD-INFO.json's file
 * list, and any non-regular entry anywhere under --root, also refuses.
 * WS-A2 criterion 2 depends on this mode.
 *
 * @param {{ tarPath: string, tarSha256: string, buildInfoPath?: string, root?: string, allowlistPath?: string }} opts
 */
export function runVerify(opts) {
  const {
    tarPath,
    tarSha256,
    buildInfoPath = DEFAULT_BUILD_INFO_PATH,
    root = DEFAULT_OUT_DIR,
    allowlistPath = DEFAULT_ALLOWLIST_PATH,
  } = opts;

  if (!existsSync(tarPath)) {
    throw new ImportRefused(`--tar path does not exist: ${tarPath}`);
  }
  if (statSync(tarPath).isDirectory()) {
    throw new ImportRefused(`--tar must be a file, not a directory: ${tarPath}`);
  }
  if (!existsSync(buildInfoPath)) {
    throw new ImportRefused(`BUILD-INFO.json not found at ${buildInfoPath} -- run an import first`);
  }

  const buffer = readFileSync(tarPath);

  // W1b (security review): a wrong-but-self-consistent BUILD-INFO.json
  // (one whose own tar_sha256 field was rewritten to match a re-signed
  // tar) used to sail through, because the ONLY thing --verify pinned the
  // tar's bytes against was a field carried by the very tree being
  // verified. --tar-sha256 has to come from the caller, out of band, the
  // same way runImport already requires it -- so the pin can never be
  // satisfied by editing data that lives inside the thing being checked.
  if (!/^[0-9a-f]{64}$/i.test(tarSha256 ?? "")) {
    throw new ImportRefused(`--tar-sha256 must be exactly 64 hex characters, got: ${JSON.stringify(tarSha256)}`);
  }
  const actualTarSha256 = sha256Hex(buffer);
  if (actualTarSha256.toLowerCase() !== tarSha256.toLowerCase()) {
    throw new ImportRefused(`tar sha256 ${actualTarSha256} does not match --tar-sha256 ${tarSha256} -- refusing before any comparison against BUILD-INFO.json`);
  }

  const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8"));

  const issues = [];

  // Still checked, but purely informational drift detection now -- the
  // security-relevant pin is the --tar-sha256 comparison above, which
  // cannot be satisfied by anything BUILD-INFO.json itself records.
  if (buildInfo.tar_sha256 !== actualTarSha256) {
    issues.push(
      `tar sha256 ${actualTarSha256} does not match BUILD-INFO.json's recorded tar_sha256 ${buildInfo.tar_sha256 ?? "(missing)"}`,
    );
  }

  if (!looksLikeTar(buffer)) {
    throw new ImportRefused(
      [`--tar does not look like a tar file (missing ustar magic): ${tarPath}`, ...issues].join("; "),
    );
  }

  const { globalRecords, entries } = readTar(buffer);
  const commitId = globalRecords.comment;
  if (!commitId) {
    issues.push("tar is missing the pax global header commit id");
  } else if (typeof buildInfo.jpos_sha !== "string" || commitId.toLowerCase() !== buildInfo.jpos_sha.toLowerCase()) {
    issues.push(`tar commit id ${commitId} does not match BUILD-INFO.json's jpos_sha ${buildInfo.jpos_sha ?? "(missing)"}`);
  }

  try {
    assertNoRegularFilesOutsideAnchor(entries);
  } catch (err) {
    issues.push(err.message);
  }

  const patterns = loadAllowlist(allowlistPath);
  const selected = selectAllowlistedEntries(entries, patterns);
  const tarByRelPath = new Map(selected.map(({ relPath, data }) => [relPath, data]));

  // V1: BUILD-INFO.json's recorded file list is the sole authority for
  // "this path is supposed to exist under --root". `added[]` is
  // deliberately NOT consulted here (unlike checks.mjs's allowlist gate
  // and --status's drift report): it exists so a fork's own new files
  // don't trip the *allowlist* rule, but --verify's claim is byte-equality
  // against the pinned tar, and a file only ever listed in `added[]` was
  // never part of that tar -- so it is exactly the kind of on-disk extra
  // this mode exists to catch, not an exception to it.
  const known = buildInfo.files || {};

  // V1: walk the WHOLE --root tree with lstat (no symlink following) --
  // this is the only way to see a file that landed on disk without ever
  // being recorded anywhere (BUILD-INFO.json's files map or the tar), and
  // the only way to see a non-regular entry (a symlink swapped in for a
  // known path, or planted anywhere else) without ever reading through it.
  let diskFiles = [];
  let diskNonRegular = [];
  if (existsSync(root)) {
    const walked = walkRootForVerify(root);
    diskFiles = walked.files;
    diskNonRegular = walked.nonRegular;
  } else {
    issues.push(`--root does not exist: ${root}`);
  }

  for (const relPath of diskNonRegular.sort()) {
    issues.push(`non-regular entry on disk (expected a plain file): ${relPath}`);
  }

  const diskFileSet = new Set(diskFiles);
  const nonRegularSet = new Set(diskNonRegular);

  const allPaths = new Set([...tarByRelPath.keys(), ...Object.keys(known), ...diskFiles]);
  for (const relPath of [...allPaths].sort()) {
    if (nonRegularSet.has(relPath)) {
      // Already reported above as a non-regular entry -- don't also
      // report it as missing/mismatched/extra, which would double-count
      // the same on-disk fact under a different message.
      continue;
    }

    const inTar = tarByRelPath.has(relPath);
    const inKnown = relPath in known;

    if (inTar && !inKnown) {
      // The given tar selects this path, but this BUILD-INFO.json never
      // recorded it -- the tar and BUILD-INFO.json don't agree on what
      // was imported (the jpos_sha/tar_sha256 checks above should
      // already have caught a mismatched tar, but report it explicitly
      // too rather than silently comparing against nothing).
      issues.push(`selected from the tar but not recorded in BUILD-INFO.json's file list: ${relPath}`);
      continue;
    }
    if (!inTar && inKnown) {
      issues.push(`recorded in BUILD-INFO.json but not selected from the tar: ${relPath}`);
      continue;
    }
    if (!inTar && !inKnown) {
      // On disk only -- neither the tar nor BUILD-INFO.json knows this
      // path. Reported once, below, as the V1 extra-file finding; there
      // is nothing to compare its bytes against here.
      continue;
    }

    // inTar && inKnown: the expected, normal case.
    if (!diskFileSet.has(relPath)) {
      issues.push(`missing on disk: ${relPath}`);
      continue;
    }
    const abs = join(root, relPath);
    const diskData = readFileSync(abs);
    const tarData = tarByRelPath.get(relPath);
    if (!diskData.equals(tarData)) {
      issues.push(`content mismatch (does not equal the tar's bytes): ${relPath}`);
    }
  }

  // V1: every regular file the walk found that isn't in BUILD-INFO.json's
  // file list is an unrecorded extra, whether or not it happens to be
  // allowlisted, whether or not its content is otherwise clean, and
  // whether or not it is separately listed in `added[]` -- none of those
  // make it part of the pinned tar, which is the only thing --verify
  // attests to.
  for (const relPath of diskFiles.sort()) {
    if (!(relPath in known)) {
      issues.push(`on disk but not in BUILD-INFO.json's file list: ${relPath}`);
    }
  }

  if (issues.length > 0) {
    throw new ImportRefused(`--verify found ${issues.length} issue(s):\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }

  return { ok: true, checked: tarByRelPath.size };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);

  if (args.status) {
    try {
      const { modified, removed, added } = runStatus({
        buildInfoPath: typeof args["build-info"] === "string" ? args["build-info"] : undefined,
        root: typeof args.root === "string" ? args.root : undefined,
      });
      for (const p of modified) console.log(`MODIFIED: ${p}`);
      for (const p of removed) console.log(`REMOVED: ${p}`);
      for (const p of added) console.log(`ADDED: ${p}`);
      if (modified.length === 0 && removed.length === 0 && added.length === 0) {
        console.log("import.mjs: no drift since import");
      }
      return 0;
    } catch (err) {
      console.error(`import.mjs: refused: ${err.message}`);
      return 1;
    }
  }

  if (args.verify) {
    const missingV = ["tar", "tar-sha256"].filter((k) => typeof args[k] !== "string");
    if (missingV.length > 0) {
      console.error(
        "import.mjs: usage: import.mjs --verify --tar <file> --tar-sha256 <64-hex> [--build-info <path>] [--root <dir>] [--allowlist <path>]\n" +
          `import.mjs: missing required flag(s): ${missingV.map((m) => `--${m}`).join(", ")}`,
      );
      return 1;
    }
    try {
      const result = runVerify({
        tarPath: args.tar,
        tarSha256: args["tar-sha256"],
        buildInfoPath: typeof args["build-info"] === "string" ? args["build-info"] : undefined,
        root: typeof args.root === "string" ? args.root : undefined,
        allowlistPath: typeof args.allowlist === "string" ? args.allowlist : undefined,
      });
      console.log(`import.mjs: --verify passed (${result.checked} file(s) checked)`);
      return 0;
    } catch (err) {
      console.error(`import.mjs: refused: ${err.message}`);
      return 1;
    }
  }

  const missing = ["tar", "sha", "tar-sha256", "origin", "out"].filter((k) => typeof args[k] !== "string");
  if (missing.length > 0) {
    console.error(
      `import.mjs: usage: import.mjs --tar <file> --sha <40-hex> --tar-sha256 <64-hex> --origin <url> --out <dir>\n` +
        `import.mjs: missing required flag(s): ${missing.map((m) => `--${m}`).join(", ")}`,
    );
    return 1;
  }

  try {
    const result = runImport({
      tarPath: args.tar,
      sha: args.sha,
      tarSha256: args["tar-sha256"],
      origin: args.origin,
      outDir: args.out,
      buildInfoPath: typeof args["build-info"] === "string" ? args["build-info"] : undefined,
      allowlistPath: typeof args.allowlist === "string" ? args.allowlist : undefined,
      checkedBy: typeof args["checked-by"] === "string" ? args["checked-by"] : undefined,
    });
    console.log(`import.mjs: imported ${result.written.length} file(s) into ${result.outDir}`);
    console.log(`import.mjs: wrote ${result.buildInfoPath}`);
    return 0;
  } catch (err) {
    console.error(`import.mjs: refused: ${err.message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
