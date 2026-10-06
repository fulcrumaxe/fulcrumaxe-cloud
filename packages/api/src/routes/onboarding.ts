import { z } from "zod";
import { SANDBOX_PINNED_VCPUS, PINNED_MEMORY_MB, computeComputeUsd } from "@fx/spend";
import { ONBOARDING_STEPS, getOnboarding } from "@fx/core/src/onboarding/progress.js";
import {
  PreviewExistsError as ServicePreviewExistsError,
  PreviewCapNotConfirmedError as ServiceCapNotConfirmedError,
  PreviewCapacityError as ServiceCapacityError,
  PreviewInstallLimitError as ServiceInstallLimitError,
  PreviewNoModelKeyError as ServiceNoModelKeyError,
  PreviewUnavailableError as ServiceUnavailableError,
  getLatestPreview,
  getPreviewProgress,
  requestPreview,
} from "@fx/core/src/onboarding/preview.js";
import { OUTCOMES, STAGE_IDS } from "@fx/core/src/onboarding/previewProgress.js";
import type { RouteContext, RouteEntry } from "../registry.js";
import {
  ModelKeyRequiredError,
  PreviewAlreadyRequestedError,
  PreviewCapNotConfirmedError,
  PreviewCapacityReachedError,
  PreviewInstallLimitReachedError,
  PreviewUnavailableError,
} from "../errors.js";
import { runActionDeps } from "./run-actions.js";

/**
 * D#31 API-9 seams, installed by apps/web's catch-all (like `runActionDeps`).
 * `previewAvailable` stays false until the worker can really run a preview, so POST answers 503 until then.
 * `projectPreviewResult` turns a succeeded run's envelope into the customer-facing result; @fx/api does not
 * import the pipeline, so it is injected. Null leaves `result` null.
 */
export const onboardingDeps: {
  previewAvailable: () => boolean;
  /** The operator decision for an account (apps/web installs it); null: no account is an operator. */
  isOperatorAccount: ((accountId: string) => boolean) | null;
  projectPreviewResult: ((envelope: unknown) => unknown) | null;
} = {
  previewAvailable: () => false,
  isOperatorAccount: null,
  projectPreviewResult: null,
};

const serviceCtx = (ctx: RouteContext) => ({ pool: ctx.pool, principal: ctx.principal });

const onboardingSchema = z.object({
  started_at: z.string(),
  steps: z.array(z.object({ step: z.enum(ONBOARDING_STEPS), completed_at: z.string().nullable(), skipped: z.boolean() })),
});

const requestBodySchema = z.strictObject({ repo_id: z.string().uuid(), confirm_model_cap_usd: z.number() });
const acceptedSchema = z.object({
  preview_id: z.string().uuid(),
  action_id: z.string().uuid(),
  state: z.string(),
});

const previewResultSchema = z.union([
  z.object({
    issues: z
      .array(z.object({ number: z.number().int(), title: z.string(), category: z.string(), expected_model_usd: z.number() }))
      .max(50),
    sample_spec: z.object({ issue_number: z.number().int(), body: z.string() }),
  }),
  z.object({ error: z.literal("invalid_output") }),
]);
const previewSchema = z.object({
  preview_id: z.string().uuid(),
  state: z.enum(["requested", "running", "finished", "void"]),
  repo_id: z.string().uuid(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  result: previewResultSchema.nullable(),
  void_reason: z.string().nullable(),
  run_status: z.string().nullable(),
});
const progressSchema = z.object({
  server_time: z.string(),
  outcome: z.enum(OUTCOMES),
  reason: z.string().nullable(),
  slow: z.boolean(),
  slot_freed: z.boolean(),
  elapsed_seconds: z.number().int().nullable(),
  repo_name: z.string().nullable(),
  stages: z.array(z.object({ id: z.enum(STAGE_IDS), status: z.enum(["done", "active", "pending", "failed"]), at: z.string().nullable() })),
  feed: z.array(z.object({ seq: z.number().int(), at: z.string(), text: z.string() })).max(30),
  numbers: z.object({
    files_read: z.number().int(),
    compute: z.object({ usd: z.number(), basis: z.enum(["none", "estimate", "recorded"]), cap_usd: z.number() }),
    model: z.object({ whose: z.enum(["operator", "ai_gateway", "anthropic", "customer"]), usd: z.number().nullable() }),
  }),
});
const latestPreviewSchema = z.object({ preview: previewSchema.nullable(), progress: progressSchema.nullable() });

/** Our sandbox cost for a number of seconds, at the sandbox size every run is created with. */
const estimateComputeUsd = (seconds: number): number => computeComputeUsd(seconds, SANDBOX_PINNED_VCPUS, PINNED_MEMORY_MB / 1024);

/** The service's typed refusals become the API's own errors; anything else (NotFound, Forbidden, a fault) passes through. */
function mapPreviewError(err: unknown): never {
  if (err instanceof ServiceUnavailableError) throw new PreviewUnavailableError();
  if (err instanceof ServiceCapNotConfirmedError) throw new PreviewCapNotConfirmedError();
  if (err instanceof ServiceNoModelKeyError) throw new ModelKeyRequiredError();
  if (err instanceof ServiceCapacityError) throw new PreviewCapacityReachedError();
  if (err instanceof ServicePreviewExistsError) throw new PreviewAlreadyRequestedError();
  if (err instanceof ServiceInstallLimitError) throw new PreviewInstallLimitReachedError();
  throw err;
}

export const onboardingRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/onboarding",
    operationId: "getOnboarding",
    summary: "Where the account is in onboarding",
    description:
      "Session only; a token is refused. Always six steps in order (`model_key`, `readonly_app`, `preview`, `pay`, `write_app`, `first_pr`); " +
      "`completed_at` is a server time, or null while the step is open. `skipped` is true for a step that is not open but was never done: the free `preview` once the plan is chosen without one (it then has no time; a preview that finishes later turns it into a done step with its real time). Choosing a plan does not wait for any earlier step. Works for an account that has not subscribed yet. " +
      "`model_key` and `readonly_app` follow the current state, so they reopen when the model key is removed or stops working, or when the read-only GitHub App is uninstalled or suspended; the other steps are milestones that stay done.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "never",
    rateClass: "read",
    responseSchema: onboardingSchema,
    extraResponses: { "403": "Error `session_required` (a token) or `insufficient_role` (below admin)." },
    handler: (ctx) => getOnboarding(serviceCtx(ctx)),
  },
  {
    method: "POST",
    path: "/api/v1/onboarding/preview",
    operationId: "requestPreview",
    summary: "Ask for the account's one read-only preview run",
    description:
      "Session only, owner or admin; a token is refused. `Idempotency-Key` is required. The body must repeat the model spending cap (20 USD) so the customer has seen it. " +
      "Answers 202 `{ preview_id, action_id, state }`; read progress with `GET /api/v1/onboarding/preview`. " +
      "The same key and body replays the first answer (with `Idempotent-Replayed: true`) and starts nothing more. Runs on a repo of the read-only app.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "required",
    startsRun: true,
    rateClass: "write",
    bodySchema: requestBodySchema,
    responseSchema: acceptedSchema,
    successStatus: 202,
    extraResponses: {
      "403": "Error `session_required` (a token) or `insufficient_role` (below admin).",
      "404": "Error `not_found`: the repo is missing, belongs to another account, or is not on the read-only app.",
      "409": "Error `model_key_required` (no working model connection), `preview_capacity` (today's allowance is used up) `preview_exists` (a preview was already requested) or `preview_install_limit` (this GitHub installation or owner already used its free preview in the last 30 days).",
      "422": "Error `preview_cap_not_confirmed` (the cap must equal 20), `idempotency_key_reused`, or a body that does not validate.",
      "503": "Error `preview_unavailable`: previews cannot run yet. Nothing is written.",
    },
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof requestBodySchema>;
      const signal = runActionDeps.getRunActionSignal();
      if (!signal) throw new PreviewUnavailableError();
      const result = await requestPreview(
        serviceCtx(ctx),
        { repoId: body.repo_id, confirmModelCapUsd: body.confirm_model_cap_usd, idempotencyKey: ctx.idempotencyKey || undefined },
        { signal, available: () => onboardingDeps.previewAvailable(), isOperatorAccount: (id) => onboardingDeps.isOperatorAccount?.(id) === true },
      ).catch(mapPreviewError);
      if (result.replayed) ctx.markReplayed?.();
      return { preview_id: result.previewId, action_id: result.actionId, state: result.state };
    },
  },
  {
    method: "GET",
    path: "/api/v1/onboarding/preview",
    operationId: "getOnboardingPreview",
    summary: "The account's newest preview",
    description:
      "Session only, owner or admin. Answers `{ preview, progress }` with the newest preview, void ones included (`void_reason` says why), or `{ preview: null, progress: null }` when there is none. " +
      "`progress` is the live view of that preview: the `outcome` (one name per screen), the seven `stages` (queued, sandbox, clone, read, plan, write, done) marked only from what the run recorded, a `feed` of at most 30 short activity lines built by the server from fixed templates (never model text, file contents, command output, tokens or URLs), " +
      "and honest `numbers`: files read, sandbox compute (our cost, an `estimate` while running and `recorded` once the ledger has it) and model usage labelled by whose it is. `server_time` is the clock to measure `elapsed_seconds` against. The read is bounded and writes nothing. " +
      "`result` is model output derived from repository text: show it as plain text only. It is null until the run has succeeded, and `{ error: \"invalid_output\" }` when the output failed its checks.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "never",
    rateClass: "read",
    responseSchema: latestPreviewSchema,
    extraResponses: { "403": "Error `session_required` (a token) or `insufficient_role` (below admin)." },
    async handler(ctx) {
      const project = onboardingDeps.projectPreviewResult;
      const preview = await getLatestPreview(serviceCtx(ctx), project ? { projectResult: project } : {});
      if (!preview) return { preview: null, progress: null };
      const progress = await getPreviewProgress(serviceCtx(ctx), preview.preview_id, {
        isOperatorAccount: (id) => onboardingDeps.isOperatorAccount?.(id) === true,
        estimateComputeUsd,
      });
      return { preview, progress };
    },
  },
];
