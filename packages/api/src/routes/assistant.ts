import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { DELEGATION_SCOPES, DELEGATION_TTL_MS, approveLink } from "@fx/core/src/tokens/delegation.js";
import { insertApiToken, type Scope as CoreScope } from "@fx/core/src/tokens/service.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import type { RouteEntry } from "../registry.js";
import { ApiError, UnauthenticatedError } from "../errors.js";
import { displayHint, generateToken } from "../tokens/format.js";
import { hashToken } from "../tokens/resolve.js";
import { assertTokensAvailable } from "./tokens.js";

/**
 * D#597 CC-4: the assistant's delegation token and the device link that hands it to a runner. A delegation token is short (an hour at
 * most), bound to one repo and one client, holds only `read` and `corrections:write`, and is an ordinary revocable token in every other
 * respect: it dies with its creator's membership, and its power is its creator's current role. The pipeline stays deterministic; this
 * gives the assistant a way to propose, and a person's confirmation is still what decides.
 */

const clientIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,48}$/);
const mintBodySchema = z.object({ repo_id: z.string().uuid(), client_id: clientIdSchema }).strict();
const tokenSchema = z.object({
  id: z.string().uuid(),
  token: z.string(),
  display_hint: z.string(),
  scopes: z.array(z.enum(["read", "corrections:write"])),
  repo_id: z.string().uuid(),
  client_id: z.string(),
  expires_at: z.string(),
});

const startBodySchema = z.object({ client_id: clientIdSchema }).strict();
const startResponseSchema = z.object({ device_code: z.string(), user_code: z.string(), expires_at: z.string(), interval_seconds: z.number().int() });
const pollBodySchema = z.object({ device_code: z.string().min(20).max(100) }).strict();
const pollResponseSchema = z.object({ status: z.enum(["pending", "expired", "approved"]), token: tokenSchema.omit({ id: true, display_hint: true }).extend({ token_id: z.string().uuid() }).optional() });
const approveBodySchema = z.object({ user_code: z.string().min(8).max(12), repo_id: z.string().uuid() }).strict();
const approveResponseSchema = z.object({ client_id: z.string() });

/** The short code a person types: 8 letters and digits, no I, O, 0 or 1. 32 symbols, so a byte maps without bias. */
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const POLL_INTERVAL_SECONDS = 5;

function newUserCode(): string {
  return [...randomBytes(8)].map((b) => USER_CODE_ALPHABET[b % 32]).join("");
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The anonymous routes' `handler` is never reached (the dispatcher serves `anonymousHandler`); if it ever is, it refuses. */
async function noPrincipal(): Promise<never> {
  throw new UnauthenticatedError();
}

export const assistantRoutes: RouteEntry[] = [
  {
    method: "POST",
    path: "/api/v1/assistant/tokens",
    operationId: "mintAssistantToken",
    summary: "Mint a delegation token for the assistant",
    description:
      "Session only. Returns a token that lasts an hour, is bound to the given repo and client id, holds `read` and `corrections:write`, and can be revoked like any token (`DELETE /api/v1/tokens/{id}`). What it may do is the creator's current role: it dies with their membership, and a member's token cannot accept a correction. The secret appears only in this response.",
    minRole: "member",
    idempotency: "never",
    rateClass: "write",
    bodySchema: mintBodySchema,
    responseSchema: tokenSchema,
    successStatus: 201,
    async handler(ctx, input) {
      assertTokensAvailable();
      const body = input.body as z.infer<typeof mintBodySchema>;
      const plaintext = generateToken();
      const hint = displayHint(plaintext);
      const inserted = await insertApiToken(ctx.pool, {
        accountId: ctx.principal.accountId,
        createdBy: ctx.principal.userId,
        tokenHash: hashToken(plaintext),
        displayHint: hint,
        name: `assistant ${body.client_id}`,
        scopes: [...DELEGATION_SCOPES] as CoreScope[],
        expiresAt: new Date(Date.now() + DELEGATION_TTL_MS),
        delegation: { repoId: body.repo_id, clientId: body.client_id },
      });
      return { id: inserted.id, token: plaintext, display_hint: hint, scopes: [...DELEGATION_SCOPES], repo_id: body.repo_id, client_id: body.client_id, expires_at: inserted.expiresAt };
    },
  },
  {
    method: "POST",
    path: "/api/v1/assistant/link",
    operationId: "startAssistantLink",
    summary: "Start a device link for a runner",
    description:
      "No credential: the runner calls this before it has one. Returns a `device_code` the runner keeps secret and polls with, and a short `user_code` a person approves in a workspace session. The code lasts 10 minutes.",
    principals: [],
    anonymous: true,
    minRole: "member",
    idempotency: "never",
    rateClass: "write",
    bodySchema: startBodySchema,
    responseSchema: startResponseSchema,
    successStatus: 201,
    handler: noPrincipal,
    async anonymousHandler(ctx, input) {
      const body = input.body as z.infer<typeof startBodySchema>;
      for (let attempt = 0; attempt < 3; attempt++) {
        const deviceCode = `fxdl_${randomBytes(32).toString("base64url")}`;
        const userCode = newUserCode();
        try {
          const { rows } = await ctx.pool.query<{ expires_at: Date }>("SELECT assistant_link_start($1, $2, $3) AS expires_at", [sha256(deviceCode), userCode, body.client_id]);
          return { device_code: deviceCode, user_code: userCode, expires_at: rows[0]!.expires_at.toISOString(), interval_seconds: POLL_INTERVAL_SECONDS };
        } catch (err) {
          if ((err as { code?: string }).code !== "23505") throw err; // the short code collided with a live one: draw again
        }
      }
      throw new ApiError(503, "link_unavailable", "could not start a link; try again");
    },
  },
  {
    method: "POST",
    path: "/api/v1/assistant/link/poll",
    operationId: "pollAssistantLink",
    summary: "Poll a device link",
    description:
      "No credential; the `device_code` is the credential. `pending` until a person approves, `expired` after 10 minutes (or when the approver is gone). An approved code is redeemed exactly once: the first poll gets the token, every later one 409 `link_already_redeemed`.",
    principals: [],
    anonymous: true,
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    bodySchema: pollBodySchema,
    responseSchema: pollResponseSchema,
    extraResponses: { "409": "Error `link_already_redeemed`: the token was already handed out." },
    handler: noPrincipal,
    async anonymousHandler(ctx, input) {
      const body = input.body as z.infer<typeof pollBodySchema>;
      const plaintext = generateToken();
      const hint = displayHint(plaintext);
      const { rows } = await ctx.pool.query<{
        outcome: string;
        token_id: string | null;
        token_expires_at: Date | null;
        token_repo_id: string | null;
        token_client_id: string | null;
      }>("SELECT * FROM assistant_link_redeem($1, $2, $3)", [sha256(body.device_code), hashToken(plaintext), hint]);
      const r = rows[0]!;
      if (r.outcome === "pending" || r.outcome === "expired") return { status: r.outcome };
      if (r.outcome === "redeemed") throw new ApiError(409, "link_already_redeemed", "this link was already redeemed");
      if (r.outcome !== "issued" || !r.token_id || !r.token_expires_at || !r.token_repo_id || !r.token_client_id) throw new NotFoundError("link not found");
      return {
        status: "approved",
        token: { token_id: r.token_id, token: plaintext, scopes: [...DELEGATION_SCOPES], repo_id: r.token_repo_id, client_id: r.token_client_id, expires_at: r.token_expires_at.toISOString() },
      };
    },
  },
  {
    method: "POST",
    path: "/api/v1/assistant/link/approve",
    operationId: "approveAssistantLink",
    summary: "Approve a device link",
    description:
      "Session only. Binds the runner's code to one repo of this account; the runner's next poll receives a delegation token created by the caller. 404 for an unknown or expired code and for a repo that is not this account's.",
    minRole: "member",
    idempotency: "never",
    rateClass: "write",
    bodySchema: approveBodySchema,
    responseSchema: approveResponseSchema,
    async handler(ctx, input) {
      assertTokensAvailable();
      const body = input.body as z.infer<typeof approveBodySchema>;
      const client = await approveLink(ctx.pool, ctx.principal, body.user_code.replace(/-/g, "").toUpperCase(), body.repo_id);
      if (client === null) throw new NotFoundError("link code not found");
      return { client_id: client };
    },
  },
];
