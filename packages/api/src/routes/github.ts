import { z } from "zod";
import type { Pool } from "pg";
import { CREATE_LIMIT_PER_DAY, CREATE_LIMIT_PER_HOUR, descriptionHash, mintCreateRepoState } from "@fx/core/src/github/createRepoState.js";
import { validateNewRepo } from "@fx/core/src/github/repoName.js";
import { AccountNotActiveError } from "@fx/core/src/tenancy/errors.js";
import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";
import type { RouteEntry } from "../registry.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";
import { ApiError, RateLimitedError } from "../errors.js";
import { buildInstallUrl, GithubAppNotConfiguredError, isInstallationAppKind } from "../github/installUrl.js";
import { platformOpsPool } from "../sse/pools.js";

/** Test seam for the platform_ops pool the create intent's account, installation and quota reads run on. */
export const githubRouteDeps: { getPlatformOpsPool: () => Pool } = { getPlatformOpsPool: platformOpsPool };

/** Loose types on purpose: `validateNewRepo` is the one rule set and names the failing field (`code: "invalid"`). */
const createIntentBodySchema = z
  .object({
    owner_gh_id: z.number().int().positive(),
    name: z.unknown(),
    visibility: z.unknown().optional(),
    description: z.unknown().optional(),
    auto_init: z.unknown().optional(),
  })
  .strict();
const createIntentResponseSchema = z.object({ authorize_url: z.string().url() });

const installUrlResponseSchema = z.object({ url: z.string().url() });

/** Kept a plain optional string so a missing or wrong value gets `code: "invalid"` (C23), not zod's own issue code. */
const installUrlQuerySchema = z.object({ app_kind: z.string().optional() });

/**
 * D#31 API-8c: `GET /api/v1/github/install-url?app_kind=team_readonly|team|sitekit`.
 * Session-only, owner/admin. It only mints the install URL with its signed
 * `state`; the callback that verifies it is not part of this route. No
 * fallback between kinds: `app_kind` is required and each kind reads its own
 * slug env.
 */
export const githubRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/github/install-url",
    operationId: "getInstallUrl",
    sessionLimit: SESSION_LIMITS.githubInstallUrl,
    summary: "The GitHub App install URL for one App kind, carrying a signed state",
    minRole: "admin",
    idempotency: "never",
    rateClass: "read",
    querySchema: installUrlQuerySchema,
    responseSchema: installUrlResponseSchema,
    async handler(ctx, input) {
      const { app_kind: appKind } = (input.query ?? {}) as z.infer<typeof installUrlQuerySchema>;
      if (!isInstallationAppKind(appKind)) {
        throw new ApiError(422, "validation_failed", "request failed validation", [{ path: "app_kind", code: "invalid" }]);
      }
      try {
        const url = buildInstallUrl({ accountId: ctx.principal.accountId, userId: ctx.principal.userId, appKind });
        return { url };
      } catch (err) {
        if (err instanceof GithubAppNotConfiguredError) {
          throw new ApiError(503, "github_app_not_configured", "the GitHub App install is not configured");
        }
        throw err;
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/repos/create-intent",
    operationId: "createRepoIntent",
    sessionLimit: SESSION_LIMITS.githubCreateIntent,
    summary: "Start creating a GitHub repo with the caller's own GitHub authority",
    description:
      "Session only, owner or admin. Validates the request and returns GitHub's user-authorization URL for the team App with a signed state. The repo is created only when the browser comes back through the web callback.",
    extraResponses: {
      "409": "`account_not_active`, or `install_first` when the account has no recorded active team installation.",
      "429": "`rate_limited`: the account used its 10 creations per hour or 50 per day. Carries `Retry-After`.",
      "503": "`github_app_not_configured`.",
    },
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    bodySchema: createIntentBodySchema,
    responseSchema: createIntentResponseSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof createIntentBodySchema>;
      const valid = validateNewRepo({ name: body.name, visibility: body.visibility, description: body.description, autoInit: body.auto_init });
      if (!valid.ok) throw new ApiError(422, "validation_failed", "request failed validation", [{ path: valid.path, code: "invalid" }]);
      const { name, visibility, description, autoInit } = valid.value;

      // The callback URL is on the same origin as the sign-in callback.
      const secret = process.env.GITHUB_INSTALL_STATE_SECRET;
      const clientId = process.env.GITHUB_APP_TEAM_CLIENT_ID;
      let redirectUri: string | undefined;
      try {
        redirectUri = `${new URL(process.env.FX_GITHUB_CALLBACK_URL ?? "").origin}/api/github/create-repo/callback`;
      } catch {
        redirectUri = undefined;
      }
      if (!secret || Buffer.byteLength(secret, "utf8") < 32 || !clientId || !/^[A-Za-z0-9._-]{1,64}$/.test(clientId) || !redirectUri) {
        throw new ApiError(503, "github_app_not_configured", "the GitHub App install is not configured");
      }

      const { accountId, userId } = ctx.principal;
      const gate = await withPlatformOps(githubRouteDeps.getPlatformOpsPool(), async (client) => {
        await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
        const acct = await client.query<{ status: string }>("SELECT status FROM accounts WHERE id = $1 AND deleted_at IS NULL", [accountId]);
        const inst = await client.query(
          `SELECT 1 FROM installations i JOIN installation_installers n ON n.gh_installation_id = i.gh_installation_id AND n.app_kind = i.app_kind
            WHERE i.account_id = $1 AND i.app_kind = 'team' AND n.deleted_at IS NULL AND n.suspended_at IS NULL LIMIT 1`,
          [accountId],
        );
        const counts = await client.query<{ last_hour: string; last_day: string }>("SELECT last_hour, last_day FROM github_repo_create_audit_counts($1, '')", [accountId]);
        return { active: acct.rows[0]?.status === "active", installed: inst.rowCount === 1, hour: Number(counts.rows[0]?.last_hour), day: Number(counts.rows[0]?.last_day) };
      });
      if (!gate.active) throw new AccountNotActiveError(`account ${accountId} is not active`);
      if (!gate.installed) throw new ApiError(409, "install_first", "install the GitHub App on this owner first");
      if (gate.hour >= CREATE_LIMIT_PER_HOUR) throw new RateLimitedError(3600);
      if (gate.day >= CREATE_LIMIT_PER_DAY) throw new RateLimitedError(86_400);

      const state = mintCreateRepoState(
        {
          account_id: accountId,
          user_id: userId,
          owner_gh_id: body.owner_gh_id,
          name,
          visibility,
          description_sha256: descriptionHash(description),
          ...(description ? { description } : {}),
          auto_init: autoInit,
        },
        secret,
      );
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return { authorize_url: url.toString() };
    },
  },
];
