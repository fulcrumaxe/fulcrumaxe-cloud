import type { NextRequest } from "next/server";
import { listApprovals } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../lib/runnerRoutes";

/** D#6 R2b-4a: GET /api/runners/approvals. Any member: the runs waiting for approval, and whether this member is one of the people who can give it. */
export const listApprovalsHandler = (req: NextRequest) => handleSessionRequest(req, (deps, principal) => listApprovals(deps, principal));
