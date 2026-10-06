/** What a parsed request path points at. */
export type ApiTarget = { kind: "api"; owner: string; repo: string; subpath: string };
export type GitTarget = {
  kind: "git";
  owner: string;
  repo: string;
  /** Which git protocol service this target maps to — the same for either
   * `endpoint` below (`info/refs` merely DISCOVERS this same service; it
   * doesn't change what's being discovered). */
  service: "upload-pack" | "receive-pack";
  /**
   * D#2 fix round 1, must-fix 2: the literal URL endpoint segment matched —
   * distinct from `service`, which only says which service `info/refs` is
   * discovering. Real git smart-HTTP restricts methods per ENDPOINT, not
   * per service: `info/refs` is GET/HEAD-only discovery, while
   * `git-upload-pack` and `git-receive-pack` are POST-only. `decide()`
   * gates on this field so a request can't reach `git-upload-pack` (or
   * `git-receive-pack`) with a method like PUT/PATCH/DELETE just because
   * its `service` happens to match.
   */
  endpoint: "info/refs" | "git-upload-pack" | "git-receive-pack";
};
export type PathTarget = ApiTarget | GitTarget;

const API_RE = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/;
const GIT_RE = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * Parse a proxied request path into either a REST API target
 * (`/repos/{owner}/{repo}/...`) or a git smart-HTTP target
 * (`/{owner}/{repo}[.git]/{info/refs,git-upload-pack,git-receive-pack}`).
 *
 * Returns `null` for anything else — `/gists`, `/user`, `/orgs`, `/search`,
 * a malformed path, or an `info/refs` request with no `service` query
 * param to disambiguate it. A `null` here is exactly the shape `decide()`
 * default-denies on.
 */
export function parseTarget(path: string, query?: Record<string, string>): PathTarget | null {
  const apiMatch = API_RE.exec(path);
  if (apiMatch) {
    // `!`: both are mandatory capture groups (`([^/]+)`, no `?`) in a
    // match that already succeeded; only the third group is genuinely
    // optional. (noUncheckedIndexedAccess, D#2 H13b: this file is now
    // consumed from apps/web's stricter tsconfig.)
    const owner = apiMatch[1]!;
    const repo = apiMatch[2]!;
    const rest = apiMatch[3];
    return { kind: "api", owner, repo, subpath: rest ?? "" };
  }

  const gitMatch = GIT_RE.exec(path);
  if (gitMatch) {
    const owner = gitMatch[1]!;
    const repo = gitMatch[2]!;
    const endpoint = gitMatch[3]! as "info/refs" | "git-upload-pack" | "git-receive-pack";
    if (endpoint === "git-upload-pack") {
      return { kind: "git", owner, repo, service: "upload-pack", endpoint };
    }
    if (endpoint === "git-receive-pack") {
      return { kind: "git", owner, repo, service: "receive-pack", endpoint };
    }
    // info/refs: the service is disambiguated by the query string.
    const svc = query?.service;
    if (svc === "git-upload-pack") return { kind: "git", owner, repo, service: "upload-pack", endpoint };
    if (svc === "git-receive-pack") return { kind: "git", owner, repo, service: "receive-pack", endpoint };
    return null;
  }

  return null;
}
