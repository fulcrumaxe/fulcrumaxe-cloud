/**
 * The engine's version, from one of two places below the configured repository root. The engine's own source repo has `engine/manifest.json`; a project with the engine
 * installed has no `engine/` directory and records the version in `.autonomous-team/engine-install.json` instead. The manifest is read first. Only when it is absent
 * (no `engine/` directory, or no manifest in it) is the install record read; an `engine/` that is unsafe, or a manifest that is unsafe or has no usable version, is refused
 * with no fallback. Either file is read with no link followed (its directory is judged by `lstat`, the file by the handle it was opened with) and refused when it is
 * another user's, open to others, or over 64 KiB. The version must be a dotted number (`ENGINE_VERSION_PATTERN`): anything else is no version, and the repo's bridge does
 * not start.
 */
import { closeSync, lstatSync, readSync } from "node:fs";
import path from "node:path";
import { ENGINE_VERSION_PATTERN } from "@fulcrumaxe/runner-protocol";
import { openPlain } from "./cursor.js";

const MANIFEST_MAX_BYTES = 64 * 1024;

export type VersionRefusal = "no_manifest" | "unsafe_manifest" | "bad_version";

type VersionAnswer = { ok: true; version: string } | { ok: false; why: VersionRefusal };

/** The version, or the closed word for why there is none. Nothing the file holds is returned or put in a message except a version that passed the pattern. */
export function readEngineVersion(repoRoot: string, uid: number | undefined): VersionAnswer {
  if (!path.isAbsolute(repoRoot)) return { ok: false, why: "unsafe_manifest" };
  const manifest = readVersionFile(repoRoot, "engine", "manifest.json", uid);
  if (manifest.ok || manifest.why !== "no_manifest") return manifest;
  return readVersionFile(repoRoot, ".autonomous-team", "engine-install.json", uid);
}

/** One candidate file `<root>/<dirName>/<fileName>`: `no_manifest` when the directory or the file is not there, a closed refusal for anything unsafe or unusable. */
function readVersionFile(repoRoot: string, dirName: string, fileName: string, uid: number | undefined): VersionAnswer {
  let dir: ReturnType<typeof lstatSync>;
  try {
    dir = lstatSync(path.join(repoRoot, dirName), { throwIfNoEntry: false });
  } catch {
    // fx-swallow-ok: a repo root that is a file (ENOTDIR) or cannot be searched (EACCES) is one closed refusal for this repo, never a throw into the others' pass; the error names a path
    return { ok: false, why: "unsafe_manifest" };
  }
  if (dir === undefined) return { ok: false, why: "no_manifest" };
  if (dir.isSymbolicLink() || !dir.isDirectory() || (uid !== undefined && dir.uid !== uid)) return { ok: false, why: "unsafe_manifest" };
  let opened: ReturnType<typeof openPlain>;
  try {
    opened = openPlain(path.join(repoRoot, dirName, fileName), 0o022, undefined, uid);
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
    // The engine's generators write `engine_version`; `version` is the name the plan used for it.
    const version = parsed !== null && typeof parsed === "object" ? (parsed.engine_version ?? parsed.version) : undefined;
    return typeof version === "string" && ENGINE_VERSION_PATTERN.test(version) ? { ok: true, version } : { ok: false, why: "bad_version" };
  } catch {
    // fx-swallow-ok: a file that is not JSON is "no usable version"; the parser's words could quote the file
    return { ok: false, why: "bad_version" };
  } finally {
    closeSync(opened.fd);
  }
}
