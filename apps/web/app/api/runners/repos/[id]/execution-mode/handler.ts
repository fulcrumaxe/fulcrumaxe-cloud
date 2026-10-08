import type { NextRequest } from "next/server";
import { setExecutionMode } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../lib/runnerRoutes";

/** D#6 R2b: POST /api/runners/repos/:id/execution-mode. An owner or admin moves a repo between the sandbox and a runner, or turns its local-review auto-merge on or off. */
export const executionModeHandler = (req: NextRequest, repoId: string) =>
  handleSessionRequest(req, (deps, principal, body) => setExecutionMode(deps, principal, repoId, body), { json: true });
