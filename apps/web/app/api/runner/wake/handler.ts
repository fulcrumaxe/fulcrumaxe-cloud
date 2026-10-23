import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getCache } from "@vercel/functions";
import { RUNNER_WAKE_CACHE_NAMESPACE, readWakeKey, runnerSeenWriter, runnerWake, type RunnerSeenWriter, type WakeDeps } from "@fx/runner-cloud";

/**
 * D#6 RUNNER-WAKE R3b: GET /api/runner/wake. The no-database "is there work for my account" check (`runnerWake` decides everything).
 * This edge never builds `runnerDeps()`: those hold the pools. It reads only the origin, the wake key and the liveness cache; the account's
 * epoch and the revocations come from the pending-work store the instrumentation hook installs (Runtime Cache).
 */

let seenWriter: RunnerSeenWriter | undefined;
/**
 * The `seen:<rid>` writer over the wake namespace of Runtime Cache, where the fleet read finds it (runnerSeenCache.ts). One per process, so it
 * remembers its own last writes and never reads the cache. Built on first use.
 */
function liveSeenWriter(): RunnerSeenWriter {
  if (seenWriter) return seenWriter;
  const cache = getCache({ namespace: RUNNER_WAKE_CACHE_NAMESPACE });
  seenWriter = runnerSeenWriter({ set: (key, value, ttlSeconds) => cache.set(key, value, { ttl: ttlSeconds, name: key }) });
  return seenWriter;
}

export function wakeDeps(): WakeDeps {
  return { origin: process.env.FX_APP_ORIGIN, wakeKey: () => readWakeKey(process.env), seenWriter: liveSeenWriter() };
}

/** A GET carries no body; anything at all is read only as far as one byte, so the handler can refuse it. */
async function firstBytes(req: Request): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  try {
    const { value } = await reader.read();
    return value ?? new Uint8Array(0);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The handler over `deps` (tests pass their own). Next calls the route with a second, context argument, so the route uses `wakeHandler` below. */
export const makeWakeHandler = (deps: () => WakeDeps) => (req: NextRequest): Promise<NextResponse> => handle(req, deps);
export const wakeHandler = makeWakeHandler(wakeDeps);

async function handle(req: NextRequest, deps: () => WakeDeps): Promise<NextResponse> {
  let res: { status: number; body: unknown; headers?: Record<string, string> };
  try {
    res = await runnerWake(deps(), { method: req.method, headers: Object.fromEntries(req.headers), body: await firstBytes(req) });
  } catch (error) {
    // fx-swallow-ok: answered as a bare 500 and logged to stdout only; the usual reporter would open a database connection to count this.
    console.log(JSON.stringify({ event: "runner_wake.edge_failed", error_name: error instanceof Error ? error.name : "unknown" }));
    res = { status: 500, body: { error: { code: "internal", message: "internal error" } } };
  }
  return NextResponse.json(res.body, { status: res.status, headers: { "cache-control": "no-store", ...res.headers } });
}
