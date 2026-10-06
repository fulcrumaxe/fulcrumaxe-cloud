import type { NextRequest } from "next/server";
import { rotateRunnerKey } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#6 R2a: POST /api/runner/rotate. Rotates a runner key, signed by the current key. No session, cookie or token is read. */
export const rotateHandler = (req: NextRequest) => handleRunnerRequest(req, rotateRunnerKey);
