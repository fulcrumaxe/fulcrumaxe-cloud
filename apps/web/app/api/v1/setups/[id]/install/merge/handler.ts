import type { NextRequest } from "next/server";
import { installMergeRun } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../../lib/runnerRoutes";

/** D#845 ON-20a: POST /api/v1/setups/:id/install/merge. An owner or admin, signed in with a session (no API token, no runner signature), merges the install pull request: the person's click is the only thing that does. */
export const mergeInstallHandler = (req: NextRequest, setupId: string) => handleSessionRequest(req, (deps, principal) => installMergeRun(deps, principal, setupId));
