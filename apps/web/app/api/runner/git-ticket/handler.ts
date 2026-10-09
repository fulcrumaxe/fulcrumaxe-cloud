import type { NextRequest } from "next/server";
import { gitTicketRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#6 R5a-2b: POST /api/runner/git-ticket. Gives a cloud-verified run a short-lived signed ticket for the GitHub proxy. No session, cookie or token is read. */
export const gitTicketHandler = (req: NextRequest) => handleRunnerRequest(req, gitTicketRun);
