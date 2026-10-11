// The release signing library (D#6 R6-3, correction C38 section 2). Every document is built and signed with `@tufjs/models`, the
// reference TUF model classes, and every signature is a plain Node `crypto` Ed25519 signature over the library's canonical JSON. This
// file writes no cryptography of its own and no metadata JSON by hand.
//
// What the tools produce is exactly what the runner's client (`src/update/tuf.ts`, tuf-js) verifies: consistent-snapshot metadata
// (`N.root.json`, `N.targets.json`, `N.snapshot.json`, `timestamp.json`) in one directory, and targets named `v<x.y.z>/fx-runner-<platform>`
// with a SHA-256 and a length. No private key is read from a command-line value, and none is ever printed.
import crypto from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Metadata, MetaFile, Signature, Snapshot, TargetFile, Targets, Timestamp } from "@tufjs/models";
import { artifactName } from "./release-manifest.mjs";

const DAY_MS = 86_400_000;
const SPEC_VERSION = "1.0.31";
const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** The release tag of a microVM image, `vm-<template>-<12 hex>`: every file of one image lives under it. */
const VM_TAG = /^vm-[a-z][a-z0-9-]{0,30}-[0-9a-f]{12}$/;
const VM_TARGET = /^vm-[a-z][a-z0-9-]{0,30}-[0-9a-f]{12}\/(?:kernel|rootfs|agent)-(?:amd64|arm64)-([0-9a-f]{64})$/;

/** Days each role lives for, unless a flag says otherwise. The runbook states the re-sign cadence these imply. */
export const DEFAULT_EXPIRY_DAYS = Object.freeze({ root: 365, targets: 90, snapshot: 14, timestamp: 14 });

export class ReleaseToolError extends Error {}
const fail = (message) => {
  throw new ReleaseToolError(message);
};

// ---------------------------------------------------------------------------------------------------------------- keys

/** The TUF description of an Ed25519 public key, and its key id (SHA-256 of the canonical JSON of that description). */
export function tufKey(publicHex) {
  const json = { keytype: "ed25519", scheme: "ed25519", keyval: { public: publicHex } };
  // Canonical JSON for this fixed shape: keys in sorted order, no spaces.
  const canonical = `{"keytype":"ed25519","keyval":{"public":"${publicHex}"},"scheme":"ed25519"}`;
  return { keyID: crypto.createHash("sha256").update(canonical).digest("hex"), json };
}

/** A usable signer from a PKCS#8 PEM. Throws a plain error for anything that is not an Ed25519 private key. */
export function signerFromPem(pem) {
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(pem);
  } catch {
    // fx-swallow-ok: the node error can echo key text; replaced with a fixed sentence
    return fail("the signing key is not a readable private key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("the signing key is not an Ed25519 key");
  const publicKey = crypto.createPublicKey(privateKey);
  const publicHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const { keyID } = tufKey(publicHex);
  return { keyID, publicHex, sign: (data) => crypto.sign(null, data, privateKey).toString("hex") };
}

export function generateKeyPair() {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  const signer = signerFromPem(pem);
  return { pem, ...signer, jwk: publicJwk(signer.publicHex) };
}

/** The public key as a JWK (RFC 8037), the only form a key is ever printed in. */
export function publicJwk(publicHex) {
  return { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicHex, "hex").toString("base64url") };
}

/** A public key from a JWK object or its JSON text. */
export function publicHexFromJwk(jwk) {
  let value = jwk;
  if (typeof jwk === "string") {
    try {
      value = JSON.parse(jwk);
    } catch {
      // fx-swallow-ok: replaced with a fixed sentence
      return fail("the public key is not JSON");
    }
  }
  if (value === null || typeof value !== "object" || value.kty !== "OKP" || value.crv !== "Ed25519" || typeof value.x !== "string") fail("the public key is not an Ed25519 JWK");
  if (Object.keys(value).some((k) => !["kty", "crv", "x"].includes(k))) fail("the public key JWK carries a field that is not public (only kty, crv and x are accepted)");
  const raw = Buffer.from(value.x, "base64url");
  if (raw.length !== 32) fail("the public key is not 32 bytes");
  return raw.toString("hex");
}

/** Read a public JWK from a file. `flag` names the option in the error, never the path or its contents. */
export function readPublicKeyFile(file, flag = "the public key file") {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // fx-swallow-ok: the node error carries the path; replaced with a sentence naming the flag
    return fail(`the public key file given for ${flag} could not be read`);
  }
  return publicHexFromJwk(text);
}

/**
 * A signer from a key FILE or from the NAME of an environment variable. The command line carries a path or a name, never key text.
 * A file readable by group or others is refused. `flag` is the option name (for example `--targets-key`); errors name it and never
 * echo the path, the variable name or any value.
 */
/** @param {Record<string, any>} options */
export function loadSigner({ file, env, environment = process.env, flag = "the key option" }) {
  if ((file === undefined) === (env === undefined)) fail(`give exactly one of ${flag} (a key file path) and ${flag}-env (an environment variable name)`);
  if (file !== undefined) {
    let stat;
    let text;
    try {
      stat = statSync(file);
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) fail(`the key file given for ${flag} is readable by other users; run chmod 600 on it`);
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (error instanceof ReleaseToolError) throw error;
      // fx-swallow-ok: the node error carries the path; replaced with a sentence naming the flag
      return fail(`the key file given for ${flag} could not be read`);
    }
    return signerFromPem(text);
  }
  const value = environment[env];
  if (value === undefined || value === "") fail(`the environment variable named by ${flag}-env is not set`);
  return signerFromPem(value);
}

/**
 * Refuse a private-key path inside any git working tree or inside the repository this tool lives in (a key must never be able
 * to be committed), and refuse any path that passes through a symbolic link: every existing component is lstat-ed and a link is an
 * error, so there is nothing to resolve and nothing to swap between this check and the open.
 */
export function assertOutsideRepo(target) {
  const absolute = path.resolve(target);
  const parts = absolute.split(path.sep);
  let walked = parts[0] === "" ? path.sep : parts[0];
  for (const part of parts.slice(1)) {
    walked = path.join(walked, part);
    let stat;
    try {
      stat = lstatSync(walked);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") break;
      // fx-swallow-ok: the node error carries the path; replaced with a fixed sentence
      return fail("a part of the key path could not be inspected; nothing was written");
    }
    if (stat.isSymbolicLink()) fail("refusing a key path that passes through a symbolic link; give the real path");
  }
  const own = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));
  if (absolute === own || absolute.startsWith(own + path.sep)) fail("refusing to write a private key inside this repository; choose a path outside every working tree");
  for (let dir = path.dirname(absolute); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) fail("refusing to write a private key inside a git working tree; choose a path outside every working tree");
    if (path.dirname(dir) === dir) break;
  }
  return absolute;
}

/** Write a freshly generated private key, mode 0600, never over an existing file. Returns the public JWK. */
export function writeNewKey(file) {
  assertOutsideRepo(file);
  const pair = generateKeyPair();
  const resolved = path.resolve(file);
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  // Checked again after the directories exist: a link planted in between is refused here, and the open below is O_EXCL.
  assertOutsideRepo(file);
  let fd;
  try {
    fd = openSync(resolved, "wx", 0o600);
  } catch {
    // fx-swallow-ok: replaced with a fixed sentence
    return fail("that key file already exists (or cannot be created); nothing was written");
  }
  try {
    writeSync(fd, pair.pem);
  } finally {
    closeSync(fd);
  }
  return pair.jwk;
}

// ------------------------------------------------------------------------------------------------------- metadata files

const FILE_PATTERN = /^(\d+)\.(root|targets|snapshot)\.json$/;

/** Highest version of a role present in `dir`, or 0. */
export function latestVersion(dir, role) {
  if (!existsSync(dir)) return 0;
  let best = 0;
  for (const name of readdirSync(dir)) {
    const match = FILE_PATTERN.exec(name);
    if (match !== null && match[2] === role) best = Math.max(best, Number(match[1]));
  }
  return best;
}

function readMetadata(dir, name, type) {
  const file = path.join(dir, name);
  if (!existsSync(file)) fail(`${name} is not in the metadata directory`);
  return { bytes: readFileSync(file), meta: Metadata.fromJSON(type, JSON.parse(readFileSync(file, "utf8"))) };
}

function writeFiles(dir, files) {
  mkdirSync(dir, { recursive: true });
  // Written in the order given (the timestamp last), each through a rename so a reader never sees half a file.
  for (const [name, bytes] of files) {
    const staging = path.join(dir, `.${name}.tmp`);
    writeFileSync(staging, bytes);
    renameSync(staging, path.join(dir, name));
  }
}

const toBytes = (meta) => Buffer.from(JSON.stringify(meta.toJSON()));
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function addSignatures(meta, signers) {
  for (const signer of signers) meta.sign((data) => new Signature({ keyID: signer.keyID, sig: signer.sign(data) }));
}

function expiryFrom(now, days, role) {
  if (!Number.isFinite(days) || days <= 0) fail(`the ${role} lifetime must be a positive number of days`);
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

const asArray = (value) => (Array.isArray(value) ? value : [value]);

function rootKeysOf(root, role) {
  return root.signed.roles[role].keyIDs;
}

/** Throw unless `signed` carries a threshold of valid signatures from the keys `rootMeta` names for `role`. */
function assertThreshold(rootMeta, role, meta, what) {
  try {
    rootMeta.verifyDelegate(role, meta);
  } catch {
    // fx-swallow-ok: replaced with a sentence naming the file and the role, never the key text
    return fail(`${what} is not signed by a threshold of the ${role} keys that the root names`);
  }
}

/**
 * The root chain of `dir`, verified from a TRUSTED copy of root 1 (the file the owner holds, later the root compiled into the build).
 * `1.root.json` must equal the trusted bytes exactly; every `N.root.json` must be version N, signed by a threshold of root N-1's
 * root keys and by a threshold of its own; nothing may be skipped. Returns the roots in order. The newest must be unexpired unless
 * `allowExpired` (rotate-root is how an expired root is replaced). Without a trusted root there is nothing to verify against, so the
 * tools refuse rather than trust whatever is in the directory.
 */
export function verifiedRootChain(dir, trustedRoot, now, { allowExpired = false } = {}) {
  if (trustedRoot === undefined || trustedRoot.length === 0) fail("a trusted root is required: give --trusted-root <the 1.root.json you hold>; nothing in the metadata directory is trusted on its own");
  const trusted = Buffer.isBuffer(trustedRoot) ? trustedRoot : Buffer.from(String(trustedRoot));
  const latest = latestVersion(dir, "root");
  if (latest === 0) fail("no root metadata in the metadata directory; run init-root first");
  const chain = [];
  for (let version = 1; version <= latest; version += 1) {
    const { bytes, meta } = readMetadata(dir, `${version}.root.json`, "root");
    if (meta.signed.version !== version) fail(`${version}.root.json carries a different version number inside`);
    if (version === 1 && !bytes.equals(trusted)) fail("1.root.json is not the trusted root: it differs from the file given as --trusted-root");
    assertThreshold(meta, "root", meta, `${version}.root.json (against its own keys)`);
    if (version > 1) assertThreshold(chain[version - 2], "root", meta, `${version}.root.json (against root ${version - 1})`);
    chain.push(meta);
  }
  if (!allowExpired && chain[latest - 1].signed.isExpired(now)) fail("the root metadata is expired; rotate the root first");
  return chain;
}

/**
 * Verify timestamp, snapshot and targets in `dir` under `root` and confirm they agree: the newest snapshot file is the one the
 * timestamp names (length and SHA-256 included), and the newest targets file is the version that snapshot names. Returns undefined
 * for a directory that has no targets yet (and refuses one that has a timestamp or snapshot without targets). Expiry is checked only
 * when `enforceExpiry`: release and refresh-timestamp exist to renew expired online roles.
 */
function verifyChain(dir, root, now, { enforceExpiry }) {
  const targetsVersion = latestVersion(dir, "targets");
  if (targetsVersion === 0) {
    if (existsSync(path.join(dir, "timestamp.json")) || latestVersion(dir, "snapshot") !== 0) fail("the directory has a timestamp or snapshot but no targets");
    return undefined;
  }
  const timestamp = readMetadata(dir, "timestamp.json", "timestamp");
  assertThreshold(root, "timestamp", timestamp.meta, "timestamp.json");
  const snapshotVersion = timestamp.meta.signed.snapshotMeta.version;
  if (latestVersion(dir, "snapshot") !== snapshotVersion) fail("the newest snapshot file is not the one the timestamp points to");
  const snapshot = readMetadata(dir, `${snapshotVersion}.snapshot.json`, "snapshot");
  const listed = timestamp.meta.signed.snapshotMeta;
  if (listed.hashes?.sha256 !== sha256(snapshot.bytes) || listed.length !== snapshot.bytes.length) fail("the snapshot does not match the hash and length the timestamp lists");
  assertThreshold(root, "snapshot", snapshot.meta, `${snapshotVersion}.snapshot.json`);
  const named = snapshot.meta.signed.meta["targets.json"]?.version;
  if (named === undefined) fail("the snapshot does not list targets.json");
  if (named !== targetsVersion) fail("the newest targets file is not the version the snapshot points to");
  const targets = readMetadata(dir, `${targetsVersion}.targets.json`, "targets");
  assertThreshold(root, "targets", targets.meta, `${targetsVersion}.targets.json`);
  if (enforceExpiry) {
    if (timestamp.meta.signed.isExpired(now)) fail("timestamp.json is expired");
    if (snapshot.meta.signed.isExpired(now)) fail(`${snapshotVersion}.snapshot.json is expired`);
    if (targets.meta.signed.isExpired(now)) fail(`${targetsVersion}.targets.json is expired`);
  }
  return { timestamp: timestamp.meta, snapshot: snapshot.meta, targets: targets.meta, snapshotVersion, targetsVersion };
}

/**
 * The existing metadata, verified, for a command that builds on it. It is checked against the newest root first, and if that root
 * does not verify it (the targets or online key was rotated and a renew is due) against the older roots of the VERIFIED chain, so the
 * renew can carry the list forward. Nothing unsigned, tampered or unreferenced passes under any of them. `rootVersion` says which
 * root vouched for it.
 */
function verifiedExisting(dir, chain, now) {
  let first;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    try {
      return { state: verifyChain(dir, chain[index], now, { enforceExpiry: false }), rootVersion: index + 1 };
    } catch (error) {
      if (!(error instanceof ReleaseToolError)) throw error;
      first ??= error;
    }
  }
  throw first;
}

/** The signers given must be exactly keys the root names for the role (a wrong-role key is refused before anything is signed). */
function checkRoleKeys(root, role, signers) {
  const allowed = new Set(rootKeysOf(root, role));
  for (const signer of signers) if (!allowed.has(signer.keyID)) fail(`the key given for ${role} is not one of the ${role} keys that the root names`);
}

/** Refuse any key shared between the root, targets and online (snapshot/timestamp) roles: one leaked secret must not hold two roles. */
function assertDistinctRoleKeys({ root, targets, online }) {
  const sets = [["root", new Set(root)], ["targets", new Set(targets)], ["online", new Set(online)]];
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      if ([...sets[i][1]].some((key) => sets[j][1].has(key))) fail(`the ${sets[i][0]} and ${sets[j][0]} keys must be different keys; no key may hold two roles`);
    }
  }
}

// -------------------------------------------------------------------------------------------------------------- init-root

function buildRootSigned({ version, now, days, keys, thresholds }) {
  // Root.fromJSON on a plain description keeps this to the reference class's own parsing and validation.
  const keyMap = {};
  const roles = {};
  for (const [role, publicHexes] of Object.entries(keys)) {
    const ids = [];
    for (const hex of publicHexes) {
      const { keyID, json } = tufKey(hex);
      keyMap[keyID] = json;
      ids.push(keyID);
    }
    roles[role] = { keyids: ids, threshold: thresholds?.[role] ?? 1 };
  }
  return Metadata.fromJSON("root", {
    signed: { _type: "root", spec_version: SPEC_VERSION, version, expires: expiryFrom(now, days, "root"), consistent_snapshot: true, keys: keyMap, roles },
    signatures: [],
  });
}

/**
 * The owner's root key signs `1.root.json`, naming the targets key and the online key (which signs snapshot and timestamp).
 * `targetsPublic` and `onlinePublic` are public-key hex strings (or arrays of them).
 */
/** @param {Record<string, any>} options */
export function initRoot({ dir, rootSigner, targetsPublic, onlinePublic, days = DEFAULT_EXPIRY_DAYS.root, thresholds, now = new Date() }) {
  if (latestVersion(dir, "root") !== 0) fail("this directory already has a root; use rotate-root to change it");
  const online = asArray(onlinePublic);
  assertDistinctRoleKeys({ root: [rootSigner.publicHex], targets: asArray(targetsPublic), online });
  const root = buildRootSigned({
    version: 1,
    now,
    days,
    keys: { root: [rootSigner.publicHex], targets: asArray(targetsPublic), snapshot: online, timestamp: online },
    thresholds,
  });
  addSignatures(root, [rootSigner]);
  assertThreshold(root, "root", root, "the new root");
  writeFiles(dir, [["1.root.json", toBytes(root)]]);
  return { version: 1, expires: root.signed.expires };
}

/**
 * Compare the file at `<artifacts>/<name>` with a targets entry: "ok", or "missing" when it is not there; a file that is there and
 * differs (length or SHA-256), is not a regular file, or sits at an unsafe name throws an error naming the ENTRY, never a path.
 */
function compareArtifact(artifacts, name, entry) {
  const segments = name.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) fail("a listed target name is not a plain relative path");
  const file = path.join(artifacts, ...segments);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    // fx-swallow-ok: a file that is not there is reported as missing
    return "missing";
  }
  if (!stat.isFile()) fail(`the artifact for ${name} is not a regular file`);
  const bytes = readFileSync(file);
  if (bytes.length !== entry.length || sha256(bytes) !== entry.hashes?.sha256) fail(`the artifact for ${name} does not match the length and SHA-256 the signed targets list`);
  return "ok";
}

// ---------------------------------------------------------------------------------------------------------------- release

/** `v<version>/<artifact name>` for each manifest entry, as the updater looks them up. */
export function targetEntries(manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0) fail("the manifest has no entries");
  return manifest.map((entry) => {
    if (entry.target !== undefined) {
      // A microVM image file (D#587 B-1): named by its own digest, so a released file is never replaced and a digest can be looked up by name.
      const named = VM_TARGET.exec(String(entry.target));
      if (named === null) fail("a manifest entry has a target that is not vm-<template>-<12 hex>/<kernel|rootfs|agent>-<arch>-<sha256>");
      if (entry.sha256 !== named[1] || !Number.isSafeInteger(entry.size) || entry.size < 1) fail("a vm manifest entry's sha256 must be the one in its name, and its size a positive integer");
      return { path: entry.target, length: entry.size, hashes: { sha256: entry.sha256 } };
    }
    if (typeof entry.version !== "string" || !SEMVER.test(entry.version)) fail("a manifest entry has a version that is not x.y.z");
    if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) fail("a manifest entry has a sha256 that is not 64 lowercase hex digits");
    if (!Number.isSafeInteger(entry.size) || entry.size < 1) fail("a manifest entry has a size that is not a positive integer");
    return { path: `v${entry.version}/${artifactName(entry.platform)}`, length: entry.size, hashes: { sha256: entry.sha256 } };
  });
}

function signTimestampAndSnapshot({ root, onlineSigners, targetsVersion, previous, now, days }) {
  // `previous` is the verified existing state (or undefined for a first release); no version number is read from an unverified file.
  const snapshotVersion = (previous?.snapshotVersion ?? 0) + 1;
  const snapshot = new Metadata(
    new Snapshot({ version: snapshotVersion, specVersion: SPEC_VERSION, expires: expiryFrom(now, days.snapshot, "snapshot"), meta: { "targets.json": new MetaFile({ version: targetsVersion }) } }),
  );
  addSignatures(snapshot, onlineSigners);
  assertThreshold(root, "snapshot", snapshot, "the new snapshot");
  const snapshotBytes = toBytes(snapshot);
  const timestamp = new Metadata(
    new Timestamp({
      version: (previous?.timestamp.signed.version ?? 0) + 1,
      specVersion: SPEC_VERSION,
      expires: expiryFrom(now, days.timestamp, "timestamp"),
      snapshotMeta: new MetaFile({ version: snapshotVersion, length: snapshotBytes.length, hashes: { sha256: sha256(snapshotBytes) } }),
    }),
  );
  addSignatures(timestamp, onlineSigners);
  assertThreshold(root, "timestamp", timestamp, "the new timestamp");
  return [
    [`${snapshotVersion}.snapshot.json`, snapshotBytes],
    ["timestamp.json", toBytes(timestamp)],
  ];
}

/**
 * Sign a new targets version, then snapshot and timestamp. The listed targets carry over from the previous targets version, plus the
 * manifest's, minus every file of a release in `drop` (withdrawing a bad one): a runner version `x.y.z`, or a microVM image tag
 * `vm-<template>-<12 hex>` (all of that image's kernel, root disk and agent entries). With neither a manifest nor a drop, `renew: true`
 * signs the same list again with a new expiry.
 */
/** @param {Record<string, any>} options */
export function release({ dir, trustedRoot, artifacts, manifest, drop = [], renew = false, targetsSigners, onlineSigners, days = {}, now = new Date() }) {
  const lifetimes = { ...DEFAULT_EXPIRY_DAYS, ...days };
  const chain = verifiedRootChain(dir, trustedRoot, now);
  const root = chain[chain.length - 1];
  const targetsKeys = asArray(targetsSigners);
  const onlineKeys = asArray(onlineSigners);
  checkRoleKeys(root, "targets", targetsKeys);
  checkRoleKeys(root, "snapshot", onlineKeys);
  checkRoleKeys(root, "timestamp", onlineKeys);
  if (manifest === undefined && drop.length === 0 && !renew) fail("nothing to do: give a manifest, a version to drop, or --renew");
  for (const v of drop) if (!SEMVER.test(v) && !VM_TAG.test(v)) fail("a release to drop is neither x.y.z nor a vm-<template>-<12 hex> tag");

  // What is carried forward comes only from metadata that verified: the previous targets file is signed by a threshold of targets
  // keys of a root in the verified chain, and is exactly the version the verified snapshot and timestamp point to.
  const { state, rootVersion } = verifiedExisting(dir, chain, now);
  const previousVersion = state?.targetsVersion ?? 0;
  const listed = new Map();
  if (state !== undefined) {
    for (const [name, file] of Object.entries(state.targets.signed.targets)) listed.set(name, { path: name, length: file.length, hashes: file.hashes });
  }
  // Entries vouched for only by an OLDER root (a key was rotated, usually after a leak) may have been added with the leaked key, so
  // each one that is carried forward must match the real artifact before it is signed again. The newest root vouching for the list
  // (no rotation of the targets or online key) needs no such check.
  const carriedUnderOlderRoot = state !== undefined && rootVersion !== chain.length;
  for (const tag of drop) {
    const prefix = VM_TAG.test(tag) ? `${tag}/` : `v${tag}/`;
    const hits = [...listed.keys()].filter((name) => name.startsWith(prefix));
    if (hits.length === 0) fail(`${tag} is not listed, so there is nothing to drop`);
    for (const name of hits) listed.delete(name);
  }
  if (carriedUnderOlderRoot) {
    if (artifacts === undefined) fail(`the earlier targets are vouched for only by root ${rootVersion}, not the newest root ${chain.length} (a key was rotated); give --artifacts <dir> holding every file still listed (v<x.y.z>/fx-runner-<platform> and vm-<template>-<12 hex>/<kind>-<arch>-<sha256>), or --drop the releases you cannot supply (a runner x.y.z, or a microVM image tag; an old root disk is about 1 GiB, so withdraw old images rather than keep them)`);
    for (const [name, entry] of listed) {
      if (compareArtifact(artifacts, name, entry) === "missing") fail(`the artifact for ${name} is not in --artifacts, so its entry cannot be verified; supply it or --drop that release (${name.startsWith("vm-") ? name.split("/")[0] : name.split("/")[0].slice(1)})`);
    }
  }
  if (manifest !== undefined) {
    for (const entry of targetEntries(manifest)) {
      const existing = listed.get(entry.path);
      if (existing !== undefined && existing.hashes.sha256 !== entry.hashes.sha256) fail(`${entry.path} is already released with different contents; a released file is never replaced (release a new version)`);
      listed.set(entry.path, entry);
    }
  }

  const targetsVersion = previousVersion + 1;
  const targets = new Metadata(
    new Targets({
      version: targetsVersion,
      specVersion: SPEC_VERSION,
      expires: expiryFrom(now, lifetimes.targets, "targets"),
      targets: Object.fromEntries([...listed.values()].sort((a, b) => a.path.localeCompare(b.path)).map((t) => [t.path, new TargetFile({ path: t.path, length: t.length, hashes: t.hashes })])),
    }),
  );
  addSignatures(targets, targetsKeys);
  assertThreshold(root, "targets", targets, "the new targets");
  const files = [[`${targetsVersion}.targets.json`, toBytes(targets)], ...signTimestampAndSnapshot({ root, onlineSigners: onlineKeys, targetsVersion, previous: state, now, days: lifetimes })];
  writeFiles(dir, files);
  return { targets: targetsVersion, listed: [...listed.keys()].sort(), files: files.map(([name]) => name), carriedUnderRoot: state === undefined ? undefined : rootVersion, newestRoot: chain.length };
}

// ----------------------------------------------------------------------------------------------------- refresh-timestamp

/**
 * Re-sign the online roles with a new expiry and no other change: a new snapshot version (it lists the same targets) and a new timestamp.
 * The snapshot is re-signed too because the one online key signs both and the snapshot's own expiry would otherwise end the
 * client's updates after its lifetime. It refuses when the targets or the root are expired: those need their own keys.
 */
/** @param {Record<string, any>} options */
export function refreshTimestamp({ dir, trustedRoot, onlineSigners, days = {}, now = new Date() }) {
  const lifetimes = { ...DEFAULT_EXPIRY_DAYS, ...days };
  const chain = verifiedRootChain(dir, trustedRoot, now);
  const root = chain[chain.length - 1];
  const onlineKeys = asArray(onlineSigners);
  checkRoleKeys(root, "snapshot", onlineKeys);
  checkRoleKeys(root, "timestamp", onlineKeys);
  // The targets the new snapshot will point at must verify under the newest root first; the old timestamp and snapshot may be expired.
  const state = verifyChain(dir, root, now, { enforceExpiry: false });
  if (state === undefined) fail("there is no targets metadata to refresh; run release first");
  if (state.targets.signed.isExpired(now)) fail("the targets metadata is expired; refreshing the timestamp cannot help, sign a new targets version (release --renew)");
  const files = signTimestampAndSnapshot({ root, onlineSigners: onlineKeys, targetsVersion: state.targetsVersion, previous: state, now, days: lifetimes });
  writeFiles(dir, files);
  return { files: files.map(([name]) => name) };
}

// ----------------------------------------------------------------------------------------------------------- rotate-root

/**
 * Root version N+1, signed by the keys of root N and by its own, the TUF way. Give `newRootSigner` to change the root key, and
 * `targetsPublic` / `onlinePublic` to change those keys. Changing a key that signs targets, snapshot or timestamp makes the existing
 * files of that role invalid under the new root, so a `release --renew` with the new keys has to follow.
 */
/** @param {Record<string, any>} options */
export function rotateRoot({ dir, trustedRoot, oldRootSigners, newRootSigner, targetsPublic, onlinePublic, days = DEFAULT_EXPIRY_DAYS.root, thresholds, now = new Date() }) {
  const chain = verifiedRootChain(dir, trustedRoot, now, { allowExpired: true });
  const previousVersion = chain.length;
  const previous = chain[previousVersion - 1];
  const oldSigners = asArray(oldRootSigners);
  checkRoleKeys(previous, "root", oldSigners);
  const publicOf = (role) => rootKeysOf(previous, role).map((id) => previous.signed.keys[id].keyVal.public);
  const rootPublic = newRootSigner === undefined ? publicOf("root") : [newRootSigner.publicHex];
  const targets = targetsPublic === undefined ? publicOf("targets") : asArray(targetsPublic);
  const online = onlinePublic === undefined ? publicOf("timestamp") : asArray(onlinePublic);
  assertDistinctRoleKeys({ root: rootPublic, targets, online });
  const next = buildRootSigned({
    version: previousVersion + 1,
    now,
    days,
    keys: { root: rootPublic, targets, snapshot: online, timestamp: online },
    thresholds: thresholds ?? Object.fromEntries(["root", "targets", "snapshot", "timestamp"].map((r) => [r, previous.signed.roles[r].threshold])),
  });
  // Old root keys sign (so clients holding root N accept it) and the new root keys sign (so root N+1 stands on its own).
  addSignatures(next, oldSigners);
  if (newRootSigner !== undefined) addSignatures(next, [newRootSigner]);
  assertThreshold(previous, "root", next, "the new root (against the previous root)");
  assertThreshold(next, "root", next, "the new root (against itself)");
  writeFiles(dir, [[`${previousVersion + 1}.root.json`, toBytes(next)]]);
  const changed = (role) => JSON.stringify(rootKeysOf(previous, role)) !== JSON.stringify(rootKeysOf(next, role));
  return { version: previousVersion + 1, expires: next.signed.expires, resignNeeded: ["targets", "snapshot", "timestamp"].filter(changed) };
}

// -------------------------------------------------------------------------------------------------------------------- check

/**
 * Verify everything in `dir` the way a client would: the root chain from the trusted root 1 (every link), then timestamp, snapshot
 * and targets under the newest root with their expiry, and, when `artifacts` names a directory, the length and SHA-256 of every listed
 * file found at `<artifacts>/<target path>` (for example `<artifacts>/v1.0.0/fx-runner-linux-x64`). A listed file that is not there is
 * reported as not checked, never as ok. Throws a ReleaseToolError naming the first problem.
 */
/** @param {Record<string, any>} options */
export function checkRepo({ dir, trustedRoot, artifacts, now = new Date() }) {
  const chain = verifiedRootChain(dir, trustedRoot, now);
  const root = chain[chain.length - 1];
  const state = verifyChain(dir, root, now, { enforceExpiry: true });
  if (state === undefined) fail("there is no targets metadata to check; run release first");
  const names = Object.keys(state.targets.signed.targets).sort();
  const checked = [];
  const notChecked = [];
  if (artifacts !== undefined) {
    for (const name of names) {
      if (compareArtifact(artifacts, name, state.targets.signed.targets[name]) === "missing") notChecked.push(name);
      else checked.push(name);
    }
  }
  return { root: chain.length, targets: state.targetsVersion, snapshot: state.snapshotVersion, timestamp: state.timestamp.signed.version, listed: names, artifactsChecked: checked, artifactsNotChecked: artifacts === undefined ? names : notChecked };
}
