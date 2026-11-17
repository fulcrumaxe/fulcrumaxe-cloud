import { z } from "zod";
import { clearEngineHalt, EngineHaltForbidden, EngineHaltRepoNotFound, setEngineHalt } from "@fx/db/src/engineHalt.js";
import { writeEngineAudit } from "@fx/db/src/engineAudit.js";
import { markRunnerWork } from "@fx/core/src/pendingWork.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ForbiddenError, NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { RouteEntry } from "../registry.js";

/**
 * Engine bridge EB-11a: halt and un-halt one repo's engine.
 *
 * Who: a PERSON, as an owner or admin, on a session. The routes name `principals: ["session"]`, so a token is refused (`session_required`) before the
 * handler runs; the runner channel is a different surface and has no way here at all. The database checks the same thing again inside the
 * definer functions of migration 1031 (a verified owner or admin member of an active account), so a path that skipped this file still could not
 * write the marker. A repo of another account answers 404, never 403.
 *
 * A halt answers `applied: false`: the runner applies it on its next pull (EB-11b) and reports `halt_applied`; the repo list shows `halt_pending`
 * until it does. A repeat while halted, or a clear when not halted, changes nothing and writes no audit row.
 */

const idParamsSchema = z.object({ id: z.string() });
const emptyBodySchema = z.object({}).strict();

const haltReplySchema = z.object({
  halt_epoch: z.number().int(),
  halted: z.literal(true),
  /** Always false here: whether the runner has applied it is derived from the session's `halt_applied` events when the repo list is read. */
  applied: z.literal(false),
});
const clearReplySchema = z.object({
  /** Unchanged by the clear. */
  halt_epoch: z.number().int(),
  halted: z.literal(false),
});

/** Maps the halt module's refusals to the API's. Everything else is rethrown as it is. */
function mapHaltError(error: unknown): unknown {
  if (error instanceof EngineHaltRepoNotFound) return new NotFoundError("repo not found");
  if (error instanceof EngineHaltForbidden) return new ForbiddenError("only an owner or admin can change the engine halt");
  return error;
}

export const engineHaltRoutes: RouteEntry[] = [
  {
    method: "POST",
    path: "/api/v1/engine/repos/{id}/halt",
    operationId: "haltEngineRepo",
    summary: "Halt one repo's engine: it is stopped on the runner, every decide is refused, and only a person can clear it",
    description:
      "Sets the repo's halt marker and adds one to its `halt_epoch`, under a row lock, so a decide or start-like command in flight either committed before it or is refused after it. " +
      "Writes `engine_halt.set` in the same transaction and wakes the account's runners. A repeat while halted answers 200 with the same epoch and writes nothing. Owner or admin, session only.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: emptyBodySchema,
    responseSchema: haltReplySchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      try {
        const result = await withTenant(ctx.pool, accountId, userId, async (client) => {
          const r = await setEngineHalt(client, repoId);
          if (r.newly_halted) await writeEngineAudit(client, "engine_halt.set", { repo_id: repoId, halt_epoch: r.halt_epoch });
          return r;
        });
        // After the commit: the runner's pull reads the committed marker. A lost hint is covered by the runner's own slow pull.
        if (result.newly_halted) void markRunnerWork(accountId);
        return { halt_epoch: result.halt_epoch, halted: true as const, applied: false as const };
      } catch (error) {
        throw mapHaltError(error);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/engine/repos/{id}/halt/clear",
    operationId: "clearEngineRepoHalt",
    summary: "Lift one repo's engine halt. Only a person can; the epoch stays",
    description:
      "Clears the marker and writes `engine_halt.cleared` in the same transaction. The `halt_epoch` does not change. The engine is not restarted: a person starts it again. " +
      "A clear when the repo is not halted answers 200 and writes nothing. Owner or admin, session only: no API token, runner or engine command can clear a halt.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: emptyBodySchema,
    responseSchema: clearReplySchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      try {
        const result = await withTenant(ctx.pool, accountId, userId, async (client) => {
          const r = await clearEngineHalt(client, repoId);
          if (r.newly_cleared) await writeEngineAudit(client, "engine_halt.cleared", { repo_id: repoId, halt_epoch: r.halt_epoch });
          return r;
        });
        // The runner learns of the clear on its next pull (`halted: false` at the same epoch), so it is woken like a halt.
        if (result.newly_cleared) void markRunnerWork(accountId);
        return { halt_epoch: result.halt_epoch, halted: false as const };
      } catch (error) {
        throw mapHaltError(error);
      }
    },
  },
];
