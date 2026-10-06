import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { MAX_BODY_BYTES, RunnerHttpError, errorResponse, toResponse } from "@fx/runner-cloud";
import type { FailRunnerLeases, RunnerCloudDeps, RunnerHttpRequest, RunnerHttpResponse, SessionPrincipal } from "@fx/runner-cloud";
import { defaultAuthDeps } from "../app/api/auth/_lib/deps";
import { getWorker } from "./worker";
import { applyRefreshedSessionCookie, resolveActiveSession } from "./shell/session-guard";

/**
 * D#6 R2a: the thin edge between Next and `@fx/runner-cloud`, which decides everything. The signed URL's origin is
 * FX_APP_ORIGIN (the CSRF step's "configured workspace origin"); while it is unset the runner routes answer 503.
 */

/** The worker's lease-fail method, resolved per call: null (and so a 503 `leases_not_failed`) while no worker is configured. */
const failRunnerLeases: FailRunnerLeases = async (input) => {
  const worker = await getWorker();
  if (!worker) throw new Error("no worker configured");
  return worker.failRunnerLeases(input);
};

export function runnerDeps(): RunnerCloudDeps {
  const auth = defaultAuthDeps();
  return { appUserPool: auth.appUserPool, platformOpsPool: auth.platformOpsPool, origin: process.env.FX_APP_ORIGIN, failRunnerLeases };
}

/** Reads at most `max` bytes of the body, or returns null as soon as it is over. A declared length over the cap is refused unread. */
export async function readCappedBody(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function send(res: RunnerHttpResponse): NextResponse {
  return NextResponse.json(res.body, { status: res.status, headers: { "cache-control": "no-store", ...res.headers } });
}

/** A runner-signed route. The body is capped before anything else happens; no cookie or token is read. */
export async function handleRunnerRequest(
  req: NextRequest,
  run: (deps: RunnerCloudDeps, request: RunnerHttpRequest) => Promise<RunnerHttpResponse>,
  deps: () => RunnerCloudDeps = runnerDeps,
): Promise<NextResponse> {
  return send(
    await toResponse(async () => {
      const body = await readCappedBody(req, MAX_BODY_BYTES);
      if (!body) throw new RunnerHttpError(413, "body_too_large", "the request body is too large");
      return run(deps(), { method: req.method, headers: Object.fromEntries(req.headers), body });
    }),
  );
}

/** A session route: the signed-in user is the only identity; a runner signature has no meaning here and gets 401. */
export async function handleSessionRequest(
  req: NextRequest,
  run: (deps: RunnerCloudDeps, principal: SessionPrincipal, body: unknown) => Promise<RunnerHttpResponse>,
  options: { json: boolean; deps?: () => RunnerCloudDeps } = { json: false },
): Promise<NextResponse> {
  const deps = (options.deps ?? runnerDeps)();
  const resolved = await resolveActiveSession(req, { platformOpsPool: deps.platformOpsPool });
  if (!resolved) return send(errorResponse(new RunnerHttpError(401, "unauthorized", "sign in required")));
  const body = options.json ? await req.json().catch(() => null) : null;
  const res = await toResponse(() => run(deps, { accountId: resolved.session.accountId, userId: resolved.session.userId }, body));
  return applyRefreshedSessionCookie(send(res), resolved.refreshedToken);
}
