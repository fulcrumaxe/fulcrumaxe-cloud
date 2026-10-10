#!/usr/bin/env node
// Renders the release copies of install.sh and the Homebrew formula from release-manifest.json (D#6 R6-5), and writes the checksums file.
//
//   node scripts/release-render.mjs install   --manifest <file> --template <install.sh> --out <file>
//   node scripts/release-render.mjs formula   --manifest <file> --template <fx-runner.rb.tmpl> --out <file>
//   node scripts/release-render.mjs checksums --manifest <file> --out <file>
//
// The checksums always come from the manifest, which is the one place the hashes are computed. A manifest must hold all four platforms
// of one version, each with a SHA-256; a rendered file that still contains an `@FX_` placeholder is refused and nothing is written.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_NAMES } from "./release-manifest.mjs";

const upper = (platform) => platform.toUpperCase().replace(/-/g, "_");

/** The manifest entries, checked: every platform present once, one version, a 64-digit SHA-256 each. */
export function loadManifest(file) {
  let entries;
  try {
    entries = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("the manifest could not be read as JSON");
  }
  if (!Array.isArray(entries)) throw new Error("the manifest is not a list");
  const byPlatform = new Map(entries.map((entry) => [entry?.platform, entry]));
  for (const platform of Object.keys(ARTIFACT_NAMES)) {
    const entry = byPlatform.get(platform);
    if (entry === undefined) throw new Error(`the manifest has no ${platform} entry`);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`the ${platform} entry has no SHA-256`);
  }
  if (entries.length !== Object.keys(ARTIFACT_NAMES).length) throw new Error("the manifest lists a platform twice or one that is not released");
  const versions = new Set(entries.map((entry) => entry.version));
  if (versions.size !== 1 || !/^\d+\.\d+\.\d+$/.test([...versions][0])) throw new Error("the manifest must name one x.y.z version");
  return { version: [...versions][0], entries };
}

/** Fills `@FX_VERSION@`, `@FX_SHA256_<PLATFORM>@` and `@FX_FILE_<PLATFORM>@`. Throws if any `@FX_` is left. */
export function renderTemplate(text, manifest) {
  let out = text.replaceAll("@FX_VERSION@", manifest.version);
  for (const entry of manifest.entries) {
    out = out.replaceAll(`@FX_SHA256_${upper(entry.platform)}@`, entry.sha256).replaceAll(`@FX_FILE_${upper(entry.platform)}@`, ARTIFACT_NAMES[entry.platform]);
  }
  const left = out.match(/@FX_[A-Z0-9_]*@?/g);
  if (left !== null) throw new Error(`placeholders left after rendering: ${[...new Set(left)].join(", ")}`);
  return out;
}

export function checksumsText(manifest) {
  return manifest.entries.map((entry) => `${entry.sha256}  ${ARTIFACT_NAMES[entry.platform]}\n`).join("");
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
    if (command === "install" || command === "formula") text = renderTemplate(readFileSync(need("--template"), "utf8"), manifest);
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
