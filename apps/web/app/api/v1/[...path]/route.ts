import type { NextRequest } from "next/server";
import { handleApiHeadRequest, handleApiRequest } from "@fx/api/src/handler.js";
import { appUserPool, platformOpsPool } from "@fx/api/src/sse/pools.js";
import { runActionDeps } from "@fx/api/src/routes/run-actions.js";
import { onboardingDeps } from "@fx/api/src/routes/onboarding.js";
import { parsePreviewResult } from "@fx/pipeline";
import { operatorMode } from "@fx/worker";
import { httpRunActionSignalFromEnv } from "@fx/api/src/runActions/httpSignal.js";
import { previewEnabled, workerConfigured } from "../../../../lib/worker";
import { getAuthorCheck } from "../../../../lib/github/authorCheck";

/**
 * D#31 API-1b: the one catch-all every `/api/v1/*` request goes through
 * (`GET /api/v1/openapi.json` gets its own more-specific route file once
 * API-1c adds it -- Next matches the more specific segment first, so this
 * file is never reached for it). Every method handler below just
 * forwards to `handleApiRequest`, which does routing (against
 * `packages/api`'s registry, not anything hand-rolled here), authn/authz
 * and error mapping. `/api/<resource>` and `/api/v2/*` 404 without any
 * code at all: no route file exists at either path, so Next's own router
 * never reaches this file for them.
 *
 * Short `maxDuration` (TA: "JSON goes through one catch-all, and SSE
 * uses its own maxDuration = 800 files") -- this file only ever returns
 * a single JSON response, never a stream.
 */
export const maxDuration = 30;

// The app_user and platform_ops pools are shared with the SSE route files
// (packages/api/src/sse/pools.ts), so one function instance holds one set of
// connections, not one per route. `resolvePrincipal` needs the platform_ops
// pool to re-check a session cookie's epoch and per-session revocation (D#31
// API-1c security fix round item 1, CWE-613).

// D#2 VCREDS: this is the one file that runs in the /api/v1 process next to the handler's module
// graph (the same instance of run-actions.ts), so the signal seam is installed here. The routes
// answer 503 until a worker can be built AND the kick URL and secret are both set.
runActionDeps.getRunActionSignal = () => (workerConfigured() ? httpRunActionSignalFromEnv() : null);
// D#31 AUTHOR-CHECK-WIRE: the retry author check, the same function the worker is handed (lib/worker.ts).
runActionDeps.getAuthorCheck = getAuthorCheck;
onboardingDeps.projectPreviewResult = parsePreviewResult;
// D#2 H14c-3-3a: the preview is offered only behind the FX_ONBOARDING_PREVIEW flag, on a worker that can run it.
onboardingDeps.previewAvailable = previewEnabled;
// The operator exception: an operator account needs no model connection of its own for a preview (the same decision the worker takes).
onboardingDeps.isOperatorAccount = (accountId) => operatorMode(process.env, accountId).active;

async function dispatch(req: NextRequest): Promise<Response> {
  return handleApiRequest(req, appUserPool(), platformOpsPool());
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;

/**
 * D#31 API-1c (live-checked against a real `next start`, per the
 * PR 126 reviewer's flag): "Headers: every /api/v1 response ... sends
 * Cache-Control ... and X-Request-Id" applies to every response on this
 * surface, not just the five methods above. Left to Next's own automatic
 * handling, neither is true -- see `handleApiHeadRequest`'s own doc
 * comment (packages/api/src/handler.ts) for HEAD, and OPTIONS bypasses
 * `handleApiRequest` entirely under Next's default handling (a bare 204
 * or 405 built only from the set of exported method names, carrying
 * neither header). Both confirmed live before this fix. Wiring both
 * through the same dispatcher means every response on this surface goes
 * through the one place `Cache-Control` and `X-Request-Id` are set.
 * OPTIONS is dispatched as-is: no registry entry declares `OPTIONS`, so
 * it 404s `not_found` through the exact same error-mapping path every
 * other unmatched method already uses -- consistent, and no special
 * case, rather than a hand-rolled Allow-header response the Spec never
 * asked for.
 */
export async function HEAD(req: NextRequest): Promise<Response> {
  return handleApiHeadRequest(req, appUserPool(), platformOpsPool());
}

export const OPTIONS = dispatch;
