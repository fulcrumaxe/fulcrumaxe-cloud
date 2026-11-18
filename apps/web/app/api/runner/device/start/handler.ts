import type { NextRequest } from "next/server";
import type { RateLimitStore } from "@fx/api/src/ratelimit/store.js";
import { startDevice } from "@fx/runner-cloud";
import { handleRunnerRequest, perIpLimit } from "../../../../../lib/runnerRoutes";

/** A per-minute cap before the body is read; the per-hour limits (10 per address, the global figure) are the database's, on stored rows. */
export const DEVICE_START_LIMIT_PER_IP_PER_MINUTE = 20;

/**
 * ON-2: POST /api/runner/device/start. No session, cookie, token or signature is read: the sender proves it holds the key it presents with a signed
 * proof in the body. The store is injectable for tests; the route uses the Postgres-backed one.
 */
export const makeStartHandler = (store?: () => RateLimitStore) => {
  const guard = perIpLimit("runner-device-start", DEVICE_START_LIMIT_PER_IP_PER_MINUTE, store);
  return (req: NextRequest) => handleRunnerRequest(req, startDevice, undefined, guard);
};

export const startHandler = makeStartHandler();
