import { classifyAuthor, type RepoPermission } from "@fx/trust";
import type { GitHubHttp } from "./githubMergePort.js";
import type { PullRequestAuthorTrust, MergeGateDeps } from "./mergeGate.js";

/**
 * D#598 P1d-1 (R-P1d-3, R-P1d-5): who may have their pull request merged by the platform. Trust comes from identity only, in this order:
 *  (a) the platform's own App bot accounts, then (b) the intake allowlist: neither costs a GitHub call;
 *  (c) `admin` or `maintain` on the repository the pull request is in, read live on each run from `collaborators/{login}/permission` and never stored.
 * `write` does not count (`allowWritePermission` is fixed off), and a missing or blank login never does.
 *
 * Fail closed: anything but a definite answer (5xx, 429, timeout, transport failure, a refused path, a body naming no permission) is `unverified`: the merge stops now
 * and the next run asks again. A fenced `runner_local` client does not list this path and it is not widened: a non-bot author there is `unverified`, with no request.
 */
export interface PullRequestAuthorTrustDeps {
  http: GitHubHttp;
  owner: string;
  name: string;
  /** `runner_local`: the client is the local-only fence; make no read at all. */
  fenced: boolean;
  /** The platform's App bot logins (`<slug>[bot]`). A throw means they could not be read. */
  botLogins(): Promise<readonly string[]>;
  /** The intake allowlist (null reads as empty). */
  allowlist(): readonly string[] | null;
}

/** The shape GitHub gives a user or organisation login (a bot's `[bot]` login is not one, so it never reaches the permission read). */
const LOGIN_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const KNOWN: readonly string[] = ["admin", "maintain", "write", "triage", "read", "none"];

/** `role_name` is the exact role (maintain and triage included); the older `permission` folds them into write and read. */
function permissionOf(body: unknown): RepoPermission | null {
  if (typeof body !== "object" || body === null) return null;
  for (const candidate of [(body as { role_name?: unknown }).role_name, (body as { permission?: unknown }).permission]) {
    if (typeof candidate === "string" && KNOWN.includes(candidate)) return candidate as RepoPermission;
  }
  return null;
}

export function createPullRequestAuthorTrust(deps: PullRequestAuthorTrustDeps): NonNullable<MergeGateDeps["pullRequestAuthorTrust"]> {
  return async (_pr, { login }): Promise<PullRequestAuthorTrust> => {
    if (login === null || login.trim() === "") return "untrusted";
    let botsKnown = true;
    let bots: readonly string[] = [];
    try {
      bots = await deps.botLogins();
    } catch {
      // fx-swallow-ok: the bot logins only widen trust; when they cannot be read the other two rules still apply and the answer below is `unverified`, never trusted
      botsKnown = false;
    }
    if (classifyAuthor({ login, repoPermission: null, allowlist: [...bots, ...(deps.allowlist() ?? [])] }) === "trusted") return "trusted";
    if (deps.fenced) return "unverified";
    if (!LOGIN_RE.test(login)) return botsKnown ? "untrusted" : "unverified";
    let permission: RepoPermission | null;
    try {
      const res = await deps.http.request({ method: "GET", path: `/repos/${deps.owner}/${deps.name}/collaborators/${encodeURIComponent(login)}/permission` });
      // 404 is GitHub's answer for a user with no access at all.
      permission = res.status === 404 ? "none" : res.status === 200 ? permissionOf(res.body) : null;
    } catch {
      // fx-swallow-ok: a failed read is `unverified`; the error can carry the request path, which holds the login
      return "unverified";
    }
    if (permission === null) return "unverified";
    if (classifyAuthor({ login, repoPermission: permission, allowlist: [], allowWritePermission: false }) === "trusted") return "trusted";
    return botsKnown ? "untrusted" : "unverified";
  };
}
