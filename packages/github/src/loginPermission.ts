import type { RepoPermission } from "@fx/trust";
import type { AppCredentialsSource } from "./appCredentials.js";
import { GH_OWNER_LOGIN_RE, GH_REPO_NAME_RE } from "./eventMapper.js";
import { toPermission } from "./issueAuthorLookup.js";
import { getInstallationToken, type AccessTokenRequester, type InstallationTokenCache } from "./installationToken.js";

/**
 * D#483: one login's real permission on one repository, with the author lookup's token and answer rules (./issueAuthorLookup.ts): a 404 is
 * `none`, anything that is not a definite answer THROWS a fixed message (never naming the login). Nothing is cached.
 */
export interface LoginPermissionDeps {
  resolveInstallation: (repoId: string) => Promise<{ installationId: number; appKind: string } | null>;
  appCredentials: AppCredentialsSource;
  requester: AccessTokenRequester;
  cache: InstallationTokenCache;
  fetchImpl?: typeof fetch;
}

export type LoginPermissionLookup = (input: { repoId: string; owner: string; name: string; login: string; signal?: AbortSignal }) => Promise<RepoPermission>;

const CALL_TIMEOUT_MS = 10_000;

export function createLoginPermissionLookup(deps: LoginPermissionDeps): LoginPermissionLookup {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async ({ repoId, owner, name, login, signal }) => {
    if (!GH_OWNER_LOGIN_RE.test(owner) || !GH_REPO_NAME_RE.test(name)) throw new Error("loginPermission: invalid_coordinates");
    // A login GitHub could not have issued (a bot's `[bot]` suffix included) is no collaborator: no call is made for it.
    if (!GH_OWNER_LOGIN_RE.test(login)) return "none";
    if (signal?.aborted) throw new Error("loginPermission: aborted");
    const installation = await deps.resolveInstallation(repoId);
    if (!installation) throw new Error("loginPermission: no_installation");
    const token = await getInstallationToken({
      installationId: installation.installationId,
      appKind: installation.appKind,
      purpose: "run",
      role: "author_check",
      scope: { repositories: [name], permissions: { metadata: "read", issues: "read" } },
      appCredentials: deps.appCredentials,
      requester: deps.requester,
      cache: deps.cache,
    });
    let res: Response;
    try {
      res = await fetchImpl(`https://api.github.com/repos/${owner}/${name}/collaborators/${encodeURIComponent(login)}/permission`, {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
        redirect: "error",
        signal: signal ? AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), signal]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      throw new Error("loginPermission: request_failed");
    }
    if (res.status === 404) return "none";
    if (res.status !== 200) throw new Error(`loginPermission: permission_failed (${res.status})`);
    return toPermission((await res.json()) as { role_name?: unknown; permission?: unknown } | null);
  };
}
