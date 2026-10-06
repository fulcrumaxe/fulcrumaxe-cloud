import type { RepoVisibility, RepoVisibilityPort } from "./runnerTarget.js";

/**
 * D#6 R3b (correction C12 sections 2.3 and 3): the real `RepoVisibilityPort`. It reads the repository's `private` flag
 * from GitHub, live, on every call (no cache: a repo made public a minute ago must not read as private), through the
 * caller's HTTP client.
 *
 * It fails closed. The answer is `private` only when GitHub answered 200 with `private` exactly `true` AND the body names
 * the same repository we asked about. `private: false` is `public`. Every other outcome is `unknown`: a transport error, a
 * 403 or 404 (the App lost access, or the repo was deleted or renamed), a malformed body, a body for another repository, a
 * missing or non-boolean flag. `RunnerTarget.admit` and the job issuer turn `public` into `public_repo` and `unknown` into
 * `repo_visibility_unknown`.
 */

/** The one GitHub call this port makes. The caller's client holds the token and the base URL. */
export interface RepoReadHttp {
  /** Resolves for ANY HTTP status; rejects only on a transport failure. */
  request(req: { method: "GET"; path: string }): Promise<{ status: number; body: unknown }>;
}

export interface GithubRepoVisibilityDeps {
  /** The repository's GitHub coordinates from our own `repos` row, or null when it has none. Tenant-scoped by the caller. */
  resolveRepo(repo: { accountId: string; repoId: string }): Promise<{ owner: string; name: string } | null>;
  /** A client that can read this repository (the read token of the App's installation on it). Throws when there is none. */
  open(repo: { accountId: string; repoId: string; owner: string; name: string }): Promise<RepoReadHttp>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function createGithubRepoVisibility(deps: GithubRepoVisibilityDeps): RepoVisibilityPort {
  return {
    async visibility(repo): Promise<RepoVisibility> {
      try {
        const coordinates = await deps.resolveRepo(repo);
        if (coordinates === null) return "unknown";
        const http = await deps.open({ ...repo, ...coordinates });
        const res = await http.request({ method: "GET", path: `/repos/${coordinates.owner}/${coordinates.name}` });
        if (res.status !== 200 || !isObject(res.body)) return "unknown";
        // The answer must be about the repository we asked for (a redirect after a rename, a proxy, a stale cache).
        const full = res.body.full_name;
        if (typeof full !== "string" || full.toLowerCase() !== `${coordinates.owner}/${coordinates.name}`.toLowerCase()) return "unknown";
        if (res.body.private === true) return "private";
        if (res.body.private === false) return "public";
        return "unknown";
      } catch {
        // fx-swallow-ok: fail closed; "unknown" refuses the run with a fixed code, and the error text can carry the request URL
        return "unknown";
      }
    },
  };
}
