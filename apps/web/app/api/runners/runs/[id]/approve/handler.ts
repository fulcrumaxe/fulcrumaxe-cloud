import type { NextRequest } from "next/server";
import { approveRun } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../lib/runnerRoutes";

/** D#6 R2b: POST /api/runners/runs/:id/approve. The registrant of a live subscription runner approves a run for it. */
export const approveRunHandler = (req: NextRequest, runId: string) => handleSessionRequest(req, (deps, principal) => approveRun(deps, principal, runId));
