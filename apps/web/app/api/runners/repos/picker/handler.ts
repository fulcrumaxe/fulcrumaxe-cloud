import type { NextRequest } from "next/server";
import { listPickerRepos } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../lib/runnerRoutes";

/** D#845 ON-7a2: GET /api/runners/repos/picker. Owner or admin; a runner signature has no meaning here and gets 401. The rules live in `listPickerRepos`. */
export const listPickerReposHandler = (req: NextRequest) => handleSessionRequest(req, (deps, principal) => listPickerRepos(deps, principal));
