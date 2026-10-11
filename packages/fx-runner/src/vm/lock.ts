/**
 * The microVM image lock (D#587 B-1): `infra/microvm-image/lock.json`. The Dockerfile and the workflow read the download pins
 * from it with `jq`; this module reads only what the root-disk build itself needs, and refuses a lock it cannot trust.
 */
import { CliError } from "../cliError.js";

export const ARCHES = ["amd64", "arm64"] as const;
export type Arch = (typeof ARCHES)[number];
export const TEMPLATES = ["fx-agent"] as const;

export interface RootfsParams {
  /** Every file time in the root disk is this, so the same inputs give the same bytes. */
  sourceDateEpoch: number;
  fsUuid: string;
  hashSeed: string;
  label: string;
}

export interface VmLock {
  template: string;
  rootfs: RootfsParams;
  /** The `mke2fs` the pins were made with; the build reports the one it ran, and never takes an older one than 1.47.1. */
  e2fsprogsVersion: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bad = (what: string): never => {
  throw new CliError(`the image lock is not usable: ${what}`, 2);
};

export function parseLock(text: string): VmLock {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // fx-swallow-ok: replaced with a fixed sentence; the parser's message could echo file content
    return bad("it is not JSON");
  }
  const lock = doc as { schema?: unknown; template?: unknown; rootfs?: Record<string, unknown>; tools?: { e2fsprogs?: { version?: unknown } } };
  if (lock.schema !== 1) bad("schema must be 1");
  if (typeof lock.template !== "string" || !(TEMPLATES as readonly string[]).includes(lock.template)) bad("unknown template");
  const r = lock.rootfs ?? {};
  const epoch = r["source_date_epoch"];
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) bad("rootfs.source_date_epoch");
  if (typeof r["fs_uuid"] !== "string" || !UUID.test(r["fs_uuid"])) bad("rootfs.fs_uuid");
  if (typeof r["hash_seed"] !== "string" || !UUID.test(r["hash_seed"])) bad("rootfs.hash_seed");
  if (typeof r["label"] !== "string" || !/^[a-z]{1,16}$/.test(r["label"])) bad("rootfs.label");
  const version = lock.tools?.e2fsprogs?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) bad("tools.e2fsprogs.version");
  return {
    template: lock.template as string,
    rootfs: { sourceDateEpoch: epoch as number, fsUuid: r["fs_uuid"] as string, hashSeed: r["hash_seed"] as string, label: r["label"] as string },
    e2fsprogsVersion: version as string,
  };
}
