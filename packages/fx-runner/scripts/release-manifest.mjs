#!/usr/bin/env node
// The release manifest: one { version, platform, sha256, size } entry for each fx-runner single-executable file in a directory, written as
// release-manifest.json. It carries no date, path or host name, so the same files always give the same manifest.
//
// ARTIFACT_NAMES is the one place the release file names are written down. The installer (R6-4) and the release workflow (R6-5) read it
// (`node scripts/release-manifest.mjs --names` prints "<platform> <file name>" lines for shell), so a name is never typed twice.
//
//   node scripts/release-manifest.mjs --dir <dir> [--version <v>]
//   node scripts/release-manifest.mjs --names
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The platforms a release ships, and the file name each one has on the release page. The order is the order of the manifest. */
export const ARTIFACT_NAMES = Object.freeze({
  "darwin-arm64": "fx-runner-darwin-arm64",
  "darwin-x64": "fx-runner-darwin-x64",
  "linux-x64": "fx-runner-linux-x64",
  "linux-arm64": "fx-runner-linux-arm64",
});

export const MANIFEST_FILE = "release-manifest.json";

/** The package's own version, which a release is named after. */
export function packageVersion() {
  const text = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8");
  return JSON.parse(text).version;
}

export function artifactName(platform) {
  if (!Object.hasOwn(ARTIFACT_NAMES, platform)) throw new Error(`unknown platform ${String(platform).slice(0, 40)}; one of ${Object.keys(ARTIFACT_NAMES).join(", ")}`);
  return ARTIFACT_NAMES[platform];
}

/** The entry for one built file: its hash and size are read from the file itself. */
export function manifestEntry({ file, platform, version }) {
  artifactName(platform);
  const bytes = readFileSync(file);
  return { version, platform, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

/** Entries for every artifact present in `dir`, in manifest order. A platform with no file is left out; a directory with none is an error. */
export function manifestFor(dir, version) {
  const entries = [];
  for (const [platform, name] of Object.entries(ARTIFACT_NAMES)) {
    const file = path.join(dir, name);
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      // a platform that was not built is simply not in the manifest
      isFile = false;
    }
    if (isFile) entries.push(manifestEntry({ file, platform, version }));
  }
  if (entries.length === 0) throw new Error(`no fx-runner artifact in ${dir}`);
  return entries;
}

export function writeManifest(dir, version) {
  const entries = manifestFor(dir, version);
  const file = path.join(dir, MANIFEST_FILE);
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
  return { file, entries };
}

function main(argv) {
  if (argv.includes("--names")) {
    for (const [platform, name] of Object.entries(ARTIFACT_NAMES)) process.stdout.write(`${platform} ${name}\n`);
    return 0;
  }
  const value = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const dir = value("--dir");
  if (dir === undefined) {
    process.stderr.write("usage: release-manifest.mjs --dir <dir> [--version <v>] | --names\n");
    return 2;
  }
  try {
    const { file } = writeManifest(path.resolve(dir), value("--version") ?? packageVersion());
    process.stdout.write(`${file}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`release-manifest: ${error instanceof Error ? error.message : "failed"}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
