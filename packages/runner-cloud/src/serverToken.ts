import { RunnerHttpError, type RunnerCloudDeps, type SessionPrincipal } from "./http.js";
import { mintProvisioningToken } from "./provisioningTokens.js";
import { SERVER_TOKEN_REPO_COUNT, SERVER_TOKEN_TTL_SECONDS, type IssuedServerToken } from "./userData.js";

/** A token made for a rented server: the secret (shown once, to be handed to `renderUserData`), the row it is bound to by MC-4, and when it ends. */
export interface ServerProvisioningToken extends IssuedServerToken {
  id: string;
  expiresAt: string;
}

/**
 * D#845 MC-5, S-2: the one way a server's token is made. The life (30 minutes) and the repositories (none) are fixed here, not taken from any caller: a
 * server's token that outlived its boot, or that bound the new machine to a repository, would be a standing credential sitting in `user_data`. It goes
 * through the ordinary mint (an owner or admin of an active account, the five-outstanding limit, the audit row). Binding it to the server row and its IPv4
 * is the create flow's job (`managed_servers.provisioning_token_id`); `register` then refuses any other source address.
 */
export async function mintServerProvisioningToken(deps: RunnerCloudDeps, principal: SessionPrincipal, credentialMode: "subscription" | "api_key"): Promise<ServerProvisioningToken> {
  const res = await mintProvisioningToken(deps, principal, { credential_mode: credentialMode, allowed_repo_ids: [], ttl_seconds: SERVER_TOKEN_TTL_SECONDS });
  const body = res.body as { id?: unknown; token?: unknown; expires_at?: unknown };
  if (res.status !== 201 || typeof body.id !== "string" || typeof body.token !== "string" || typeof body.expires_at !== "string") throw new RunnerHttpError(500, "mint_failed", "the token could not be made");
  return { id: body.id, secret: body.token, ttlSeconds: SERVER_TOKEN_TTL_SECONDS, repoCount: SERVER_TOKEN_REPO_COUNT, expiresAt: body.expires_at };
}
