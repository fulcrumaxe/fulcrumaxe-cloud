import type { NextRequest } from "next/server";
import { retryInstall } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../../lib/runnerRoutes";

/** D#845 ON-8b: POST /api/v1/setups/:id/install/retry. An owner or admin, signed in with a session (no API token), issues the next attempt of a failed or expired install. */
export const retryInstallHandler = (req: NextRequest, setupId: string) => handleSessionRequest(req, (deps, principal) => retryInstall(deps, principal, setupId));
