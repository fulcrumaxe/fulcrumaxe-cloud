import type { NextRequest } from "next/server";
import { engineRepoTokenStopRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../lib/runnerRoutes";

/** D#845 ON-18: POST /api/runner/engine/repo-token-stop. The runner that gave up refreshing a session's repository token reports the stop it is about to make; no session, cookie or token is read. */
export const engineRepoTokenStopHandler = (req: NextRequest) => handleRunnerRequest(req, engineRepoTokenStopRun);
