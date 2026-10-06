import type { NextRequest } from "next/server";
import type { RateLimitStore } from "@fx/api/src/ratelimit/store.js";
import { registerRunner } from "@fx/runner-cloud";
import { REGISTER_LIMIT_PER_IP_PER_MINUTE, handleRunnerRequest, perIpLimit } from "../../../../lib/runnerRoutes";

/**
 * D#6 R2a: POST /api/runner/register. Registers a runner, signed by the key it registers; the code names the account. No
 * session, cookie or token is read. R2b: limited per client address before the body is read (CWE-770). The store is
 * injectable for tests; the route uses the Postgres-backed one.
 */
export const makeRegisterHandler = (store?: () => RateLimitStore) => {
  const guard = perIpLimit("runner-register", REGISTER_LIMIT_PER_IP_PER_MINUTE, store);
  return (req: NextRequest) => handleRunnerRequest(req, registerRunner, undefined, guard);
};

export const registerHandler = makeRegisterHandler();
