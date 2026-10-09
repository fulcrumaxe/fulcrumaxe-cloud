#!/usr/bin/env node
// Sign the runner's release metadata (D#6 R6-3, correction C38 section 2). Subcommands:
//
//   init-root          the offline root key signs 1.root.json, naming the targets key and the online key
//   release            targets from release-manifest.json (or --drop <x.y.z>, or --renew), then snapshot and timestamp
//   refresh-timestamp  new snapshot and timestamp with the online key, nothing else changed (weekly)
//   rotate-root        root N+1, signed by the old and the new root key
//   check              verify the directory the way a client would (root chain from the trusted root, every signature, expiry, and
//                      the artifact hashes when --artifacts names a directory holding them)
//
// release, refresh-timestamp, rotate-root and check all REQUIRE --trusted-root <file>: the 1.root.json the owner holds. The tools
// verify everything they build on against it before they sign anything, and refuse when it is missing or does not match.
//
// Every command works on one directory, --dir. A private key is named by a FILE PATH (--root-key, --targets-key, --online-key,
// --new-root-key) or by the NAME of an environment variable (the same flag with -env), never given as a value: key text on the command
// line is refused. Public keys are JWK files as printed by tuf-keygen.mjs. Nothing secret is printed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReleaseToolError, checkRepo, initRoot, loadSigner, readPublicKeyFile, refreshTimestamp, release, rotateRoot } from "./tuf-lib.mjs";

const FLAGS = {
  "init-root": ["--root-key", "--root-key-env", "--targets-pubkey", "--online-pubkey", "--root-days"],
  release: ["--trusted-root", "--artifacts", "--manifest", "--drop", "--renew", "--targets-key", "--targets-key-env", "--online-key", "--online-key-env", "--targets-days", "--snapshot-days", "--timestamp-days"],
  "refresh-timestamp": ["--trusted-root", "--online-key", "--online-key-env", "--snapshot-days", "--timestamp-days"],
  "rotate-root": ["--trusted-root", "--root-key", "--root-key-env", "--new-root-key", "--new-root-key-env", "--targets-pubkey", "--online-pubkey", "--root-days"],
  check: ["--trusted-root", "--artifacts"],
};
const BOOLEAN = new Set(["--renew"]);
const REPEATABLE = new Set(["--drop"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USAGE = "usage: tuf-release.mjs <init-root|release|refresh-timestamp|rotate-root|check> --dir <metadata directory> [flags]\n";

function parse(command, argv) {
  const allowed = new Set(["--dir", ...FLAGS[command]]);
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    // Never echo the argument: a mistaken key pasted here would land in a log. The position is enough to find it.
    if (!allowed.has(flag)) throw new ReleaseToolError(`unknown argument at position ${i + 1} for ${command}`);
    if (BOOLEAN.has(flag)) {
      values.set(flag, true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new ReleaseToolError(`${flag} needs a value`);
    i += 1;
    if (REPEATABLE.has(flag)) values.set(flag, [...(values.get(flag) ?? []), value]);
    else if (values.has(flag)) throw new ReleaseToolError(`${flag} is given twice`);
    else values.set(flag, value);
  }
  return values;
}

function signerFor(values, flag, environment) {
  const file = values.get(flag);
  const env = values.get(`${flag}-env`);
  if (typeof file === "string" && /-----BEGIN|PRIVATE KEY/.test(file)) throw new ReleaseToolError(`${flag} takes a file path; key text on the command line is refused`);
  if (typeof env === "string" && !ENV_NAME.test(env)) throw new ReleaseToolError(`${flag}-env takes the NAME of an environment variable; key text on the command line is refused`);
  return loadSigner({ file, env, environment, flag });
}

/** The release manifest. The errors name the flag, never the path. */
function readManifest(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // fx-swallow-ok: the node error carries the path; replaced with a sentence naming the flag
    throw new ReleaseToolError("the file given for --manifest could not be read");
  }
  try {
    return JSON.parse(text);
  } catch {
    // fx-swallow-ok: replaced with a fixed sentence
    throw new ReleaseToolError("the file given for --manifest is not JSON");
  }
}

/** The trusted root-1 file, as bytes. The error names the flag, never the path. */
function trustedRootFor(values) {
  const file = required(values, "--trusted-root");
  try {
    return readFileSync(file);
  } catch {
    // fx-swallow-ok: the node error carries the path; replaced with a sentence naming the flag
    throw new ReleaseToolError("the file given for --trusted-root could not be read");
  }
}

function lifetimes(values) {
  const out = {};
  for (const role of ["root", "targets", "snapshot", "timestamp"]) {
    const raw = values.get(`--${role}-days`);
    if (raw === undefined) continue;
    if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1) throw new ReleaseToolError(`--${role}-days must be a whole number of days`);
    out[role] = Number(raw);
  }
  return out;
}

function required(values, flag) {
  const value = values.get(flag);
  if (value === undefined) throw new ReleaseToolError(`${flag} is required`);
  return value;
}

/**
 * @param {string[]} argv
 * @param {{ environment?: Record<string, string | undefined>, now?: Date, out?: (s: string) => unknown, err?: (s: string) => unknown }} [io]
 */
export function main(argv, { environment = process.env, now = new Date(), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const [command, ...rest] = argv;
  if (command === undefined || !Object.hasOwn(FLAGS, command)) {
    err(USAGE);
    return 2;
  }
  try {
    const values = parse(command, rest);
    const dir = required(values, "--dir");
    const life = lifetimes(values);
    if (command === "init-root") {
      const result = initRoot({
        dir,
        rootSigner: signerFor(values, "--root-key", environment),
        targetsPublic: readPublicKeyFile(required(values, "--targets-pubkey"), "--targets-pubkey"),
        onlinePublic: readPublicKeyFile(required(values, "--online-pubkey"), "--online-pubkey"),
        ...(life.root === undefined ? {} : { days: life.root }),
        now,
      });
      out(`wrote ${result.version}.root.json, expires ${result.expires}\n`);
    } else if (command === "release") {
      const manifestFile = values.get("--manifest");
      const result = release({
        dir,
        trustedRoot: trustedRootFor(values),
        ...(values.get("--artifacts") === undefined ? {} : { artifacts: values.get("--artifacts") }),
        ...(manifestFile === undefined ? {} : { manifest: readManifest(manifestFile) }),
        drop: values.get("--drop") ?? [],
        renew: values.get("--renew") === true,
        targetsSigners: signerFor(values, "--targets-key", environment),
        onlineSigners: signerFor(values, "--online-key", environment),
        days: life,
        now,
      });
      out(`wrote ${result.files.join(", ")}\nlisted: ${result.listed.join(", ")}\n`);
      if (result.carriedUnderRoot !== undefined && result.carriedUnderRoot !== result.newestRoot) {
        out(`note: the earlier targets verified under root ${result.carriedUnderRoot}, not the newest root ${result.newestRoot} (a key was rotated); read the listed files above before publishing\n`);
      }
    } else if (command === "refresh-timestamp") {
      const result = refreshTimestamp({ dir, trustedRoot: trustedRootFor(values), onlineSigners: signerFor(values, "--online-key", environment), days: life, now });
      out(`wrote ${result.files.join(", ")}\n`);
    } else if (command === "rotate-root") {
      const newRoot = values.has("--new-root-key") || values.has("--new-root-key-env") ? signerFor(values, "--new-root-key", environment) : undefined;
      const targets = values.get("--targets-pubkey");
      const online = values.get("--online-pubkey");
      const result = rotateRoot({
        dir,
        trustedRoot: trustedRootFor(values),
        oldRootSigners: signerFor(values, "--root-key", environment),
        ...(newRoot === undefined ? {} : { newRootSigner: newRoot }),
        ...(targets === undefined ? {} : { targetsPublic: readPublicKeyFile(targets, "--targets-pubkey") }),
        ...(online === undefined ? {} : { onlinePublic: readPublicKeyFile(online, "--online-pubkey") }),
        ...(life.root === undefined ? {} : { days: life.root }),
        now,
      });
      out(`wrote ${result.version}.root.json, expires ${result.expires}\n`);
      if (result.resignNeeded.length > 0) out(`the keys for ${result.resignNeeded.join(", ")} changed: run release --renew with the new keys before publishing\n`);
    } else {
      const artifacts = values.get("--artifacts");
      const result = checkRepo({ dir, trustedRoot: trustedRootFor(values), ...(artifacts === undefined ? {} : { artifacts }), now });
      out(`ok: root ${result.root}, targets ${result.targets}, snapshot ${result.snapshot}, timestamp ${result.timestamp}\nlisted: ${result.listed.join(", ")}\n`);
      out(artifacts === undefined ? "artifacts: not checked (give --artifacts <dir> to check their SHA-256 and length)\n" : `artifacts checked: ${result.artifactsChecked.length}, not found (not checked): ${result.artifactsNotChecked.length === 0 ? "none" : result.artifactsNotChecked.join(", ")}\n`);
    }
    return 0;
  } catch (error) {
    const code = typeof error?.code === "string" && /^E[A-Z]+$/.test(error.code) ? ` (${error.code})` : "";
    err(`tuf-release: ${error instanceof ReleaseToolError ? error.message : error instanceof SyntaxError ? "a JSON file could not be read" : `failed${code}`}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
