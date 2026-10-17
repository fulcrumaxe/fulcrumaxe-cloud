import { z } from "zod";
import { withTenant } from "@fx/db/src/withTenant.js";
import {
  AGENT_PROPOSABLE_KINDS,
  SETUP_REQUEST_CHECK_KINDS,
  SETUP_REQUEST_KINDS,
  SETUP_REQUEST_STATES,
  setupRequestTitle,
} from "@fx/core/src/setup-requests/kinds.js";
import {
  SETUP_REQUEST_LIST_LIMIT,
  SetupRequestError,
  getSetupRequest,
  listSetupRequests,
  proposeSetupRequest,
  resolveSetupRequest,
  type SetupRequest,
} from "@fx/core/src/setup-requests/store.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";

/**
 * D#598 P8a: the HTTP face of `setup_requests`. A request asks a person for one step the platform cannot do (an environment variable, a
 * GitHub App install, ...). It adds no rule of its own beyond the shape of the body:
 *
 *  - The kind is one of five (public/private drift is recomputed by the platform, never proposed). The body is strict: a `value`, `secret`
 *    or any other field is a 422, and text shaped like a credential in `target` or `reason` is refused. A request names a variable, it never carries one.
 *  - `reason` is plain text. It is stored and returned exactly as sent (markup and addresses stay literal characters); the only link a
 *    request can hold is `provider_url`, on github.com or vercel.com. `title` is built here from a fixed template, never from the reason.
 *  - The account and the person come from the session. Nothing in a body can name either. Every route is session-only: a token can neither read nor write.
 *  - Reading is any member. Proposing, marking done and withdrawing are owner or admin, because each one decides whether an item can go on.
 *  - Undo: a person can withdraw an open request (the item stays paused until someone advances it) or mark it done (resumes at once). Repeating
 *    the decision already taken answers 200 with the request unchanged; the opposite decision on a closed request is 409.
 */

const idParamsSchema = z.object({ id: z.string() });
const UUID = z.string().uuid();

const requestSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  work_item_id: z.string().nullable(),
  kind: z.enum(SETUP_REQUEST_KINDS),
  /** The words a list shows, from a fixed template around `target`. Plain text. */
  title: z.string(),
  target: z.string(),
  /** `env_var` only: the variable's name. */
  env_name: z.string().nullable(),
  /** The agent's reason, as sent. Plain text: show it as text only. */
  reason: z.string(),
  /** The one link a request may hold: a page on github.com or vercel.com. */
  provider_url: z.string().nullable(),
  check: z.enum(SETUP_REQUEST_CHECK_KINDS).nullable(),
  state: z.enum(SETUP_REQUEST_STATES),
  origin: z.enum(["agent", "derived"]),
  created_by: z.string().nullable(),
  created_at: z.string(),
  resolution: z.enum(["marked_done", "check_passed", "condition_cleared", "withdrawn"]).nullable(),
  resolved_by: z.string().nullable(),
  resolved_at: z.string().nullable(),
  /** After "mark done", why the check put the request back (plain text), else null. */
  check_reason: z.string().nullable(),
  check_ran_at: z.string().nullable(),
});

const listResponseSchema = z.object({ requests: z.array(requestSchema), truncated: z.boolean() });

// Strict, and no field that could hold a secret: unknown keys (`value`, `secret`, `token`...) are refused as `unrecognized_keys`.
const createBodySchema = z
  .object({
    kind: z.enum(AGENT_PROPOSABLE_KINDS),
    repo_id: UUID,
    work_item_id: UUID.nullish(),
    target: z.string().min(1).max(200),
    env_name: z.string().min(1).max(100).nullish(),
    reason: z.string().min(1).max(1000),
    provider_url: z.string().min(1).max(500).nullish(),
    check: z.enum(SETUP_REQUEST_CHECK_KINDS).nullish(),
  })
  .strict();

const listQuerySchema = z.object({
  state: z.enum(["open", "all"]).optional(),
  work_item_id: UUID.optional(),
  repo_id: UUID.optional(),
});

const toDto = (r: SetupRequest): z.infer<typeof requestSchema> => ({
  id: r.id,
  repo_id: r.repoId,
  work_item_id: r.workItemId,
  kind: r.kind,
  title: setupRequestTitle(r.kind, r.target, r.envName),
  target: r.target,
  env_name: r.envName,
  reason: r.reason,
  provider_url: r.providerUrl,
  check: r.checkKind,
  state: r.state,
  origin: r.origin,
  created_by: r.createdBy,
  created_at: r.createdAt.toISOString(),
  resolution: r.resolution,
  resolved_by: r.resolvedBy,
  resolved_at: r.resolvedAt?.toISOString() ?? null,
  check_reason: r.checkReason,
  check_ran_at: r.checkRanAt?.toISOString() ?? null,
});

/** The core's named errors as API answers. */
function mapError(error: unknown): unknown {
  if (error instanceof SetupRequestError) {
    if (error.code === "already_open") return new ApiError(409, "setup_request_exists", "this step is already requested");
    if (error.code === "not_open") return new ApiError(409, "setup_request_closed", error.message);
    return new ApiError(422, "invalid_input", error.message, [{ path: error.field ?? "", code: error.code }]);
  }
  // The database's own gate (owner/admin policy, CHECK constraints) as a last line.
  if ((error as { code?: string } | null)?.code === "42501") return new ForbiddenError("only an owner or admin can do this");
  return error;
}

const resolveRoute = (verb: "withdraw" | "done", operationId: string, summary: string, description: string): RouteEntry => ({
  method: "POST",
  path: `/api/v1/setup-requests/{id}/${verb}`,
  operationId,
  summary,
  description,
  // principals omitted -> session-only: a token is not a person.
  minRole: "admin",
  idempotency: "never",
  rateClass: "write",
  extraResponses: { "409": "The request is already closed the other way (`setup_request_closed`)." },
  paramsSchema: idParamsSchema,
  responseSchema: requestSchema,
  async handler(ctx, input) {
    const { accountId, userId } = ctx.principal;
    try {
      return await withTenant(ctx.pool, accountId, userId, async (client) =>
        toDto(await resolveSetupRequest(client, { id: input.params.id!, userId, to: verb === "done" ? "done" : "withdrawn" })),
      );
    } catch (error) {
      throw mapError(error);
    }
  },
});

export const setupRequestRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/setup-requests",
    operationId: "listSetupRequests",
    summary: "The account's setup requests, newest first (open ones by default)",
    // principals omitted -> session-only: the text is an agent's, so it is shown to a signed-in person only.
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    querySchema: listQuerySchema,
    responseSchema: listResponseSchema,
    async handler(ctx, input) {
      const query = input.query as z.infer<typeof listQuerySchema>;
      const { accountId, userId } = ctx.principal;
      try {
        return await withTenant(ctx.pool, accountId, userId, async (client) => {
          const { requests, truncated } = await listSetupRequests(client, {
            state: query.state ?? "open",
            ...(query.work_item_id ? { workItemId: query.work_item_id } : {}),
            ...(query.repo_id ? { repoId: query.repo_id } : {}),
            limit: SETUP_REQUEST_LIST_LIMIT,
          });
          return { requests: requests.map(toDto), truncated };
        });
      } catch (error) {
        throw mapError(error);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v1/setup-requests/{id}",
    operationId: "getSetupRequest",
    summary: "One setup request",
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: requestSchema,
    async handler(ctx, input) {
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => toDto(await getSetupRequest(client, input.params.id!)));
    },
  },
  {
    method: "POST",
    path: "/api/v1/setup-requests",
    operationId: "createSetupRequest",
    summary: "Ask a person for one setup step; the work item it names stays paused until it is done",
    description:
      "Proposes one request of a fixed kind. The body is strict: a field outside the listed ones (a `value`, a `secret`) is refused, and so is text shaped like a credential. " +
      "`reason` is stored as plain text. The only link allowed is `provider_url` on github.com or vercel.com. The account and the proposing person are the session's. " +
      "Owner or admin, session only.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: { "409": "The same step is already requested and open (`setup_request_exists`)." },
    bodySchema: createBodySchema,
    responseSchema: requestSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof createBodySchema>;
      const { accountId, userId } = ctx.principal;
      try {
        return await withTenant(ctx.pool, accountId, userId, async (client) =>
          toDto(
            await proposeSetupRequest(client, {
              userId,
              repoId: body.repo_id,
              workItemId: body.work_item_id ?? null,
              kind: body.kind,
              target: body.target,
              envName: body.env_name ?? null,
              reason: body.reason,
              providerUrl: body.provider_url ?? null,
              check: body.check ?? null,
            }),
          ),
        );
      } catch (error) {
        throw mapError(error);
      }
    },
  },
  resolveRoute(
    "withdraw",
    "withdrawSetupRequest",
    "Withdraw an open setup request; its work item stays paused until someone advances it",
    "Owner or admin, session only. Repeating a withdrawal answers 200 with the request unchanged; withdrawing a request already marked done is 409.",
  ),
  resolveRoute(
    "done",
    "markSetupRequestDone",
    "Mark an open setup request done; its work item can go on at once",
    "Owner or admin, session only. Repeating it answers 200 with the request unchanged; marking a withdrawn request done is 409. A check that later fails puts the request back.",
  ),
];
