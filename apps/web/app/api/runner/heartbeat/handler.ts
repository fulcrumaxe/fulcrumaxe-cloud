import type { NextRequest } from "next/server";
import { heartbeatRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#6 R2b-3: POST /api/runner/heartbeat. Extends a run's lease while the runner still holds it. No session, cookie or token is read. */
export const heartbeatHandler = (req: NextRequest) => handleRunnerRequest(req, heartbeatRun);
