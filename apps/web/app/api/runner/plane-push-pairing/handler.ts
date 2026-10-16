import type { NextRequest } from "next/server";
import { planePushPairingRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#598 P1f-2b: POST /api/runner/plane-push-pairing. Gives a run-end hook the repository's live pairing, only while it is the one the build started with. Read-only. No session, cookie or token is read. */
export const planePushPairingHandler = (req: NextRequest) => handleRunnerRequest(req, planePushPairingRun);
