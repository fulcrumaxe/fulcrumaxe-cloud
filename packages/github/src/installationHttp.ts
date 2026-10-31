import type { AppCredentialsSource } from "./appCredentials.js";
import { ADD_DISCUSSION_COMMENT_DOCUMENT, type RetractionSurface } from "./retraction.js";
import { GH_OWNER_LOGIN_RE, GH_REPO_NAME_RE } from "./eventMapper.js";
import { getInstallationToken, RECEIPT_BLOCK_PERMISSIONS, RETRACTION_PERMISSIONS, REVERT_PR_PERMISSIONS, type AccessTokenRequester, type InstallationTokenCache } from "./installationToken.js";
import { REVERT_PR_DOCUMENT, revertPrVariables } from "./revertPr.js";
import { pinnedMergeGateBody } from "./mergeGateGraphql.js";

/**
 * D#483 P3: an HTTP client for ONE repository's GitHub API, authenticated as the write App's installation, for the stage
 * driver's own calls (it is not the gh-proxy: nothing here forwards a sandbox's request).
 *
 *   - `read`       finds the executor's pull request and lists its changed files. Token: metadata:read and
 *                  pull_requests:read, one repository.
 *   - `merge_gate` the merge gate: check runs, statuses and branch protection (reads), the platform's commit status and
 *                  the merge (writes). Token: the `merge_gate` purpose's fixed permission set (installationToken.ts).
 *   - `runner_pr`  D#6 R2b-3e: the cloud's own pull request for a `runner_local` run (find, open as a draft, read its changed
 *                  paths, mark ready, close), and the repository's branch state, through `POST /graphql` as well as the
 *                  repository's REST paths. Token: metadata:read, contents:read (GraphQL refs need it), pull_requests:write,
 *                  one repository. Because contents:read could otherwise reach file contents, this kind has its own exact list:
 *                  `POST /graphql`, `GET` the repository, `GET` and `POST` its `/pulls`, and `PATCH /pulls/<digits>`; every other
 *                  method and path is `path_refused`. Which GraphQL documents and bodies are sent is `localOnlyGithub`'s job
 *                  (runner-cloud's `createRunPullRequestPort` applies it itself), since this package cannot see them.
 *
 *   - `repo_map`   D#600 CX-3a: the repository's file tree at one commit, for the prompt's repository map. Token: metadata:read and
 *                  contents:read, one repository. Because contents:read could otherwise reach file contents, this kind has its own
 *                  exact list, GET only: the repository, one branch ref, one tree and one blob by id. Not commits, not `contents`.
 *
 *   - `branch_delete` D#598 P1f-5d: removes ONE branch of a private repository and nothing else. Token: the `branch_delete` purpose
 *                  (`contents: write`, one repository, minted fresh and revoked by `close()`). The client is pinned to the one branch it was
 *                  opened for, which must be one of the shapes the platform pushes (`fx/issue-<n>`, a planned PR child's `fx/<parent#>-<key>`, or `fx/<run id>-g<generation>`), and
 *                  allows exactly: `GET` the repository, `GET` that branch's ref, and `DELETE` that branch's ref ONCE. A push, a second
 *                  branch, a second delete and every other path are refused before a token is used.
 *
 *   - `branch_sync` FIXROUND-BASE-SYNC: brings ONE private pull request branch up to date with its base. Token: the `branch_sync` purpose (`contents: write`,
 *                  `pull_requests: read`, one repository, minted fresh and revoked by `close()`). The client is pinned to the branch (one of the two shapes the
 *                  platform pushes) and the pull request number it was opened for, and allows exactly: `GET` the repository, `GET` that pull request, `GET` a
 *                  branch ref, and `POST /merges` ONCE, whose body is exactly `base` = the pinned branch, `head` = a commit id and `commit_message`.
 *
 *   - `receipt_block` D#7 DP6a (C22 B4): the decision-receipt block in ONE pull request's body. Token: the `receipt_block` purpose (`pull_requests: write`, `checks: read`,
 *                  one repository). The client is pinned to the pull request number it was opened for, and allows exactly: `GET` that pull request (to read the current
 *                  body), `PATCH` it with a JSON body whose only key is `body` (a string), and `GET /commits/<sha>/check-runs`. Every other method, path and body key is
 *                  refused before a request is sent.
 *   - `revert_pr`  D#7 DP7-2w: a draft revert of ONE merged pull request. Token: the `revert_pr` purpose (`contents: write`, `pull_requests: write`, one repository, fresh, revoked by `close()`).
 *                  Pinned to the pull request number it was opened for; allows exactly `GET` that pull request (its node id is read from the answer) and `POST /graphql` ONCE,
 *                  whose body is the pinned document (revertPr.ts) with that node id, `draft` true and the fixed title and body. Anything else is `path_refused` before a request is sent.
 *
 *   - `retraction` D#7 DP7b-w: a correction on the ONE surface a deprecation notice was recorded on. Token: the `retraction` purpose (one key, by surface: `contents: write` for a
 *                  release, `issues: write` for a comment, `discussions: write` for a Discussion; one repository, minted fresh and revoked by `close()`). The client is pinned to
 *                  the surface it was opened for and allows exactly: a release, `GET` it and `PATCH` it once with a body whose only key is `body`; a comment, `POST /issues/<n>/comments`
 *                  once with a body whose only key is `body`; a Discussion, `POST /graphql` once with exactly the pinned discussion-comment mutation document and the pinned node id.
 *
 * What it keeps, so a bug in a caller cannot widen it:
 *   - the host is api.github.com and the path must start with `/repos/<owner>/<name>/` for the repository the client was
 *     opened for: any other path throws before a token is used;
 *   - a path may hold only URL-path characters (no `..`, no query or fragment: query goes in `query`);
 *   - redirects are an error, every call has a timeout, a non-JSON body reads as `null`;
 *   - the optional `log` hears the method, the path with the repository masked, the status and, for an error status,
 *     GitHub's own `message` cut short. It never hears a token, a header or a request body.
 */

export type InstallationHttpKind = "read" | "merge_gate" | "runner_pr" | "repo_map" | "branch_delete" | "branch_sync" | "receipt_block" | "retraction" | "revert_pr";

export interface InstallationHttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Starts with `/repos/<owner>/<name>/`; `runner_pr` may also name `/graphql` (POST only). */
  path: string;
  query?: Readonly<Record<string, string | number>>;
  body?: unknown;
}
export interface InstallationHttpResponse {
  status: number;
  body: unknown;
}
export interface InstallationHttp {
  /** Resolves for any HTTP status; rejects only on a transport failure (or a request this client refuses). */
  request(req: InstallationHttpRequest): Promise<InstallationHttpResponse>;
  /** A `branch_delete` client revokes its token here (`DELETE /installation/token`); it never throws. Other kinds have nothing to release. */
  close?(): Promise<void>;
}

export interface InstallationHttpLogEntry {
  method: string;
  path: string;
  status: number;
  message: string | null;
}

export interface InstallationHttpDeps {
  resolveInstallation: (repoId: string) => Promise<{ installationId: number; appKind: string } | null>;
  appCredentials: AppCredentialsSource;
  requester: AccessTokenRequester;
  cache: InstallationTokenCache;
  fetchImpl?: typeof fetch;
  log?: (entry: InstallationHttpLogEntry) => void;
}

export interface InstallationHttpTarget {
  repoId: string;
  owner: string;
  name: string;
  /**
   * D#6 R3c: lets a `read` or `merge_gate` client send `POST /graphql` (and nothing else beyond its own list). Off by default. Only a
   * caller that puts the client behind `localOnlyGithub` sets it: this package cannot see which document or variables are sent, so the
   * fence, not this flag, decides what a GraphQL call may ask for. A `runner_pr` client always may.
   */
  allowGraphql?: boolean;
  /** `branch_delete` only: the one branch the client may read and delete. Required for that kind, refused for every other. */
  branch?: string;
  /** `branch_sync` and `receipt_block` only: the one pull request the client may read (and, for `receipt_block`, update). Required for those kinds, refused for every other. */
  prNumber?: number;
  /** `retraction` only: the one surface the client may write to. Required for that kind, refused for every other. */
  retraction?: RetractionSurface;
}

/**
 * The branches the platform pushes to a private repository: the item's pull request branch (`fx/issue-<n>`, or a planned PR child's `fx/<parent#>-<key>`, D#483 S5-b2c-3),
 * or a runner run's branch. Nothing else is ever deleted. Whose branch it is, is decided by the grant's recorded head and the caller, never by this shape.
 */
export const DELETABLE_BRANCH = /^fx\/(?:issue-[1-9][0-9]{0,9}|[1-9][0-9]{0,11}-[a-z0-9-]{1,32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-g[1-9][0-9]{0,5})$/;

const CALL_TIMEOUT_MS = 15_000;
const RUNNER_PR_PERMISSIONS = Object.freeze({ metadata: "read", contents: "read", pull_requests: "write" } as const);
const REPO_MAP_PERMISSIONS = Object.freeze({ metadata: "read", contents: "read" } as const);
const GRAPHQL_PATH = "/graphql";
const PATH_RE = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.~%:/@+=-]*$/;
/** A branch ref read for `branch_sync`: `git/ref/heads/<name>`, the name made of the characters a branch the platform follows can hold. */
const BRANCH_REF_PATH = /^git\/ref\/heads\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,5}$/;
/** The longest comment or release body a `retraction` client sends (GitHub's own cap is 65536). */
export const RETRACTION_BODY_MAX = 20_000;
const NODE_ID_RE = /^[A-Za-z0-9_=-]{1,200}$/;
const validRetractionSurface = (s: RetractionSurface): boolean =>
  s.kind === "release" ? Number.isSafeInteger(s.releaseId) && s.releaseId >= 1 : s.kind === "comment" ? Number.isSafeInteger(s.number) && s.number >= 1 : s.kind === "discussion" && NODE_ID_RE.test(s.discussionId);
const MESSAGE_RE = /[^\x20-\x7e]/g;

/** Kinds whose log line never carries GitHub's own `message` (method, masked path and status only). Per kind, so each new write kind opts in. Shared by `revert_pr` and `retraction`. */
const QUIET_ERROR_KINDS: ReadonlySet<InstallationHttpKind> = new Set<InstallationHttpKind>(["revert_pr", "retraction"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class InstallationHttpError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`installationHttp: ${reason}`);
    this.name = "InstallationHttpError";
    this.reason = reason;
  }
}

/** The only REST calls a `runner_pr` client may make (the allowlist A2 to A5 of runner-cloud's `localOnlyGithub`, at path level). */
function runnerPrAllowed(method: string, path: string, prefix: string): boolean {
  const repoRoot = prefix.slice(0, -1);
  if (method === "GET") return path === repoRoot || path === `${prefix}pulls`;
  if (method === "POST") return path === `${prefix}pulls`;
  if (method === "PATCH") return path.startsWith(`${prefix}pulls/`) && /^\d+$/.test(path.slice(prefix.length + "pulls/".length));
  return false;
}

/** The only REST calls a `repo_map` client may make: the repository, one branch ref, one tree and one blob (by 40-hex id). */
function repoMapAllowed(method: string, path: string, prefix: string): boolean {
  if (method !== "GET") return false;
  if (path === prefix.slice(0, -1)) return true;
  const rest = path.startsWith(prefix) ? path.slice(prefix.length) : "";
  return /^git\/(trees|blobs)\/[0-9a-f]{40}$/.test(rest) || /^git\/ref\/heads\/[A-Za-z0-9._/-]{1,200}$/.test(rest);
}

export function createInstallationHttp(deps: InstallationHttpDeps): (kind: InstallationHttpKind, target: InstallationHttpTarget) => Promise<InstallationHttp> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  /** `DELETE /installation/token` with the token itself as the bearer; a failure leaves the token to lapse at GitHub's own expiry. */
  const revokeInstallationToken = async (token: string): Promise<void> => {
    try {
      await fetchImpl("https://api.github.com/installation/token", {
        method: "DELETE",
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "fulcrumaxe-cloud", "x-github-api-version": "2022-11-28" },
        redirect: "error",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      // fx-swallow-ok: a revoke that cannot be made leaves the token to lapse at GitHub's own expiry; nothing else can use it (it never leaves this closure)
    }
  };

  return async (kind, target) => {
    if (!GH_OWNER_LOGIN_RE.test(target.owner) || !GH_REPO_NAME_RE.test(target.name)) throw new InstallationHttpError("invalid_coordinates");
    if ((kind === "branch_sync" || kind === "receipt_block" || kind === "revert_pr") !==(target.prNumber !== undefined) || (target.prNumber !== undefined && !(Number.isSafeInteger(target.prNumber) && target.prNumber >= 1))) throw new InstallationHttpError("invalid_coordinates");
    if ((kind === "branch_delete" || kind === "branch_sync") !== (target.branch !== undefined) || (target.branch !== undefined && !DELETABLE_BRANCH.test(target.branch))) throw new InstallationHttpError("invalid_coordinates");
    if ((kind === "retraction") !== (target.retraction !== undefined) || (target.retraction !== undefined && !validRetractionSurface(target.retraction))) throw new InstallationHttpError("invalid_coordinates");
    const installation = await deps.resolveInstallation(target.repoId);
    if (!installation) throw new InstallationHttpError("no_installation");
    const token = await getInstallationToken({
      installationId: installation.installationId,
      appKind: installation.appKind,
      purpose: kind === "retraction" ? "retraction" : kind === "merge_gate" ? "merge_gate" : kind === "branch_delete" ? "branch_delete" : kind === "branch_sync" ? "branch_sync" : kind === "receipt_block" ? "receipt_block" : "run",
      role: kind === "retraction" ? "retraction" : kind === "merge_gate" ? "merge_gate" : kind === "branch_delete" ? "branch_delete" : kind === "branch_sync" ? "branch_sync" : kind === "receipt_block" ? "receipt_block" : kind === "runner_pr" ? "runner_pr" : kind === "repo_map" ? "repo_map" : "pr_read",
      scope: { repositories: [target.name], permissions: kind === "retraction" ? RETRACTION_PERMISSIONS[target.retraction!.kind] : kind === "merge_gate" ? {} : kind === "receipt_block" ? RECEIPT_BLOCK_PERMISSIONS : kind === "runner_pr" ? RUNNER_PR_PERMISSIONS : kind === "repo_map" ? REPO_MAP_PERMISSIONS : { metadata: "read", pull_requests: "read" } },
      appCredentials: deps.appCredentials,
      requester: deps.requester,
      cache: deps.cache,
      ...(kind === "branch_delete" || kind === "branch_sync" || kind === "retraction" ? { revoke: revokeInstallationToken } : {}),
      // D#7 DP7-2w: the `revert_pr` purpose, its fixed permission set and its revoke (these override the generic choices above).
      ...(kind === "revert_pr" ? { purpose: "revert_pr" as const, role: "revert_pr", scope: { repositories: [target.name] as [string], permissions: REVERT_PR_PERMISSIONS }, revoke: revokeInstallationToken } : {}),
    });
    const prefix = `/repos/${target.owner}/${target.name}/`;
    // The repository itself (`GET /repos/<owner>/<name>`, no trailing slash) is also allowed, for GET only: D#6 R3b reads its `private` flag.
    const repoRoot = prefix.slice(0, -1);
    let deleted = false;
    /** `revert_pr` only: the pinned pull request's node id, read from the answer to the one GET; the mutation may name nothing else. */
    let revertNodeId: string | undefined;
    let revertSent = false;

    return {
      async close() {
        if (kind === "branch_delete" || kind === "branch_sync" || kind === "retraction" || kind === "revert_pr") await revokeInstallationToken(token);
      },
      async request(raw) {
        // Snapshot every field of the request exactly once; from here on only the snapshot is used (checks, URL, body, log), so a caller's accessor
        // or `toJSON` cannot answer one thing to a check and another to the send. The body is a JSON round trip: the checked value IS the sent bytes.
        const method: unknown = raw.method;
        const path: unknown = raw.path;
        const rawQuery: unknown = raw.query;
        const rawBody: unknown = raw.body;
        if (typeof method !== "string" || typeof path !== "string" || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new InstallationHttpError("path_refused");
        let snapBody: unknown;
        try {
          const text = rawBody === undefined ? undefined : JSON.stringify(rawBody);
          snapBody = text === undefined ? undefined : JSON.parse(text);
        } catch {
          // fx-swallow-ok: a body that cannot be serialized is refused before anything is sent
          throw new InstallationHttpError("path_refused");
        }
        const req = { method: method as typeof raw.method, path, query: rawQuery === undefined || rawQuery === null ? undefined : { ...(rawQuery as Record<string, string | number>) }, body: snapBody };
        const graphql = (kind === "runner_pr" || kind === "retraction" || target.allowGraphql === true) && req.method === "POST" && req.path === GRAPHQL_PATH;
        // `revert_pr` may name `/graphql` too, but only the one exact mutation checked below.
        // D#694 B5a: the hosted `merge_gate` client may send `POST /graphql` only for one of five pinned documents (mergeGateGraphql.ts); never a blanket flag.
        const pinnedBody = kind === "merge_gate" && req.method === "POST" && req.path === GRAPHQL_PATH && req.query === undefined ? pinnedMergeGateBody(req.body, { owner: target.owner, name: target.name }) : undefined;
        const pinnedGate = pinnedBody !== undefined;
        const allowed = graphql || pinnedGate || (kind === "revert_pr" && req.method === "POST" && req.path === GRAPHQL_PATH) || (req.method === "GET" && req.path === repoRoot) || (req.path.startsWith(prefix) && PATH_RE.test(req.path));
        if (!allowed || req.path.includes("..")) throw new InstallationHttpError("path_refused");
        // `runner_pr` holds contents:read, so it gets its own EXACT list rather than the prefix rule above (CWE-284): a caller that
        // names this kind must not be able to read file contents, patches or commits. Everything else is refused here, PUT included.
        if (kind === "runner_pr" && !(graphql || runnerPrAllowed(req.method, req.path, prefix))) throw new InstallationHttpError("path_refused");
        // `repo_map` holds contents:read, so it too gets an exact list (no `contents`, commits, archives or `..`).
        if (kind === "repo_map" && !repoMapAllowed(req.method, req.path, prefix)) throw new InstallationHttpError("path_refused");
        // `branch_delete` holds contents:write, so it gets the narrowest list there is: read the one branch, delete the one branch, once.
        if (kind === "branch_delete") {
          const read = req.method === "GET" && (req.path === repoRoot || req.path === `${prefix}git/ref/heads/${target.branch}`);
          const remove = req.method === "DELETE" && req.path === `${prefix}git/refs/heads/${target.branch}` && req.query === undefined && req.body === undefined;
          if (!read && !remove) throw new InstallationHttpError("path_refused");
          if (remove && deleted) throw new InstallationHttpError("already_used");
          if (remove) deleted = true;
        }
        // `branch_sync` holds contents:write, so it gets an exact list too: the pull request, a branch ref, and one merge into the pinned branch.
        if (kind === "branch_sync") {
          const read = req.method === "GET" && req.query === undefined && (req.path === repoRoot || req.path === `${prefix}pulls/${target.prNumber}` || BRANCH_REF_PATH.test(req.path.slice(prefix.length)));
          const b = req.body as Record<string, unknown> | undefined;
          const merge =
            req.method === "POST" && req.path === `${prefix}merges` && req.query === undefined && typeof b === "object" && b !== null && Object.keys(b).sort().join() === "base,commit_message,head" &&
            b["base"] === target.branch && typeof b["head"] === "string" && /^[0-9a-f]{40}$/.test(b["head"]) && typeof b["commit_message"] === "string";
          if (!read && !merge) throw new InstallationHttpError("path_refused");
          if (merge && deleted) throw new InstallationHttpError("already_used");
          if (merge) deleted = true;
        }
        // `receipt_block` holds pull_requests:write, so it gets an exact list: the one pull request (read, and a PATCH whose only key is `body`) and a commit's check runs.
        if (kind === "receipt_block") {
          const b = req.body as Record<string, unknown> | undefined;
          const pr = req.path === `${prefix}pulls/${target.prNumber}` && req.query === undefined;
          const readPr = req.method === "GET" && pr && b === undefined;
          const writePr = req.method === "PATCH" && pr && typeof b === "object" && b !== null && !Array.isArray(b) && Object.keys(b).join() === "body" && typeof b["body"] === "string";
          const runs = req.method === "GET" && b === undefined && req.path.startsWith(`${prefix}commits/`) && /^[0-9a-f]{40}\/check-runs$/.test(req.path.slice(prefix.length + "commits/".length));
          if (!readPr && !writePr && !runs) throw new InstallationHttpError("path_refused");
        }
        // `retraction` holds a write on ONE surface, so it gets an exact list for that surface alone (see the header): everything else, and a second write, is refused.
        if (kind === "retraction") {
          const s = target.retraction!;
          const b = req.body as Record<string, unknown> | undefined;
          const obj = typeof b === "object" && b !== null && !Array.isArray(b);
          const bodyOnly = obj && Object.keys(b).join() === "body" && typeof b["body"] === "string" && b["body"].length <= RETRACTION_BODY_MAX;
          const v = obj ? (b["variables"] as Record<string, unknown> | null | undefined) : undefined;
          const read = s.kind === "release" && req.method === "GET" && req.path === `${prefix}releases/${s.releaseId}` && req.query === undefined && b === undefined;
          const write =
            req.query === undefined &&
            ((s.kind === "release" && req.method === "PATCH" && req.path === `${prefix}releases/${s.releaseId}` && bodyOnly) ||
              (s.kind === "comment" && req.method === "POST" && req.path === `${prefix}issues/${s.number}/comments` && bodyOnly) ||
              (s.kind === "discussion" && req.method === "POST" && req.path === GRAPHQL_PATH && obj && Object.keys(b).sort().join() === "query,variables" && b["query"] === ADD_DISCUSSION_COMMENT_DOCUMENT &&
                typeof v === "object" && v !== null && Object.keys(v).sort().join() === "body,discussionId" && v["discussionId"] === s.discussionId && typeof v["body"] === "string" && v["body"].length <= RETRACTION_BODY_MAX));
          if (!read && !write) throw new InstallationHttpError("path_refused");
          if (write && deleted) throw new InstallationHttpError("already_used");
          if (write) deleted = true;
        }
        // `revert_pr` holds contents:write and pull_requests:write, so it gets the narrowest list there is: read the one pull request, then send the one pinned mutation, once.
        if (kind === "revert_pr") {
          const b = req.body as Record<string, unknown> | undefined;
          const v = isRecord(b) ? b["variables"] : undefined;
          const readPr = req.method === "GET" && req.path === `${prefix}pulls/${target.prNumber}` && req.query === undefined && b === undefined;
          const mutate =
            req.method === "POST" && req.path === GRAPHQL_PATH && req.query === undefined && isRecord(b) && Object.keys(b).sort().join() === "query,variables" && b["query"] === REVERT_PR_DOCUMENT &&
            revertNodeId !== undefined && isRecord(v) && JSON.stringify(v) === JSON.stringify(revertPrVariables(revertNodeId));
          if (!readPr && !mutate) throw new InstallationHttpError("path_refused");
          if (mutate && revertSent) throw new InstallationHttpError("path_refused");
          if (mutate) revertSent = true;
        }
        if (kind === "read" && req.method !== "GET" && !graphql) throw new InstallationHttpError("method_refused");
        // PATCH is for `runner_pr` alone (closing a pull request); the other kinds never needed it and never get it.
        if (req.method === "PATCH" && kind !== "runner_pr" && kind !== "receipt_block" && kind !== "retraction") throw new InstallationHttpError("method_refused");
        // DELETE is for `branch_delete` alone, and only on its pinned ref (checked above).
        if (req.method === "DELETE" && kind !== "branch_delete") throw new InstallationHttpError("method_refused");
        if (kind === "runner_pr" && req.method === "PUT") throw new InstallationHttpError("method_refused");
        const sendBody = pinnedBody ?? req.body; // a pinned body is the checked copy, so the bytes sent are the bytes checked
        const url = new URL(`https://api.github.com${req.path}`);
        for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, String(v));
        let res: Response;
        try {
          res = await fetchImpl(url, {
            method: req.method,
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${token}`,
              ...(kind === "branch_delete" || kind === "receipt_block" || kind === "retraction" || kind === "revert_pr" ? { "user-agent": "fulcrumaxe-cloud" } : {}),
              "x-github-api-version": "2022-11-28",
              ...(sendBody !== undefined ? { "content-type": "application/json" } : {}),
            },
            body: sendBody === undefined ? undefined : JSON.stringify(sendBody),
            redirect: "error",
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          });
        } catch {
          // fx-swallow-ok: rethrown as a fixed-message error; the original's text can carry the request URL and headers
          throw new InstallationHttpError("request_failed");
        }
        const text = await res.text();
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          // fx-swallow-ok: a body that is not JSON reads as null, which every caller treats as "not the shape expected"
          body = null;
        }
        const message = !QUIET_ERROR_KINDS.has(kind) && res.status >= 400 && body !== null && typeof body === "object" && "message" in body && typeof (body as { message: unknown }).message === "string" ? (body as { message: string }).message.replace(MESSAGE_RE, "").slice(0, 120) : null;
        if (kind === "revert_pr" && req.method === "GET" && res.status === 200 && isRecord(body) && typeof body["node_id"] === "string" && /^[A-Za-z0-9_=-]{4,100}$/.test(body["node_id"])) revertNodeId = body["node_id"];
        deps.log?.({ method: req.method, path: req.path.replace(/^\/repos\/[^/]+\/[^/]+/, "/repos/:o/:r"), status: res.status, message });
        return { status: res.status, body };
      },
    };
  };
}
