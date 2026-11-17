import type { NextRequest } from "next/server";
import { defaultEngineDialsPorts, engineDials } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../lib/runnerRoutes";

/** EB-9b: GET /api/runner/engine/dials?repo_gh_id=N. The runner asks what the repo's decisions resolve to; no session, cookie or token is read. */
export const engineDialsHandler = (req: NextRequest) => handleRunnerRequest(req, (deps, request) => engineDials(deps, request, req.nextUrl.search, defaultEngineDialsPorts()));
