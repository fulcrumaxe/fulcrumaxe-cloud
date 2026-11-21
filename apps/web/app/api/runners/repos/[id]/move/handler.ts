import type { NextRequest } from "next/server";
import { moveProjectRoute } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../lib/runnerRoutes";

/** D#845 MC-10a: POST /api/runners/repos/:id/move with { to_runner_id, carry_state? }. Owner or admin only; the rules live in MC-9's `moveProject`. */
export const moveProjectHandler = (req: NextRequest, repoId: string) => handleSessionRequest(req, (deps, principal, body) => moveProjectRoute(deps, principal, repoId, body), { json: true });
