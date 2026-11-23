import { z } from "zod";
import { createHetznerCredentialProbe } from "@fx/hetzner";
import {
  MachineOpsError,
  connectHetznerCredential,
  machineKekSource,
  removeHetznerCredential,
  type HetznerCredentialView,
  type HetznerTokenProbe,
  type KekSource,
} from "@fx/model-connection";
import type { RouteEntry } from "../registry.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";
import { ApiError } from "../errors.js";
import { withTenant } from "@fx/db/src/withTenant.js";

/**
 * D#845 MC-2: `POST|DELETE /api/v1/machine-credentials/hetzner`, thin wrappers over the sealed Hetzner Cloud token (`@fx/model-connection` machineOps).
 *
 * The token enters this file once, in the POST body, and goes straight to the service. Every response is the DTO below (a four-character tail, never the
 * token) and every error is fixed text with a code from a closed list. Both routes are session-only (`principals` omitted: an API token may never write a
 * credential) and owner or admin (`minRole: "admin"`). The caller never supplies a URL or host; the probe calls one fixed host.
 */
const postBodySchema = z.object({ token: z.string() });
export const hetznerCredentialResponseSchema = z.object({
  id: z.string(),
  status: z.enum(["ok", "invalid"]),
  token_hint: z.string(),
  unlabelled_server_count: z.number().int().nonnegative(),
  created_at: z.string(),
});

/** Test seam and production wiring: the probe is real Hetzner over TLS unless a test replaces it; the KEK is read from the environment by the machine_ops module only. */
export const machineCredentialDeps: { getProbe: () => HetznerTokenProbe | null; getKek: () => KekSource } = {
  getProbe: () => createHetznerCredentialProbe(),
  getKek: () => machineKekSource(),
};

const STATUS_OF: Record<MachineOpsError["code"], number> = {
  machine_kek_unset: 503,
  not_configured: 503,
  invalid_token_format: 422,
  token_invalid: 422,
  token_read_only: 422,
  provider_unreachable: 503,
  already_connected: 409,
  not_connected: 404,
  credential_invalid: 409,
  server_not_managed: 404,
  unseal_failed: 500,
};
const ON_TOKEN = new Set<MachineOpsError["code"]>(["invalid_token_format", "token_invalid", "token_read_only"]);

/** The service's fixed message and a code from its closed list; nothing the caller sent is echoed. */
export function mapError(err: unknown): unknown {
  if (!(err instanceof MachineOpsError)) return err;
  return new ApiError(STATUS_OF[err.code], err.code, err.message, ON_TOKEN.has(err.code) ? [{ path: "token", code: err.code }] : undefined);
}

export const hetznerCredentialStatusSchema = z.object({
  status: z.enum(["connected", "invalid", "none"]),
  token_hint: z.string().nullable(),
  /** Counted once, when the token is connected (the connect answer carries it). It is not stored, and a read never calls Hetzner, so it is null here. */
  unlabelled_server_count: z.number().int().nonnegative().nullable(),
});

const toDto = (v: HetznerCredentialView) => ({ ...v, created_at: v.created_at.toISOString() });
const serviceCtx = (ctx: { pool: Parameters<typeof removeHetznerCredential>[0]["pool"]; principal: { accountId: string; userId: string } }) => ({
  pool: ctx.pool,
  principal: { accountId: ctx.principal.accountId, userId: ctx.principal.userId },
  kek: machineCredentialDeps.getKek(),
});

export const machineCredentialRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/machine-credentials/hetzner",
    operationId: "getHetznerCredential",
    summary: "Whether a Hetzner Cloud token is connected: its status and its last four characters, never the token",
    description: "Session only, owner or admin. Never 404: with no token the answer is 200 `status: none`. Reads the account's own row only; it does not open the token and does not call Hetzner.",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "never",
    rateClass: "read",
    responseSchema: hetznerCredentialStatusSchema,
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      const row = await withTenant(ctx.pool, accountId, userId, async (c) =>
        (await c.query<{ status: "ok" | "invalid"; token_hint: string }>(
          `SELECT status, token_hint FROM machine_provider_credentials WHERE account_id = $1 AND provider = 'hetzner_cloud' AND removed_at IS NULL`,
          [accountId],
        )).rows[0],
      );
      if (!row) return { status: "none" as const, token_hint: null, unlabelled_server_count: null };
      return { status: row.status === "ok" ? ("connected" as const) : ("invalid" as const), token_hint: row.token_hint, unlabelled_server_count: null };
    },
  },
  {
    method: "POST",
    path: "/api/v1/machine-credentials/hetzner",
    operationId: "connectHetznerCredential",
    sessionLimit: SESSION_LIMITS.machineCredentialPut,
    summary: "Connect Hetzner Cloud with an API token (checked for read and write; the token is sealed and never returned)",
    // principals omitted -> session-only: a token may never write a credential.
    minRole: "admin",
    idempotency: "never", // a route carrying a secret rejects Idempotency-Key.
    rateClass: "write",
    bodySchema: postBodySchema,
    responseSchema: hetznerCredentialResponseSchema,
    successStatus: 201,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof postBodySchema>;
      try {
        const probe = machineCredentialDeps.getProbe();
        if (probe === null) throw new MachineOpsError("not_configured");
        return toDto(await connectHetznerCredential({ ...serviceCtx(ctx), probe }, { token: body.token }));
      } catch (err) {
        throw mapError(err);
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/machine-credentials/hetzner",
    operationId: "removeHetznerCredential",
    summary: "Remove the stored Hetzner token (its servers stay)",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    responseSchema: z.null(),
    successStatus: 204,
    async handler(ctx) {
      try {
        await removeHetznerCredential(serviceCtx(ctx));
        return null;
      } catch (err) {
        throw mapError(err);
      }
    },
  },
];
