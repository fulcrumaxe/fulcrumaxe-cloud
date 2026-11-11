import { posix } from "node:path";
import { git } from "./planePushGit.js";
import type { Refusal } from "./planePush.js";

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

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const utf8 = (key: string): string => Buffer.from(key, "latin1").toString("utf8");

const refusal = (publicPath: string, overlayPath: string, how: string): Refusal => ({
  kind: "overlay_path",
  path: publicPath,
  message: `${publicPath} ${how} the overlay (private) path ${overlayPath}`,
});

async function overlayBlobs(repoDir: string, rev: string, match: (p: string) => boolean): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const buf = await git(repoDir, ["ls-tree", "-r", "-z", "--full-tree", rev]);
  for (const rec of buf.toString("latin1").split("\0")) {
    const m = /^(\d+) (\w+) ([0-9a-f]{40})\t([\s\S]*)$/.exec(rec);
    if (!m || m[2] !== "blob" || m[3] === EMPTY_BLOB) continue;
    const path = utf8(m[4] as string);
    if (match(path) && !out.has(m[3] as string)) out.set(m[3] as string, path);
  }
  return out;
}

export async function privateSourceRefusals(repoDir: string, changes: readonly PrivateSourceChange[], base: string, head: string, match: (p: string) => boolean): Promise<Refusal[]> {
  const out: Refusal[] = [];

  // (a) either side of a rename or copy.
  const raw = (await git(repoDir, ["diff", "--raw", "-z", "--no-abbrev", "-M", "-C", "--find-copies-harder", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", base, head, "--"])).toString("latin1").split("\0");
  for (let n = 0; n < raw.length; ) {
    const m = /^:\d+ \d+ [0-9a-f]{40} ([0-9a-f]{40}) ([RC])\d*$/.exec(raw[n] ?? "");
    if (m) {
      const from = utf8(raw[n + 1] ?? "");
      const to = utf8(raw[n + 2] ?? "");
      if (m[1] !== EMPTY_BLOB && (match(from) || match(to))) out.push(refusal(to, match(from) ? from : to, m[2] === "R" ? "is renamed from or to" : "is copied from or to"));
      n += 3;
    } else n += 2;
  }

  // (b) the content of an overlay file under a public name.
  const live = changes.filter((c) => !c.deleted && c.mode !== "160000" && c.sha !== EMPTY_BLOB && !match(utf8(c.key)));
  if (live.length > 0) {
    const known = await overlayBlobs(repoDir, base, match);
    for (const [sha, path] of await overlayBlobs(repoDir, head, match)) if (!known.has(sha)) known.set(sha, path);
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
