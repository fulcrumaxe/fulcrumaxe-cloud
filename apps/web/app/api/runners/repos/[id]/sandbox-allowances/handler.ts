import type { NextRequest } from "next/server";
import { getSandboxAllowances, setSandboxAllowances } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../lib/runnerRoutes";

/** D#6 R7a: GET /api/runners/repos/:id/sandbox-allowances. Any member reads the allowance set an owner or admin approved for the repo. */
export const getSandboxAllowancesHandler = (req: NextRequest, repoId: string) => handleSessionRequest(req, (deps, principal) => getSandboxAllowances(deps, principal, repoId));

/** D#6 R7a: PUT /api/runners/repos/:id/sandbox-allowances. An owner or admin approves the reviewed allowance file they picked, typing the repo's name. */
export const putSandboxAllowancesHandler = (req: NextRequest, repoId: string) =>
  handleSessionRequest(req, (deps, principal, body) => setSandboxAllowances(deps, principal, repoId, body), { json: true });
