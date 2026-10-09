import type { NextRequest } from "next/server";
import { getPlanApprovalDial, setPlanApprovalDial } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../lib/runnerRoutes";

/** D#6 R2b-4a: GET /api/runners/repos/:id/plan-approval-dial. Any member reads the repo's dial for "a runner run uses a member's Claude plan". */
export const getPlanApprovalDialHandler = (req: NextRequest, repoId: string) => handleSessionRequest(req, (deps, principal) => getPlanApprovalDial(deps, principal, repoId));

/** D#6 R2b-4a: PUT /api/runners/repos/:id/plan-approval-dial. An owner or admin writes the next version of that dial. */
export const putPlanApprovalDialHandler = (req: NextRequest, repoId: string) =>
  handleSessionRequest(req, (deps, principal, body) => setPlanApprovalDial(deps, principal, repoId, body), { json: true });
