import type { NextRequest } from "next/server";
import { runnerHello } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#6 R2a: POST /api/runner/hello. Records a runner's protocol and binary versions, signed by its key. No session, cookie or token is read. */
export const helloHandler = (req: NextRequest) => handleRunnerRequest(req, runnerHello);
