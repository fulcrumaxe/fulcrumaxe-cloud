import { z } from "zod";
import {
  assertScopesAllowedForRole,
  expiresAtFromDays,
  insertApiToken,
  listApiTokens,
  revokeAllMine,
  revokeToken,
  type Scope as CoreScope,
} from "@fx/core/src/tokens/service.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import type { RouteEntry } from "../registry.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import { SessionRequiredError, TokensNotAvailableError } from "../errors.js";
import { displayHint, generateToken } from "../tokens/format.js";
import { hashToken } from "../tokens/resolve.js";
import { TOKEN_GA_BLOCKERS } from "../tokens/ga-blockers.js";

const scopeSchema = z.enum(["read", "runs:cancel", "audit:read", "work_items:write", "discussions:write", "corrections:write"]);

/**
 * D#31 C20 criterion 3. 1-64 Unicode CODE POINTS (not UTF-16 units). The
 * name is stored exactly as sent, so anything that would need trimming or
 * cleaning is refused instead. Deliberately no message text: a zod issue's
 * `code` and `path` are all the 422 envelope carries, so the submitted
 * value can never be echoed.
 */
const NAME_MAX_CODE_POINTS = 64;
// C0 (U+0000-001F), DEL, C1 (U+0080-009F), bidi embedding/override
// (U+202A-202E) and isolate (U+2066-2069) controls, U+2028/U+2029, and lone
// surrogates (Postgres cannot store them byte for byte).
const NAME_FORBIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029]|\p{Surrogate}/u;
const NAME_EDGE_WHITESPACE_RE = /^[\s\p{White_Space}]|[\s\p{White_Space}]$/u;

const tokenNameSchema = z
  .string()
  .refine((n) => {
    const length = [...n].length;
    return length >= 1 && length <= NAME_MAX_CODE_POINTS;
  })
  .refine((n) => !NAME_EDGE_WHITESPACE_RE.test(n))
  .refine((n) => !NAME_FORBIDDEN_RE.test(n));

const tokenListItemSchema = z.object({
  id: z.string().uuid(),
  display_hint: z.string(),
  name: z.string().nullable(),
  scopes: z.array(scopeSchema),
  created_by: z.string().uuid(),
  /** True exactly when `created_by` is the session principal's user id; computed per request, not stored. */
  created_by_me: z.boolean(),
  expires_at: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

/** "The create response is the only place the secret appears" (criterion 2) -- `token` never appears on any other schema in this file. */
const createTokenResponseSchema = z.object({
  id: z.string().uuid(),
  token: z.string(),
  display_hint: z.string(),
  name: z.string().nullable(),
  scopes: z.array(scopeSchema),
  expires_at: z.string(),
  created_at: z.string(),
});

const createTokenBodySchema = z.object({
  scopes: z.array(scopeSchema).min(1),
  name: tokenNameSchema.nullable().optional(),
  // Criterion 8: 0 or 366 -> 422 (min/max reject both); omitted -> legal.
  expires_in_days: z.number().int().min(1).max(365).optional(),
});

const listTokensResponseSchema = z.object({
  data: z.array(tokenListItemSchema),
  next_cursor: z.string().nullable(),
});

const listTokensQuerySchema = z.object({
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

const revokeMineResponseSchema = z.object({ revoked: z.number().int() });

const tokenIdParamsSchema = z.object({ id: z.string() });

/** Criterion 12 + C13b: production minting needs FX_API_TOKENS_ENABLED="1" AND an empty blocker list. Exported so a test can inject a list directly. */
export function assertTokensAvailable(blockers: readonly string[] = TOKEN_GA_BLOCKERS): void {
  if (process.env.NODE_ENV === "production") {
    if (process.env.FX_API_TOKENS_ENABLED !== "1" || blockers.length > 0) {
      throw new TokensNotAvailableError();
    }
  }
}

/** "The v1 contract" > route table: `POST /api/v1/tokens`, `GET /api/v1/tokens`, `POST /api/v1/tokens/revoke-mine` | S, member; `DELETE /api/v1/tokens/{id}` | S (own; any for owner/admin), or a token deleting itself. */
export const tokenRoutes: RouteEntry[] = [
  {
    method: "POST",
    path: "/api/v1/tokens",
    operationId: "createToken",
    summary: "Mint a new API token",
    // principals omitted -> session-only default.
    minRole: "member",
    idempotency: "never", // a route returning a secret rejects Idempotency-Key.
    rateClass: "write",
    bodySchema: createTokenBodySchema,
    responseSchema: createTokenResponseSchema,
    successStatus: 201,
    async handler(ctx, input) {
      assertTokensAvailable();
      // A reserved scope already 422s via createTokenBodySchema's z.enum.
      const body = input.body as z.infer<typeof createTokenBodySchema>;
      assertScopesAllowedForRole(body.scopes, ctx.principal.role);

      const plaintext = generateToken();
      const hint = displayHint(plaintext);
      const expiresAt = expiresAtFromDays(body.expires_in_days);
      const inserted = await insertApiToken(ctx.pool, {
        accountId: ctx.principal.accountId,
        createdBy: ctx.principal.userId,
        tokenHash: hashToken(plaintext),
        displayHint: hint,
        scopes: body.scopes as CoreScope[],
        expiresAt,
        name: body.name ?? null,
      });

      return {
        id: inserted.id,
        token: plaintext,
        display_hint: hint,
        name: body.name ?? null,
        scopes: body.scopes,
        expires_at: expiresAt.toISOString(),
        created_at: inserted.createdAt,
      };
    },
  },
  {
    method: "GET",
    path: "/api/v1/tokens",
    operationId: "listTokens",
    summary: "The caller's tokens (every token in the account for owner/admin)",
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    querySchema: listTokensQuerySchema,
    responseSchema: listTokensResponseSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof listTokensQuerySchema>;
      const limit = parseLimit(query.limit);
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const result = await listApiTokens(
        ctx.pool,
        { accountId: ctx.principal.accountId, userId: ctx.principal.userId },
        { limit, cursor: cursor ? { createdAt: cursor.created_at, id: cursor.id } : undefined },
      );
      return {
        data: result.data.map((t) => ({
          id: t.id,
          display_hint: t.displayHint,
          name: t.name,
          scopes: t.scopes,
          created_by: t.createdBy,
          created_by_me: t.createdBy === ctx.principal.userId,
          expires_at: t.expiresAt,
          created_at: t.createdAt,
          last_used_at: t.lastUsedAt,
          revoked_at: t.revokedAt,
        })),
        next_cursor: result.nextCursor ? encodeCursor(result.nextCursor.createdAt, result.nextCursor.id) : null,
      };
    },
  },
  {
    method: "POST",
    path: "/api/v1/tokens/revoke-mine",
    operationId: "revokeMyTokens",
    summary: "Revoke every token the caller created",
    minRole: "member",
    idempotency: "never",
    rateClass: "write",
    responseSchema: revokeMineResponseSchema,
    async handler(ctx) {
      const revoked = await revokeAllMine(ctx.pool, ctx.principal.accountId, ctx.principal.userId);
      return { revoked };
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/tokens/{id}",
    operationId: "deleteToken",
    summary: "Revoke a single token (a token principal may only delete itself)",
    principals: ["session", "token"],
    tokenSelfOnly: true,
    minRole: "member",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: tokenIdParamsSchema,
    responseSchema: z.null(),
    successStatus: 204,
    async handler(ctx, input) {
      const targetId = input.params.id!;
      // Criterion 9: a token deleting another id -> 403 session_required
      // (not insufficient_scope -- tokenSelfOnly admits any token here).
      if (ctx.principal.kind === "token" && ctx.principal.tokenId !== targetId) {
        throw new SessionRequiredError();
      }
      const revoked = await revokeToken(
        ctx.pool,
        {
          accountId: ctx.principal.accountId,
          userId: ctx.principal.userId,
          tokenId: ctx.principal.kind === "token" ? ctx.principal.tokenId : undefined,
        },
        targetId,
        "user_requested",
      );
      if (!revoked) {
        // Criterion 9 (CWE-639): RLS already collapsed "another's
        // token"/"cross-tenant"/"nonexistent" into zero rows -> 404.
        throw new NotFoundError(`token ${targetId} not found`);
      }
      return null;
    },
  },
];
