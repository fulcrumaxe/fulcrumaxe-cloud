import { getContext } from "@vercel/oidc";
import type { CreateWorkerOptions } from "./compositionRoot.js";

/**
 * D#2 VCREDS: the production source of the sandbox port's Vercel credentials.
 *
 *  - team id    <- env VERCEL_TEAM_ID, project id <- env VERCEL_PROJECT_ID (the same two
 *    names the gh-proxy already requires; this file reads those two keys and no others);
 *  - token      <- the `x-vercel-oidc-token` header of the CURRENT invocation, read on every
 *    `getToken()` call and never held. The memoised worker is shared across invocations, so
 *    it must not keep a token of its own.
 *
 * Deliberately absent: a fallback to the `VERCEL_OIDC_TOKEN` variable (build time only in
 * production) and any refresh (the library's refresh signs in through the local Vercel CLI
 * login, which must never be used here). No header means no token.
 *
 * The SDK replaces the ids it was given with the token's own owner and project claims, so a
 * wrong configured id would be ignored silently. This file therefore checks the claims itself
 * and refuses a token that names another team or project, or that is about to expire.
 *
 * Every error here is a fixed string: no id, variable value or token text is ever in one.
 */

export const CREDENTIALS_NOT_CONFIGURED = "worker: Vercel credentials are not configured";
export const NO_USABLE_TOKEN = "worker: no usable Vercel OIDC token in this invocation";

/**
 * @vercel/sandbox 3.5.1 (dist/api-client/api-client.js:48-64, `expirationBufferMs: 300 * 1e3`)
 * re-checks the token before EVERY request and, once fewer than 300 s remain, asks @vercel/oidc
 * for a fresh one; that refresh signs in through the local Vercel CLI login, which must never be
 * reachable. The port reads the token once per open() and keeps using the sandbox for the rest of
 * the invocation, so a token admitted now must outlast the buffer for as long as the invocation
 * can run.
 */
export const SDK_REFRESH_BUFFER_SECONDS = 300;
/**
 * The longest any function that can use the worker can run: Vercel kills an invocation at its
 * maxDuration. The workflow flow/step routes generate `maxDuration: "max"`, the plan maximum,
 * 800 s on Pro (apps/web/app/.well-known/workflow/v1/config.json, generated at build); the
 * /api/v1 catch-all exports 30; the kick and sweep routes export none (platform default, below
 * the maximum). packages/worker/test/vercelCredentials.test.ts reads the route exports and fails
 * if any could outrun this.
 */
export const MAX_INVOCATION_SECONDS = 800;
export const MARGIN_SECONDS = 60;
/**
 * A token with this many seconds left or fewer is refused (1160 s). Vercel documents a function's
 * OIDC token as reused for up to 90 minutes with a 2 hour TTL (https://vercel.com/docs/oidc), so a
 * real invocation starts with at least about 30 minutes (1800 s) left, well above this.
 */
export const MIN_REMAINING_SECONDS = SDK_REFRESH_BUFFER_SECONDS + MAX_INVOCATION_SECONDS + MARGIN_SECONDS;

export class VercelCredentialsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VercelCredentialsUnavailableError";
  }
}

export interface VercelCredentialsDeps {
  /** The current invocation's request context; defaults to `@vercel/oidc`'s `getContext`. */
  getContext?: () => { headers?: Record<string, string | string[] | undefined> } | undefined;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

type VercelCredentials = CreateWorkerOptions["vercel"];

function named(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The JWT's payload claims, unverified (the token came from our own runtime); undefined if it is not a JWT. */
function claimsOf(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p === "")) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
  } catch {
    // fx-swallow-ok: a token that does not decode is not a JWT, an expected answer; the caller refuses it and the token is never echoed
    return undefined;
  }
}

export function productionVercelCredentials(env: Readonly<Record<string, string | undefined>>, deps: VercelCredentialsDeps = {}): VercelCredentials {
  const teamId = named(env.VERCEL_TEAM_ID);
  const projectId = named(env.VERCEL_PROJECT_ID);
  if (!teamId || !projectId) throw new VercelCredentialsUnavailableError(CREDENTIALS_NOT_CONFIGURED);
  const context = deps.getContext ?? getContext;
  const now = deps.now ?? Date.now;
  return {
    teamId,
    projectId,
    getToken: async () => {
      const header = context()?.headers?.["x-vercel-oidc-token"];
      const claims = typeof header === "string" && header !== "" ? claimsOf(header) : undefined;
      if (
        typeof header !== "string" ||
        !claims ||
        claims.owner_id !== teamId ||
        claims.project_id !== projectId ||
        typeof claims.exp !== "number" ||
        !(claims.exp > now() / 1000 + MIN_REMAINING_SECONDS)
      ) {
        throw new VercelCredentialsUnavailableError(NO_USABLE_TOKEN);
      }
      return header;
    },
  };
}
