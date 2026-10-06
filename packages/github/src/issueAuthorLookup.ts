import type { IssueAuthorLookup, IssueAuthorResult } from "@fx/core/src/runActions/authorCheck.js";
import type { RepoPermission } from "@fx/trust";
import type { AppCredentialsSource } from "./appCredentials.js";
import { GH_OWNER_LOGIN_RE, GH_REPO_NAME_RE } from "./eventMapper.js";
import { getInstallationToken, type AccessTokenRequester, type InstallationTokenCache } from "./installationToken.js";

/**
 * D#31 API-6b-3: the GitHub side of the retry author check. Two reads per
 * external work item, with a read-only, single-repo installation token:
 * the issue (its author's login, resolved by GitHub so a rename or a deleted
 * account reads correctly) and that login's repository permission.
 *
 * Every failure that is not a definite answer THROWS, and the caller turns a
 * throw into "unavailable", never "trusted". A 404 on the issue is `missing`;
 * a 404 on the permission call is `none`. The login never appears in a thrown
 * message or a warn line, and the token never carries contents or any write.
 */
export interface IssueAuthorLookupDeps {
  /** The installation that serves a repo, from our own rows. Null when the repo has no usable installation. */
  resolveInstallation: (repoId: string) => Promise<{ installationId: number; appKind: string } | null>;
  appCredentials: AppCredentialsSource;
  requester: AccessTokenRequester;
  cache: InstallationTokenCache;
  fetchImpl?: typeof fetch;
}

const CALL_TIMEOUT_MS = 10_000;
const KNOWN_PERMISSIONS: readonly RepoPermission[] = ["admin", "maintain", "write", "triage", "read", "none"];

export function toPermission(body: { role_name?: unknown; permission?: unknown } | null): RepoPermission {
  for (const candidate of [body?.role_name, body?.permission]) {
    if (typeof candidate === "string" && (KNOWN_PERMISSIONS as readonly string[]).includes(candidate)) return candidate as RepoPermission;
  }
  return "none";
}

export function createIssueAuthorLookup(deps: IssueAuthorLookupDeps): IssueAuthorLookup {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function get(url: string, token: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetchImpl(url, {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
        redirect: "error",
        signal: signal ? AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), signal]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      // A fixed message: the request URL (and so the login) must not reach an error or a log.
      throw new Error("issueAuthorLookup: request_failed");
    }
  }

  return async ({ repoId, owner, name, number, signal }): Promise<IssueAuthorResult> => {
    if (!GH_OWNER_LOGIN_RE.test(owner) || !GH_REPO_NAME_RE.test(name) || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error("issueAuthorLookup: invalid_coordinates");
    }
    if (signal?.aborted) throw new Error("issueAuthorLookup: aborted");
    const installation = await deps.resolveInstallation(repoId);
    if (!installation) throw new Error("issueAuthorLookup: no_installation");
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

    const repoPath = `https://api.github.com/repos/${owner}/${name}`;
    const issue = await get(`${repoPath}/issues/${number}`, token, signal);
    if (issue.status === 404) return { status: "missing" };
    if (issue.status !== 200) throw new Error(`issueAuthorLookup: issue_failed (${issue.status})`);
    const issueBody = (await issue.json()) as { user?: { login?: unknown } | null } | null;
    const login = issueBody?.user?.login;
    if (typeof login !== "string" || login.length === 0) return { status: "missing" };

    const perm = await get(`${repoPath}/collaborators/${encodeURIComponent(login)}/permission`, token, signal);
    if (perm.status === 404) return { status: "found", login, permission: "none" };
    if (perm.status !== 200) throw new Error(`issueAuthorLookup: permission_failed (${perm.status})`);
    return { status: "found", login, permission: toPermission((await perm.json()) as { role_name?: unknown; permission?: unknown } | null) };
  };
}
