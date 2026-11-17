import type { NextRequest } from "next/server";
import { ackEngineCommand } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../../../lib/runnerRoutes";

/** EB-8a: POST /api/runner/engine/commands/:id/ack. The delivering runner reports what became of one command. No session, cookie or token is read. */
export const ackHandler = (req: NextRequest, commandId: string) => handleRunnerRequest(req, (deps, request) => ackEngineCommand(deps, request, commandId));
