import type { RepoPermission } from "@fx/trust";
import { GH_OWNER_LOGIN_RE } from "./eventMapper.js";
import { toPermission } from "./issueAuthorLookup.js";
import { PlanReadError, type PlanReadClient } from "./planReadClient.js";
import { DISCUSSIONS_PAGE_QUERY, DISCUSSION_COMMENTS_QUERY, REPO_HEAD_QUERY } from "./planQueries.js";

/**
 * D#483 S3: the readers the plan import is built from. Each takes a `PlanReadClient` (read-only by construction, see
 * planReadClient.ts) and one repository, and returns plain data. Nothing here decides what a task is or whether it is done.
 *
 *   readRepoHead        default branch, its head commit, whether Discussions are on (one GraphQL query)
 *   readRepoFile        a file at a commit, raw, capped (a missing file is null)
 *   listIssuesAndPulls  the issues list, paged by its Link header, split into issues and pull requests
 *   listDiscussions / listDiscussionComments   paged by pageInfo
 *
 * Untrusted text is bounded where it is read: a pull request's body is not kept, only its `D#` lines (the importer's
 * reference-line rule needs nothing else), and titles and bodies are cut to fixed lengths.
 */
export interface RepoHead {
  defaultBranch: string;
  sha: string;
  discussionsEnabled: boolean;
}

interface RepoRef {
  owner: string;
  name: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A GraphQL answer whose shape is not the one asked for is GitHub misbehaving, never an empty result. */
function unexpected(): never {
  throw new PlanReadError("github_unavailable");
}

export async function readRepoHead(client: PlanReadClient, repo: RepoRef): Promise<RepoHead> {
  const data = await client.graphqlDocument(REPO_HEAD_QUERY, { owner: repo.owner, name: repo.name });
  const r = isRecord(data) ? data.repository : undefined;
  if (r === null) throw new PlanReadError("app_permission_missing");
  if (!isRecord(r)) return unexpected();
  const ref = r.defaultBranchRef;
  if (!isRecord(ref) || typeof ref.name !== "string" || !isRecord(ref.target) || typeof ref.target.oid !== "string") return unexpected();
  if (!/^[0-9a-f]{40}$/.test(ref.target.oid)) return unexpected();
  return { defaultBranch: ref.name, sha: ref.target.oid, discussionsEnabled: r.hasDiscussionsEnabled === true };
}

/** The file's text, or null when it is not there. Over `maxBytes` throws `plan_file_too_large`. */
export async function readRepoFile(client: PlanReadClient, repo: RepoRef, path: string, ref: string, maxBytes: number): Promise<string | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await client.request({
    method: "GET",
    path: `/repos/${repo.owner}/${repo.name}/contents/${encoded}`,
    query: { ref },
    accept: "application/vnd.github.raw+json",
    maxBytes,
  });
  if (res.status === 404) return null;
  if (res.status !== 200) return unexpected();
  return res.text;
}

export interface PullSummary {
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  mergedAt: string | null;
  /** The body's lines that contain `D#`, in order (at most MAX_D_LINES, each cut to MAX_D_LINE_CHARS). */
  dLines: string[];
}

export interface IssueSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  authorLogin: string | null;
  authorAssociation: string | null;
  labels: string[];
}

export const MAX_D_LINES = 40;
export const MAX_D_LINE_CHARS = 2000;
export const MAX_TITLE_CHARS = 300;
export const ISSUES_PER_PAGE = 100;

function dLinesOf(body: unknown): string[] {
  if (typeof body !== "string") return [];
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes("D#")) continue;
    out.push(line.slice(0, MAX_D_LINE_CHARS));
    if (out.length >= MAX_D_LINES) break;
  }
  return out;
}

export interface IssuesAndPulls {
  issues: IssueSummary[];
  pulls: PullSummary[];
  /** True when the read stopped at a bound (pull requests, or the client's request budget) before the end of the list. */
  truncated: boolean;
  pagesRead: number;
}

/**
 * The repository's issues list, `state=all`, oldest first, followed through its `Link: rel="next"` header. The list holds pull
 * requests too; an item is a pull request exactly when it has a `pull_request` key, and that key's `merged_at` says merged.
 * `maxPulls` bounds the pull requests kept (default 6000); past it the read stops and says `truncated`. A request budget
 * that runs out mid-list is the same: the pages read so far are returned with `truncated: true`.
 */
export async function listIssuesAndPulls(client: PlanReadClient, repo: RepoRef, opts: { maxPulls?: number; maxIssues?: number } = {}): Promise<IssuesAndPulls> {
  const maxPulls = opts.maxPulls ?? 6000;
  const maxIssues = opts.maxIssues ?? 6000;
  const issues: IssueSummary[] = [];
  const pulls: PullSummary[] = [];
  let truncated = false;
  let pagesRead = 0;
  for (let page = 1; ; page += 1) {
    let res;
    try {
      res = await client.request({
        method: "GET",
        path: `/repos/${repo.owner}/${repo.name}/issues`,
        query: { state: "all", per_page: ISSUES_PER_PAGE, sort: "created", direction: "asc", page },
      });
    } catch (err) {
      if (err instanceof PlanReadError && err.code === "request_budget_exceeded") {
        truncated = true;
        break;
      }
      throw err;
    }
    if (res.status === 404) throw new PlanReadError("repo_not_connected");
    if (res.status !== 200) return unexpected();
    let list: unknown;
    try {
      list = JSON.parse(res.text);
    } catch {
      // fx-swallow-ok: a non-JSON listing is GitHub misbehaving
      return unexpected();
    }
    if (!Array.isArray(list)) return unexpected();
    pagesRead += 1;
    for (const item of list) {
      if (!isRecord(item) || typeof item.number !== "number" || !Number.isInteger(item.number)) return unexpected();
      const title = typeof item.title === "string" ? item.title.slice(0, MAX_TITLE_CHARS) : "";
      const pr = item.pull_request;
      if (isRecord(pr)) {
        if (pulls.length >= maxPulls) {
          truncated = true;
          continue;
        }
        const mergedAt = typeof pr.merged_at === "string" ? pr.merged_at : null;
        pulls.push({
          number: item.number,
          title,
          state: mergedAt ? "merged" : item.state === "open" ? "open" : "closed",
          mergedAt,
          dLines: dLinesOf(item.body),
        });
      } else {
        if (issues.length >= maxIssues) {
          truncated = true;
          continue;
        }
        const user = isRecord(item.user) ? item.user : null;
        issues.push({
          number: item.number,
          title,
          state: item.state === "open" ? "open" : "closed",
          authorLogin: user && typeof user.login === "string" ? user.login : null,
          authorAssociation: typeof item.author_association === "string" ? item.author_association : null,
          labels: Array.isArray(item.labels)
            ? item.labels.map((l) => (typeof l === "string" ? l : isRecord(l) && typeof l.name === "string" ? l.name : "")).filter((l) => l !== "").slice(0, 30)
            : [],
        });
      }
    }
    if (truncated && (pulls.length >= maxPulls || issues.length >= maxIssues)) break;
    if (!/rel="next"/.test(res.headers["link"] ?? "")) break;
  }
  return { issues, pulls, truncated, pagesRead };
}

export interface DiscussionSummary {
  number: number;
  title: string;
  body: string;
  closed: boolean;
  authorLogin: string | null;
}

export interface DiscussionComment {
  id: number;
  body: string;
  createdAt: string;
  authorLogin: string | null;
}

export const MAX_BODY_CHARS = 60_000;

export async function listDiscussions(client: PlanReadClient, repo: RepoRef, opts: { maxDiscussions?: number } = {}): Promise<{ discussions: DiscussionSummary[]; truncated: boolean }> {
  const max = opts.maxDiscussions ?? 600;
  const discussions: DiscussionSummary[] = [];
  let after: string | null = null;
  for (;;) {
    const data: unknown = await client.graphqlDocument(DISCUSSIONS_PAGE_QUERY, { owner: repo.owner, name: repo.name, first: 100, after });
    const r = isRecord(data) ? data.repository : undefined;
    if (r === null) throw new PlanReadError("app_permission_missing");
    if (!isRecord(r)) return unexpected();
    if (r.hasDiscussionsEnabled !== true) throw new PlanReadError("discussions_disabled");
    const conn = r.discussions;
    if (!isRecord(conn) || !Array.isArray(conn.nodes) || !isRecord(conn.pageInfo)) return unexpected();
    for (const n of conn.nodes) {
      if (!isRecord(n) || typeof n.number !== "number") return unexpected();
      if (discussions.length >= max) return { discussions, truncated: true };
      const author = isRecord(n.author) ? n.author : null;
      discussions.push({
        number: n.number,
        title: typeof n.title === "string" ? n.title.slice(0, MAX_TITLE_CHARS) : "",
        body: typeof n.body === "string" ? n.body.slice(0, MAX_BODY_CHARS) : "",
        closed: n.closed === true,
        authorLogin: author && typeof author.login === "string" ? author.login : null,
      });
    }
    if (conn.pageInfo.hasNextPage !== true) return { discussions, truncated: false };
    if (typeof conn.pageInfo.endCursor !== "string") return unexpected();
    after = conn.pageInfo.endCursor;
  }
}

export async function listDiscussionComments(client: PlanReadClient, repo: RepoRef, number: number, opts: { maxComments?: number } = {}): Promise<{ comments: DiscussionComment[]; truncated: boolean }> {
  const max = opts.maxComments ?? 300;
  const comments: DiscussionComment[] = [];
  let after: string | null = null;
  for (;;) {
    const data: unknown = await client.graphqlDocument(DISCUSSION_COMMENTS_QUERY, { owner: repo.owner, name: repo.name, number, first: 100, after });
    const r = isRecord(data) ? data.repository : undefined;
    if (r === null) throw new PlanReadError("app_permission_missing");
    if (!isRecord(r)) return unexpected();
    const d = r.discussion;
    if (d === null) return { comments, truncated: false };
    if (!isRecord(d) || !isRecord(d.comments)) return unexpected();
    const conn = d.comments;
    if (!Array.isArray(conn.nodes) || !isRecord(conn.pageInfo)) return unexpected();
    for (const n of conn.nodes) {
      if (!isRecord(n) || typeof n.databaseId !== "number") return unexpected();
      if (comments.length >= max) return { comments, truncated: true };
      const author = isRecord(n.author) ? n.author : null;
      comments.push({
        id: n.databaseId,
        body: typeof n.body === "string" ? n.body.slice(0, MAX_BODY_CHARS) : "",
        createdAt: typeof n.createdAt === "string" ? n.createdAt : "",
        authorLogin: author && typeof author.login === "string" ? author.login : null,
      });
    }
    if (conn.pageInfo.hasNextPage !== true) return { comments, truncated: false };
    if (typeof conn.pageInfo.endCursor !== "string") return unexpected();
    after = conn.pageInfo.endCursor;
  }
}

/**
 * A login's permission on the repository, from the platform's own permission API. A login it does not know is a 404 and reads
 * as `none`. Any other answer that is not a clear one is `github_unavailable`: a failed lookup never reads as trusted (the
 * import fails instead of silently applying or dropping a Correction).
 */
export async function readAuthorPermission(client: PlanReadClient, repo: RepoRef, login: string): Promise<RepoPermission> {
  if (!GH_OWNER_LOGIN_RE.test(login)) return "none";
  const res = await client.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/collaborators/${encodeURIComponent(login)}/permission` });
  if (res.status === 404) return "none";
  if (res.status !== 200) return unexpected();
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    // fx-swallow-ok: a non-JSON permission answer is the other side misbehaving
    return unexpected();
  }
  return isRecord(body) ? toPermission(body) : unexpected();
}
