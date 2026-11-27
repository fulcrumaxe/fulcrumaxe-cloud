import type { NextRequest } from "next/server";
import { engineRepoTokenRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../lib/runnerRoutes";

/** D#845 ON-18: POST /api/runner/engine/repo-token. The runner of a placed repo with a running session asks for the repo-scoped token the engine uses; no session, cookie or token is read. */
export const engineRepoTokenHandler = (req: NextRequest) => handleRunnerRequest(req, engineRepoTokenRun);
