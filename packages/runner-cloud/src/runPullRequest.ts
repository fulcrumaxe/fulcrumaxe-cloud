import { COPY } from "@fulcrumaxe/runner-protocol";
import type { TenantQueryable } from "./acceptanceScope.js";
import { LocalOnlyGithubError, localOnlyGithub, type GithubClient, type GithubGraphqlOperation, type GithubResponse, type LocalOnlyGithub } from "./localOnlyGithub.js";

/**
 * D#6 R2b-3e (C21 section 5, C22 section 6): the GitHub port the `done` route will use for a `runner_local` repo. There is no
 * route here. The port is the only thing that talks to GitHub about such a repo, and it does so only through `localOnlyGithub`,
 * which it applies itself to whatever client `open` returns, so a caller cannot hand it an unfenced one. Its calls are exactly the
 * allowlist's A1 to A5:
 *
 *   defaultBranch  A2  the repository's default branch, read at `done` (it is the pull request's base)
 *   branchState    A1  RunBranchState: does the run branch exist, its head oid, how far ahead of the base, the default branch
 *   openDraft      A3, A4  find the open pull request for the branch (on the run's base) and reuse it, or open a DRAFT one; where
 *                          the repository cannot have drafts, ONE retry as a ready pull request (C23 section 4)
 *   changedFiles   A1  PullRequestFiles: paths and change types only, every page, with the total
 *   markReady      A1  MarkReady
 *   close          A5  close the pull request (a scope violation)
 *
 * The order is the draft-first rule: GitHub's GraphQL gives the changed paths without patches only for a pull request, so the
 * pull request has to exist before its files can be read, and it must not be reviewable until they have been checked. So the only
 * way this port opens a pull request is as a draft, and the only way it makes one ready is `markReady`. The one exception is a
 * repository that cannot have drafts (GitHub Free, private): GitHub answers the draft with a 422 that says so, and the port then
 * retries once with `draft: false` and a fixed line in the body (`READY_FALLBACK_LINE`). That pull request is already ready, so its
 * ref says `draft: false` and `markReady` does nothing for it; the scope check still runs before the run can succeed, and a
 * violation still closes it. Any other 422, and a 422 on the retry, is `rejected`.
 * The caller reads `changedFiles`, holds them to the scope, and only then calls `markReady`.
 *
 * Failures: a transport error, a 5xx, a 429 and a rate-limit 403 are `unavailable` (retry later; the `done` route answers 503 and
 * writes nothing). Any other non-success status, a GraphQL error and a body of the wrong shape are `rejected` or `malformed`. No
 * error message holds a path, a name or a response body. Opening the client has two kinds of failure: no installation, or an App that
 * cannot write (a read-only one), is permanent and `rejected`; a token mint that failed or timed out, or a transport error, is `unavailable`. A `LocalOnlyGithubError` is a bug in this file, not a GitHub failure, and
 * is rethrown unchanged.
 */

export interface PullRequestRepo {
  /** From our own `repos` row (never from the job or the runner). `id` is what `open` uses to find the repository's installation. */
  id: string;
  owner: string;
  name: string;
}

export type RunPullRequestFailure = "unavailable" | "rejected" | "malformed";
export class RunPullRequestError extends Error {
  constructor(readonly reason: RunPullRequestFailure) {
    super(`run pull request: ${reason}`);
    this.name = "RunPullRequestError";
  }
  get retryable(): boolean {
    return this.reason === "unavailable";
  }
}

export interface BranchState {
  /** Whether the run branch exists on GitHub. */
  exists: boolean;
  headOid: string | null;
  /** How many commits the branch is ahead of the base; null when the branch is missing or the base could not be compared. A caller must read null as "no commit". */
  aheadBy: number | null;
  defaultBranch: string | null;
}
export interface PullRequestRef {
  number: number;
  /** The GraphQL node id `markReady` needs. */
  nodeId: string;
  /** False when the pull request was already ready (a repeat `done` after `markReady`, or a person marked it). */
  draft: boolean;
  /** True when an open pull request for the branch already existed and was reused. */
  reused: boolean;
}
/** The change types GitHub documents. The port does not classify: `changeType` is passed through exactly as GitHub gave it, an unknown value included (the rename rule is the `done` route's). */
export const CHANGE_TYPES = ["ADDED", "DELETED", "RENAMED", "COPIED", "MODIFIED", "CHANGED"] as const;
export interface ChangedFiles {
  /** `path` is the file's path after the change; GraphQL does not give a renamed file's old path. `changeType` is GitHub's string, verbatim. */
  files: Array<{ path: string; changeType: string }>;
  totalCount: number;
  /** True only when every page was read and the files read are exactly `totalCount`. Anything else must be treated as a scope violation. */
  complete: boolean;
}
/** The one line a ready fallback adds to the pull request body (C23 section 4). */
export const READY_FALLBACK_LINE = "Opened as ready because this repository does not support draft pull requests.";
export interface RunPullRequestText {
  runId: string;
  workItemId: string;
  workItemTitle: string | null;
}

export interface RunPullRequestPort {
  defaultBranch(repo: PullRequestRepo): Promise<string>;
  branchState(input: { repo: PullRequestRepo; branch: string; base: string }): Promise<BranchState>;
  openDraft(input: { repo: PullRequestRepo; branch: string; base: string; run: RunPullRequestText }): Promise<PullRequestRef>;
  changedFiles(input: { repo: PullRequestRepo; number: number }): Promise<ChangedFiles>;
  markReady(input: { repo: PullRequestRepo; pullRequest: PullRequestRef }): Promise<void>;
  close(input: { repo: PullRequestRepo; number: number }): Promise<void>;
}

/**
 * The ids and title the pull request text is made from, read from our own tables for the run (never from the job or the runner).
 * Null when the run has no work item. `client` must be under the run's tenant.
 */
export async function loadRunPullRequestText(client: TenantQueryable, run: { accountId: string; runId: string }): Promise<RunPullRequestText | null> {
  const { rows } = await client.query<{ work_item_id: string; title: string | null }>(
    `SELECT ar.work_item_id, w.title
       FROM agent_runs ar
       JOIN work_items w ON w.account_id = ar.account_id AND w.id = ar.work_item_id
      WHERE ar.account_id = $1 AND ar.id = $2`,
    [run.accountId, run.runId],
  );
  return rows.length === 1 ? { runId: run.runId, workItemId: rows[0]!.work_item_id, workItemTitle: rows[0]!.title } : null;
}

export const TITLE_MAX = 256;
export const MAX_FILE_PAGES = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The work item's title as a pull request title: whitespace and control characters collapsed, at most 256 characters (never half a surrogate pair), or the fixed fallback. */
export function pullRequestTitle(workItemTitle: string | null): string {
  const clean = (workItemTitle ?? "").replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  let out = "";
  for (const ch of clean) {
    if (out.length + ch.length > TITLE_MAX) break;
    out += ch;
  }
  return out.trimEnd() || COPY.pullRequestTitleFallback;
}

/** The pull request's description: the fixed template with the two ids. Nothing the agent wrote can reach it, because nothing else is an input. */
export function pullRequestBody(input: { runId: string; workItemId: string }, options: { readyFallback?: boolean } = {}): string {
  if (!UUID.test(input.runId) || !UUID.test(input.workItemId)) throw new TypeError("pullRequestBody: ids must be UUIDs");
  const body = COPY.pullRequestBody.replace("{run}", input.runId).replace("{item}", input.workItemId);
  return options.readyFallback === true ? `${body}

${READY_FALLBACK_LINE}` : body;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const malformed = (): never => {
  throw new RunPullRequestError("malformed");
};
const need = <T>(value: T | null | undefined | false): T => (value ? value : malformed());

/** Maps a response's status to success or the failure it stands for. */
function checkStatus(res: GithubResponse, ok: readonly number[]): void {
  if (ok.includes(res.status)) return;
  const message = isObject(res.body) && typeof res.body.message === "string" ? res.body.message : "";
  if (res.status >= 500 || res.status === 429 || (res.status === 403 && /rate limit|abuse/i.test(message))) throw new RunPullRequestError("unavailable");
  throw new RunPullRequestError("rejected");
}

/**
 * Whether a 422 from `POST /pulls` says the repository cannot have draft pull requests: `draft` together with `not supported`,
 * case-insensitive, in GitHub's top-level `message` or in any `errors[].message` (or a bare string in `errors`).
 *
 * GitHub's wording, as users report it, inside the REST validation-failure shape (`message: "Validation Failed"`,
 * `errors: [{ resource, code: "custom", message }]`): "Draft pull requests are not supported in this repository." GitHub's own
 * pages state the cause but do not quote the string: draft pull requests exist in public repositories on Free and Pro and in public
 * and private repositories on Team and above (docs.github.com, "About pull requests", section "Draft pull requests"). The match is
 * loose on purpose, so a rewording that keeps both words still works; a different 422 (no commits, duplicate, bad head) says neither.
 */
export function isDraftUnsupported(body: unknown): boolean {
  const texts: unknown[] = [];
  if (isObject(body)) {
    texts.push(body.message);
    if (Array.isArray(body.errors)) for (const e of body.errors as unknown[]) texts.push(isObject(e) ? e.message : e);
  }
  return texts.some((t) => typeof t === "string" && /draft/i.test(t) && /not supported/i.test(t));
}

async function guarded(call: () => Promise<GithubResponse>): Promise<GithubResponse> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof LocalOnlyGithubError || error instanceof RunPullRequestError) throw error;
    // fx-swallow-ok: a transport failure or timeout; the original's text can carry the request URL, so only a fixed reason survives
    throw new RunPullRequestError("unavailable");
  }
}

/** Runs a fixed document and answers its `data`. GraphQL errors arrive with status 200, so `errors` is read here. */
async function query(gh: LocalOnlyGithub, op: GithubGraphqlOperation, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await guarded(() => gh.graphql(op, variables));
  checkStatus(res, [200]);
  if (!isObject(res.body)) return malformed();
  if (Array.isArray(res.body.errors) && res.body.errors.length > 0) {
    const limited = res.body.errors.some((e) => isObject(e) && (e.type === "RATE_LIMITED" || e.type === "SERVICE_UNAVAILABLE"));
    throw new RunPullRequestError(limited ? "unavailable" : "rejected");
  }
  return isObject(res.body.data) ? res.body.data : malformed();
}

/** An `open` failure that no retry fixes: the repository has no installation, or its App cannot write. Read by the error's own code, so this package needs no import of @fx/github. */
function isPermanentOpenFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; reason?: unknown };
  return e.code === "installation_not_writable" || e.reason === "no_installation";
}

const repoPath = (repo: PullRequestRepo): string => `/repos/${repo.owner}/${repo.name}`;
const sameRepo = (fullName: unknown, repo: PullRequestRepo): boolean => typeof fullName === "string" && fullName.toLowerCase() === `${repo.owner}/${repo.name}`.toLowerCase();

function pullRequestRef(raw: unknown, branch: string, repo: PullRequestRepo, reused: boolean): PullRequestRef {
  if (!isObject(raw) || !isCount(raw.number) || raw.number < 1 || typeof raw.node_id !== "string" || typeof raw.draft !== "boolean" || raw.state !== "open") return malformed();
  const head = raw.head;
  if (!isObject(head) || head.ref !== branch || !isObject(head.repo) || !sameRepo(head.repo.full_name, repo)) return malformed();
  return { number: raw.number, nodeId: raw.node_id, draft: raw.draft, reused };
}

/** Builds the port over `open`, which answers a client for one repository (the App's installation token for it; for the app, see apps/web). */
export function createRunPullRequestPort(deps: { open(repo: PullRequestRepo): Promise<GithubClient> }): RunPullRequestPort {
  const client = async (repo: PullRequestRepo): Promise<LocalOnlyGithub> => {
    let inner: GithubClient;
    try {
      inner = await deps.open(repo);
    } catch (error) {
      // fx-swallow-ok: the cause can carry a name or a token, so only a fixed reason survives. No installation and a read-only App
      // are permanent (a retry cannot fix them); a token mint that failed or timed out, or a transport error, is worth retrying.
      throw new RunPullRequestError(isPermanentOpenFailure(error) ? "rejected" : "unavailable");
    }
    return localOnlyGithub(inner);
  };

  async function findOpen(gh: LocalOnlyGithub, repo: PullRequestRepo, branch: string, base: string): Promise<PullRequestRef | null> {
    const res = await guarded(() => gh.request({ method: "GET", path: `${repoPath(repo)}/pulls`, query: { head: `${repo.owner}:${branch}`, base, state: "open", per_page: 100 } }));
    checkStatus(res, [200]);
    if (!Array.isArray(res.body)) return malformed();
    // A pull request whose head is a fork's branch of the same name is not ours; only a head in this repository counts. A reused one
    // must also target the run's base (the query asks for it; this holds the answer to it too), or the scope check would read another diff.
    const mine = (res.body as unknown[])
      .filter((item) => isObject(item) && isObject(item.head) && item.head.ref === branch && isObject(item.head.repo) && sameRepo(item.head.repo.full_name, repo) && isObject(item.base) && item.base.ref === base)
      .map((item) => pullRequestRef(item, branch, repo, true));
    return mine.sort((a, b) => a.number - b.number)[0] ?? null;
  }

  return {
    async defaultBranch(repo) {
      const gh = await client(repo);
      const res = await guarded(() => gh.request({ method: "GET", path: repoPath(repo) }));
      checkStatus(res, [200]);
      if (!isObject(res.body) || !sameRepo(res.body.full_name, repo)) return malformed();
      const name = res.body.default_branch;
      return typeof name === "string" && name.length > 0 ? name : malformed();
    },

    async branchState({ repo, branch, base }) {
      const gh = await client(repo);
      const data = await query(gh, "RunBranchState", { owner: repo.owner, name: repo.name, head: branch, base });
      const repository = need(isObject(data.repository) && data.repository);
      const defaultRef = repository.defaultBranchRef;
      const defaultBranch = isObject(defaultRef) && typeof defaultRef.name === "string" ? defaultRef.name : null;
      const ref = repository.ref;
      if (ref === null || ref === undefined) return { exists: false, headOid: null, aheadBy: null, defaultBranch };
      if (!isObject(ref) || ref.name !== branch || !isObject(ref.target) || typeof ref.target.oid !== "string" || !OID.test(ref.target.oid)) return malformed();
      const baseRef = repository.baseRef;
      const compare = isObject(baseRef) ? baseRef.compare : null;
      const aheadBy = isObject(compare) && isCount(compare.aheadBy) ? compare.aheadBy : null;
      return { exists: true, headOid: ref.target.oid, aheadBy, defaultBranch };
    },

    async openDraft({ repo, branch, base, run }) {
      const ids = { runId: run.runId, workItemId: run.workItemId };
      const title = pullRequestTitle(run.workItemTitle);
      const body = pullRequestBody(ids);
      const gh = await client(repo);
      const existing = await findOpen(gh, repo, branch, base);
      if (existing) return existing;
      const create = (text: string, draft: boolean) => guarded(() => gh.request({ method: "POST", path: `${repoPath(repo)}/pulls`, body: { title, body: text, head: branch, base, draft } }));
      const res = await create(body, true);
      if (res.status === 422) {
        // Another attempt opened it between our look and our create: use theirs. If there is still none, GitHub refused for another reason.
        const raced = await findOpen(gh, repo, branch, base);
        if (raced) return raced;
        if (isDraftUnsupported(res.body)) {
          // The repository cannot have drafts: retry ONCE as a ready pull request. A 422 on the retry, like any other status, goes to checkStatus.
          const retry = await create(pullRequestBody(ids, { readyFallback: true }), false);
          checkStatus(retry, [201]);
          return pullRequestRef(retry.body, branch, repo, false);
        }
      }
      checkStatus(res, [201]);
      return pullRequestRef(res.body, branch, repo, false);
    },

    async changedFiles({ repo, number }) {
      const gh = await client(repo);
      const files: ChangedFiles["files"] = [];
      let totalCount = 0;
      let cursor: string | null = null;
      for (let page = 0; page < MAX_FILE_PAGES; page++) {
        const data = await query(gh, "PullRequestFiles", { owner: repo.owner, name: repo.name, number, ...(cursor === null ? {} : { cursor }) });
        const pr = need(isObject(data.repository) && isObject(data.repository.pullRequest) && data.repository.pullRequest);
        const list = need(isObject(pr.files) && pr.files);
        const info = need(isObject(list.pageInfo) && list.pageInfo);
        if (!isCount(list.totalCount) || !Array.isArray(list.nodes) || list.nodes.length > 100 || typeof info.hasNextPage !== "boolean") return malformed();
        totalCount = list.totalCount;
        for (const node of list.nodes as unknown[]) {
          if (!isObject(node) || typeof node.path !== "string" || node.path.length === 0 || typeof node.changeType !== "string" || node.changeType.length === 0) return malformed();
          files.push({ path: node.path, changeType: node.changeType });
        }
        if (!info.hasNextPage) return { files, totalCount, complete: files.length === totalCount };
        if (typeof info.endCursor !== "string" || info.endCursor === cursor) return malformed();
        cursor = info.endCursor;
      }
      // More pages than GitHub lists for one pull request: what was read is not all of it.
      return { files, totalCount, complete: false };
    },

    async markReady({ repo, pullRequest }) {
      if (!pullRequest.draft) return;
      const gh = await client(repo);
      const data = await query(gh, "MarkReady", { id: pullRequest.nodeId });
      const result = need(isObject(data.markPullRequestReadyForReview) && data.markPullRequestReadyForReview);
      const pr = need(isObject(result.pullRequest) && result.pullRequest);
      if (pr.number !== pullRequest.number || pr.isDraft !== false) malformed();
    },

    async close({ repo, number }) {
      const gh = await client(repo);
      const res = await guarded(() => gh.request({ method: "PATCH", path: `${repoPath(repo)}/pulls/${number}`, body: { state: "closed" } }));
      checkStatus(res, [200]);
      if (!isObject(res.body) || res.body.number !== number || res.body.state !== "closed") malformed();
    },
  };
}
