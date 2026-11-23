import type { NextRequest } from "next/server";
import { startEngine } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../../lib/runnerRoutes";

/** D#845 ON-13a2: POST /api/v1/engine/repos/:id/start. An owner or admin, signed in with a session (no API token), starts the repo's placed engine: refused 402 without a covering plan and 409 `operate_off` while operate is off. */
export const startEngineHandler = (req: NextRequest, repoId: string) => handleSessionRequest(req, (deps, principal) => startEngine(deps, principal, repoId));
