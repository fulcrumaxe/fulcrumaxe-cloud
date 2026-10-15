import type { AppCredentialsSource } from "./appCredentials.js";
import { GH_OWNER_LOGIN_RE, GH_REPO_NAME_RE } from "./eventMapper.js";
import { InstallationTokenCache, InstallationTokenError, MintTimeoutError, getInstallationToken, mintAppJwt, type AccessTokenRequester } from "./installationToken.js";

/**
 * D#598 P1c: the GitHub API calls an executor makes to the paired PUBLIC repo, and nothing else.
 *
 *   mintPushToken   finds the write App's installation on that repo (`GET /repos/<o>/<n>/installation`, as the App) and mints a token
 *                   with the `plane_push` purpose: this one repository, `contents` and `pull_requests` write, and a response from
 *                   GitHub that is checked to say exactly that. An App that is not installed there is `app_not_installed`.
 *   branchExists    `GET /git/ref/heads/<branch>`: a branch that exists is never pushed over.
 *   openPullRequest `POST /pulls`, the one call that makes the pushed branch a pull request.
 *
 * The host is fixed to api.github.com (the origin can be replaced for a test server only through `apiOrigin`, which must be https).
 * Every path is built here from a validated owner, name and branch. Redirects are an error, every call has a timeout, and no error
 * carries a token, a header, a request body or GitHub's text: failures carry a fixed `code` from the route's refusal list.
 */

export type PlanePushApiFailure = "app_not_installed" | "token_scope_mismatch" | "public_unavailable" | "pr_failed";

export class PlanePushApiError extends Error {
  constructor(readonly code: PlanePushApiFailure) {
    super(`planePushApi: ${code}`);
    this.name = "PlanePushApiError";
  }
}

export interface PlanePushApiDeps {
  appCredentials: AppCredentialsSource;
  requester: AccessTokenRequester;
  cache: InstallationTokenCache;
  fetchImpl?: typeof fetch;
  apiOrigin?: string;
  now?: () => number;
}

const CALL_TIMEOUT_MS = 15_000;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,330}$/;

function split(codeRepo: string): { owner: string; name: string } {
  const [owner, name, extra] = codeRepo.split("/");
  if (extra !== undefined || !owner || !name || !GH_OWNER_LOGIN_RE.test(owner) || !GH_REPO_NAME_RE.test(name) || name === "." || name === "..") throw new PlanePushApiError("public_unavailable");
  return { owner, name };
}

export function createPlanePushApi(deps: PlanePushApiDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const origin = new URL(deps.apiOrigin ?? "https://api.github.com");
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.username) throw new Error("planePushApi: apiOrigin must be a plain https origin");

  async function call(method: "GET" | "POST", path: string, auth: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetchImpl(new URL(path, origin), {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${auth}`,
          "user-agent": "fulcrumaxe-cloud",
          "x-github-api-version": "2022-11-28",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      // fx-swallow-ok: replaced by a fixed code; the original's text can carry the request URL
      throw new PlanePushApiError("public_unavailable");
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // fx-swallow-ok: a body that is not JSON reads as null, which every caller treats as "not the shape expected"
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }

  return {
    async mintPushToken(codeRepo: string): Promise<string> {
      const { owner, name } = split(codeRepo);
      const credentials = deps.appCredentials("team");
      const jwt = await mintAppJwt(credentials.appId, credentials.privateKeyPem, deps.now);
      const found = await call("GET", `/repos/${owner}/${name}/installation`, jwt);
      if (found.status === 404) throw new PlanePushApiError("app_not_installed");
      const id = found.status === 200 && found.body !== null && typeof found.body === "object" ? (found.body as { id?: unknown }).id : undefined;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new PlanePushApiError("public_unavailable");
      try {
        return await getInstallationToken({
          installationId: id,
          appKind: "team",
          purpose: "plane_push",
          role: "plane_push",
          scope: { repositories: [name], permissions: { contents: "write", pull_requests: "write" } },
          appCredentials: deps.appCredentials,
          requester: deps.requester,
          cache: deps.cache,
          ...(deps.now ? { now: deps.now } : {}),
        });
      } catch (err) {
        if (err instanceof InstallationTokenError && err.reason === "token_scope_mismatch") throw new PlanePushApiError("token_scope_mismatch");
        // GitHub refuses a mint for a repository the installation does not cover with 404 or 422.
        const status = err instanceof InstallationTokenError ? (err.cause as { status?: unknown } | undefined)?.status : undefined;
        if (status === 404 || status === 422) throw new PlanePushApiError("app_not_installed");
        if (err instanceof MintTimeoutError || err instanceof InstallationTokenError) throw new PlanePushApiError("public_unavailable");
        throw err;
      }
    },

    async branchExists(input: { codeRepo: string; branch: string; token: string }): Promise<boolean> {
      const { owner, name } = split(input.codeRepo);
      if (!BRANCH.test(input.branch) || input.branch.includes("..")) throw new PlanePushApiError("public_unavailable");
      const res = await call("GET", `/repos/${owner}/${name}/git/ref/heads/${input.branch.split("/").map(encodeURIComponent).join("/")}`, input.token);
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      throw new PlanePushApiError("public_unavailable");
    },

    async openPullRequest(input: { codeRepo: string; branch: string; base: string; title: string; body: string; token: string }): Promise<{ number: number; url: string }> {
      const { owner, name } = split(input.codeRepo);
      const res = await call("POST", `/repos/${owner}/${name}/pulls`, input.token, { title: input.title, head: input.branch, base: input.base, body: input.body, maintainer_can_modify: false });
      const b = res.body !== null && typeof res.body === "object" ? (res.body as { number?: unknown; html_url?: unknown }) : {};
      const expectedUrl = new RegExp(`^https://github\\.com/${owner}/${name.replace(/[.]/g, "\\.")}/pull/(\\d+)$`, "i");
      if (res.status !== 201 || typeof b.number !== "number" || !Number.isSafeInteger(b.number) || typeof b.html_url !== "string" || expectedUrl.exec(b.html_url)?.[1] !== String(b.number)) {
        throw new PlanePushApiError(res.status >= 500 || res.status === 429 ? "public_unavailable" : "pr_failed");
      }
      return { number: b.number, url: b.html_url };
    },
  };
}
