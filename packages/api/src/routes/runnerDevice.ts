import { z } from "zod";
import { RunnerHttpError, approveDeviceCode, denyDeviceCode, lookupDeviceCode, readDeviceCodeKey, type RunnerHttpResponse } from "@fx/runner-cloud";
import { runnerLimitsFor } from "@fx/spend";
import { ApiError } from "../errors.js";
import type { RouteContext, RouteEntry } from "../registry.js";

/**
 * ON-2: the person's side of linking a machine by a typed code. All three are session routes for an owner or admin: a token, of any kind, gets
 * 403, and so does a member. The code is typed by the person; no route here takes it from a link, and none lists codes (a pending code has no
 * account, and the tables behind these definers are closed to app sessions).
 */

/** Test seam: the key the typed code is hashed with and the plan's runner ceiling. Production reads FX_DEVICE_CODE_KEY and the plan data. */
export const runnerDeviceDeps: { key?: () => Buffer | null; maxRunners?: (plan: string) => number } = {};

/** What the person typed, as typed: the service normalises it (spaces and case do not matter) and checks the exact shape. */
/** The response shapes as zod 4 (this package's), beside the protocol's zod 3 ones; a test holds the two together. */
const lookupResponse = z.object({
  facts: z.object({ hostname: z.string().optional(), os: z.string(), arch: z.string(), kvm: z.boolean(), ip_country: z.string().optional() }).strict(),
  expires_at: z.string(),
  warning: z.string(),
});
const approveResponse = z.object({ runner_id: z.string().uuid() });
const denyResponse = z.object({ denied: z.literal(true) });
const typed = z.string().min(1).max(32);
const lookupBody = z.object({ user_code: typed }).strict();
const approveBody = z.object({ user_code: typed, name: z.string().min(1).max(64).optional(), confirm: z.literal(true) }).strict();

type Step = (deps: Parameters<typeof lookupDeviceCode>[0], principal: { accountId: string; userId: string }, body: unknown) => Promise<RunnerHttpResponse>;

/** The runner-cloud service speaks `RunnerHttpError`; this dispatcher speaks `ApiError`. */
async function via(ctx: RouteContext, body: unknown, step: Step): Promise<unknown> {
  try {
    const deps = {
      appUserPool: ctx.pool,
      deviceCodeKey: runnerDeviceDeps.key ?? (() => readDeviceCodeKey(process.env)),
      maxRunners: runnerDeviceDeps.maxRunners ?? ((plan: string) => runnerLimitsFor(plan).maxRunners),
    };
    return (await step(deps, { accountId: ctx.principal.accountId, userId: ctx.principal.userId }, body)).body;
  } catch (error) {
    if (!(error instanceof RunnerHttpError)) throw error;
    throw new ApiError(error.status, error.code, error.message);
  }
}

const EXTRA = {
  "404": "Error `code_not_found`: no code like it. It counts as a wrong attempt.",
  "410": "Error `code_gone`: the code expired, was turned down, or was already used.",
  "429": "Error `rate_limited`: six wrong codes in 15 minutes for this account.",
  "503": "Error `not_configured`: this deployment cannot link machines by a typed code.",
};

export const runnerDeviceRoutes: RouteEntry[] = [
  {
    method: "POST",
    path: "/api/v1/runners/device/lookup",
    operationId: "lookupRunnerDeviceCode",
    summary: "Look up the machine behind a typed device code",
    description:
      "Session only, owner or admin. The person types the code the machine shows; nothing fills it in. Answers the machine's facts (hostname, os, arch, whether it has KVM, the country its request came from) and a fixed warning. " +
      "Six codes that match nothing in 15 minutes stop this account's lookups, approvals and cancels for the rest of the window.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    bodySchema: lookupBody,
    responseSchema: lookupResponse,
    extraResponses: EXTRA,
    handler: (ctx, input) => via(ctx, input.body, lookupDeviceCode),
  },
  {
    method: "POST",
    path: "/api/v1/runners/device/approve",
    operationId: "approveRunnerDeviceCode",
    summary: "Approve a typed device code and link the machine",
    description:
      "Session only, owner or admin. `confirm` must be true. Creates the runner in this account with no repositories: a new machine has none until a project is placed on it. " +
      "The machine's next signed poll collects its registration, once. A plan with no room for another runner answers 409 `runner_limit`.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    bodySchema: approveBody,
    responseSchema: approveResponse,
    extraResponses: { ...EXTRA, "409": "Errors: `runner_limit` and `key_registered`." },
    handler: (ctx, input) => via(ctx, input.body, approveDeviceCode),
  },
  {
    method: "POST",
    path: "/api/v1/runners/device/deny",
    operationId: "denyRunnerDeviceCode",
    summary: "Turn down a typed device code",
    description: "Session only, owner or admin. The code becomes denied; the machine's next poll is a 410 `denied`.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    bodySchema: lookupBody,
    responseSchema: denyResponse,
    extraResponses: EXTRA,
    handler: (ctx, input) => via(ctx, input.body, denyDeviceCode),
  },
];
