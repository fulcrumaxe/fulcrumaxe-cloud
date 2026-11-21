#!/usr/bin/env node
// Renders the release copies of install.sh and the Homebrew formula from release-manifest.json (D#6 R6-5), and writes the checksums file.
//
//   node scripts/release-render.mjs install   --manifest <file> --template <install.sh> --out <file>
//   node scripts/release-render.mjs formula   --manifest <file> --template <fx-runner.rb.tmpl> --out <file>
//   node scripts/release-render.mjs checksums --manifest <file> --out <file>
//
// The checksums always come from the manifest, which is the one place the hashes are computed. A manifest must hold all four platforms
// of one version, each with a SHA-256; a rendered file that still contains an `@FX_` placeholder is refused and nothing is written.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "./install-render.mjs";
import { ARTIFACT_NAMES, SIDECAR_ENTRY } from "./release-manifest.mjs";
import { SIDECAR_ARCHIVE } from "./sidecar.mjs";

// The renderer is install-render.mjs (the cloud's install route loads the same file); it is re-exported so callers of this file keep working.
export { renderTemplate };

/** Where the release copy of install.sh downloads from: this repository's GitHub release assets. `FX_RELEASE_REPO` (owner/name) names another one. */
export function githubTargetBase(repo = process.env.FX_RELEASE_REPO ?? "fulcrumaxe/fulcrumaxe-cloud") {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("FX_RELEASE_REPO must look like owner/name");
  return `https://github.com/${repo}/releases/download/`;
}

/** The SHA-256 of the root this runner build compiles in (tuf/1.root.json). The script names it in a comment for audit; it is not a check there. */
export function trustedRootSha256() {
  return createHash("sha256").update(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tuf", "1.root.json"))).digest("hex");
}

/** The manifest entries, checked: every platform present once, one version, a 64-digit SHA-256 each. */
export function loadManifest(file) {
  let entries;
  try {
    entries = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("the manifest could not be read as JSON");
  }
  if (!Array.isArray(entries)) throw new Error("the manifest is not a list");
  // D#749 V2c-2c: the sidecar archive entry has no platform; it is kept apart so the four-platform rules below stay as they were.
  const sidecars = entries.filter((entry) => entry?.artifact === SIDECAR_ENTRY);
  entries = entries.filter((entry) => entry?.artifact !== SIDECAR_ENTRY);
  if (sidecars.length > 1) throw new Error("the manifest lists the sidecar archive twice");
  if (sidecars.length === 1 && !/^[0-9a-f]{64}$/.test(String(sidecars[0].sha256))) throw new Error("the sidecar entry has no SHA-256");
  const byPlatform = new Map(entries.map((entry) => [entry?.platform, entry]));
  for (const platform of Object.keys(ARTIFACT_NAMES)) {
    const entry = byPlatform.get(platform);
    if (entry === undefined) throw new Error(`the manifest has no ${platform} entry`);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`the ${platform} entry has no SHA-256`);
  }
  if (entries.length !== Object.keys(ARTIFACT_NAMES).length) throw new Error("the manifest lists a platform twice or one that is not released");
  const versions = new Set(entries.map((entry) => entry.version));
  if (versions.size !== 1 || !/^\d+\.\d+\.\d+$/.test([...versions][0])) throw new Error("the manifest must name one x.y.z version");
  if (sidecars.length === 1 && sidecars[0].version !== [...versions][0]) throw new Error("the sidecar entry is of another version than the binaries");
  return { version: [...versions][0], entries, sidecar: sidecars[0] };
}

export function checksumsText(manifest) {
  const lines = manifest.entries.map((entry) => `${entry.sha256}  ${ARTIFACT_NAMES[entry.platform]}\n`);
  if (manifest.sidecar !== undefined) lines.push(`${manifest.sidecar.sha256}  ${SIDECAR_ARCHIVE}\n`);
  return lines.join("");
}

function main(argv) {
  const [command, ...rest] = argv;
  const flags = new Map();
  for (let i = 0; i < rest.length; i += 2) flags.set(rest[i], rest[i + 1]);
  const need = (flag) => {
    const value = flags.get(flag);
    if (value === undefined) throw new Error(`${flag} is required`);
    return value;
  };
  try {
    const manifest = loadManifest(need("--manifest"));
    let text;
    if (command === "install") text = renderTemplate(readFileSync(need("--template"), "utf8"), manifest, { targetBaseUrl: githubTargetBase(), trustedRootSha256: trustedRootSha256() });
    else if (command === "formula") text = renderTemplate(readFileSync(need("--template"), "utf8"), manifest);
    else if (command === "checksums") text = checksumsText(manifest);
    else throw new Error("usage: release-render.mjs <install|formula|checksums> --manifest <file> [--template <file>] --out <file>");
    writeFileSync(need("--out"), text);
    return 0;
  } catch (error) {
    process.stderr.write(`release-render: ${error instanceof Error ? error.message : "failed"}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
