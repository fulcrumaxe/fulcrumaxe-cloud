import type { NextRequest } from "next/server";
import { installSummaryRun } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../../lib/runnerRoutes";

/** D#845 ON-20a: GET /api/v1/setups/:id/install/summary. Any member, signed in with a session (no API token, no runner signature): what the install pull request holds, by category, read from GitHub at the pushed commit. */
export const installSummaryHandler = (req: NextRequest, setupId: string) => handleSessionRequest(req, (deps, principal) => installSummaryRun(deps, principal, setupId));
