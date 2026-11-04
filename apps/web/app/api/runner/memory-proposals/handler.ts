import type { NextRequest } from "next/server";
import { memoryProposalsRun } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../lib/runnerRoutes";

/** D#601 MEM-6: POST /api/runner/memory-proposals. Takes in the memory proposals a person said yes to on their own machine, after a run of that runner ended. No session, cookie or token is read. */
export const memoryProposalsHandler = (req: NextRequest) => handleRunnerRequest(req, memoryProposalsRun);
