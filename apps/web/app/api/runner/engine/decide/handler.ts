import type { NextRequest } from "next/server";
import { engineDecide } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../../../../../lib/runnerRoutes";

/** EB-9a: POST /api/runner/engine/decide. The engine asks before it spawns, merges or marks a Spec ready. No session, cookie or token is read. */
export const engineDecideHandler = (req: NextRequest) => handleRunnerRequest(req, (deps, request) => engineDecide(deps, request));
