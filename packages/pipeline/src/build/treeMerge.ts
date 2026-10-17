import type { GitHubHttp } from "./githubMergePort.js";

/**
 * D#519 MQ3-a: the tree check for a platform refresh. The new head's tree must be EXACTLY the clean three-way merge of the reviewed
 * head and the default-branch commit it merged in, over their unique merge base, path by path. A head with the right parents and an
 * altered tree (an injected file, a reverted PR change) is not that merge, so nothing carries onto it.
 *
 * COPY, NOT SHARED YET. `readTreeEntries`, `isCleanMerge` and `isUniqueBase` are the same functions, with the same signatures and
 * behaviour, as the ones in `review/mergeOnly.ts` on the open PR for D#598 P7c (branch `merge-only-recheck`), which this change
 * does not edit. Once both are merged they should be consolidated into one module (this file is the natural home: it has no
 * dependency on either feature). Until then a fix to one belongs in the other.
 *
 * Fail closed: a truncated recursive tree, a merge base that is not the unique best one, or any read that does not answer 200 with the
 * expected shape is "not verified", never "verified".
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const SHA1 = /^[0-9a-f]{40}$/;

/** A tree entry as `mode type sha`: a change of mode, of kind (file, symlink, submodule) or of content shows up as a different string. */
export type TreeEntries = ReadonlyMap<string, string>;
export type TreeReading = { ok: true; entries: TreeEntries } | { ok: false };

const repoPath = (owner: string, name: string): string => `/repos/${owner}/${name}`;

/** The commit's tree id, or null when the commit cannot be read. */
async function readTreeId(http: GitHubHttp, repo: { owner: string; name: string }, commit: string): Promise<string | null> {
  const res = await http.request({ method: "GET", path: `${repoPath(repo.owner, repo.name)}/git/commits/${commit}` });
  const tree = res.status === 200 && isObj(res.body) ? res.body.tree : undefined;
  return isObj(tree) && typeof tree.sha === "string" && SHA1.test(tree.sha) ? tree.sha : null;
}

/** Every file, symlink and submodule entry (directories are implied by their contents) of one commit's tree. A truncated list is unreadable. */
export async function readTreeEntries(http: GitHubHttp, repo: { owner: string; name: string }, commit: string): Promise<TreeReading> {
  if (!SHA1.test(commit)) return { ok: false };
  const treeId = await readTreeId(http, repo, commit);
  if (treeId === null) return { ok: false };
  const res = await http.request({ method: "GET", path: `${repoPath(repo.owner, repo.name)}/git/trees/${treeId}`, query: { recursive: 1 } });
  if (res.status !== 200 || !isObj(res.body) || res.body.truncated !== false || !Array.isArray(res.body.tree)) return { ok: false };
  const entries = new Map<string, string>();
  for (const e of res.body.tree) {
    if (!isObj(e) || typeof e.path !== "string" || typeof e.mode !== "string" || typeof e.type !== "string" || typeof e.sha !== "string") return { ok: false };
    if (e.type !== "tree") entries.set(e.path, `${e.mode} ${e.type} ${e.sha}`);
  }
  return { ok: true, entries };
}

/**
 * Whether `head` is the clean three-way merge of `from` (the reviewed head) and `other` (the second parent) over `base`, path by path.
 * Where the base side did not change a path the reviewed head's entry stands; where the pull request did not change it the second
 * parent's does; where both changed it the result must equal what they both made. Anything else is not the clean merge.
 */
export function isCleanMerge(base: TreeEntries, from: TreeEntries, other: TreeEntries, head: TreeEntries): boolean {
  const paths = new Set([...base.keys(), ...from.keys(), ...other.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const f = from.get(path);
    const o = other.get(path);
    const h = head.get(path);
    if (f === o) {
      if (h !== f) return false;
    } else if (f === b) {
      if (h !== o) return false;
    } else if (o === b) {
      if (h !== f) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Whether the merge base GitHub named for `from...other` is the one best merge base of the two. With a criss-cross history there are
 * two, GitHub returns just one, and the three-way test over the wrong one is not stricter. `aheadFromBase` is `ahead_by` of
 * `compare/{baseCommit}...{other}`, `aheadFromReviewed` is `ahead_by` of `compare/{from}...{other}`; they are equal exactly when the
 * merge base is the unique best one. A missing or malformed count is not unique.
 */
export function isUniqueBase(aheadFromBase: unknown, aheadFromReviewed: unknown): boolean {
  return typeof aheadFromBase === "number" && Number.isInteger(aheadFromBase) && aheadFromBase >= 0 && aheadFromBase === aheadFromReviewed;
}

export type CleanMergeReading = { clean: true } | { clean: false; reason: "unreadable" | "ambiguous_merge_base" | "tree_differs" };

/**
 * Reads the merge base of `from` and `other`, requires it to be the unique best one, reads the four trees and compares. The caller has
 * already placed `other` on the default branch and checked the parents; this is only the tree.
 */
export async function readCleanMerge(http: GitHubHttp, repo: { owner: string; name: string; from: string; other: string; head: string }): Promise<CleanMergeReading> {
  if (!SHA1.test(repo.from) || !SHA1.test(repo.other) || !SHA1.test(repo.head)) return { clean: false, reason: "unreadable" };
  const mb = await http.request({ method: "GET", path: `${repoPath(repo.owner, repo.name)}/compare/${repo.from}...${repo.other}`, query: { per_page: 1 } });
  const baseCommit = mb.status === 200 && isObj(mb.body) && isObj(mb.body.merge_base_commit) ? mb.body.merge_base_commit.sha : undefined;
  if (typeof baseCommit !== "string" || !SHA1.test(baseCommit) || !isObj(mb.body)) return { clean: false, reason: "unreadable" };
  const fromBase = await http.request({ method: "GET", path: `${repoPath(repo.owner, repo.name)}/compare/${baseCommit}...${repo.other}`, query: { per_page: 1 } });
  if (fromBase.status !== 200 || !isObj(fromBase.body)) return { clean: false, reason: "unreadable" };
  if (!isUniqueBase(fromBase.body.ahead_by, mb.body.ahead_by)) return { clean: false, reason: "ambiguous_merge_base" };
  const ids = { owner: repo.owner, name: repo.name };
  const [base, from, other, head] = await Promise.all([baseCommit, repo.from, repo.other, repo.head].map((c) => readTreeEntries(http, ids, c)));
  if (!base!.ok || !from!.ok || !other!.ok || !head!.ok) return { clean: false, reason: "unreadable" };
  return isCleanMerge(base!.entries, from!.entries, other!.entries, head!.entries) ? { clean: true } : { clean: false, reason: "tree_differs" };
}
