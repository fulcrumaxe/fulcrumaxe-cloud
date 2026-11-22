import { z } from "zod";
import type { RouteContext, RouteEntry } from "../registry.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";
import { ApiError } from "../errors.js";
import { createServer, getServer, quoteServer, type ServerCtx } from "../machines/servers.js";
import { mapError } from "./machine-credential.js";

/**
 * D#845 MC-4: quote and create a Hetzner Cloud server. All three routes are session-only (`principals` omitted: an API token gets 403) and owner or admin.
 * The quote and the create open the person's stored Hetzner token, so each is rate-limited as the credential route is.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY = /^[0-9]{1,6}(\.[0-9]{1,6})?$/;
const TYPE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const LOCATION = /^[a-z0-9][a-z0-9._-]{0,15}$/;
/** Hetzner server names are host names. */
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const priceSchema = z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/), hourly_gross: z.string().regex(MONEY), monthly_gross: z.string().regex(MONEY), ipv4_monthly_gross: z.string().regex(MONEY) });
const createBody = z.strictObject({
  server_type: z.string().regex(TYPE),
  location: z.string().regex(LOCATION),
  name: z.string().regex(NAME).optional(),
  ssh_key_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  quoted: priceSchema,
});
const quoteQuery = z.strictObject({ server_type: z.string().regex(TYPE), location: z.string().regex(LOCATION) });
const idParams = z.object({ id: z.string() });

export const serverQuoteSchema = priceSchema.extend({
  tier: z.literal("standard"),
  tier_notice: z.string(),
  billed_by: z.string(),
  server_type: z.string(),
  location: z.string(),
  available: z.boolean(),
});
export const serverSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.literal("hetzner_cloud"),
  status: z.string(),
  server_type: z.string().nullable(),
  location: z.string().nullable(),
  public_ipv4: z.string().nullable(),
  failure_code: z.string().nullable(),
  price: priceSchema,
  created_at: z.string(),
});

const serverCtx = (ctx: RouteContext): ServerCtx => ({ pool: ctx.pool, principal: { accountId: ctx.principal.accountId, userId: ctx.principal.userId } });
const EXTRA = {
  "409": "Error `price_changed`: the live price differs from `quoted` by any amount; nothing was created, and `data.live` holds the live price. Other 409s are `hetzner_*` codes (limit reached, size not available, name used) and `credential_invalid`.",
  "503": "Error `price_unavailable` or a `hetzner_*` code: Hetzner did not answer, and no price is shown. `not_configured` and `machine_kek_unset` mean Hetzner Cloud servers are off here.",
};

export const machineServerRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/machine-servers/quote",
    operationId: "quoteHetznerServer",
    summary: "The live price of a Hetzner Cloud server (hourly, monthly and IPv4, gross), with the standard-tier statement that comes before it",
    description: "Session only, owner or admin. Read from Hetzner on every call; there is no cached or guessed price, and with Hetzner down the answer is 503 with none.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "read",
    sessionLimit: SESSION_LIMITS.machineServerQuote,
    querySchema: quoteQuery,
    responseSchema: serverQuoteSchema,
    extraResponses: EXTRA,
    async handler(ctx, input) {
      const q = input.query as z.infer<typeof quoteQuery>;
      try {
        return await quoteServer(serverCtx(ctx), { serverType: q.server_type, location: q.location });
      } catch (err) {
        throw mapError(err);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/machine-servers",
    operationId: "createHetznerServer",
    summary: "Create a Hetzner Cloud server with the stored token, at the price the person was shown",
    description:
      "Session only, owner or admin. Needs an `Idempotency-Key`: the same key answers the server the first request made and creates nothing more (the answer carries `Idempotent-Replayed: true`). " +
      "`quoted` must equal the live price; any difference is 409 `price_changed` and nothing is created. A failure part way undoes what was made (firewall, token, server) and leaves the row `failed`.",
    minRole: "admin",
    idempotency: "required",
    rateClass: "write",
    sessionLimit: SESSION_LIMITS.machineServerCreate,
    bodySchema: createBody,
    responseSchema: serverSchema,
    successStatus: 201,
    extraResponses: EXTRA,
    async handler(ctx, input) {
      const b = input.body as z.infer<typeof createBody>;
      if (!ctx.idempotencyKey) throw new ApiError(400, "idempotency_key_required", "an Idempotency-Key is required");
      try {
        const out = await createServer(serverCtx(ctx), {
          idempotencyKey: ctx.idempotencyKey, serverType: b.server_type, location: b.location, quoted: b.quoted,
          ...(b.name === undefined ? {} : { name: b.name }), ...(b.ssh_key_id === undefined ? {} : { sshKeyId: b.ssh_key_id }),
        });
        if (out.reused) ctx.markReplayed?.();
        return out.server;
      } catch (err) {
        throw mapError(err);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v1/machine-servers/{id}",
    operationId: "getHetznerServer",
    summary: "One Hetzner Cloud server of this account",
    description: "Session only, owner or admin. A malformed id is 400 `invalid_request`; an id that is not this account's is 404.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParams,
    responseSchema: serverSchema,
    async handler(ctx, input) {
      const id = (input.params as { id: string }).id;
      if (!UUID.test(id)) throw new ApiError(400, "invalid_request", "the server id is not valid");
      const server = await getServer(serverCtx(ctx), id.toLowerCase());
      if (!server) throw new ApiError(404, "not_found", "no such server");
      return server;
    },
  },
];
