import type { NextRequest } from "next/server";
import { ingestEvents } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../../lib/runnerRoutes";

/** D#6 R2b-3: POST /api/runner/runs/:id/events. A runner's metadata events for a run it holds. No session, cookie or token is read. */
export const eventsHandler = (req: NextRequest, runId: string) => handleRunnerRequest(req, (deps, request) => ingestEvents(deps, request, runId));
