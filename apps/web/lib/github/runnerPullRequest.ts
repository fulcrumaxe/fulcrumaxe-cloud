import { createRunPullRequestPort, type GithubRequest, type PullRequestRepo, type RunPullRequestPort } from "@fx/runner-cloud";
import type { ContinuationBasePort } from "@fx/runner";
import type { InstallationHttpRequest } from "@fx/github";
import { openInstallationHttp, readRepoAppLogin } from "./installationHttp";

/**
 * D#6 R2b-3e: the live GitHub side of the `done` pull request for a `runner_local` repo. The client is the App's installation on the
 * repository (the same stored installation `createAppRepoVisibility` reads through; `openInstallationHttp` resolves it from our own
 * `repos` and `installations` rows), opened with the `runner_pr` token: one repository, metadata and contents read, pull requests
 * write. `createRunPullRequestPort` puts every call through `localOnlyGithub`, so only the allowlist's A1 to A5 ever reach it; this
 * file only translates a request into the installation client's shape.
 */
const METHODS = new Set<string>(["GET", "POST", "PATCH"]);

export function createAppRunPullRequestPort(deps: { open?: typeof openInstallationHttp; appLogin?: (repo: PullRequestRepo) => Promise<string> } = {}): RunPullRequestPort {
  const open = deps.open ?? openInstallationHttp;
  const appLogin = deps.appLogin ?? ((repo: PullRequestRepo) => readRepoAppLogin(repo.id));
  return createRunPullRequestPort({
    appLogin,
    async open(repo) {
      const http = await open("runner_pr", { repoId: repo.id, owner: repo.owner, name: repo.name });
      return {
        request(req: GithubRequest) {
          if (!METHODS.has(req.method)) return Promise.reject(new Error("method_refused"));
          // The client sets its own Accept (application/vnd.github+json), authorization and API version; the caller's headers are not forwarded.
          const out: InstallationHttpRequest = { method: req.method as InstallationHttpRequest["method"], path: req.path, query: req.query, body: req.body };
          return http.request(out);
        },
      };
    },
  });
}

/**
 * D#6 R2b-3f: a continuation's branch head, read at its dispatch through the same port (the default branch, then `RunBranchState`). The
 * answer is the branch's head object id, or null when the branch does not exist yet; anything GitHub cannot answer is a throw.
 */
export function createAppContinuationBase(port: RunPullRequestPort = createAppRunPullRequestPort()): ContinuationBasePort {
  return {
    async headOid({ repo, branch }) {
      const base = await port.defaultBranch(repo);
      const state = await port.branchState({ repo, branch, base });
      return state.exists ? state.headOid : null;
    },
  };
}
