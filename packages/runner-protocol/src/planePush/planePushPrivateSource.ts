import { posix } from "node:path";
import { git, gitWithStderr } from "./planePushGit.js";
import { hasNulInHead, type Refusal } from "./planePush.js";

/**
 * Content that comes from a private-only (overlay) path must not reach the public repo under a public name. The scan of the public commit
 * only sees the NEW side of each change, so this runs on the private objects, before anything is built:
 *
 *   - a rename or copy whose source or destination is an overlay path (the source is read from git's own rename and copy detection);
 *   - an added or changed public file whose content is byte-identical (same git object id) to a file at an overlay path, in the item's
 *     base tree or its head tree (a copy that keeps no history);
 *   - a symlink whose target resolves into an overlay path.
 *
 * Object ids are compared, never contents; a refusal names the public path and the overlay path only. Limit: content copied WITH edits is
 * not found by a path or object-id rule; the identifier and plan-data scans stay the guard for that.
 */

export interface PrivateSourceChange {
  /** The path as git reports it, one byte per char. */
  key: string;
  deleted: boolean;
  mode: string;
  sha: string;
}

/** Rename and copy detection limit passed to git explicitly (git's own default is 1000 and differs by version and config). */
export const RENAME_LIMIT = 4000;

const EMPTY_BLOB ="e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const utf8 = (key: string): string => Buffer.from(key, "latin1").toString("utf8");

const refusal = (publicPath: string, overlayPath: string, how: string): Refusal => ({
  kind: "overlay_path",
  path: publicPath,
  message: `${publicPath} ${how} the overlay (private) path ${overlayPath}`,
});

async function overlayBlobs(repoDir: string, rev: string, match: (p: string) => boolean, onlyPaths?: ReadonlySet<string>, allPaths?: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const buf = await git(repoDir, ["ls-tree", "-r", "-z", "--full-tree", rev]);
  for (const rec of buf.toString("latin1").split("\0")) {
    const m = /^(\d+) (\w+) ([0-9a-f]{40})\t([\s\S]*)$/.exec(rec);
    if (!m || m[2] !== "blob" || m[3] === EMPTY_BLOB) continue;
    const path = utf8(m[4] as string);
    if (match(path)) allPaths?.add(path);
    if (match(path) && (onlyPaths === undefined || onlyPaths.has(path)) && !out.has(m[3] as string)) out.set(m[3] as string, path);
  }
  return out;
}

/**
 * `exportMode` (ON-27c1): private paths are EXPECTED to change, so a file MOVED out of a private path (git's rename: the source is gone at head)
 * is not refused here; its new public path is scanned like any new file. What stays refused is content that is still at a private path at head
 * and also appears under a public name: a copy, a same-blob file, a symlink into a private path.
 */
export async function privateSourceRefusals(repoDir: string, changes: readonly PrivateSourceChange[], base: string, head: string, match: (p: string) => boolean, renameLimit: number = RENAME_LIMIT, exportMode = false, binaryGlobMatch?: (p: string) => boolean): Promise<Refusal[]> {
  const out: Refusal[] = [];

  // (a) either side of a rename or copy.
  // When the change set is too large git narrows its search, says so on stderr and still exits 0 (LC_ALL=C pins the wording), so a
  // cut-short detection is refused rather than read as "no copies found".
  const diff = await gitWithStderr(repoDir, ["diff", "--raw", "-z", "--no-abbrev", "-M", "-C", "--find-copies-harder", `-l${renameLimit}`, "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", base, head, "--"], undefined, { LC_ALL: "C", LANGUAGE: "C" });
  if (/too many files/i.test(diff.stderr)) {
    return [{ kind: "overlay_path", path: "(change set)", message: "rename and copy detection was cut short because the change set is too large, so content copied from an overlay (private) path cannot be ruled out" }];
  }
  const raw = diff.out.toString("latin1").split("\0");
  for (let n = 0; n < raw.length; ) {
    const m = /^:\d+ \d+ [0-9a-f]{40} ([0-9a-f]{40}) ([RC])\d*$/.exec(raw[n] ?? "");
    if (m) {
      const from = utf8(raw[n + 1] ?? "");
      const to = utf8(raw[n + 2] ?? "");
      // Export: a move between two private paths is dropped like any private change; a move out of a private path publishes only when the
      // destination will be scanned as text (not under the binary allow list, no NUL byte in its first 8 KB); a copy out of one is always refused.
      let expected = false;
      if (exportMode) {
        if (!match(from)) expected = true;
        else if (match(to)) expected = true;
        else if (m[2] === "R") expected = !(binaryGlobMatch?.(to) ?? false) && !hasNulInHead(await git(repoDir, ["cat-file", "blob", m[1] as string]));
      }
      if (!expected && m[1] !== EMPTY_BLOB && (match(from) || match(to))) out.push(refusal(to, match(from) ? from : to, m[2] === "R" ? "is renamed from or to" : "is copied from or to"));
      n += 3;
    } else n += 2;
  }

  // (b) the content of an overlay file under a public name.
  const live = changes.filter((c) => !c.deleted && c.mode !== "160000" && c.sha !== EMPTY_BLOB && !match(utf8(c.key)));
  if (live.length > 0) {
    // Export: a private file that is gone at head was moved, not copied, so only base blobs at paths that still hold a private file at head count.
    const headPaths = new Set<string>();
    const atHead = await overlayBlobs(repoDir, head, match, undefined, headPaths);
    const stillThere = exportMode ? headPaths : undefined;
    const known = await overlayBlobs(repoDir, base, match, stillThere);
    for (const [sha, path] of atHead) if (!known.has(sha)) known.set(sha, path);
    for (const c of live) {
      const from = known.get(c.sha);
      if (from !== undefined) out.push(refusal(utf8(c.key), from, "has the same content as"));
    }
  }

  // (c) a symlink pointing into an overlay path.
  for (const c of changes) {
    if (c.deleted || c.mode !== "120000") continue;
    const here = utf8(c.key);
    const target = utf8((await git(repoDir, ["cat-file", "blob", c.sha])).toString("latin1"));
    const resolved = posix.normalize(posix.join(posix.dirname(here), target));
    if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(target)) continue;
    if (match(resolved) || match(`${resolved.replace(/\/+$/, "")}/`)) out.push(refusal(here, resolved, "is a symlink into"));
  }
  return out;
}
