import type { NextRequest } from "next/server";
import { setupPlanRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../../lib/runnerRoutes";

/** D#845 ON-8b: GET /api/runner/setup/:setup_id/plan?version=N. The machine running a setup job fetches the approved plan file; signed, no session, cookie or token is read. */
export const setupPlanHandler = (req: NextRequest, setupId: string) => handleRunnerRequest(req, (deps, request) => setupPlanRun(deps, request, req.nextUrl.search, setupId));
