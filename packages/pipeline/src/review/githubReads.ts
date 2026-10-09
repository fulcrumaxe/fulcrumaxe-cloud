import { REVIEW_STATUS_CONTEXT_NAME } from "../build/mergeGate.js";
import type { GitHubHttp, LocalGitHubHttp } from "../build/githubMergePort.js";
import { SHA_PATTERN } from "../build/mergeGate.js";
import { isRunnerMode } from "@fx/runner";
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
  /** The pull request's head branch: `fx/issue-<n>` for a sandbox build, the run's recorded branch for a runner run. */
  branch: string;
}

export type FindPullRequestResult = { ok: true; pr: OpenPullRequest } | { ok: false; reason: "no_open_pr" | "ambiguous_pr" | "github_unavailable" | "malformed" | "bad_base_ref" };

const repoPath = (owner: string, name: string): string => `/repos/${owner}/${name}`;

const isHeadOf = (p: unknown, here: string): p is Json => isObj(p) && isObj(p.head) && isObj(p.head.repo) && typeof p.head.repo.full_name === "string" && p.head.repo.full_name.toLowerCase() === here;

/** Number, head commit and base branch of one pull request object, each checked; `branch` is the caller's, already established. */
function readPull(pr: Json, branch: string): FindPullRequestResult {
  const head = pr.head as Json;
  const base = pr.base;
  if (typeof pr.number !== "number" || !Number.isSafeInteger(pr.number) || pr.number <= 0) return { ok: false, reason: "malformed" };
  if (typeof head.sha !== "string" || !SHA_PATTERN.test(head.sha)) return { ok: false, reason: "malformed" };
  if (!isObj(base) || typeof base.ref !== "string") return { ok: false, reason: "malformed" };
  // The base branch is printed into a reviewer's shell command, so it must be a plain ref.
  if (!isSafeRef(base.ref)) return { ok: false, reason: "bad_base_ref" };
  return { ok: true, pr: { number: pr.number, headSha: head.sha, baseRef: base.ref, branch } };
}

/** The open pull request whose head is the executor's branch for `issue` (`fx/issue-<n>`), in this repository. The sandbox build's lookup. */
export async function findOpenPullRequest(http: GitHubHttp, repo: { owner: string; name: string; issue: number }): Promise<FindPullRequestResult> {
  const branch = branchFor(repo.issue);
  const res = await http.request({
    method: "GET",
    path: `${repoPath(repo.owner, repo.name)}/pulls`,
    query: { state: "open", head: `${repo.owner}:${branch}`, per_page: 5 },
  });
  if (res.status !== 200) return { ok: false, reason: "github_unavailable" };
  if (!Array.isArray(res.body)) return { ok: false, reason: "malformed" };
  const here = `${repo.owner}/${repo.name}`.toLowerCase();
  // Only a branch of this repository: the head repository must be the base repository.
  const mine = res.body.filter((p): p is Json => isHeadOf(p, here));
  if (mine.length === 0) return { ok: false, reason: res.body.length === 0 ? "no_open_pr" : "malformed" };
  if (mine.length > 1) return { ok: false, reason: "ambiguous_pr" };
  return readPull(mine[0]!, branch);
}

/**
 * D#6 C25 section 1.2: a runner run's pull request, found by the number and the branch its `done` recorded and never by the issue's
 * number (a runner run pushes `fx/<run>-g<generation>`, so `fx/issue-<n>` names nothing). Open and of this repository, and its head
 * branch must be the recorded one: a pull request whose head is some other branch is not the run's, and is `malformed`, not found.
 */
export async function findRecordedPullRequest(http: GitHubHttp, repo: { owner: string; name: string }, recorded: { number: number; branch: string }, options: { local?: boolean } = {}): Promise<FindPullRequestResult> {
  if (options.local === true) return findRecordedPullRequestLocal(http, repo, recorded);
  const res = await http.request({ method: "GET", path: `${repoPath(repo.owner, repo.name)}/pulls/${recorded.number}` });
  if (res.status === 404) return { ok: false, reason: "no_open_pr" };
  if (res.status !== 200) return { ok: false, reason: "github_unavailable" };
  const p = res.body;
  if (!isObj(p) || !isHeadOf(p, `${repo.owner}/${repo.name}`.toLowerCase())) return { ok: false, reason: "malformed" };
  if (p.number !== recorded.number || (p.head as Json).ref !== recorded.branch) return { ok: false, reason: "malformed" };
  if (p.state !== "open") return { ok: false, reason: "no_open_pr" };
  return readPull(p, recorded.branch);
}

/**
 * D#6 R3c: the same lookup for a `runner_local` repo, through the allowlist's list call (A3) only: the open pull requests whose head is
 * the recorded branch, then the recorded number among them. `GET pulls/{n}` is not on the allowlist. No match is `no_open_pr`, and a
 * list that holds pull requests but not this number is `malformed`, as the by-number lookup would have answered.
 */
async function findRecordedPullRequestLocal(http: GitHubHttp, repo: { owner: string; name: string }, recorded: { number: number; branch: string }): Promise<FindPullRequestResult> {
  const res = await http.request({ method: "GET", path: `${repoPath(repo.owner, repo.name)}/pulls`, query: { state: "open", head: `${repo.owner}:${recorded.branch}`, per_page: 5 } });
  if (res.status !== 200) return { ok: false, reason: "github_unavailable" };
  if (!Array.isArray(res.body)) return { ok: false, reason: "malformed" };
  if (res.body.length === 0) return { ok: false, reason: "no_open_pr" };
  const here = `${repo.owner}/${repo.name}`.toLowerCase();
  const mine = res.body.filter((p): p is Json => isHeadOf(p, here) && p.number === recorded.number && (p.head as Json).ref === recorded.branch);
  if (mine.length !== 1) return { ok: false, reason: "malformed" };
  if (mine[0]!.state !== "open") return { ok: false, reason: "no_open_pr" };
  return readPull(mine[0]!, recorded.branch);
}

/** Where an item's pull request comes from: `repos.execution_mode` and, for a runner repo, what its run's `done` recorded. */
export interface PullRequestSource {
  executionMode: string;
  recordedPr: { number: number; branch: string } | null;
}

/**
 * The one switch: a `runner_local` repo's pull request is the one its run recorded, and none recorded is `no_open_pr`, never a lookup
 * by the issue's branch. Every other repo is a sandbox build and keeps the lookup by `fx/issue-<n>`.
 */
export async function findPullRequestForItem(http: GitHubHttp, repo: { owner: string; name: string; issue: number } & PullRequestSource): Promise<FindPullRequestResult> {
  if (isRunnerMode(repo.executionMode)) {
    // D#6 R3c: a runner repo's lookup uses only the allowlist's list call (A3); the composition root hands it the fenced client.
    return repo.recordedPr === null ? { ok: false, reason: "no_open_pr" } : findRecordedPullRequest(http, repo, repo.recordedPr, { local: repo.executionMode === "runner_local" });
  }
  return findOpenPullRequest(http, repo);
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

/**
 * D#6 R3c: the changed files of a `runner_local` repo's pull request: PATHS and change types only (the `PullRequestFiles` document, A1).
 * GitHub gives no patch and our cloud never asks for one. Because no diff is seen, a file counts as "diff not shown" to the security
 * check (`changes: 1`, a stand-in for "some change, size unknown"), so `securityTriggers` fires and the security reviewer is always
 * required on such a repo. That is the fail-closed side. A list that is cut short (the cap, or fewer files than GitHub's total) is `truncated`.
 */
export async function listChangedFilesLocal(http: LocalGitHubHttp, repo: { owner: string; name: string; pr: number }): Promise<ListFilesResult> {
  const files: ChangedFile[] = [];
  let cursor: string | null = null;
  let total = 0;
  for (let page = 1; page <= FILES_MAX_PAGES; page++) {
    const res = await http.graphql("PullRequestFiles", { owner: repo.owner, name: repo.name, number: repo.pr, ...(cursor === null ? {} : { cursor }) });
    if (res.status !== 200) return { ok: false, reason: "github_unavailable" };
    // GraphQL reports an error with status 200 and an errors array: that is a failure, never an empty list.
    if (!isObj(res.body) || res.body.errors !== undefined) return { ok: false, reason: "github_unavailable" };
    const data = isObj(res.body.data) ? res.body.data : null;
    const repository = data !== null && isObj(data.repository) ? data.repository : null;
    const pull = repository !== null && isObj(repository.pullRequest) ? repository.pullRequest : null;
    const list = pull !== null && isObj(pull.files) ? pull.files : null;
    if (list === null || !Array.isArray(list.nodes) || !isObj(list.pageInfo) || typeof list.totalCount !== "number") return { ok: false, reason: "malformed" };
    total = list.totalCount;
    for (const f of list.nodes) {
      if (!isObj(f) || typeof f.path !== "string") return { ok: false, reason: "malformed" };
      files.push({ path: f.path, previousPath: null, patch: null, changes: 1 });
    }
    if (list.pageInfo.hasNextPage !== true) return { ok: true, files, truncated: files.length < total };
    if (typeof list.pageInfo.endCursor !== "string") return { ok: false, reason: "malformed" };
    cursor = list.pageInfo.endCursor;
  }
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
