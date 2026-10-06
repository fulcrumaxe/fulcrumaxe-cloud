import type { Pool } from "pg";
import { z } from "zod";
import { createPool } from "@fx/db/src/pool.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import {
  connect,
  envKekSource,
  fetchValidationHttpClient,
  getStatus,
  InvalidModelKeyError,
  remove,
  test as testConnection,
  type ConnectionStatusView,
  type KekSource,
  type ModelConnectionCtx,
  type ValidationHttpClient,
} from "@fx/model-connection";
import type { RouteContext, RouteEntry } from "../registry.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";
import { ApiError } from "../errors.js";

/**
 * D#31 API-2: `GET|PUT|DELETE /api/v1/model-connection` and
 * `POST /api/v1/model-connection/test`, thin wrappers over the H21
 * service (`@fx/model-connection`: getStatus / connect / remove / test).
 *
 * The customer's model key is a secret. It enters this file exactly once,
 * in the PUT body, and is handed straight to `connect()`. Nothing here
 * returns, logs, audits or stores it: every response is the frozen
 * status DTO below (a display fingerprint, never the key), and every
 * error is built from fixed text plus a code from a closed list, never
 * from the submitted value or from upstream error text.
 *
 * GET is `S+T(read)`, any member. The three mutations are session-only
 * (`principals` omitted -> the registry's session-only default) and
 * owner/admin (`minRole: "admin"` ranks admin and owner alike).
 *
 * SSRF: the caller never supplies a URL or host. `provider` is a closed
 * enum, and the service maps each provider to one hardcoded HTTPS host
 * (redirects refused), so `/test` can only ever call those two hosts.
 */

const providerSchema = z.enum(["ai_gateway", "anthropic"]);

/** The frozen C6 status DTO -- the only shape this file ever returns. */
export const modelConnectionResponseSchema = z.object({
  provider: providerSchema,
  fingerprint: z.string(),
  status: z.enum(["unvalidated", "ok", "broken"]),
  last_validated_at: z.string().nullable(),
  last_error_code: z.string().nullable(),
});

const putModelConnectionBodySchema = z.object({
  provider: providerSchema,
  key: z.string(),
});

/**
 * Dependencies the service needs beyond the request context. The
 * catch-all hands a route only `{pool, principal}`, so the platform_ops
 * pool, the KEK and the provider HTTP client are resolved here: from the
 * same env vars the catch-all itself reads, or from a test override.
 */
export interface ModelConnectionDeps {
  platformOpsPool: Pool;
  kek: KekSource;
  httpClient: ValidationHttpClient;
}

let overrides: Partial<ModelConnectionDeps> = {};
let cachedPlatformOpsPool: Pool | undefined;

/** Test seam: replace any dependency (the fake provider client, a fake KEK, the test's pool). Pass `{}` to reset. */
export function setModelConnectionDeps(next: Partial<ModelConnectionDeps>): void {
  overrides = next;
}

function platformOpsPool(): Pool {
  if (overrides.platformOpsPool) return overrides.platformOpsPool;
  if (!cachedPlatformOpsPool) {
    const url = process.env.DATABASE_URL_PLATFORM_OPS;
    if (!url) {
      throw new Error("DATABASE_URL_PLATFORM_OPS must be set");
    }
    cachedPlatformOpsPool = createPool(url);
  }
  return cachedPlatformOpsPool;
}

/**
 * The three extra dependencies are getters so a route resolves only what
 * it uses: `getStatus` (the GET) touches none of them, so it never needs
 * the platform_ops URL or the KEK to be configured.
 */
function serviceCtx(ctx: RouteContext): ModelConnectionCtx {
  return {
    pool: ctx.pool,
    principal: { accountId: ctx.principal.accountId, userId: ctx.principal.userId },
    get platformOpsPool() {
      return platformOpsPool();
    },
    get kek() {
      return overrides.kek ?? envKekSource();
    },
    get httpClient() {
      return overrides.httpClient ?? fetchValidationHttpClient();
    },
  };
}

function toDto(view: ConnectionStatusView): z.infer<typeof modelConnectionResponseSchema> {
  return {
    provider: view.provider,
    fingerprint: view.fingerprint,
    status: view.status,
    last_validated_at: view.last_validated_at ? view.last_validated_at.toISOString() : null,
    last_error_code: view.last_error_code,
  };
}

/** Codes the service raises for a key or provider it will not store. Anything else (a provider's own status code) is folded into `rejected`. */
const KEY_FORMAT_CODES = new Set(["invalid_key_format"]);
const PROVIDER_CODES = new Set(["invalid_provider", "provider_disabled"]);

/**
 * `InvalidModelKeyError` -> 422 `invalid_model_key`. The message is fixed
 * and the only variable part is a code from a closed set: the service's
 * own message text is deliberately not forwarded.
 */
function invalidKeyError(err: InvalidModelKeyError): ApiError {
  if (PROVIDER_CODES.has(err.providerCode)) {
    return new ApiError(422, "invalid_model_key", "the model provider is not available", [
      { path: "provider", code: err.providerCode },
    ]);
  }
  const code = KEY_FORMAT_CODES.has(err.providerCode) ? err.providerCode : "rejected";
  return new ApiError(422, "invalid_model_key", "the model key was not accepted", [{ path: "key", code }]);
}

async function currentDto(ctx: ModelConnectionCtx): Promise<z.infer<typeof modelConnectionResponseSchema>> {
  const view = await getStatus(ctx);
  if (!view) {
    throw new NotFoundError("no model connection");
  }
  return toDto(view);
}

export const modelConnectionRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/model-connection",
    operationId: "getModelConnection",
    summary: "The account's model connection (provider, fingerprint, status; never the key)",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    responseSchema: modelConnectionResponseSchema,
    async handler(ctx) {
      return currentDto(serviceCtx(ctx));
    },
  },
  {
    method: "PUT",
    path: "/api/v1/model-connection",
    operationId: "putModelConnection",
    sessionLimit: SESSION_LIMITS.modelKeyPut,
    summary: "Connect or replace the account's model key",
    // principals omitted -> session-only: a token may never write a key.
    minRole: "admin",
    idempotency: "never", // a route carrying a secret rejects Idempotency-Key.
    rateClass: "write",
    bodySchema: putModelConnectionBodySchema,
    responseSchema: modelConnectionResponseSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof putModelConnectionBodySchema>;
      const svc = serviceCtx(ctx);
      try {
        return toDto(await connect(svc, { provider: body.provider, key: body.key }));
      } catch (err) {
        if (err instanceof InvalidModelKeyError) {
          throw invalidKeyError(err);
        }
        throw err;
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/model-connection",
    operationId: "deleteModelConnection",
    summary: "Remove the account's model key",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    responseSchema: z.null(),
    successStatus: 204,
    async handler(ctx) {
      await remove(serviceCtx(ctx));
      return null;
    },
  },
  {
    method: "POST",
    path: "/api/v1/model-connection/test",
    operationId: "testModelConnection",
    sessionLimit: SESSION_LIMITS.modelKeyTest,
    summary: "Re-validate the stored key against its provider",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    responseSchema: modelConnectionResponseSchema,
    async handler(ctx) {
      const svc = serviceCtx(ctx);
      // test() records the outcome (ok / broken / unreachable) on the row;
      // the response is the resulting status, not the provider's answer.
      await testConnection(svc);
      return currentDto(svc);
    },
  },
];
