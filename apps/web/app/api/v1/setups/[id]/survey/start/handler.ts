import type { NextRequest } from "next/server";
import { startSurveyRoute } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../../lib/runnerRoutes";

/** D#845 ON-10e2a: POST /api/v1/setups/:id/survey/start. An owner or admin, signed in with a session (no API token), starts the survey. The body is optional: `{consent: "public_repo_v1"}` is what a public repo's survey needs. */
export const startSurveyHandler = (req: NextRequest, setupId: string) => handleSessionRequest(req, (deps, principal, body) => startSurveyRoute(deps, principal, setupId, body), { json: true });
