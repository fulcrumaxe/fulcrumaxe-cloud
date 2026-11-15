import { z } from "zod";
import { SIGN_IN_NEED_KINDS, readSignInNeeds, signInCommand } from "@fx/core/src/verify/signInNeeds.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { RouteEntry } from "../registry.js";

/**
 * D#749 VERIFY-SIGNIN-EXPIRY: the repositories whose post-merge check needs the checking account signed in again on a runner, read for the Needs you list. List only. Session only, any member
 * can read. Nothing is stored for the list: it is derived on each read from the runners' last reports and the checks parked for a sign-in, so an entry leaves when the sign-in is renewed.
 */
const itemSchema = z.object({
  repo_id: z.string(),
  /** `owner/name`, or null when the repository has none on record. */
  repo: z.string().nullable(),
  kind: z.enum(SIGN_IN_NEED_KINDS),
  /** The one command to run on the runner's machine, with the repository's configured address. Fixed text, never from a runner or a page. */
  command: z.string(),
  /** When the oldest parked check started waiting; null when none is parked. */
  since: z.string().nullable(),
});
const listResponseSchema = z.object({ items: z.array(itemSchema) });

export const verifySignInRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/verify-sign-in",
    operationId: "listVerifySignInNeeds",
    summary: "The repositories whose post-merge check needs the checking account signed in again on a runner",
    description: "Session only, any member. One entry per repository with checking on, in its most pressing kind: a check waiting for a sign-in, or the runners' saved sign-in expired, missing or about to expire. Read only.",
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    responseSchema: listResponseSchema,
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      const needs = await withTenant(ctx.pool, accountId, userId, (client) => readSignInNeeds(client, accountId));
      return { items: needs.map((n) => ({ repo_id: n.repoId, repo: n.repo, kind: n.kind, command: signInCommand(n.baseUrl), since: n.since === null ? null : n.since.toISOString() })) };
    },
  },
];
