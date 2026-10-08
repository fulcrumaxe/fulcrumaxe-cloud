import type { AppCredentialsSource } from "./appCredentials.js";
import { GH_OWNER_LOGIN_RE, GH_REPO_NAME_RE } from "./eventMapper.js";
import { getInstallationToken, type AccessTokenRequester, type InstallationTokenCache } from "./installationToken.js";

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
 * What it keeps, so a bug in a caller cannot widen it:
 *   - the host is api.github.com and the path must start with `/repos/<owner>/<name>/` for the repository the client was
 *     opened for: any other path throws before a token is used;
 *   - a path may hold only URL-path characters (no `..`, no query or fragment: query goes in `query`);
 *   - redirects are an error, every call has a timeout, a non-JSON body reads as `null`;
 *   - the optional `log` hears the method, the path with the repository masked, the status and, for an error status,
 *     GitHub's own `message` cut short. It never hears a token, a header or a request body.
 */

export type InstallationHttpKind = "read" | "merge_gate" | "runner_pr";

export interface InstallationHttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH";
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
}

const CALL_TIMEOUT_MS = 15_000;
const RUNNER_PR_PERMISSIONS = Object.freeze({ metadata: "read", contents: "read", pull_requests: "write" } as const);
const GRAPHQL_PATH = "/graphql";
const PATH_RE = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.~%:/@+=-]*$/;
const MESSAGE_RE = /[^\x20-\x7e]/g;

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

export function createInstallationHttp(deps: InstallationHttpDeps): (kind: InstallationHttpKind, target: InstallationHttpTarget) => Promise<InstallationHttp> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return async (kind, target) => {
    if (!GH_OWNER_LOGIN_RE.test(target.owner) || !GH_REPO_NAME_RE.test(target.name)) throw new InstallationHttpError("invalid_coordinates");
    const installation = await deps.resolveInstallation(target.repoId);
    if (!installation) throw new InstallationHttpError("no_installation");
    const token = await getInstallationToken({
      installationId: installation.installationId,
      appKind: installation.appKind,
      purpose: kind === "merge_gate" ? "merge_gate" : "run",
      role: kind === "merge_gate" ? "merge_gate" : kind === "runner_pr" ? "runner_pr" : "pr_read",
      scope: { repositories: [target.name], permissions: kind === "merge_gate" ? {} : kind === "runner_pr" ? RUNNER_PR_PERMISSIONS : { metadata: "read", pull_requests: "read" } },
      appCredentials: deps.appCredentials,
      requester: deps.requester,
      cache: deps.cache,
    });
    const prefix = `/repos/${target.owner}/${target.name}/`;
    // The repository itself (`GET /repos/<owner>/<name>`, no trailing slash) is also allowed, for GET only: D#6 R3b reads its `private` flag.
    const repoRoot = prefix.slice(0, -1);

    return {
      async request(req) {
        const graphql = kind === "runner_pr" && req.method === "POST" && req.path === GRAPHQL_PATH;
        const allowed = graphql || (req.method === "GET" && req.path === repoRoot) || (req.path.startsWith(prefix) && PATH_RE.test(req.path));
        if (!allowed || req.path.includes("..")) throw new InstallationHttpError("path_refused");
        // `runner_pr` holds contents:read, so it gets its own EXACT list rather than the prefix rule above (CWE-284): a caller that
        // names this kind must not be able to read file contents, patches or commits. Everything else is refused here, PUT included.
        if (kind === "runner_pr" && !(graphql || runnerPrAllowed(req.method, req.path, prefix))) throw new InstallationHttpError("path_refused");
        if (kind === "read" && req.method !== "GET") throw new InstallationHttpError("method_refused");
        // PATCH is for `runner_pr` alone (closing a pull request); the other kinds never needed it and never get it.
        if (req.method === "PATCH" && kind !== "runner_pr") throw new InstallationHttpError("method_refused");
        if (kind === "runner_pr" && req.method === "PUT") throw new InstallationHttpError("method_refused");
        const url = new URL(`https://api.github.com${req.path}`);
        for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, String(v));
        let res: Response;
        try {
          res = await fetchImpl(url, {
            method: req.method,
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${token}`,
              "x-github-api-version": "2022-11-28",
              ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
            },
            body: req.body === undefined ? undefined : JSON.stringify(req.body),
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
        const message = res.status >= 400 && body !== null && typeof body === "object" && "message" in body && typeof (body as { message: unknown }).message === "string" ? (body as { message: string }).message.replace(MESSAGE_RE, "").slice(0, 120) : null;
        deps.log?.({ method: req.method, path: req.path.replace(/^\/repos\/[^/]+\/[^/]+/, "/repos/:o/:r"), status: res.status, message });
        return { status: res.status, body };
      },
    };
  };
}
