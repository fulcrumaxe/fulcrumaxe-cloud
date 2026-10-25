/**
 * Two planes: the ONE comparison of what a paired item's public commit changes against what the reviewers cleared.
 *
 * Both callers read git trees their own way and hand the result here: the cloud reads GitHub's REST tree endpoints (cloud runtime), and the local runner
 * reads `git ls-tree -r -z` of objects it fetched itself (a runner_local repository, where the cloud must not read contents). Everything that decides
 * "same" lives in this file, so the two cannot drift apart:
 *
 *  - a tree is a map from path to (mode, type, object id); directories are not entries; a malformed, repeated or unknown-mode entry makes the whole tree
 *    unusable (null), never partly used;
 *  - a change is a path with its base entry and its head entry, each (mode, type, id) or ABSENT, wherever the two differ. Keeping the base entry matters:
 *    the merge squashes the public pull request onto the default branch, so the same end content reached from another starting content is a different
 *    change;
 *  - the private side drops the paths the pairing keeps out of the public repository (`keep`), the public side drops nothing;
 *  - two change sets are the same when their sorted key lists are equal.
 *
 * Pure: no I/O, no clock. Imports nothing outside this package.
 */

/** The file modes git records for a leaf of a tree: regular, executable, symbolic link, submodule. */
const LEAF_MODES: ReadonlySet<string> = new Set(["100644", "100755", "120000", "160000"]);
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const TREE_ENTRY_ABSENT = "ABSENT";

export interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
}
export type TreeMap = ReadonlyMap<string, TreeEntry>;

export interface TreeChangeSet {
  /** Sorted, one per changed path: the path, the base entry and the head entry, so two sets compare by value. */
  keys: string[];
  /** The changed paths (kept ones only), in tree order. */
  paths: string[];
}

export const showTreeEntry = (e: TreeEntry | undefined): string => (e === undefined ? TREE_ENTRY_ABSENT : `${e.mode}:${e.type}:${e.sha}`);

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A tree from the entries a tree listing gives (GitHub's `tree` array, or any list of the same shape). Directory entries are skipped. Null when any
 * entry is not an object with string path, mode, type and sha, has a mode that is not a leaf mode, an id that is not a full object id, or repeats a path.
 *
 * An EMPTY listing is a tree here (a commit with no files): this reader accepts it where `treeFromLsTree` refuses empty output. The two are not interchangeable
 * on that one input; the runner's content check treats an unreadable base as "could not know", never as "no files".
 */
export function treeFromEntries(entries: readonly unknown[]): Map<string, TreeEntry> | null {
  const out = new Map<string, TreeEntry>();
  for (const e of entries) {
    if (!isObj(e) || typeof e.path !== "string" || typeof e.mode !== "string" || typeof e.type !== "string" || typeof e.sha !== "string") return null;
    if (e.type === "tree") continue;
    if (!LEAF_MODES.has(e.mode) || !OBJECT_ID.test(e.sha) || out.has(e.path)) return null;
    out.set(e.path, { mode: e.mode, type: e.type, sha: e.sha });
  }
  return out;
}

const LS_TREE_LINE = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)$/;

/**
 * A tree from the output of `git ls-tree -r -z <commit>`: records `<mode> <type> <id>\t<path>` ended by NUL. Null for anything else (so a truncated or
 * hand-made output cannot pass as a tree), including an empty tree: a commit with no files is not a usable base here.
 */
export function treeFromLsTree(output: string): Map<string, TreeEntry> | null {
  if (output === "" || !output.endsWith("\0")) return null;
  const entries: unknown[] = [];
  for (const record of output.slice(0, -1).split("\0")) {
    const m = LS_TREE_LINE.exec(record);
    if (m === null) return null;
    entries.push({ mode: m[1], type: m[2], sha: m[3], path: m[4] });
  }
  return treeFromEntries(entries);
}

/** The change set of `head` against `base`: every path whose entry differs and which `keep` accepts. */
export function diffTreeEntries(base: TreeMap, head: TreeMap, keep: (path: string) => boolean): TreeChangeSet {
  const keys: string[] = [];
  const paths: string[] = [];
  const consider = (path: string) => {
    const was = base.get(path);
    const now = head.get(path);
    if (showTreeEntry(was) === showTreeEntry(now) || !keep(path)) return;
    keys.push(`${path}\u0000${showTreeEntry(was)}\u0000${showTreeEntry(now)}`);
    paths.push(path);
  };
  for (const path of head.keys()) consider(path);
  for (const path of base.keys()) if (!head.has(path)) consider(path);
  return { keys: keys.sort(), paths };
}

/** Whether two change sets (their `keys`) are the same change. Both lists are sorted by `diffTreeEntries`. */
export function sameChangeKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
