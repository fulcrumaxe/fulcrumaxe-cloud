import type { NextRequest } from "next/server";
import { selfRevokeRunner } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#6 R2a: POST /api/runner/revoke. A runner revokes itself, signed by its own key. No session, cookie or token is read. */
export const revokeHandler = (req: NextRequest) => handleRunnerRequest(req, selfRevokeRunner);
