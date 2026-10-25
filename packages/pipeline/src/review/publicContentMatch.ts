import { compileOverlay, diffTreeEntries, sameChangeKeys, treeFromEntries, type TreeEntry } from "@fulcrumaxe/runner-protocol/planePush";
import type { GitHubHttp } from "../build/githubMergePort.js";
import { SHA_PATTERN } from "../build/mergeGate.js";
import { isSafeRef } from "./reviewPrompts.js";
import type { ChangedFile } from "./securityTrigger.js";

/**
 * Two planes: does the public pull request hold exactly what the reviewers cleared?
 *
 * A paired item's reviewers judge the private run branch; the pull request that merges is a different commit on the code repository. The push record
 * says which private head it was built from, but a record is not content. This compares the CONTENT of the two commits, and reads nothing that follows a
 * branch's live head (not the pull request's file list, not its base name):
 *
 *  - Each pull request's base must be its repository's DEFAULT branch (the repository's own setting, read here, not the pull request's say-so), so the
 *    pull request cannot be retargeted at an older branch and back between reads.
 *  - Each side's change set is computed at an explicit commit: its git tree against the tree of its merge base with the default branch (the merge base taken
 *    from a compare of the explicit head sha). A change is a path with its base entry and its head entry, each (mode, type, blob sha) or ABSENT, wherever
 *    the two differ. Keeping the base entry matters: the merge squashes the public pull request onto main, so the same end content reached from another
 *    starting content is a different change and would silently drop what main did in between.
 *  - The public head must be a single commit on its merge base (exactly one parent, and that parent is the merge base).
 *  - The private side drops the paths the pairing keeps out of the public repository (the pairing's own list, compiled by `compileOverlay`, the matcher
 *    the publish path uses). The public side drops nothing, so an overlay path, an extra file, a changed blob or mode, or a missing file does not match.
 *
 * The files the security check reads are the PUBLIC change set above (paths from the tree diff; patches from a compare of the explicit merge base and head,
 * keyed by path). Anything incomplete is "no match" AND an incomplete file list, which fires the security trigger.
 *
 * Fail closed throughout: a truncated tree, a failed read, a missing merge base, a malformed entry, an unusable overlay list or an unsafe ref is no match.
 * Each tree is read once per call. Nothing here throws for a refusal.
 */
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

type Repo = { owner: string; name: string };

async function defaultBranchOf(http: GitHubHttp, repo: Repo): Promise<string | null> {
  const res = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}` });
  if (res.status !== 200 || !isObj(res.body) || typeof res.body.default_branch !== "string") return null;
  return isSafeRef(res.body.default_branch) ? res.body.default_branch : null;
}

async function readTree(http: GitHubHttp, repo: Repo, commit: string): Promise<Map<string, TreeEntry> | null> {
  const res = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/git/trees/${commit}`, query: { recursive: "1" } });
  if (res.status !== 200 || !isObj(res.body) || res.body.truncated !== false || !Array.isArray(res.body.tree)) return null;
  return treeFromEntries(res.body.tree);
}

const refPath = (ref: string): string => ref.split("/").map(encodeURIComponent).join("/");

async function mergeBaseOf(http: GitHubHttp, repo: Repo, defaultBranch: string, head: string): Promise<string | null> {
  const res = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/compare/${refPath(defaultBranch)}...${head}`, query: { per_page: 1 } });
  if (res.status !== 200 || !isObj(res.body) || !isObj(res.body.merge_base_commit)) return null;
  const sha = res.body.merge_base_commit.sha;
  return typeof sha === "string" && SHA_PATTERN.test(sha) ? sha : null;
}

async function hasSingleParent(http: GitHubHttp, repo: Repo, head: string, parent: string): Promise<boolean> {
  const res = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/commits/${head}` });
  if (res.status !== 200 || !isObj(res.body) || !Array.isArray(res.body.parents) || res.body.parents.length !== 1) return false;
  const p = res.body.parents[0];
  return isObj(p) && p.sha === parent;
}

interface ChangeSet {
  keys: string[];
  paths: string[];
  mergeBase: string;
}

/** The change set of `head` against its merge base with the default branch; null when it cannot be known exactly. */
async function changeSet(http: GitHubHttp, repo: Repo, prBaseRef: string, head: string, keep: (path: string) => boolean, requireSingleParent: boolean): Promise<ChangeSet | null> {
  if (!SHA_PATTERN.test(head) || !isSafeRef(prBaseRef)) return null;
  const defaultBranch = await defaultBranchOf(http, repo);
  if (defaultBranch === null || defaultBranch !== prBaseRef) return null;
  const base = await mergeBaseOf(http, repo, defaultBranch, head);
  if (base === null) return null;
  if (requireSingleParent && !(await hasSingleParent(http, repo, head, base))) return null;
  const headTree = await readTree(http, repo, head);
  if (headTree === null) return null;
  const baseTree = await readTree(http, repo, base);
  if (baseTree === null) return null;
  const diff = diffTreeEntries(baseTree, headTree, keep);
  return { keys: diff.keys, paths: diff.paths, mergeBase: base };
}

/** GitHub lists at most this many files in a compare and does not page them (its paging is of commits). A list this long may be cut short. */
const COMPARE_FILES_CAP = 300;

/** The patches of `mergeBase...head` (explicit commits), by path; null when the list may be incomplete. One read. */
async function comparePatches(http: GitHubHttp, repo: Repo, mergeBase: string, head: string): Promise<Map<string, { patch: string | null; changes: number | undefined }> | null> {
  const out = new Map<string, { patch: string | null; changes: number | undefined }>();
  const res = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/compare/${mergeBase}...${head}` });
  if (res.status !== 200 || !isObj(res.body) || !Array.isArray(res.body.files) || res.body.files.length >= COMPARE_FILES_CAP) return null;
  for (const f of res.body.files) {
    if (!isObj(f) || typeof f.filename !== "string") return null;
    // A file with no patch and no count of changed lines is a change of unknown size, never of size zero.
    out.set(f.filename, { patch: typeof f.patch === "string" ? f.patch : null, changes: typeof f.changes === "number" ? f.changes : 1 });
  }
  return out;
}

export interface ContentMatchInput {
  privateHttp: GitHubHttp;
  privateRepo: Repo;
  /** The private pull request's base branch name as it reads now; it must be the repository's default branch. */
  privateBaseRef: string;
  /** The reviewed private head: an explicit commit. */
  reviewedHead: string;
  publicHttp: GitHubHttp;
  publicRepo: Repo;
  publicBaseRef: string;
  /** The public head the gate has bound and will merge: an explicit commit. */
  publicHead: string;
  /** The pairing's overlay list (`repo_pairing.overlay_globs`). */
  overlayGlobs: readonly string[];
}

export interface ContentCheck {
  /** The public change set equals the reviewed one, on the conditions above. */
  same: boolean;
  /** The public change set as the security check reads it. */
  files: ChangedFile[];
  /** The file list (or anything it rests on) is incomplete: the caller fires the security trigger. */
  incomplete: boolean;
}

const NOT_KNOWN: ContentCheck = { same: false, files: [], incomplete: true };

export async function checkPublicContent(input: ContentMatchInput): Promise<ContentCheck> {
  const overlay = compileOverlay(input.overlayGlobs);
  if ("error" in overlay) return NOT_KNOWN;
  const pub = await changeSet(input.publicHttp, input.publicRepo, input.publicBaseRef, input.publicHead, () => true, true);
  if (pub === null) return NOT_KNOWN;
  const patches = await comparePatches(input.publicHttp, input.publicRepo, pub.mergeBase, input.publicHead);
  // A path of the tree diff the compare did not list has no patch: it cannot be judged, so the check reads it as "some change, size unknown".
  const files: ChangedFile[] = pub.paths.map((path) => {
    const p = patches?.get(path);
    return { path, previousPath: null, patch: p?.patch ?? null, changes: p === undefined ? 1 : p.changes };
  });
  if (patches === null) return { same: false, files, incomplete: true };
  const priv = await changeSet(input.privateHttp, input.privateRepo, input.privateBaseRef, input.reviewedHead, (p) => !overlay.match(p), false);
  if (priv === null) return { same: false, files, incomplete: false };
  const same = sameChangeKeys(priv.keys, pub.keys);
  return { same, files, incomplete: false };
}
