import type { NextRequest } from "next/server";
import { planePushTokenRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#598 P1f-2: POST /api/runner/plane-push-token. Gives an executor run on a paired repo the one restricted token its run-end hook pushes with. No session, cookie or token is read. */
export const planePushTokenHandler = (req: NextRequest) => handleRunnerRequest(req, planePushTokenRun);
