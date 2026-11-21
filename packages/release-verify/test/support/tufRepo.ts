/**
 * A TUF repository for tests, built with `@tufjs/models` (the reference model classes) and signed with throwaway keys generated per
 * call, in memory. Nothing here is a real release key and no key is ever written to disk or committed (D#6 R6-2a, correction C38
 * section 2). The metadata is made by the library's own `Metadata.sign`, never by editing JSON; the tests that need a damaged file damage
 * the bytes after signing and say so.
 *
 * R6-3's signing tool does not exist yet; when it does, its output can replace this builder without changing the tests.
 */
import crypto from "node:crypto";
import { Key, MetaFile, Metadata, Root, Signature, Snapshot, TargetFile, Targets, Timestamp } from "@tufjs/models";
// `Role` is not part of the package's index; the reference class is reached by its file.
import { Role } from "@tufjs/models/dist/role.js";

export interface TestKey {
  id: string;
  publicHex: string;
  sign(data: Buffer): string;
}

export function makeKey(): TestKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  return {
    id: crypto.createHash("sha256").update(publicHex).digest("hex"),
    publicHex,
    sign: (data) => crypto.sign(null, data, privateKey).toString("hex"),
  };
}

export type RoleName = "root" | "timestamp" | "snapshot" | "targets";

export interface KeySet {
  root: TestKey[];
  timestamp: TestKey[];
  snapshot: TestKey[];
  targets: TestKey[];
}

export function makeKeys(count = 1): KeySet {
  const some = (): TestKey[] => Array.from({ length: count }, makeKey);
  return { root: some(), timestamp: some(), snapshot: some(), targets: some() };
}

const HOUR = 3_600_000;
export const inHours = (hours: number): string => new Date(Date.now() + hours * HOUR).toISOString();

export interface TestTarget {
  path: string;
  content: Buffer;
  /** Sign something other than the content's real length or hash. */
  length?: number;
  hashes?: Record<string, string>;
}

export interface RootSpec {
  version: number;
  expires?: string;
  keys: KeySet;
  thresholds?: Partial<Record<RoleName, number>>;
  /** Whose signatures the file carries. Default: every root key of this root. */
  signers?: TestKey[];
}

export interface RepoSpec {
  root: RootSpec;
  /** Later roots, served as `N.root.json`, each signed by the keys in its own `signers` (rotation: give the old root's keys too). */
  rotations?: RootSpec[];
  timestampVersion?: number;
  snapshotVersion?: number;
  targetsVersion?: number;
  /** The version the snapshot lists for `targets.json`, when it differs from `targetsVersion`. */
  snapshotListsTargetsVersion?: number;
  /** The snapshot version the timestamp lists, when it differs from `snapshotVersion`. */
  timestampListsSnapshotVersion?: number;
  expires?: Partial<Record<RoleName, string>>;
  targets?: TestTarget[];
  /** Keys that sign each non-root role, when they should not be the root's declared ones. */
  signWith?: Partial<Record<"timestamp" | "snapshot" | "targets", TestKey[]>>;
}

export interface BuiltRepo {
  /** The text of the trusted root a client is built with (version 1 of the chain, or whichever `root` names). */
  rootText: string;
  /** Metadata files by served name: `1.root.json`, `timestamp.json`, `3.snapshot.json`, `2.targets.json`. */
  metadata: Map<string, Buffer>;
  /** Release files by target path. */
  files: Map<string, Buffer>;
  keys: KeySet;
}

function buildRoot(spec: RootSpec): Metadata<Root> {
  const keys: Record<string, Key> = {};
  const roles: Record<string, Role> = {};
  for (const name of ["root", "timestamp", "snapshot", "targets"] as const) {
    for (const key of spec.keys[name]) {
      keys[key.id] = new Key({ keyID: key.id, keyType: "ed25519", scheme: "ed25519", keyVal: { public: key.publicHex } });
    }
    roles[name] = new Role({ keyIDs: spec.keys[name].map((k) => k.id), threshold: spec.thresholds?.[name] ?? 1 });
  }
  const root = new Metadata(new Root({ version: spec.version, specVersion: "1.0.31", expires: spec.expires ?? inHours(24 * 30), keys, roles, consistentSnapshot: true }));
  for (const key of spec.signers ?? spec.keys.root) {
    root.sign((data) => new Signature({ keyID: key.id, sig: key.sign(data) }));
  }
  return root;
}

function sign<T extends Root | Timestamp | Snapshot | Targets>(meta: Metadata<T>, signers: readonly TestKey[]): Buffer {
  for (const key of signers) meta.sign((data) => new Signature({ keyID: key.id, sig: key.sign(data) }));
  return Buffer.from(JSON.stringify(meta.toJSON()));
}

const sha256 = (data: Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

export function buildRepo(spec: RepoSpec): BuiltRepo {
  const metadata = new Map<string, Buffer>();
  const files = new Map<string, Buffer>();
  const keys = spec.root.keys;

  const rootBytes = Buffer.from(JSON.stringify(buildRoot(spec.root).toJSON()));
  metadata.set(`${spec.root.version}.root.json`, rootBytes);
  for (const rotation of spec.rotations ?? []) {
    metadata.set(`${rotation.version}.root.json`, Buffer.from(JSON.stringify(buildRoot(rotation).toJSON())));
  }
  // The roles after the last rotation are the ones that must sign everything else.
  const latest = (spec.rotations ?? []).at(-1) ?? spec.root;
  const active = latest.keys;

  const targetsVersion = spec.targetsVersion ?? 1;
  const targetsMeta = new Metadata(
    new Targets({
      version: targetsVersion,
      specVersion: "1.0.31",
      expires: spec.expires?.targets ?? inHours(24 * 30),
      targets: Object.fromEntries(
        (spec.targets ?? []).map((t) => [
          t.path,
          new TargetFile({ path: t.path, length: t.length ?? t.content.length, hashes: t.hashes ?? { sha256: sha256(t.content) } }),
        ]),
      ),
    }),
  );
  const targetsBytes = sign(targetsMeta, spec.signWith?.targets ?? active.targets);
  metadata.set(`${targetsVersion}.targets.json`, targetsBytes);
  for (const t of spec.targets ?? []) files.set(t.path, t.content);

  const snapshotVersion = spec.snapshotVersion ?? 1;
  const snapshotMeta = new Metadata(
    new Snapshot({
      version: snapshotVersion,
      specVersion: "1.0.31",
      expires: spec.expires?.snapshot ?? inHours(24 * 30),
      meta: { "targets.json": new MetaFile({ version: spec.snapshotListsTargetsVersion ?? targetsVersion }) },
    }),
  );
  const snapshotBytes = sign(snapshotMeta, spec.signWith?.snapshot ?? active.snapshot);
  metadata.set(`${snapshotVersion}.snapshot.json`, snapshotBytes);

  const timestampVersion = spec.timestampVersion ?? 1;
  const timestampMeta = new Metadata(
    new Timestamp({
      version: timestampVersion,
      specVersion: "1.0.31",
      expires: spec.expires?.timestamp ?? inHours(24),
      snapshotMeta: new MetaFile({ version: spec.timestampListsSnapshotVersion ?? snapshotVersion, length: snapshotBytes.length, hashes: { sha256: sha256(snapshotBytes) } }),
    }),
  );
  metadata.set("timestamp.json", sign(timestampMeta, spec.signWith?.timestamp ?? active.timestamp));

  return { rootText: rootBytes.toString("utf8"), metadata, files, keys };
}

/** Flip one byte inside the signed part of a metadata file after it was signed (the signature no longer matches). */
export function damageSigned(bytes: Buffer, from: string, to: string): Buffer {
  const text = bytes.toString("utf8");
  if (!text.includes(from)) throw new Error("test bug: the text to damage is not in the file");
  return Buffer.from(text.replace(from, to));
}
