#!/usr/bin/env node
// Builds the fx-runner single-executable application (SEA) for the platform this script runs on.
//
//   SOURCE_DATE_EPOCH=<seconds> node scripts/build-sea.mjs [--target <platform>] [--out-dir <dir>]
//
// Steps: (1) bundle bin/fx-runner.mjs and src/** with esbuild into one CommonJS file (`@anthropic-ai/*` is external, and nothing needs it);
// (2) download the exact Node release pinned below, and check it against nodejs.org's SHASUMS256.txt AND against the SHA-256 pinned in this
// file; (3) make the SEA blob with that Node; (4) inject the blob with postject (on macOS: remove the signature, inject, sign ad hoc, verify);
// (5) write release-manifest.json. Everything is built in a temporary folder and moved into --out-dir only when every step has passed, so a
// failed build writes nothing.
//
// The build is reproducible: the same commit, the same SOURCE_DATE_EPOCH and the same pinned Node give the same bytes (R6-1 acceptance 2).
// The blob is made by the pinned Node itself, so a target is built on a machine of the same platform (one hosted runner per target in R6-5).
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postject from "postject";
import { ARTIFACT_NAMES, artifactName, packageVersion, writeManifest } from "./release-manifest.mjs";

const run = promisify(execFile);
const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The Node release every SEA is built on. A new release is a deliberate edit here: the version, and all four hashes below. */
export const NODE_VERSION = "22.22.3";

/**
 * The SHA-256 of each platform's Node archive, copied from nodejs.org's SHASUMS256.txt for NODE_VERSION. The download is checked against both
 * that file and these, so a tampered mirror or a tampered SHASUMS file alone cannot change what is built.
 */
export const NODE_PINS = Object.freeze({
  "darwin-arm64": { archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: "0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207" },
  "darwin-x64": { archive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha256: "45830ba752fa0d892c6dcd640946669801293cac820a33591ded40ac075198ec" },
  "linux-arm64": { archive: `node-v${NODE_VERSION}-linux-arm64.tar.gz`, sha256: "cc8bc82b2dd0b595c3b95a4c3c9c8c350907cff011afbdee3d1379e812e1e3e3" },
  "linux-x64": { archive: `node-v${NODE_VERSION}-linux-x64.tar.gz`, sha256: "c7a10d6816da8eaaa7534dd73c71c6e2b2c391dbbf845e364902d156615dd1b8" },
});

export const NODE_DIST_URL = `https://nodejs.org/dist/v${NODE_VERSION}`;
/** Node's documented fuse string: the blob is only found by a binary that carries it. */
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

export class BuildError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "BuildError";
    this.code = code;
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The platform name this machine builds for, in the release's own spelling. */
export function hostPlatform(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/** Parses nodejs.org's SHASUMS256.txt: one `<64 hex>  <file name>` per line, nothing else. A line in any other shape, or a name twice, is an error. */
export function parseShasums(text) {
  const sums = new Map();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (match === null) throw new BuildError("shasums_malformed", "SHASUMS256.txt has a line that is not `<sha256>  <file>`");
    if (sums.has(match[2])) throw new BuildError("shasums_malformed", `SHASUMS256.txt lists ${match[2].slice(0, 80)} twice`);
    sums.set(match[2], match[1]);
  }
  return sums;
}

/** Checks a downloaded archive against SHASUMS256.txt and against the pin. Returns nothing; a mismatch of either throws. */
export function verifyNodeArchive({ bytes, archive, shasums, pinned }) {
  const listed = shasums.get(archive);
  if (listed === undefined) throw new BuildError("shasums_missing_entry", `SHASUMS256.txt does not list ${archive}`);
  const actual = sha256(bytes);
  if (actual !== listed) throw new BuildError("shasums_mismatch", `${archive} does not match the hash in SHASUMS256.txt`);
  if (actual !== pinned) throw new BuildError("pin_mismatch", `${archive} matches SHASUMS256.txt but not the SHA-256 pinned in build-sea.mjs`);
}

/** The commands that turn a copy of the Node binary into the SEA, in order. macOS signs: the injection breaks the signature the binary came with. */
export function injectionSteps(platform) {
  if (platform.startsWith("darwin-")) {
    return [
      { kind: "codesign", args: ["--remove-signature"] },
      { kind: "inject", machoSegmentName: "NODE_SEA" },
      { kind: "codesign", args: ["--sign", "-"] },
      { kind: "codesign", args: ["--verify"] },
    ];
  }
  return [{ kind: "inject" }];
}

/** A download base from the environment is for tests (a local TLS server) and mirrors: https only. The pins still apply to whatever it serves. */
export function distBase(env = process.env) {
  const override = env.FX_SEA_NODE_DIST_URL;
  if (override === undefined || override === "") return NODE_DIST_URL;
  if (new URL(override).protocol !== "https:") throw new BuildError("dist_url_refused", "FX_SEA_NODE_DIST_URL must be an https URL");
  return override.replace(/\/$/, "");
}

async function fetchBytes(url, fetchFn) {
  const response = await fetchFn(url);
  if (!response.ok) throw new BuildError("download_failed", `${url.slice(0, 120)} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new BuildError("download_too_large", `${url.slice(0, 120)} is over ${MAX_DOWNLOAD_BYTES} bytes`);
  return bytes;
}

/**
 * The verified bytes of the pinned Node archive. With `cacheDir` the archive is kept there after it passed, and read back through the same checks,
 * so a build that runs twice downloads once and a poisoned cache file is refused like a poisoned download.
 */
export async function pinnedNodeArchive({ platform, fetchFn = fetch, base = distBase(), cacheDir }) {
  const pin = NODE_PINS[platform];
  if (pin === undefined) throw new BuildError("platform_unsupported", `no Node pin for ${platform}`);
  const shasums = parseShasums((await fetchBytes(`${base}/SHASUMS256.txt`, fetchFn)).toString("utf8"));
  const cached = cacheDir === undefined ? undefined : path.join(cacheDir, pin.archive);
  const bytes = cached !== undefined && existsSync(cached) ? readFileSync(cached) : await fetchBytes(`${base}/${pin.archive}`, fetchFn);
  verifyNodeArchive({ bytes, archive: pin.archive, shasums, pinned: pin.sha256 });
  if (cached !== undefined && !existsSync(cached)) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cached, bytes);
  }
  return { bytes, archive: pin.archive };
}

/** Takes bin/node out of the archive. */
async function extractNode(archiveBytes, archive, workDir) {
  const archivePath = path.join(workDir, archive);
  writeFileSync(archivePath, archiveBytes);
  const top = archive.replace(/\.tar\.gz$/, "");
  await run("tar", ["-xzf", archivePath, "-C", workDir, `${top}/bin/node`]);
  return path.join(workDir, top, "bin", "node");
}

/** The seconds-since-epoch the build is stamped with: SOURCE_DATE_EPOCH, else the commit's time, else an error. */
export async function buildEpoch(env = process.env) {
  const given = env.SOURCE_DATE_EPOCH;
  if (given !== undefined && given !== "") {
    if (!/^\d{1,12}$/.test(given)) throw new BuildError("epoch_invalid", "SOURCE_DATE_EPOCH must be whole seconds");
    return Number(given);
  }
  try {
    const { stdout } = await run("git", ["log", "-1", "--format=%ct"], { cwd: PACKAGE_DIR });
    if (/^\d+$/.test(stdout.trim())) return Number(stdout.trim());
  } catch {
    // fall through to the error below
  }
  throw new BuildError("epoch_missing", "set SOURCE_DATE_EPOCH (a build with no fixed time is not reproducible)");
}

/**
 * Stop-and-report conditions (R6-1 acceptance 5): a runtime import a single file cannot hold. None exists today; a new one must fail the build here,
 * not at a customer's machine. The fallback (shipping a plain Node script) changes a resolved design point, so it is not taken silently.
 */
export function assertSingleFile(text) {
  if (/\bimport\s*\(/.test(text.replace(/^\s*\/\/.*$/gm, ""))) throw new BuildError("dynamic_import", "the bundle contains a dynamic import(); a single executable cannot load it");
  if (/require\(\s*["'][^"']*\.node["']\s*\)/.test(text) || /\bnew Worker\s*\(/.test(text)) throw new BuildError("native_or_worker", "the bundle needs a native addon or a worker file; a single executable cannot hold it");
}

/** Step 1: the one CommonJS file. */
export async function bundleRunner(epoch) {
  const result = await build({
    entryPoints: [path.join(PACKAGE_DIR, "bin", "fx-runner.mjs")],
    absWorkingDir: PACKAGE_DIR,
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["@anthropic-ai/*"],
    legalComments: "none",
    logLevel: "silent",
    // No import.meta in a CommonJS bundle; bin/fx-runner.mjs only reads it when it is not the single executable.
    define: { "import.meta.url": "undefined", __FX_BUILD_EPOCH__: JSON.stringify(String(epoch)) },
  });
  if (result.outputFiles.length !== 1) throw new BuildError("bundle_failed", "esbuild did not produce exactly one file");
  const text = result.outputFiles[0].text;
  assertSingleFile(text);
  return text;
}

async function codesign(args, file, runFn) {
  await runFn("codesign", [...args, file]);
}

/** Steps 3 and 4 on a copy of the Node binary. */
async function makeExecutable({ nodePath, bundleText, platform, workDir, epoch, runFn }) {
  const bundlePath = path.join(workDir, "fx-runner.cjs");
  const blobPath = path.join(workDir, "fx-runner.blob");
  const configPath = path.join(workDir, "sea-config.json");
  writeFileSync(bundlePath, bundleText);
  // The names are relative and the command runs in the work folder, so the random folder name never reaches the blob.
  writeFileSync(configPath, JSON.stringify({ main: "fx-runner.cjs", output: "fx-runner.blob", disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
  await runFn(nodePath, ["--experimental-sea-config", "sea-config.json"], { cwd: workDir });
  const out = path.join(workDir, artifactName(platform));
  copyFileSync(nodePath, out);
  chmodSync(out, 0o755);
  for (const step of injectionSteps(platform)) {
    if (step.kind === "codesign") await codesign(step.args, out, runFn);
    else await postject.inject(out, "NODE_SEA_BLOB", readFileSync(blobPath), { sentinelFuse: SENTINEL_FUSE, ...(step.machoSegmentName === undefined ? {} : { machoSegmentName: step.machoSegmentName }) });
  }
  chmodSync(out, 0o755);
  utimesSync(out, epoch, epoch);
  return out;
}

/** The whole build. Returns the file written and its manifest entry. Nothing is written to `outDir` unless every step passed. */
export async function buildSea({ target = hostPlatform(), outDir, epoch, fetchFn = fetch, base = distBase(), cacheDir, runFn = (cmd, args, options) => run(cmd, args, options) }) {
  if (!Object.hasOwn(ARTIFACT_NAMES, target)) throw new BuildError("platform_unsupported", `${String(target).slice(0, 40)} is not one of ${Object.keys(ARTIFACT_NAMES).join(", ")}`);
  if (target !== hostPlatform()) throw new BuildError("cross_build_unsupported", `the blob is made by the pinned Node itself, so ${target} must be built on a ${target} machine`);
  const workDir = mkdtempSync(path.join(tmpdir(), "fx-sea-"));
  try {
    const { bytes, archive } = await pinnedNodeArchive({ platform: target, fetchFn, base, cacheDir });
    const nodePath = await extractNode(bytes, archive, workDir);
    const bundleText = await bundleRunner(epoch);
    const built = await makeExecutable({ nodePath, bundleText, platform: target, workDir, epoch, runFn });
    mkdirSync(outDir, { recursive: true });
    const finalPath = path.join(outDir, path.basename(built));
    renameOrCopy(built, finalPath);
    utimesSync(finalPath, epoch, epoch);
    const { entries } = writeManifest(outDir, packageVersion());
    return { file: finalPath, entry: entries.find((entry) => entry.platform === target) };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function renameOrCopy(from, to) {
  try {
    renameSync(from, to);
  } catch {
    // a temporary folder on another file system cannot be renamed across
    copyFileSync(from, to);
    chmodSync(to, 0o755);
  }
}

function parseArgs(argv) {
  const args = { target: undefined, outDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") args.target = argv[++i];
    else if (argv[i] === "--out-dir") args.outDir = argv[++i];
    else throw new BuildError("usage", `unknown argument ${String(argv[i]).slice(0, 40)}`);
  }
  return args;
}

async function main(argv) {
  try {
    const args = parseArgs(argv);
    const { file, entry } = await buildSea({
      target: args.target ?? hostPlatform(),
      outDir: path.resolve(args.outDir ?? path.join(PACKAGE_DIR, "dist", "sea")),
      epoch: await buildEpoch(),
      cacheDir: process.env.FX_SEA_NODE_CACHE_DIR,
    });
    process.stdout.write(`${file}\nsha256 ${entry.sha256}\nsize ${entry.size}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`build-sea: ${error instanceof Error ? error.message : "failed"}\n`);
    return error instanceof BuildError && error.code === "usage" ? 2 : 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
