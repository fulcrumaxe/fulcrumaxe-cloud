import { LocalOnlyGithubError, localOnlyGithub } from "@fx/runner-cloud";
import type { InstallationHttp, InstallationHttpKind, InstallationHttpTarget } from "@fx/github";
import type { LocalGitHubHttp } from "@fx/pipeline";
import type { PrCloseHttp } from "@fx/worker";

/**
 * D#6 R3c (body criterion 9, C35 section 3.3): the review driver's and the merge gate's GitHub client for a `runner_local` repo.
 *
 * Our cloud must never receive such a repository's file contents or diffs, so every call about one goes through
 * `localOnlyGithub`: a call that is not on the allowlist (A1 to A10) is refused before a request is made, and the changed files and
 * the CI state come from the fixed GraphQL documents, which select paths and states only. The installation client underneath is
 * opened with `allowGraphql`, because the fence is what decides which document may be sent.
 *
 * A refusal is logged as one line with the rule it broke and nothing else (never a path, a name or a body), and thrown unchanged:
 * the caller's catch turns it into a fixed code, so a refused call reads as "GitHub unavailable" and never as a green answer.
 */
export function fenceInstallationHttp(http: InstallationHttp, options: { exclude?: readonly string[] } = {}): LocalGitHubHttp {
  const fenced = localOnlyGithub({
    async request(req) {
      if (req.method !== "GET" && req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") throw new LocalOnlyGithubError("not_allowlisted");
      return http.request({ method: req.method, path: req.path, query: req.query, body: req.body });
    },
  }, options);
  const logRefusal = (err: unknown): never => {
    if (err instanceof LocalOnlyGithubError) console.warn(JSON.stringify({ event: "advance.local_only_refused", rule: err.rule }));
    throw err;
  };
  return {
    request: (req) => fenced.request(req).catch(logRefusal),
    graphql: (op, variables) => fenced.graphql(op, variables).catch(logRefusal),
  };
}

type Open = (kind: InstallationHttpKind, target: InstallationHttpTarget) => Promise<InstallationHttp>;

/**
 * Puts the pull-request client that lists and closes a paired item's private pull request behind the local-only fence, so only the allowlist's A3 and
 * A5 can be sent (that client's token reads contents, which is why the fence matters). Applied for every mode: the sweep needs nothing else. The client
 * itself is opened in runnerPullRequest.ts, the one file allowed to, which returns only this fenced form.
 */
export function fenceForPrClose(http: InstallationHttp): PrCloseHttp {
  const fenced = localOnlyGithub({
    request: (req) => http.request({ method: req.method as "GET" | "PATCH", path: req.path, query: req.query, body: req.body }),
  });
  return {
    // The fence's list also holds the merge (A10) and the others; this client may only list pull requests (A3) and close one (A5).
    request: (req) =>
      (isListOrClose(req) ? fenced.request(req) : Promise.reject(new LocalOnlyGithubError("not_allowlisted"))).catch((err: unknown) => {
        if (err instanceof LocalOnlyGithubError) console.warn(JSON.stringify({ event: "advance.local_only_refused", rule: err.rule }));
        throw err;
      }),
  };
}

const isListOrClose = (req: { method: string; path: string }): boolean =>
  (req.method === "GET" && /^\/repos\/[^/?#]+\/[^/?#]+\/pulls$/.test(req.path)) || (req.method === "PATCH" && /^\/repos\/[^/?#]+\/[^/?#]+\/pulls\/[0-9]{1,10}$/.test(req.path));

/**
 * Opens the `read` or `merge_gate` client for a repository, as the plain client for a sandbox repo and the fenced one for a `runner_local` repo.
 * `withoutMerge` (the paired code repository of a `runner_local` item) takes the merge call out of the fence: the cloud never merges there.
 */
export async function openForRepo(open: Open, executionMode: string, kind: "read" | "merge_gate", target: InstallationHttpTarget, options: { withoutMerge?: boolean } = {}): Promise<InstallationHttp | LocalGitHubHttp> {
  if (executionMode !== "runner_local") return open(kind, target);
  return fenceInstallationHttp(await open(kind, { ...target, allowGraphql: true }), options.withoutMerge === true ? { exclude: ["A10"] } : {});
}
