import type { NextRequest } from "next/server";
import { retrySurvey } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../../lib/runnerRoutes";

/** D#845 ON-10b2: POST /api/v1/setups/:id/survey/retry. An owner or admin, signed in with a session (no API token), starts the survey again after it failed or when no survey is running. It takes no body. */
export const retrySurveyHandler = (req: NextRequest, setupId: string) => handleSessionRequest(req, (deps, principal, body) => retrySurvey(deps, principal, setupId, body), { json: true });
