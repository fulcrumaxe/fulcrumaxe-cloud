import type { NextRequest } from "next/server";
import { setupPushTokenRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../../lib/runnerRoutes";

/** D#845 ON-8f: POST /api/runner/setup/:setup_id/push-token. The runner running a setup job asks for its one push credential, once per job. Signed; no session, cookie or token is read. */
export const setupPushTokenHandler = (req: NextRequest, setupId: string) => handleRunnerRequest(req, (deps, request) => setupPushTokenRun(deps, request, setupId));
