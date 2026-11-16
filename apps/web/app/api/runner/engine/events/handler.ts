import type { NextRequest } from "next/server";
import { ingestEngineEvents } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../lib/runnerRoutes";

/** Engine bridge EB-4: POST /api/runner/engine/events. A runner's batch of closed engine events. Signed by the runner; no session, cookie or token is read. */
export const engineEventsHandler = (req: NextRequest) => handleRunnerRequest(req, ingestEngineEvents);
