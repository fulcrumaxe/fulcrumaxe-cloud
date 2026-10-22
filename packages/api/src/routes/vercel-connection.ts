import { z } from "zod";
import { markSetupRequestCheckPending } from "@fx/core/src/setup-requests/store.js";
import { getLatestVercelCheck } from "@fx/core/src/setup-requests/latestCheck.js";
import type { VercelNamesReader } from "@fx/core/src/setup-requests/vercelNames.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import {
  connectVercel,
  envKekSource,
  getVercelConnection,
  removeVercel,
  rotateVercel,
  vercelStateCopy,
  VercelConnectionError,
  type KekSource,
  type VercelConnectionCtx,
  type VercelConnectionView,
  type VercelTokenValidator,
} from "@fx/model-connection";
import type { RouteEntry } from "../registry.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";
import { ApiError } from "../errors.js";

/**
 * D#598 P8d-2: `GET|POST|PUT|DELETE /api/v1/vercel-connection`, thin wrappers over the sealed Vercel token store (`@fx/model-connection`).
 *
 * The Vercel token enters this file exactly once per call, in the POST or PUT body, and goes straight to the service. Nothing here returns,
 * logs, audits or stores it: every response is the status DTO below (a four-character tail, never the token), and every error is fixed text plus a
 * code from a closed list. The three writes are session-only (`principals` omitted) and owner/admin (`minRole: "admin"`); GET is any member.
 * The caller never supplies a URL or host: the validator calls one fixed host.
 */

const postBodySchema = z.object({ token: z.string(), team_id: z.string().optional() });
const putBodySchema = z.object({ token: z.string() });

export const vercelConnectionResponseSchema = z.object({
  state: z.enum(["not_connected", "connected", "rejected"]),
  fingerprint: z.string().nullable(),
  team_id: z.string().nullable(),
  connected_at: z.string().nullable(),
  rotated_at: z.string().nullable(),
  rejected_at: z.string().nullable(),
  copy: z.object({ headline: z.string(), detail: z.string(), action: z.string().nullable(), secondary_action: z.string().nullable() }),
});
type Dto = z.infer<typeof vercelConnectionResponseSchema>;

/**
 * D#598 P8d-3a: `GET /api/v1/vercel-connection/details`, the read side of the connection screen: the Vercel team and project NAMES the stored token
 * can see, and what the latest env-var check found. A separate route from the status above because it calls Vercel (cached and bounded, see
 * vercelNames.ts) and can fail on its own: the status stays a cheap database read, and a Vercel outage reads as `names.status: "unavailable"`, never
 * as an error and never as ids. `state` is derived from the latest check since the token was last connected or replaced, not from a stored stamp.
 * Session-only: it carries names of the customer's Vercel projects, which an API token has no need to read.
 */
export const vercelConnectionDetailsSchema = z.object({
  state: z.enum(["not_connected", "connected", "revoked_or_expired"]),
  names: z
    .discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), team_name: z.string().nullable(), projects: z.array(z.string()), truncated: z.boolean() }),
      z.object({ status: z.literal("unavailable") }),
    ])
    .nullable(),
  check: z
    .object({
      result: z.enum(["read", "cannot_read", "token_rejected", "unreachable"]),
      reason: z.string().nullable(),
      sentence: z.string(),
      project: z.string(),
      ran_at: z.string(),
    })
    .nullable(),
});

/** Test seam and production wiring: the validator (production passes the net-guarded fetch, apps/web/app/api/v1/[...path]/route.ts) and the KEK. */
export const vercelConnectionDeps: { getValidator: () => VercelTokenValidator | null; getKek: () => KekSource; getNames: () => VercelNamesReader | null } = {
  getValidator: () => null,
  getNames: () => null,
  getKek: () => envKekSource(),
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toDto(view: VercelConnectionView): Dto {
  const copy = vercelStateCopy(view.state, view.fingerprint);
  return {
    state: view.state,
    fingerprint: view.fingerprint,
    team_id: view.team_id,
    connected_at: iso(view.connected_at),
    rotated_at: iso(view.rotated_at),
    rejected_at: iso(view.rejected_at),
    copy: { headline: copy.headline, detail: copy.detail, action: copy.action, secondary_action: copy.secondaryAction },
  };
}

const STATUS_OF: Record<VercelConnectionError["code"], number> = {
  invalid_token_format: 422,
  invalid_team_id: 422,
  token_rejected: 422,
  provider_unreachable: 503,
  already_connected: 409,
  not_connected: 404,
};

/** The service's fixed message and a code from its closed list; nothing the caller sent is echoed. */
function mapError(err: unknown): unknown {
  if (!(err instanceof VercelConnectionError)) return err;
  return new ApiError(STATUS_OF[err.code], err.code, err.message, [{ path: err.code === "invalid_team_id" ? "team_id" : "token", code: err.code }]);
}

function serviceCtx(ctx: { pool: VercelConnectionCtx["pool"]; principal: { accountId: string; userId: string } }): VercelConnectionCtx {
  const validator = vercelConnectionDeps.getValidator();
  if (validator === null) throw new ApiError(503, "vercel_connection_not_configured", "connecting Vercel is not configured");
  return { pool: ctx.pool, principal: { accountId: ctx.principal.accountId, userId: ctx.principal.userId }, kek: vercelConnectionDeps.getKek(), validator };
}

export const vercelConnectionRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/vercel-connection/details",
    operationId: "getVercelConnectionDetails",
    summary: "The Vercel team and project names the stored token can see, and the latest env-var check (never the token or ids)",
    // principals omitted -> session-only.
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    responseSchema: vercelConnectionDetailsSchema,
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      const view = await getVercelConnection({ pool: ctx.pool, principal: ctx.principal });
      if (view.state === "not_connected" || view.connected_at === null) return { state: "not_connected" as const, names: null, check: null };
      const since = view.rotated_at ?? view.connected_at;
      const latest = await withTenant(ctx.pool, accountId, userId, (client) => getLatestVercelCheck(client, accountId, since));
      const check = latest && { result: latest.result, reason: latest.reason, sentence: latest.sentence, project: latest.project, ran_at: latest.ranAt.toISOString() };
      // Derived from the latest check; the stored status (set when a check is refused with 401) only says the same thing sooner.
      if (view.state === "rejected" || latest?.result === "token_rejected") return { state: "revoked_or_expired" as const, names: { status: "unavailable" as const }, check };
      const reader = vercelConnectionDeps.getNames();
      const names = reader === null ? { status: "unavailable" as const } : await reader.read(accountId);
      return {
        state: "connected" as const,
        names: names.status === "ok" ? { status: "ok" as const, team_name: names.teamName, projects: names.projects, truncated: names.truncated } : { status: "unavailable" as const },
        check,
      };
    },
  },
  {
    method: "GET",
    path: "/api/v1/vercel-connection",
    operationId: "getVercelConnection",
    summary: "The account's Vercel connection (state and token tail; never the token)",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    responseSchema: vercelConnectionResponseSchema,
    async handler(ctx) {
      return toDto(await getVercelConnection({ pool: ctx.pool, principal: ctx.principal }));
    },
  },
  {
    method: "POST",
    path: "/api/v1/vercel-connection",
    operationId: "connectVercel",
    sessionLimit: SESSION_LIMITS.vercelTokenPut,
    summary: "Connect Vercel with an API token",
    // principals omitted -> session-only: a token may never write a credential.
    minRole: "admin",
    idempotency: "never", // a route carrying a secret rejects Idempotency-Key.
    rateClass: "write",
    bodySchema: postBodySchema,
    responseSchema: vercelConnectionResponseSchema,
    successStatus: 201,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof postBodySchema>;
      try {
        const view = await connectVercel(serviceCtx(ctx), { token: body.token, teamId: body.team_id });
        markSetupRequestCheckPending(); // requests already waiting on an env-var check get looked at now
        return toDto(view);
      } catch (err) {
        throw mapError(err);
      }
    },
  },
  {
    method: "PUT",
    path: "/api/v1/vercel-connection",
    operationId: "rotateVercelConnection",
    sessionLimit: SESSION_LIMITS.vercelTokenPut,
    summary: "Replace the stored Vercel token",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    bodySchema: putBodySchema,
    responseSchema: vercelConnectionResponseSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof putBodySchema>;
      try {
        const view = await rotateVercel(serviceCtx(ctx), { token: body.token });
        markSetupRequestCheckPending();
        return toDto(view);
      } catch (err) {
        throw mapError(err);
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/vercel-connection",
    operationId: "disconnectVercel",
    summary: "Disconnect Vercel and delete the stored token",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    responseSchema: z.null(),
    successStatus: 204,
    async handler(ctx) {
      await removeVercel({ pool: ctx.pool, principal: ctx.principal });
      return null;
    },
  },
];
