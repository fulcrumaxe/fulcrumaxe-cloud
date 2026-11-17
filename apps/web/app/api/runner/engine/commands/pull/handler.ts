import type { NextRequest } from "next/server";
import { pullEngineCommands } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../../lib/runnerRoutes";

/** EB-8a: POST /api/runner/engine/commands/pull. The runner asks for its pending engine commands. No session, cookie or token is read. */
export const pullHandler = (req: NextRequest) => handleRunnerRequest(req, (deps, request) => pullEngineCommands(deps, request));
