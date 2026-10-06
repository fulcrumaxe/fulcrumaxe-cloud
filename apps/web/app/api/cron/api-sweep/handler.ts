import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createPool } from "@fx/db/src/pool";
import { runGatedTick } from "@fx/core/src/pendingWork";
import {
  runSweep,
  nextApiSweepDueAt,
  createDeliverySender,
  verifyApiSweepKick,
  apiSweepKickKey,
  API_SWEEP_KICK_HEADER,
  type DeliverySender,
  type SweepSummary,
} from "@fx/webhooks";

/**
 * D#31 API-4a criterion 12: the sweep cron. Matches
 * apps/web/app/api/github/webhook/handler.ts's own injectable-deps
 * pattern -- route.ts stays thin, this file holds the real logic, and
 * handler.test.ts is a fast route-layer test with no real Postgres.
 *
 * Auth: Vercel sends `Authorization: Bearer <CRON_SECRET>` automatically
 * when that exact, unprefixed env var name is configured (unlike this
 * codebase's own `FX_`-prefixed secrets). `/api/cron/api-sweep` is NOT
 * under `/api/v1` (D#31's CSRF rule (c): tokens are accepted only there),
 * so a customer's `Authorization: Bearer fxat_...` is just a wrong-value
 * comparison here, failing 401 the same as no header at all.
 */

export interface ApiSweepHandlerDeps {
  cronSecret: string;
  platformOpsPool: Parameters<typeof runSweep>[0];
  sender: DeliverySender;
}

let cachedPlatformOpsPool: ReturnType<typeof createPool> | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

/**
 * D#31 API-4a's own placeholder, kept only for any test that still wants
 * a sender that always fails without touching the network. API-4b's real,
 * SSRF-guarded HTTP dispatcher (ssrf.ts + connector.ts + sign.ts,
 * `createDeliverySender`) is wired into `defaultApiSweepDeps` below --
 * the "one assignment" API-4a's own comment anticipated.
 */
export const notYetImplementedSender: DeliverySender = {
  send: async () => ({ ok: false, errorClass: "dispatcher_not_implemented" }),
};

/**
 * D#454 H3c: the pool and the sender are built on first use, which is after the request is authenticated and the
 * pending-work marker has said there is something to do. A tick that ends at the gate creates no pool.
 */
export function defaultApiSweepDeps(): ApiSweepHandlerDeps {
  let sender: DeliverySender | undefined;
  return {
    cronSecret: process.env.CRON_SECRET ?? "",
    get platformOpsPool() {
      if (!cachedPlatformOpsPool) {
        cachedPlatformOpsPool = createPool(requireEnv("DATABASE_URL_PLATFORM_OPS"));
      }
      return cachedPlatformOpsPool;
    },
    get sender() {
      sender ??= createDeliverySender(this.platformOpsPool);
      return sender;
    },
  };
}

/** Constant-time comparison against the configured secret. Rejects
 * outright (no comparison at all) when either side is empty, so an unset
 * `CRON_SECRET` fails closed rather than matching an empty Authorization
 * header. */
function isAuthorized(authHeader: string | null, cronSecret: string): boolean {
  if (!cronSecret || !authHeader) {
    return false;
  }
  const expected = Buffer.from(`Bearer ${cronSecret}`, "utf8");
  const actual = Buffer.from(authHeader, "utf8");
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

type RunSweepFn = (pool: ApiSweepHandlerDeps["platformOpsPool"], sender: DeliverySender) => Promise<SweepSummary>;
type NextDueFn = (pool: ApiSweepHandlerDeps["platformOpsPool"]) => Promise<number | null>;

/** Whether a sweep did the work the marker exists for (housekeeping like purge does not count). */
function foundWork(s: SweepSummary): boolean {
  return s.fanOut.eventsProcessed > 0 || s.sent.claimed > 0 || s.disabledEndpoints.length > 0;
}

/**
 * One gated tick: the marker is read first and the sweep (the only thing that touches the database) runs only when
 * the gate opens. `force` is the signed kick. Returns null when the tick ended at the gate.
 */
async function gatedSweep(deps: ApiSweepHandlerDeps, runSweepFn: RunSweepFn, nextDueFn: NextDueFn, force: boolean): Promise<SweepSummary | null> {
  const ran = await runGatedTick(
    "api-sweep",
    async () => {
      const summary = await runSweepFn(deps.platformOpsPool, deps.sender);
      // If the next-due read fails, keep the marker alive rather than drop work.
      const nextDueAt = await nextDueFn(deps.platformOpsPool).catch(() => Date.now());
      return { result: summary, workFound: foundWork(summary), nextDueAt };
    },
    undefined,
    undefined,
    { force },
  );
  return ran ? ran.result : null;
}

export async function apiSweepHandler(
  req: NextRequest,
  deps: ApiSweepHandlerDeps = defaultApiSweepDeps(),
  runSweepFn: RunSweepFn = (pool, sender) => runSweep(pool, sender),
  nextDueFn: NextDueFn = (pool) => nextApiSweepDueAt(pool),
): Promise<NextResponse> {
  if (!isAuthorized(req.headers.get("authorization"), deps.cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const summary = await gatedSweep(deps, runSweepFn, nextDueFn, false);
  if (summary === null) return NextResponse.json({ skipped: true, reason: "no_pending_work" }, { status: 200 });
  return NextResponse.json(summary, { status: 200 });
}

export interface ApiSweepKickDeps {
  /** CRON_SECRET; the kick's signing key is derived from it. Empty fails closed. */
  cronSecret: string;
  /** Runs the work after the response (Next's `after`). */
  schedule(work: Promise<unknown>): void;
  /** Only called after the signature verified. */
  sweepDeps(): ApiSweepHandlerDeps;
  nowSeconds?: () => number;
}

let kickSweepInFlight = false;

/**
 * D#454 H3c: `POST /api/cron/api-sweep` with a signed kick (packages/webhooks kick.ts). The signature is the only
 * authentication: anything else is a bare 401 and touches nothing. A valid kick answers 202 at once and sweeps after
 * the response; at most one kicked sweep runs per process at a time, and the sweep skips the marker gate because the
 * kick is the signal.
 */
export async function apiSweepKickHandler(
  req: Request,
  deps: ApiSweepKickDeps,
  runSweepFn: RunSweepFn = (pool, sender) => runSweep(pool, sender),
  nextDueFn: NextDueFn = (pool) => nextApiSweepDueAt(pool),
): Promise<Response> {
  const body = await req.text();
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  if (!verifyApiSweepKick(req.headers.get(API_SWEEP_KICK_HEADER), body, apiSweepKickKey(deps.cronSecret), nowSeconds())) {
    return new Response(null, { status: 401 });
  }
  if (!kickSweepInFlight) {
    kickSweepInFlight = true;
    deps.schedule(
      gatedSweep(deps.sweepDeps(), runSweepFn, nextDueFn, true)
        .catch((err: unknown) => console.error(`api-sweep kick failed: ${err instanceof Error ? err.name : "error"}`))
        .finally(() => {
          kickSweepInFlight = false;
        }),
    );
  }
  return new Response(null, { status: 202 });
}
