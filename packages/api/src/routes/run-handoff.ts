import { z } from "zod";
import { cancelHandoff, requestHandoff, RunnerHttpError, type HandoffCloudTarget, type HandoffDeps } from "@fx/runner-cloud";
import { ApiError } from "../errors.js";
import type { RouteContext, RouteEntry } from "../registry.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";

/**
 * D#599 HO-2a: what the handoff routes need from outside this package. Fail closed: with nothing registered, a move to the cloud and a
 * move to a runner both answer 503 `handoff_unavailable`. apps/web fills it in (the cloud target needs the seat resolver and the spend
 * package; the signing check reads the environment).
 */
export const handoffRouteDeps: { cloudTarget: HandoffCloudTarget | null; runnerJobsConfigured: () => boolean; repoVisibility?: HandoffDeps["repoVisibility"] } = {
  cloudTarget: null,
  runnerJobsConfigured: () => false,
};

const paramsSchema = z.object({ id: z.string() });
const requestBody = z.object({ to: z.enum(["cloud", "runner"]) }).strict();
const requestedSchema = z.object({
  handoff_id: z.string().uuid(),
  run_id: z.string().uuid(),
  state: z.literal("requested"),
  from: z.enum(["cloud", "runner"]),
  to: z.enum(["cloud", "runner"]),
  deadline: z.string(),
});
const cancelledSchema = z.object({ handoff_id: z.string().uuid(), run_id: z.string().uuid(), state: z.literal("cancelled"), placement_restored: z.boolean() });

/** The runner-cloud service speaks `RunnerHttpError`; this dispatcher speaks `ApiError`. A refusal's closed `reason` rides in `details`. */
async function viaService<T>(run: () => Promise<{ body: unknown }>): Promise<T> {
  try {
    return (await run()).body as T;
  } catch (error) {
    if (!(error instanceof RunnerHttpError)) throw error;
    const reason = error.extra.reason;
    throw new ApiError(error.status, error.code, error.message, typeof reason === "string" ? [{ path: "reason", code: reason }] : undefined);
  }
}

const deps = (ctx: RouteContext): HandoffDeps => ({ appUserPool: ctx.pool, cloudTarget: handoffRouteDeps.cloudTarget, runnerJobsConfigured: handoffRouteDeps.runnerJobsConfigured, repoVisibility: handoffRouteDeps.repoVisibility });

/** "The v1 contract" > runs: move a running run to the other side (D#599 HO-2a). */
export const runHandoffRoutes: RouteEntry[] = [
  {
    method: "POST",
    path: "/api/v1/runs/{id}/handoff",
    operationId: "requestRunHandoff",
    summary: "Ask for a running run to move to the cloud or to the person's runner",
    description:
      "Session only, owner or admin. Body `{ to: \"cloud\" | \"runner\" }`. Checks that the target is ready, reserves spend first when the target is the cloud, then records the request " +
      "(the deadline is five minutes out) and sets the work item's placement to the target. Answers 202 `{ handoff_id, run_id, state: \"requested\", from, to, deadline }`; the active side is told on its next heartbeat. " +
      "Nothing is written when the target is refused, and the run keeps running.",
    sessionLimit: SESSION_LIMITS.runHandoff,
    startsRun: true,
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema,
    bodySchema: requestBody,
    responseSchema: requestedSchema,
    successStatus: 202,
    extraResponses: {
      "409":
        "Errors: `run_not_movable` (not a running run of a work item), `already_on_that_side`, `handoff_in_progress`, `runner_update_required` (the runner holding the run is below the handoff protocol version), `no_repo`, `model_key_required`, `no_runner_mode`, `public_repo`, `repo_visibility_unknown`, " +
        "`no_runner_online`, `target_not_ready` and `refused_spend` (the closed reason is in `details`).",
      "503": "Error `handoff_unavailable`: this deployment cannot move runs to that side.",
    },
    handler: (ctx, input) => viaService(() => requestHandoff(deps(ctx), { accountId: ctx.principal.accountId, userId: ctx.principal.userId }, input.params.id!, (input.body as z.infer<typeof requestBody>).to)),
  },
  {
    method: "POST",
    path: "/api/v1/runs/{id}/handoff/cancel",
    operationId: "cancelRunHandoff",
    summary: "Take back a move that has not begun",
    description:
      "Session only, owner or admin. Works only while the handoff is `requested`: the reservation is released (marked released, never deleted), the placement goes back if nobody changed it since, and the run keeps running. " +
      "Once the active side has been told, the move completes and this answers 409 `handoff_committed`.",
    sessionLimit: SESSION_LIMITS.runHandoff,
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema,
    responseSchema: cancelledSchema,
    extraResponses: { "404": "Error `not_found`: the run has no handoff to cancel.", "409": "Error `handoff_committed`: the move has begun." },
    handler: (ctx, input) => viaService(() => cancelHandoff({ appUserPool: ctx.pool }, { accountId: ctx.principal.accountId, userId: ctx.principal.userId }, input.params.id!)),
  },
];
