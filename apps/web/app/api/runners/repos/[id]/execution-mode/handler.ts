import type { NextRequest } from "next/server";
import { getRepoMode, setExecutionMode } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../lib/runnerRoutes";

/** D#6 R2b: POST /api/runners/repos/:id/execution-mode. An owner or admin moves a repo between the sandbox and a runner, or turns its local-review auto-merge on or off. */
export const executionModeHandler = (req: NextRequest, repoId: string) =>
  handleSessionRequest(req, (deps, principal, body) => setExecutionMode(deps, principal, repoId, body), { json: true });

/** D#6 R5b-2b-iii: GET /api/runners/repos/:id/execution-mode. Any member reads the repo's mode, whether a usable model key is connected, and the opt-in wording's hash. */
export const getRepoModeHandler = (req: NextRequest, repoId: string) => handleSessionRequest(req, (deps, principal) => getRepoMode(deps, principal, repoId));
