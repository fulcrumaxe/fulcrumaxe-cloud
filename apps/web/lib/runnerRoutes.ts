import type { NextRequest } from "next/server";
import type { Pool } from "pg";
import { NextResponse } from "next/server";
import { MAX_BODY_BYTES, RunnerHttpError, errorResponse, toResponse } from "@fx/runner-cloud";
import type { FailRunnerLeases, RunnerCloudDeps, RunnerLeaseOps, RunnerHttpRequest, RunnerHttpResponse, RunPullRequestPort, SessionPrincipal } from "@fx/runner-cloud";
import { PgRateLimitStore, type RateLimitStore } from "@fx/api/src/ratelimit/store.js";
import { bucketKeyForAnonIp, clientIpFromRequest } from "@fx/api/src/ratelimit/limits.js";
import { defaultAuthDeps } from "../app/api/auth/_lib/deps";
import { runnerLimitsFor } from "@fx/worker";
import { createAppRepoVisibility } from "./github/repoVisibility";
import { getWorker } from "./worker";
import { createAppRunPullRequestPort } from "./github/runnerPullRequest";
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

/** The worker's claim, heartbeat and events methods, resolved per call: a 503 `not_configured` while no worker is configured. */
const leases: RunnerLeaseOps = {
  claimRunnerRun: async (input) => (await requireWorker()).claimRunnerRun(input),
  heartbeatRunnerRun: async (input) => (await requireWorker()).heartbeatRunnerRun(input),
  ingestRunnerEvents: async (input) => (await requireWorker()).ingestRunnerEvents(input),
  beginRunnerDone: async (input) => (await requireWorker()).beginRunnerDone(input),
  finishRunnerDone: async (input) => (await requireWorker()).finishRunnerDone(input),
  gitTicketContext: async (input) => (await requireWorker()).gitTicketContext(input),
  signGitTicket: async (input) => (await requireWorker()).signGitTicket(input),
};

/** The live GitHub side of an executor's `done` (D#6 R2b-3f). Built once; it opens a client per call, so nothing is read from the environment until a `done` needs one. */
let pullRequests: RunPullRequestPort | undefined;

async function requireWorker() {
  const worker = await getWorker();
  if (!worker) throw new RunnerHttpError(503, "not_configured", "the runner API has no worker configured");
  return worker;
}

let visibilityPort: ReturnType<typeof createAppRepoVisibility> | undefined;
const liveVisibility = (): ReturnType<typeof createAppRepoVisibility> => (visibilityPort ??= createAppRepoVisibility());

/** The caps the claim refuses against (the worker's `runnerLimits`: a missing heavy figure reads as 1), so a waiting run can be told an account cap holds it. */
function accountRunnerCaps(): { total: number; heavy: number } {
  const { maxConcurrentRunnerJobs, maxConcurrentHeavyRunnerJobs } = runnerLimitsFor('runner');
  return { total: maxConcurrentRunnerJobs, heavy: maxConcurrentHeavyRunnerJobs ?? 1 };
}

export function runnerDeps(): RunnerCloudDeps {
  const auth = defaultAuthDeps();
  return { appUserPool: auth.appUserPool, origin: process.env.FX_APP_ORIGIN, failRunnerLeases, leases, maxRunners: (plan) => runnerLimitsFor(plan).maxRunners, accountRunnerCaps: accountRunnerCaps, repoVisibility: (accountId, repoId) => liveVisibility().visibility({ accountId, repoId }), pullRequests: (pullRequests ??= createAppRunPullRequestPort()) };
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

/**
 * Registration is the one runner route with no signature from a known runner to key a limit on (the runner row does not
 * exist yet), so it is limited per client address, before the body is read or any query is made (CWE-770). Real use is one
 * registration per machine; 10 a minute leaves room for several machines behind one address and still caps a guessing
 * run against the code space. The WAF rule in README.md is the outer layer.
 */
export const REGISTER_LIMIT_PER_IP_PER_MINUTE = 10;

let cachedStore: RateLimitStore | undefined;
const defaultStore = (): RateLimitStore => (cachedStore ??= new PgRateLimitStore(defaultAuthDeps().appUserPool));

/** A guard that answers 429 with Retry-After once `limit` requests from one address have been seen this minute. A store failure throws (a 500): never served unlimited. */
export function perIpLimit(routeName: string, limit: number, store: () => RateLimitStore = defaultStore, clientIp: (req: Request) => string = clientIpFromRequest): RequestGuard {
  return async (req) => {
    const decision = await store().checkAndIncrement(bucketKeyForAnonIp(routeName, clientIp(req)), limit);
    if (decision.allowed) return null;
    return { status: 429, body: { error: { code: "rate_limited", message: "too many requests" }, retry_after: decision.retryAfterSeconds }, headers: { "retry-after": String(decision.retryAfterSeconds) } };
  };
}

/** Runs before the body is read. A response ends the request. */
export type RequestGuard = (req: NextRequest) => Promise<RunnerHttpResponse | null>;

/** A runner-signed route. A guard (if any) and then the body cap come before anything else; no cookie or token is read. */
export async function handleRunnerRequest(
  req: NextRequest,
  run: (deps: RunnerCloudDeps, request: RunnerHttpRequest) => Promise<RunnerHttpResponse>,
  deps: () => RunnerCloudDeps = runnerDeps,
  guard?: RequestGuard,
): Promise<NextResponse> {
  return send(
    await toResponse(async () => {
      const refused = await guard?.(req);
      if (refused) return refused;
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
  options: { json: boolean; deps?: () => RunnerCloudDeps; sessionPool?: () => Pool } = { json: false },
): Promise<NextResponse> {
  const deps = (options.deps ?? runnerDeps)();
  // The session guard is the one thing here that needs the platform_ops login (it reads the session epoch); the runner code never sees it.
  const resolved = await resolveActiveSession(req, { platformOpsPool: (options.sessionPool ?? (() => defaultAuthDeps().platformOpsPool))() });
  if (!resolved) return send(errorResponse(new RunnerHttpError(401, "unauthorized", "sign in required")));
  const body = options.json ? await req.json().catch(() => null) : null;
  const res = await toResponse(() => run(deps, { accountId: resolved.session.accountId, userId: resolved.session.userId }, body));
  return applyRefreshedSessionCookie(send(res), resolved.refreshedToken);
}
