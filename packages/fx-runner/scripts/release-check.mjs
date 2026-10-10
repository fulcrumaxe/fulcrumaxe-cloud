#!/usr/bin/env node
// The checks the release workflows run between their steps (D#6 R6-5). Each one exits 0 on a pass and 1 on a refusal, with the reason on stderr.
//
//   fresh-dir <dir>                         the build output directory does not exist yet, or is empty (the manifest hashes every
//                                           artifact-named file in its directory, so a leftover file would be released)
//   compare <dirA> <dirB> [--strip-signature]
//                                           both builds hold the same artifacts with the same SHA-256 (on macOS the code signature is
//                                           removed from a copy first, as ad-hoc signing is not reproducible)
//   smoke <file> <version>                  the built program runs: `--version` names the version, `doctor --sandbox-only` answers 0 or 1
//   sea-real-ran <vitest json file>         test/release/seaReal.test.ts ran and passed: a skipped suite (nodejs.org not reached, or
//                                           FX_SEA_SKIP_REAL=1) is a failure here, though it is a pass in a developer's run
//   signing-configured <trusted root> <ENV_NAME>...
//                                           the trusted root file exists and each named secret is set; otherwise "release signing not
//                                           configured", and the release stays a draft
//   all-checked <output file> <x.y.z>       the saved output of `tuf-release.mjs check --artifacts` shows all four files of this version checked,
//                                           and none of them in its "not checked" list
//   version-matches <x.y.z>                 the version asked for is the package's own version, the one the built program reports
//   prepare-metadata <dir> <trusted root>   an empty metadata directory (the first release) gets the trusted root as 1.root.json; a
//                                           non-empty one must already hold it
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_NAMES, packageVersion } from "./release-manifest.mjs";

class Refusal extends Error {}
const fail = (message) => {
  throw new Refusal(message);
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

export function freshDir(dir) {
  if (existsSync(dir) && readdirSync(dir).length > 0) fail(`${dir} is not empty: build into a fresh directory`);
}

/** The code signature is not part of what must reproduce on macOS, so a copy without it is hashed. */
function hashOf(file, stripSignature) {
  if (!stripSignature) return sha256(file);
  const scratch = mkdtempSync(path.join(tmpdir(), "fx-strip-"));
  try {
    const copy = path.join(scratch, "copy");
    copyFileSync(file, copy);
    execFileSync(process.env.FX_RELEASE_CODESIGN ?? "codesign", ["--remove-signature", copy], { stdio: "ignore" });
    return sha256(copy);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function compare(dirA, dirB, stripSignature = false) {
  const names = Object.values(ARTIFACT_NAMES);
  const present = (dir) => names.filter((name) => existsSync(path.join(dir, name)));
  const [a, b] = [present(dirA), present(dirB)];
  if (a.length === 0) fail(`no fx-runner artifact in ${dirA}`);
  if (a.join() !== b.join()) fail(`the two builds made different files: ${a.join(", ")} against ${b.join(", ")}`);
  for (const name of a) {
    if (hashOf(path.join(dirA, name), stripSignature) !== hashOf(path.join(dirB, name), stripSignature)) fail(`${name} is not reproducible: two builds differ`);
  }
}

export function smoke(file, version) {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FX_FORBID_MODEL_CALLS: "1" };
  const first = spawnSync(file, ["--version"], { env, encoding: "utf8" });
  if (first.status !== 0 || !first.stdout.startsWith(`fx-runner ${version} `)) fail(`--version did not report ${version}`);
  const doctor = spawnSync(file, ["doctor", "--sandbox-only"], { env, encoding: "utf8" });
  const lines = (doctor.stdout ?? "").split("\n").filter((line) => line.includes("Sandbox:"));
  if (![0, 1].includes(doctor.status) || lines.length !== 1) fail("doctor --sandbox-only did not answer as the probe does");
}

export function seaRealRan(jsonFile) {
  let report;
  try {
    report = JSON.parse(readFileSync(jsonFile, "utf8"));
  } catch {
    fail("the test report could not be read");
  }
  const file = (report.testResults ?? []).find((result) => String(result.name).endsWith("seaReal.test.ts"));
  if (file === undefined) fail("seaReal.test.ts is not in the test report");
  const tests = file.assertionResults ?? [];
  const passed = tests.filter((test) => test.status === "passed").length;
  if (tests.length === 0 || passed !== tests.length) fail(`seaReal.test.ts did not run: ${passed} of ${tests.length} passed, the rest were skipped or failed (is nodejs.org reachable, and FX_SEA_SKIP_REAL unset?)`);
}

export function signingConfigured(trustedRoot, names, environment = process.env) {
  const missing = names.filter((name) => !environment[name]);
  if (missing.length > 0 || !existsSync(trustedRoot)) {
    fail(`release signing not configured (${[...missing.map((name) => `secret ${name} is not set`), ...(existsSync(trustedRoot) ? [] : ["the trusted root file is not in the repository"])].join("; ")})`);
  }
}

export function allChecked(outputFile, version) {
  const match = /artifacts checked: (\d+), not found \(not checked\): (.*)/.exec(readFileSync(outputFile, "utf8"));
  if (match === null) fail("the check output does not say which artifacts were checked (was --artifacts given?)");
  if (Number(match[1]) < Object.keys(ARTIFACT_NAMES).length) fail(`only ${match[1]} artifacts were checked; all ${Object.keys(ARTIFACT_NAMES).length} files of v${version} must be`);
  const missed = Object.values(ARTIFACT_NAMES).filter((name) => match[2].includes(`v${version}/${name}`));
  if (missed.length > 0) fail(`not checked: ${missed.join(", ")}`);
}

export function versionMatches(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail("the version must be x.y.z");
  if (version !== packageVersion()) fail(`the version ${version} is not the package version ${packageVersion()}`);
}

export function prepareMetadata(dir, trustedRoot) {
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length === 0) copyFileSync(trustedRoot, path.join(dir, "1.root.json"));
  else if (!existsSync(path.join(dir, "1.root.json"))) fail("the metadata directory has files but no 1.root.json");
}

function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (command === "fresh-dir" && rest.length === 1) freshDir(rest[0]);
    else if (command === "compare" && rest.length >= 2) compare(rest[0], rest[1], rest.includes("--strip-signature"));
    else if (command === "smoke" && rest.length === 2) smoke(rest[0], rest[1]);
    else if (command === "sea-real-ran" && rest.length === 1) seaRealRan(rest[0]);
    else if (command === "signing-configured" && rest.length >= 2) signingConfigured(rest[0], rest.slice(1));
    else if (command === "all-checked" && rest.length === 2) allChecked(rest[0], rest[1]);
    else if (command === "version-matches" && rest.length === 1) versionMatches(rest[0]);
    else if (command === "prepare-metadata" && rest.length === 2) prepareMetadata(rest[0], rest[1]);
    else fail("usage: release-check.mjs <fresh-dir|compare|smoke|sea-real-ran|signing-configured|all-checked|version-matches|prepare-metadata> ...");
    return 0;
  } catch (error) {
    process.stderr.write(`release-check: ${error instanceof Error ? error.message : "failed"}\n`);
    return error instanceof Refusal ? 1 : 2;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
