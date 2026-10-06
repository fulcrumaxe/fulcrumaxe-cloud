import { REVIEW_STATUS_CONTEXT_NAME } from "../build/mergeGate.js";
import type { GitHubHttp } from "../build/githubMergePort.js";
import { SHA_PATTERN } from "../build/mergeGate.js";
import { branchFor } from "../advance/build.js";
import { isSafeRef } from "./reviewPrompts.js";
import type { ChangedFile } from "./securityTrigger.js";

/**
 * D#483 P3: the stage driver's GitHub calls around a pull request, over the same injected `GitHubHttp` the merge gate's
 * port uses (the composition root owns the token and the transport). Every answer is structured fields only: a number, a
 * commit id, a branch name, file paths and patches. A PR title, body or comment is never read.
 *
 * Fail closed: a response of the wrong shape is `malformed`, an unexpected status is `github_unavailable`, and neither is
 * read as "no pull request" or as "nothing changed".
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

export interface OpenPullRequest {
  number: number;
  headSha: string;
  baseRef: string;
}

export type FindPullRequestResult = { ok: true; pr: OpenPullRequest } | { ok: false; reason: "no_open_pr" | "ambiguous_pr" | "github_unavailable" | "malformed" | "bad_base_ref" };

const repoPath = (owner: string, name: string): string => `/repos/${owner}/${name}`;

/** The open pull request whose head is the executor's branch for `issue` (`fx/issue-<n>`), in this repository. */
export async function findOpenPullRequest(http: GitHubHttp, repo: { owner: string; name: string; issue: number }): Promise<FindPullRequestResult> {
  const res = await http.request({
    method: "GET",
    path: `${repoPath(repo.owner, repo.name)}/pulls`,
    query: { state: "open", head: `${repo.owner}:${branchFor(repo.issue)}`, per_page: 5 },
  });
  if (res.status !== 200) return { ok: false, reason: "github_unavailable" };
  if (!Array.isArray(res.body)) return { ok: false, reason: "malformed" };
  const here = `${repo.owner}/${repo.name}`.toLowerCase();
  // Only a branch of this repository: the head repository must be the base repository.
  const mine = res.body.filter((p): p is Json => isObj(p) && isObj(p.head) && isObj(p.head.repo) && typeof p.head.repo.full_name === "string" && p.head.repo.full_name.toLowerCase() === here);
  if (mine.length === 0) return { ok: false, reason: res.body.length === 0 ? "no_open_pr" : "malformed" };
  if (mine.length > 1) return { ok: false, reason: "ambiguous_pr" };
  const pr = mine[0]!;
  const head = pr.head as Json;
  const base = pr.base;
  if (typeof pr.number !== "number" || !Number.isSafeInteger(pr.number) || pr.number <= 0) return { ok: false, reason: "malformed" };
  if (typeof head.sha !== "string" || !SHA_PATTERN.test(head.sha)) return { ok: false, reason: "malformed" };
  if (!isObj(base) || typeof base.ref !== "string") return { ok: false, reason: "malformed" };
  // The base branch is printed into a reviewer's shell command, so it must be a plain ref.
  if (!isSafeRef(base.ref)) return { ok: false, reason: "bad_base_ref" };
  return { ok: true, pr: { number: pr.number, headSha: head.sha, baseRef: base.ref } };
}

const FILES_PER_PAGE = 100;
/** GitHub lists at most 3000 files of a pull request. */
const FILES_MAX_PAGES = 30;

export type ListFilesResult = { ok: true; files: ChangedFile[]; truncated: boolean } | { ok: false; reason: "github_unavailable" | "malformed" };

/** The pull request's changed files (path, previous path, patch, change count), every page up to GitHub's cap. */
export async function listChangedFiles(http: GitHubHttp, repo: { owner: string; name: string; pr: number }): Promise<ListFilesResult> {
  const files: ChangedFile[] = [];
  for (let page = 1; page <= FILES_MAX_PAGES; page++) {
    const res = await http.request({ method: "GET", path: `${repoPath(repo.owner, repo.name)}/pulls/${repo.pr}/files`, query: { per_page: FILES_PER_PAGE, page } });
    if (res.status !== 200) return { ok: false, reason: "github_unavailable" };
    if (!Array.isArray(res.body)) return { ok: false, reason: "malformed" };
    for (const f of res.body) {
      if (!isObj(f) || typeof f.filename !== "string") return { ok: false, reason: "malformed" };
      files.push({
        path: f.filename,
        previousPath: typeof f.previous_filename === "string" ? f.previous_filename : null,
        patch: typeof f.patch === "string" ? f.patch : null,
        changes: typeof f.changes === "number" ? f.changes : undefined,
      });
    }
    if (res.body.length < FILES_PER_PAGE) return { ok: true, files, truncated: false };
  }
  // A full last page at the cap: there may be more files than GitHub will list.
  return { ok: true, files, truncated: true };
}

/** The context of the platform's own commit status (owner ruling B). */
export const REVIEW_STATUS_CONTEXT = REVIEW_STATUS_CONTEXT_NAME;
/** The status description when the reviews ran on the customer's own machine (D#6 C12 safeguard (d)). */
export const LOCAL_REVIEW_DESCRIPTION = "Local review: every required reviewer passed on this commit, on your machine";

export type PostStatusResult = { ok: true } | { ok: false; reason: "github_unavailable" };

/** Posts `fulcrumaxe/review` = success on a commit. The caller has already established that every required reviewer passed on that commit. */
export async function postReviewStatus(http: GitHubHttp, repo: { owner: string; name: string; sha: string; local?: boolean }): Promise<PostStatusResult> {
  if (!SHA_PATTERN.test(repo.sha)) throw new Error("postReviewStatus: malformed sha");
  const res = await http.request({
    method: "POST",
    path: `${repoPath(repo.owner, repo.name)}/statuses/${repo.sha}`,
    // D#6 C12 (d): the reviews of a runner_local repo ran on the customer's machine, and the status says so.
    body: { state: "success", context: REVIEW_STATUS_CONTEXT, description: repo.local === true ? LOCAL_REVIEW_DESCRIPTION : "Every required reviewer passed on this commit" },
  });
  return res.status === 201 ? { ok: true } : { ok: false, reason: "github_unavailable" };
}
