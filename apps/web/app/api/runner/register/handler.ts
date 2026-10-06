import type { NextRequest } from "next/server";
import { registerRunner } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#6 R2a: POST /api/runner/register. Registers a runner, signed by the key it registers; the code names the account. No session, cookie or token is read. */
export const registerHandler = (req: NextRequest) => handleRunnerRequest(req, registerRunner);
