import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ENGINE_COMMAND_KINDS, ENGINE_COMMAND_PURPOSE, EngineCommand } from "@fulcrumaxe/runner-protocol";
import { writeEngineAudit } from "@fx/db/src/engineAudit.js";
import { EngineCommandsBacklog, NOT_CONFIRMED_AFTER_S, findEngineTarget, insertEngineCommand, isHaltedRefusal, readHaltStates } from "@fx/db/src/engineCommands.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { markRunnerWork } from "@fx/core/src/pendingWork.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A command's `kind` and `args` as the protocol's own strict schema reads them. The schema wants the whole signed envelope, so the probe fills the
 * fields the cloud owns (ids, times, epoch) with placeholders: only `kind` and `args` are ever taken from the request, and the parse is what refuses
 * an unknown kind, another kind's args, an extra key, a bad dial class or role, and a note that is long or holds a control or bidirectional character.
 */
function probe(kind: string, args: unknown): unknown {
  const nowMs = Date.now();
  const id = randomUUID();
  return { v: 1, purpose: ENGINE_COMMAND_PURPOSE, command_id: id, command_seq: 1, runner_id: id, repo_gh_id: 1, kind, args, issued_by: id, issued_at: new Date(nowMs).toISOString(), expires_at: new Date(nowMs + 600_000).toISOString(), halt_epoch: 0 };
}

const issueBodySchema = z
  .object({ kind: z.enum(ENGINE_COMMAND_KINDS), args: z.record(z.string(), z.unknown()).default({}) })
  .strict()
  .superRefine((body, ctx) => {
    if (!EngineCommand.safeParse(probe(body.kind, body.args)).success) ctx.addIssue({ code: "custom", message: "args do not match the command kind", path: ["args"] });
  });
const issueResponseSchema = z.object({ command_id: z.string(), state: z.literal("pending"), expires_at: z.string() });

const idParamsSchema = z.object({ id: z.string() });
const cancelResponseSchema = z.object({ command_id: z.string(), state: z.literal("cancelled") });
// `ask_id` has the shape an ask's id has everywhere else (16 lowercase hex digits); anything else is refused with a 400 in the handler (the query
// schema's own refusal would be a 422), never searched for.
const listQuerySchema = z.object({ limit: z.string().regex(/^[0-9]{1,3}$/).optional(), ask_id: z.string().optional() });
const ASK_ID = /^[0-9a-f]{16}$/;
const LIST_MAX = 50;
/** The most answers one ask can show: a person can answer an ask again only while the first is still waiting, so twenty is far more than a real ask has. */
const ASK_LIST_MAX = 20;

const commandViewSchema = z.object({
  id: z.string(),
  command_seq: z.number().int(),
  kind: z.enum(ENGINE_COMMAND_KINDS),
  /** The closed arguments (ids and enums), never the note. */
  args: z.record(z.string(), z.unknown()),
  /** An answer's note, written by an owner or admin. Present only for a caller who is one; absent for a member. */
  note: z.string().optional(),
  state: z.enum(["pending", "delivered", "applied", "refused", "expired", "cancelled", "not_confirmed"]),
  refusal: z.string().nullable(),
  issued_by: z.string(),
  issued_at: z.string(),
  expires_at: z.string(),
  delivered_at: z.string().nullable(),
  acked_at: z.string().nullable(),
  halt_epoch_at_issue: z.number().int(),
});
const listResponseSchema = z.object({ commands: z.array(commandViewSchema) });

/**
 * EB-8a: the engine command channel, person's side. A command is one of a closed set (the protocol's `EngineCommand`), issued by an owner or
 * admin on a session, for the runner that holds the repo's live engine session (never a field of the request), and it lives 10 minutes. The
 * runner pulls and acks it (`/api/runner/engine/commands/...`, runner-cloud); the state shown here is the runner's own report, never a guess:
 * a pending command past its life reads `expired`, and a delivered one the runner has not acked 15 minutes past its life reads `not_confirmed`.
 */
export const engineCommandRoutes: RouteEntry[] = [
  {
    method: "POST",
    path: "/api/v1/engine/repos/{id}/commands",
    operationId: "issueEngineCommand",
    summary: "Send one command to the engine running on your machine",
    description:
      "Owner or admin, session only (a token is 403 `session_required`, a member 403). The repo must have operate switched on (409 `operate_off`) and a live engine session (409 `engine_not_connected`); the command goes to that session's runner. " +
      "A halted repo refuses `start_day`, `resume_loop`, `request_spawn` and `set_dial` (409 `halted`); `pause_loop`, `answer_ask` and `stop_agent` stay allowed. Twenty waiting commands per repo is the most (409 `too_many_pending`). " +
      "Answers 201 `pending` with the expiry, writes `engine_command.issued` in the same transaction and wakes the account's runners.",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "optional",
    rateClass: "write",
    successStatus: 201,
    extraResponses: {
      "404": "No such repo in this account.",
      "409": "`operate_off`, `engine_not_connected`, `halted` or `too_many_pending`.",
    },
    paramsSchema: idParamsSchema,
    bodySchema: issueBodySchema,
    responseSchema: issueResponseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      const body = input.body as z.infer<typeof issueBodySchema>;
      // The probe already passed the same schema; parsing again takes the strict, normalised args.
      const parsed = EngineCommand.parse(probe(body.kind, body.args));
      try {
        const issued = await withTenant(ctx.pool, accountId, userId, async (client) => {
          const target = await findEngineTarget(client, accountId, repoId);
          if (target.status === "no_repo") throw new ApiError(404, "not_found", "no such repo");
          if (target.status === "operate_off") throw new ApiError(409, "operate_off", "operate is not switched on");
          if (target.status === "not_connected") throw new ApiError(409, "engine_not_connected", "no engine is connected for this repo");
          // This is a plain read, so a halt committing between it and the insert leaves the stamp one epoch behind. The halt trigger of migration 1031
          // overrides it: it stamps `halt_epoch_at_issue` from the controls row it locks, so the stored value is exact. Behind, a stamp only fails closed
          // (the pull holds the command back), never open.
          const halt = (await readHaltStates(client, [repoId])).get(repoId)!;
          const row = await insertEngineCommand(client, { accountId, runnerId: target.runnerId, repoId, kind: parsed.kind, args: parsed.args, issuedBy: userId, haltEpoch: halt.halt_epoch });
          await writeEngineAudit(client, "engine_command.issued", { repo_id: repoId, command_id: row.id, kind: parsed.kind });
          return row;
        });
        // After the commit: the runner's pull reads the committed row. A lost hint is covered by the runner's own slow pull.
        void markRunnerWork(accountId);
        return { command_id: issued.id, state: "pending" as const, expires_at: issued.expires_at.toISOString() };
      } catch (error) {
        if (isHaltedRefusal(error)) throw new ApiError(409, "halted", "the engine is halted");
        if (error instanceof EngineCommandsBacklog) throw new ApiError(409, "too_many_pending", "too many commands are waiting");
        if ((error as { code?: string } | null)?.code === "42501") throw new ApiError(403, "forbidden", "only an owner or admin can send engine commands");
        throw error;
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/engine/commands/{id}",
    operationId: "cancelEngineCommand",
    summary: "Cancel a command the runner has not picked up yet",
    description:
      "Owner or admin, session only. Only a `pending` command can be cancelled; one the runner already has is 409 `already_delivered`, one past its life 409 `expired`, one already cancelled 409 `already_cancelled`. " +
      "Writes `engine_command.cancelled` in the same transaction. An unknown or foreign id is 404.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: { "404": "No such command in this account.", "409": "`already_delivered`, `expired` or `already_cancelled`." },
    paramsSchema: idParamsSchema,
    responseSchema: cancelResponseSchema,
    async handler(ctx, input) {
      const id = input.params.id!;
      if (!UUID.test(id)) throw new ApiError(404, "not_found", "no such command");
      const { accountId, userId } = ctx.principal;
      try {
        await withTenant(ctx.pool, accountId, userId, async (client) => {
          const moved = await client.query<{ repo_id: string; kind: string }>(
            `UPDATE engine_commands SET state = 'cancelled' WHERE id = $1 AND state = 'pending' AND expires_at > now() RETURNING repo_id, kind`,
            [id],
          );
          const row = moved.rows[0];
          if (row === undefined) {
            const seen = await client.query<{ state: string; alive: boolean }>("SELECT state, expires_at > now() AS alive FROM engine_commands WHERE id = $1", [id]);
            const found = seen.rows[0];
            if (found === undefined) throw new ApiError(404, "not_found", "no such command");
            if (found.state === "cancelled") throw new ApiError(409, "already_cancelled", "this command is already cancelled");
            if (found.state === "expired" || (found.state === "pending" && !found.alive)) throw new ApiError(409, "expired", "this command has expired");
            throw new ApiError(409, "already_delivered", "the runner already has this command");
          }
          await writeEngineAudit(client, "engine_command.cancelled", { repo_id: row.repo_id, command_id: id, kind: row.kind });
        });
      } catch (error) {
        if ((error as { code?: string } | null)?.code === "42501") throw new ApiError(403, "forbidden", "only an owner or admin can cancel an engine command");
        throw error;
      }
      return { command_id: id, state: "cancelled" as const };
    },
  },
  {
    method: "GET",
    path: "/api/v1/engine/repos/{id}/commands",
    operationId: "listEngineCommands",
    summary: "The latest commands sent to a repo's engine, with their state",
    description:
      "Any member, session only (a token is 403 `session_required`: the list can carry an owner's note). At most 50, newest first. `state` is the runner's own report, with two reads of time: a pending command past its life is `expired`, " +
      "and a delivered one with no ack 15 minutes past its life is `not_confirmed`. The `note` of an answer is shown only to an owner or admin. " +
      "With `ask_id` (16 lowercase hex digits; anything else is 400 `invalid_request`) the list is only the `answer_ask` commands for that ask, at most 20, newest first.",
    // principals omitted -> session-only.
    minRole: "member",
    idempotency: "never",
    extraResponses: { "404": "No such repo in this account." },
    paramsSchema: idParamsSchema,
    querySchema: listQuerySchema,
    responseSchema: listResponseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId, role } = ctx.principal;
      const wantNote = role === "owner" || role === "admin";
      const query = input.query as z.infer<typeof listQuerySchema>;
      const askId = query.ask_id;
      if (askId !== undefined && !ASK_ID.test(askId)) throw new ApiError(400, "invalid_request", "ask_id must be 16 lowercase hex digits");
      const cap = askId === undefined ? LIST_MAX : ASK_LIST_MAX;
      const limit = Math.min(Number(query.limit ?? cap) || cap, cap);
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        const repo = await client.query("SELECT 1 FROM repos WHERE id = $1 AND account_id = $2", [repoId, accountId]);
        if (repo.rowCount === 0) throw new ApiError(404, "not_found", "no such repo");
        const { rows } = await client.query<{
          id: string; command_seq: string; kind: z.infer<typeof commandViewSchema>["kind"]; args: Record<string, unknown>; state: z.infer<typeof commandViewSchema>["state"]; refusal: string | null; issued_by: string;
          issued_at: Date; expires_at: Date; delivered_at: Date | null; acked_at: Date | null; halt_epoch_at_issue: number;
        }>(
          `SELECT id, command_seq, kind, args,
                  CASE WHEN state = 'pending' AND expires_at <= now() THEN 'expired'
                       WHEN state = 'delivered' AND expires_at + make_interval(secs => $3) <= now() THEN 'not_confirmed'
                       ELSE state END AS state,
                  refusal, issued_by, issued_at, expires_at, delivered_at, acked_at, halt_epoch_at_issue
             FROM engine_commands WHERE repo_id = $1 AND account_id = $5
              AND ($4::text IS NULL OR (kind = 'answer_ask' AND args ->> 'ask_id' = $4))
            ORDER BY issued_at DESC, command_seq DESC LIMIT $2`,
          [repoId, limit, NOT_CONFIRMED_AFTER_S, askId ?? null, accountId],
        );
        return {
          commands: rows.map((r) => {
            const { note, ...closed } = r.args as Record<string, unknown> & { note?: string };
            return {
              id: r.id,
              command_seq: Number(r.command_seq),
              kind: r.kind,
              args: closed,
              ...(wantNote && typeof note === "string" ? { note } : {}),
              state: r.state,
              refusal: r.refusal,
              issued_by: r.issued_by,
              issued_at: r.issued_at.toISOString(),
              expires_at: r.expires_at.toISOString(),
              delivered_at: r.delivered_at?.toISOString() ?? null,
              acked_at: r.acked_at?.toISOString() ?? null,
              halt_epoch_at_issue: r.halt_epoch_at_issue,
            };
          }),
        };
      });
    },
  },
];
