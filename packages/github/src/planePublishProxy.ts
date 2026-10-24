import { decidePlanePublish, type ParsedRefUpdates } from "@fx/gh-policy";
import { reportError } from "@fx/telemetry";
import type { AppCredentialsSource } from "./appCredentials.js";
import { getInstallationToken, InstallationTokenError, MintTimeoutError, type AccessTokenRequester, type InstallationTokenCache } from "./installationToken.js";
import { PlanePushApiError } from "./planePushApi.js";
import type { PublishInstallationOwnership } from "./publishInstallationOwnership.js";
import type { PublishTarget, PublishTargetResolver } from "./publishTargetResolver.js";

/**
 * D#598 P1f-4b: one proxied request from a `plane_publish` run, from the resolved run to a minted token.
 *
 * The order is fixed: the publish target is resolved from our rows (a run with no answer is denied before anything else), the rule set in
 * gh-policy judges the request (it replaces `decide()`, which is never called for this role), and only an allowed request mints. Every mint is
 * fresh and is meant for this one request: the caller revokes the token as soon as the upstream call has been made (`revokeAfterUse`).
 * A token for the public repository is a `plane_push` token; a token for the private repository reads its contents and nothing else.
 *
 * Denial reasons are fixed strings. None carries request text, a token or a repository name from the request.
 */

/** What the publish rule set needs from the proxy's dependencies. Both are optional on the proxy; a run that needs one it lacks is denied. */
export interface PlanePublishDeps {
  resolvePublishTarget?: PublishTargetResolver;
  /** Whether the installation GitHub names for the public repository is a live team installation of the account this sandbox's run belongs to (the database decides; see publishInstallationOwnership.ts). */
  ownsPublishInstallation?: PublishInstallationOwnership;
  /** The public repository's mint (`GET /repos/<o>/<n>/installation`, then a fresh `plane_push` mint) and its one-use revoke. */
  planePublishApi?: {
    mintPushToken(codeRepo: string, opts: { ownsInstallation: (ghInstallationId: number) => Promise<boolean> }): Promise<string>;
    revokeToken(token: string): Promise<boolean>;
  };
  appCredentials: AppCredentialsSource;
  tokenCache: InstallationTokenCache;
  accessTokenRequester: AccessTokenRequester;
  now?: () => number;
}

export interface PlanePublishContext {
  method: string;
  path: string;
  query: Record<string, string>;
  sandboxName: string;
  run: { role: string; installationId: number; appKind: string | null; owner: string; repo: string };
  gitRefUpdates?: ParsedRefUpdates;
  pullRequestBody?: Record<string, unknown> | null;
}

export type PlanePublishOutcome =
  | { allow: true; installationToken: string }
  | { allow: false; status: 403 | 502; reason: string };

const deny = (status: 403 | 502, reason: string): PlanePublishOutcome => ({ allow: false, status, reason });

export async function decidePlanePublishRequest(ctx: PlanePublishContext, deps: PlanePublishDeps): Promise<PlanePublishOutcome> {
  const { resolvePublishTarget, planePublishApi, ownsPublishInstallation } = deps;
  if (!resolvePublishTarget || !planePublishApi || !ownsPublishInstallation) return deny(403, "publish_not_configured");

  const target: PublishTarget | null = await resolvePublishTarget(ctx.sandboxName);
  if (!target) return deny(403, "publish_target_not_resolved");

  const decision = decidePlanePublish({
    method: ctx.method,
    path: ctx.path,
    query: ctx.query,
    privateRepo: { owner: ctx.run.owner, repo: ctx.run.repo },
    publishTarget: target,
    ...(ctx.gitRefUpdates ? { gitRefUpdates: ctx.gitRefUpdates } : {}),
    ...(ctx.pullRequestBody !== undefined ? { pullRequestBody: ctx.pullRequestBody } : {}),
  });
  if (!decision.allow) return deny(403, decision.reason);

  try {
    const installationToken =
      decision.side === "public"
        ? // The public repo's installation may be any live team installation of the account this run belongs to; the database resolves the account from the sandbox's run.
          await planePublishApi.mintPushToken(target.codeRepo, { ownsInstallation: (id) => ownsPublishInstallation(ctx.sandboxName, id) })
        : await getInstallationToken({
            installationId: ctx.run.installationId,
            appKind: ctx.run.appKind,
            purpose: "plane_publish_read",
            role: ctx.run.role,
            scope: { repositories: [ctx.run.repo], permissions: { metadata: "read", contents: "read" } },
            appCredentials: deps.appCredentials,
            requester: deps.accessTokenRequester,
            cache: deps.tokenCache,
            ...(deps.now ? { now: deps.now } : {}),
          });
    return { allow: true, installationToken };
  } catch (err) {
    // A mint that timed out, or a GitHub that could not be reached, is an availability failure; everything else is a refused mint.
    if (err instanceof MintTimeoutError || (err instanceof PlanePushApiError && err.code === "public_unavailable")) return deny(502, "upstream_unavailable");
    if (!(err instanceof PlanePushApiError)) reportError(err, { stage: "github.proxy_mint" });
    // Which side and which fixed code (app_not_installed, token_scope_mismatch, ...) is logged; never the error's text.
    console.warn("gh-proxy: publish token mint failed", { side: decision.side, code: err instanceof PlanePushApiError ? err.code : err instanceof InstallationTokenError ? err.reason : "mint_failed" });
    return deny(403, "token_mint_failed");
  }
}
