import type { NextRequest } from "next/server";
import type { RateLimitStore } from "@fx/api/src/ratelimit/store.js";
import { pollDevice } from "@fx/runner-cloud";
import { handleRunnerRequest, perIpLimit } from "../../../../../lib/runnerRoutes";

/** A runner polls every 5 seconds; this is a floor against a flood of polls with no valid signature, ahead of the body and the lookup. */
export const DEVICE_POLL_LIMIT_PER_IP_PER_MINUTE = 60;

/** ON-2: POST /api/runner/device/poll, signed by the key the code was started with. */
export const makePollHandler = (store?: () => RateLimitStore) => {
  const guard = perIpLimit("runner-device-poll", DEVICE_POLL_LIMIT_PER_IP_PER_MINUTE, store);
  return (req: NextRequest) => handleRunnerRequest(req, pollDevice, undefined, guard);
};

export const pollHandler = makePollHandler();
