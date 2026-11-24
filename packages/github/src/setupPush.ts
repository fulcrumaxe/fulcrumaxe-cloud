import type { AppCredentialsSource } from "./appCredentials.js";
import { GH_OWNER_LOGIN_RE, GH_REPO_NAME_RE } from "./eventMapper.js";
import { getInstallationToken, SETUP_PUSH_PERMISSIONS, type AccessTokenRequester, type InstallationTokenCache } from "./installationToken.js";

/**
 * D#845 ON-8f: the one credential of a project setup's push. `mint` finds the repository's own installation (our `repos` and `installations` rows) and mints a `setup_push` token: this one repository, `contents: write` and
 * `metadata: read`, a response from GitHub that is checked to say exactly that, fresh every time and never cached. It is handed to the runner, which pushes outside any sandbox and revokes it (`DELETE /installation/token`);
 * `revoke` is the cloud's own for a token it minted and could not hand out. Nothing here keeps a token, and a failure carries no GitHub text.
 */
export interface SetupPushPort {
  mint(repo: { id: string; owner: string; name: string }): Promise<{ token: string; expiresAt: Date }>;
  revoke(token: string): Promise<void>;
}

export class SetupPushError extends Error {
  constructor(readonly code: "app_not_installed" | "invalid_repo") {
    super(`setupPush: ${code}`);
    this.name = "SetupPushError";
  }
}

export interface SetupPushDeps {
  resolveInstallation: (repoId: string) => Promise<{ installationId: number; appKind: string } | null>;
  appCredentials: AppCredentialsSource;
  requester: AccessTokenRequester;
  cache: InstallationTokenCache;
  fetchImpl?: typeof fetch;
}

export function createSetupPushPort(deps: SetupPushDeps): SetupPushPort {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const revoke = async (token: string): Promise<void> => {
    try {
      await fetchImpl("https://api.github.com/installation/token", {
        method: "DELETE",
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "fulcrumaxe-cloud", "x-github-api-version": "2022-11-28" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // fx-swallow-ok: a revoke that cannot be made leaves the token to lapse at GitHub's own expiry
    }
  };
  return {
    revoke,
    async mint(repo) {
      if (!GH_OWNER_LOGIN_RE.test(repo.owner) || !GH_REPO_NAME_RE.test(repo.name)) throw new SetupPushError("invalid_repo");
      const installation = await deps.resolveInstallation(repo.id);
      if (!installation) throw new SetupPushError("app_not_installed");
      let expiresAtMs = 0;
      const token = await getInstallationToken({
        installationId: installation.installationId,
        appKind: installation.appKind,
        purpose: "setup_push",
        role: "setup_push",
        scope: { repositories: [repo.name], permissions: SETUP_PUSH_PERMISSIONS },
        appCredentials: deps.appCredentials,
        requester: deps.requester,
        cache: deps.cache,
        fresh: true,
        revoke,
        onExpiry: (ms) => {
          expiresAtMs = ms;
        },
      });
      return { token, expiresAt: new Date(expiresAtMs) };
    },
  };
}
