import type { NextRequest } from "next/server";
import { listProvisioningTokens, mintProvisioningToken } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../lib/runnerRoutes";

/** D#605 FL-6: POST /api/runners/provisioning-tokens. A signed-in owner or admin mints a token for a machine with no browser; the secret is in this reply alone. */
export const mintTokenHandler = (req: NextRequest) => handleSessionRequest(req, (deps, principal, body) => mintProvisioningToken(deps, principal, body), { json: true });

/** D#605 FL-6: GET /api/runners/provisioning-tokens. An owner or admin lists the unused tokens (never the secret). */
export const listTokensHandler = (req: NextRequest) => handleSessionRequest(req, (deps, principal) => listProvisioningTokens(deps, principal));
