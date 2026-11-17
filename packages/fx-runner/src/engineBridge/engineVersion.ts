/**
 * The engine's version, as its own `engine/manifest.json` says: the file is read below the configured repository root, with no link followed (the `engine`
 * directory is judged by `lstat`, the file by the handle it was opened with) and refused when it is another user's, open to others, or over 64 KiB.
 * The version must be a dotted number (`ENGINE_VERSION_PATTERN`): anything else is no version, and the repo's bridge does not start.
 */
import { closeSync, lstatSync, readSync } from "node:fs";
import path from "node:path";
import { ENGINE_VERSION_PATTERN } from "@fulcrumaxe/runner-protocol";
import { openPlain } from "./cursor.js";

const MANIFEST_MAX_BYTES = 64 * 1024;

export type VersionRefusal = "no_manifest" | "unsafe_manifest" | "bad_version";

/** The version, or the closed word for why there is none. Nothing the file holds is returned or put in a message except a version that passed the pattern. */
export function readEngineVersion(repoRoot: string, uid: number | undefined): { ok: true; version: string } | { ok: false; why: VersionRefusal } {
  if (!path.isAbsolute(repoRoot)) return { ok: false, why: "unsafe_manifest" };
  let dir: ReturnType<typeof lstatSync>;
  try {
    dir = lstatSync(path.join(repoRoot, "engine"), { throwIfNoEntry: false });
  } catch {
    // fx-swallow-ok: a repo root that is a file (ENOTDIR) or cannot be searched (EACCES) is one closed refusal for this repo, never a throw into the others' pass; the error names a path
    return { ok: false, why: "unsafe_manifest" };
  }
  if (dir === undefined) return { ok: false, why: "no_manifest" };
  if (dir.isSymbolicLink() || !dir.isDirectory() || (uid !== undefined && dir.uid !== uid)) return { ok: false, why: "unsafe_manifest" };
  let opened: ReturnType<typeof openPlain>;
  try {
    opened = openPlain(path.join(repoRoot, "engine", "manifest.json"), 0o022, undefined, uid);
  } catch {
    // fx-swallow-ok: a link, a foreign or writable-by-others file is one closed refusal; the error names a path
    return { ok: false, why: "unsafe_manifest" };
  }
  if (opened === null) return { ok: false, why: "no_manifest" };
  try {
    if (opened.stat.size > MANIFEST_MAX_BYTES) return { ok: false, why: "unsafe_manifest" };
    const buf = Buffer.alloc(opened.stat.size);
    readSync(opened.fd, buf, 0, buf.length, 0);
    const parsed = JSON.parse(buf.toString("utf8")) as { engine_version?: unknown; version?: unknown } | null;
    // The engine's generator writes `engine_version`; `version` is the name the plan used for it.
    const version = parsed !== null && typeof parsed === "object" ? (parsed.engine_version ?? parsed.version) : undefined;
    return typeof version === "string" && ENGINE_VERSION_PATTERN.test(version) ? { ok: true, version } : { ok: false, why: "bad_version" };
  } catch {
    // fx-swallow-ok: a manifest that is not JSON is "no usable version"; the parser's words could quote the file
    return { ok: false, why: "bad_version" };
  } finally {
    closeSync(opened.fd);
  }
}
