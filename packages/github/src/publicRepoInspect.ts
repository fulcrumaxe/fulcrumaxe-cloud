import type { AppCredentialsSource } from "./appCredentials.js";
import { AppCredentialsError } from "./appCredentials.js";
import { GH_OWNER_LOGIN_RE, GH_REPO_NAME_RE } from "./eventMapper.js";
import { getInstallationToken, InstallationTokenError, mintAppJwt, type AccessTokenRequester, type InstallationTokenCache } from "./installationToken.js";
import type { TeamInstallationOwnership } from "./teamInstallationOwnership.js";

/**
 * D#598 PAIR-PICKER-API / PAIR-DEFAULT-BRANCH-CHECK / PAIR-INSTALL-CHECK: what the pairing screens may know about a repo before it is paired.
 *
 *   1. installation  `GET /repos/<o>/<n>/installation` as the write App (its JWT, the same lookup the push makes). The id GitHub returns is used
 *                    ONLY inside this module, and only after our own rows say it is THIS account's live `team` installation. Nothing about a
 *                    repo or installation of anyone else is ever returned: `appInstalled` is true only for the caller's own installation.
 *   2. repository    `GET /repos/<o>/<n>`. When the caller's own installation serves the repo (the write App's, or the stored installation a picker
 *                    candidate came from), the read uses a single-repo `metadata: read` token (purpose `pairing_read`, minted for this read and
 *                    revoked after it). Only a typed name with no installation of this account is read with NO credential, which answers for
 *                    public repos only and spends GitHub's small shared unauthenticated allowance (kept for a minute per repo).
 *
 * A repo that is not public (private, or missing) reads as `not_public` with no branch and `appInstalled: false`, the same for both. A 3xx
 * (a renamed repo) on the REPOSITORY read is `repo_renamed`; on the installation lookup it only means no installation, so a rename can never show through it. A
 * `pairing_read` mint GitHub refuses (403/404/422: the stored installation is suspended or gone) is `installation_unusable`. Any other unclear answer (403/429, 5xx, wrong shape, transport failure, a deadline) is
 * `github_unavailable`: the caller fails closed and never reads it as "not installed" or "not main". The host is fixed, paths are built from a
 * validated owner and name, every call has a timeout, and no error carries GitHub's text. The default branch is returned only when it is a
 * plain branch name; anything else reads as `null`, which is never `main`.
 */
export type PublicRepoInspectFailure = "github_unavailable" | "not_configured" | "repo_renamed" | "installation_unusable";

export class PublicRepoInspectError extends Error {
  constructor(readonly code: PublicRepoInspectFailure) {
    super(`publicRepoInspect: ${code}`);
    this.name = "PublicRepoInspectError";
  }
}

export interface PublicRepoFacts {
  visibility: "public" | "not_public";
  /** A validated branch name, or null (not public, or a name that is not a plain branch name). */
  defaultBranch: string | null;
  /** The caller's own write-App installation serves the repository (never true for anyone else's). */
  appInstalled: boolean;
}

/** A stored installation (from our own rows) that already serves a repo of this account, for a candidate the account installed through either App. */
export interface InstallationHint {
  installationId: number;
  appKind: "team" | "team_readonly";
}

export interface PublicRepoInspectDeps {
  appCredentials: AppCredentialsSource;
  requester: AccessTokenRequester;
  cache: InstallationTokenCache;
  ownsTeamInstallation: TeamInstallationOwnership;
  fetchImpl?: typeof fetch;
  apiOrigin?: string;
  now?: () => number;
}

const CALL_TIMEOUT_MS = 15_000;
/** Anonymous facts are public data that rarely changes; a short memory spares the shared unauthenticated allowance. */
const FACTS_TTL_MS = 60_000;
const MAX_CACHED = 500;
export const PLAIN_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export function splitCodeRepo(codeRepo: string): { owner: string; name: string } {
  const [owner, name, extra] = codeRepo.split("/");
  if (extra !== undefined || !owner || !name || !GH_OWNER_LOGIN_RE.test(owner) || !GH_REPO_NAME_RE.test(name) || name === "." || name === "..") throw new PublicRepoInspectError("github_unavailable");
  return { owner, name };
}

export function createPublicRepoInspector(deps: PublicRepoInspectDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const origin = new URL(deps.apiOrigin ?? "https://api.github.com");
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.username) throw new Error("publicRepoInspect: apiOrigin must be a plain https origin");
  const cache = new Map<string, { at: number; value: Pick<PublicRepoFacts, "visibility" | "defaultBranch"> }>();

  async function call(method: "GET" | "DELETE", path: string, auth: string | undefined, signal?: AbortSignal, redirects: "renamed" | "return" = "renamed"): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetchImpl(new URL(path, origin), {
        method,
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "fulcrumaxe-cloud",
          "x-github-api-version": "2022-11-28",
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        // A redirect is read, never followed: a renamed repo is a named refusal, and no credential is sent anywhere else.
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      // fx-swallow-ok: replaced by a fixed code; the original's text can carry the request URL
      throw new PublicRepoInspectError("github_unavailable");
    }
    if (res.status >= 300 && res.status < 400 && redirects === "renamed") throw new PublicRepoInspectError("repo_renamed");
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // fx-swallow-ok: a body that is not JSON reads as null, which every caller treats as "not the shape expected"
      body = null;
    }
    return { status: res.status, body };
  }

  /** The write App's installation id on the repo, or null on GitHub's 404. The id never leaves this module except through `ownsTeamInstallation`. */
  async function lookupInstallation(owner: string, name: string, signal?: AbortSignal): Promise<number | null> {
    let jwt: string;
    try {
      const credentials = deps.appCredentials("team");
      jwt = await mintAppJwt(credentials.appId, credentials.privateKeyPem, deps.now);
    } catch (err) {
      throw new PublicRepoInspectError(err instanceof AppCredentialsError ? "not_configured" : "github_unavailable");
    }
    // A redirect here (the App sees the repo under an old name) is no installation, never a rename: only the anonymous or covered read may say that.
    const res = await call("GET", `/repos/${owner}/${name}/installation`, jwt, signal, "return");
    if (res.status === 404 || (res.status >= 300 && res.status < 400)) return null;
    const id = res.status === 200 && res.body !== null && typeof res.body === "object" ? (res.body as { id?: unknown }).id : undefined;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new PublicRepoInspectError("github_unavailable");
    return id;
  }

  async function readRepository(owner: string, name: string, source: InstallationHint | null, signal?: AbortSignal): Promise<Pick<PublicRepoFacts, "visibility" | "defaultBranch">> {
    const key = `${owner}/${name}`.toLowerCase();
    const hit = source === null ? cache.get(key) : undefined;
    if (hit && now() - hit.at < FACTS_TTL_MS) return hit.value;
    let token: string | undefined;
    const revoke = async (t: string): Promise<void> => {
      await call("DELETE", "/installation/token", t).catch(() => undefined);
    };
    if (source) {
      try {
        token = await getInstallationToken({
          installationId: source.installationId,
          appKind: source.appKind,
          purpose: "pairing_read",
          role: "pairing_read",
          scope: { repositories: [name], permissions: { metadata: "read" } },
          appCredentials: deps.appCredentials,
          requester: deps.requester,
          cache: deps.cache,
          revoke,
        });
      } catch (err) {
        if (err instanceof AppCredentialsError) throw new PublicRepoInspectError("not_configured");
        // GitHub refusing the mint for this installation (suspended, removed, repo no longer covered) is a fact about the stored row, not an outage.
        const status = err instanceof InstallationTokenError ? (err.cause as { status?: unknown } | undefined)?.status : undefined;
        throw new PublicRepoInspectError(status === 403 || status === 404 || status === 422 ? "installation_unusable" : "github_unavailable");
      }
    }
    let res: { status: number; body: unknown };
    try {
      res = await call("GET", `/repos/${owner}/${name}`, token, signal);
    } finally {
      if (token) await revoke(token);
    }
    let value: Pick<PublicRepoFacts, "visibility" | "defaultBranch">;
    if (res.status === 404) {
      value = { visibility: "not_public", defaultBranch: null };
    } else {
      const b = res.status === 200 && res.body !== null && typeof res.body === "object" ? (res.body as { private?: unknown; full_name?: unknown; default_branch?: unknown }) : null;
      if (!b || typeof b.private !== "boolean" || typeof b.full_name !== "string" || b.full_name.toLowerCase() !== key) throw new PublicRepoInspectError("github_unavailable");
      const branch = typeof b.default_branch === "string" && PLAIN_BRANCH.test(b.default_branch) && !b.default_branch.includes("..") ? b.default_branch : null;
      value = b.private ? { visibility: "not_public", defaultBranch: null } : { visibility: "public", defaultBranch: branch };
    }
    if (source === null) {
      if (cache.size >= MAX_CACHED) cache.clear();
      cache.set(key, { at: now(), value });
    }
    return value;
  }

  return {
    /**
     * Facts about one repo for `accountId`. The installation lookup comes first because it decides which credential the read may use; its
     * result is never returned unless it is the account's own. `hint` is an installation of this account that already serves the repo.
     */
    async inspect(codeRepo: string, accountId: string, opts: { hint?: InstallationHint; signal?: AbortSignal } = {}): Promise<PublicRepoFacts> {
      const { owner, name } = splitCodeRepo(codeRepo);
      const found = await lookupInstallation(owner, name, opts.signal);
      const owned = found !== null && (await deps.ownsTeamInstallation(accountId, found));
      const source: InstallationHint | null = owned ? { installationId: found, appKind: "team" } : (opts.hint ?? null);
      const facts = await readRepository(owner, name, source, opts.signal);
      return facts.visibility === "public" ? { ...facts, appInstalled: owned } : { visibility: "not_public", defaultBranch: null, appInstalled: false };
    },
  };
}

export type PublicRepoInspector = ReturnType<typeof createPublicRepoInspector>;
