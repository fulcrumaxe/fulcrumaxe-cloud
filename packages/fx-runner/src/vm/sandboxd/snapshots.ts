/**
 * Snapshot bookkeeping for `fx-sandboxd` (D#587 B-3b). The helper keeps no list and no retention policy, so the daemon tracks every snapshot it
 * asked for: its size (to hold the quota), when it was taken (expiry, and which is oldest) and which sandbox owns it. The list is kept in a 0600
 * state file under a 0700 directory, opened without following links, so a snapshot is still found after the daemon restarts.
 */
import { randomBytes } from "node:crypto";
import { readJsonNoFollow, writeJsonAtomic } from "../../engineBridge/stateFiles.js";
import { SANDBOX_ID } from "./helperClient.js";

export const MIB = 1024 ** 2;
/** Vercel's snapshots expire after 30 days unless told otherwise; so do these. */
export const DEFAULT_SNAPSHOT_TTL_SECONDS = 30 * 24 * 3600;
/** A persistent sandbox keeps one snapshot unless told otherwise (the executor's `keepLastSnapshots`). */
export const DEFAULT_KEEP_LAST = 1;
/** The most snapshots one sandbox may keep: each is the guest's whole RAM on disk. */
export const MAX_KEEP_LAST = 10;
/** The helper's cap on the device-state file; a snapshot is the guest's RAM plus up to this much. */
export const STATE_FILE_BYTES = 4 * MIB;
export const snapshotNeedBytes = (guestRamBytes: number): number => guestRamBytes + STATE_FILE_BYTES;
const STATE_FILE = "sandboxd-snapshots.json";
const STATE_MAX_BYTES = 4 * MIB;

export interface SnapshotMeta { id: string; bytes: number; takenAt: number }
export interface PersistedSandbox {
  name: string;
  template: string;
  vcpus: number;
  memMb: number;
  createdAt: number;
  keepLast: number;
  snapshots: SnapshotMeta[];
}
export interface StoreFile { version: 1; sandboxes: PersistedSandbox[]; orphans: SnapshotMeta[] }

/** The snapshot side of the runner's limits (`microvm.snapshot_dir`, `microvm.snapshot_quota_bytes`) and what the daemon needs to enforce them. */
export interface SnapshotDeps {
  /** `microvm.snapshot_dir`: where the helper keeps the files. The daemon only asks how much room is left on it. */
  dir: string;
  quotaBytes: number;
  /** Bytes available to the runner's user on the file system holding `dir`; undefined when it cannot be read (the snapshot is then refused). */
  freeBytes(dir: string): number | undefined;
  /** The daemon's own 0700 directory for its state file. */
  stateDir: string;
  ttlSeconds?: number;
}

/**
 * D#845 ON-13b2 (Ruling 81.1a): the production snapshot wiring. The caller reads the runner's `microvm.snapshot_dir` and `microvm.snapshot_quota_bytes` (the completed caps), the free-space reader (statfs, built outside `src`) and makes the daemon's 0700
 * state directory; any part that is missing or refused means no snapshot deps, so no sandbox may be persistent and a session's stop fails closed (`snapshot_failed`) instead of keeping an unquotaed file.
 */
export function productionSnapshots(config: { sandboxdDir: string; uid: number | undefined; caps: { snapshotDir: string; snapshotQuotaBytes: number } | undefined; freeBytes: (dir: string) => number | undefined; ensureDir: (dir: string, uid: number) => void }): SnapshotDeps | undefined {
  if (config.uid === undefined || config.caps === undefined) return undefined;
  try {
    config.ensureDir(config.sandboxdDir, config.uid);
  } catch {
    // fx-swallow-ok: a state directory that cannot be made or is not safe means no snapshots (the caller reports the failed stop in its own closed word)
    return undefined;
  }
  return { dir: config.caps.snapshotDir, quotaBytes: config.caps.snapshotQuotaBytes, freeBytes: config.freeBytes, stateDir: config.sandboxdDir };
}

export type SnapshotAdmission = { admit: true } | { admit: false; detail: string };

/**
 * Whether one more snapshot of a guest with `guestRamBytes` may be taken. A full snapshot is as big as the guest's RAM, so the free space on the
 * snapshot directory must cover it, and the bytes already held plus this one must fit the quota. Every refusal names both numbers it compared.
 */
export function admitSnapshot(input: { guestRamBytes: number; usedBytes: number; quotaBytes: number; freeBytes: number | undefined }): SnapshotAdmission {
  const { guestRamBytes, usedBytes, quotaBytes, freeBytes } = input;
  if (typeof freeBytes !== "number" || !Number.isFinite(freeBytes) || freeBytes < 0) return { admit: false, detail: "the free space of the snapshot directory could not be read" };
  const need = snapshotNeedBytes(guestRamBytes);
  if (freeBytes < need) return { admit: false, detail: `${freeBytes} bytes free on the snapshot directory; a snapshot needs ${need} bytes (the guest's RAM of ${guestRamBytes} plus ${STATE_FILE_BYTES} for the device state)` };
  if (usedBytes + need > quotaBytes) return { admit: false, detail: `${usedBytes} bytes held plus ${need} for this snapshot (the guest's RAM of ${guestRamBytes} plus ${STATE_FILE_BYTES} for the device state) is over the quota of ${quotaBytes} bytes` };
  return { admit: true };
}

/** An id the helper accepts (the same pattern as a sandbox id): `sn` and 24 hex digits. */
export const newSnapshotId = (): string => `sn${randomBytes(12).toString("hex")}`;

const isInt = (v: unknown, min: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function meta(v: unknown): SnapshotMeta {
  if (!isRec(v) || typeof v["id"] !== "string" || !SANDBOX_ID.test(v["id"]) || !isInt(v["bytes"], 1) || !isInt(v["takenAt"], 0)) throw new Error("bad snapshot entry");
  return { id: v["id"], bytes: v["bytes"], takenAt: v["takenAt"] };
}

/** Reads the state file: absent is empty, anything malformed throws (the daemon then refuses to start rather than forget snapshots it holds). */
export function loadStore(stateDir: string, uid: number): StoreFile {
  const raw = readJsonNoFollow(stateDir, STATE_FILE, uid, STATE_MAX_BYTES);
  if (raw === undefined) return { version: 1, sandboxes: [], orphans: [] };
  if (!isRec(raw) || raw["version"] !== 1 || !Array.isArray(raw["sandboxes"]) || !Array.isArray(raw["orphans"])) throw new Error("fx-sandboxd: the snapshot state file is not valid");
  const sandboxes = raw["sandboxes"].map((s: unknown): PersistedSandbox => {
    if (!isRec(s) || typeof s["name"] !== "string" || !SANDBOX_ID.test(s["name"]) || typeof s["template"] !== "string" || !SANDBOX_ID.test(s["template"]) || !isInt(s["vcpus"], 1) || !isInt(s["memMb"], 1) || !isInt(s["createdAt"], 0) || !isInt(s["keepLast"], 1) || s["keepLast"] > MAX_KEEP_LAST || !Array.isArray(s["snapshots"])) throw new Error("fx-sandboxd: the snapshot state file is not valid");
    return { name: s["name"], template: s["template"], vcpus: s["vcpus"], memMb: s["memMb"], createdAt: s["createdAt"], keepLast: s["keepLast"], snapshots: s["snapshots"].map(meta) };
  });
  return { version: 1, sandboxes, orphans: (raw["orphans"] as unknown[]).map(meta) };
}

export function saveStore(stateDir: string, uid: number, file: StoreFile): void {
  writeJsonAtomic(stateDir, STATE_FILE, file, uid, { maxBytes: STATE_MAX_BYTES });
}
