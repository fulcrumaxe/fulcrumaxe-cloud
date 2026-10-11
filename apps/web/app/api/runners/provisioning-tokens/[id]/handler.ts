import type { NextRequest } from "next/server";
import { revokeProvisioningToken } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../lib/runnerRoutes";

/** D#605 FL-6: DELETE /api/runners/provisioning-tokens/:id. A signed-in owner or admin revokes an unused token; it stops working at once. */
export const revokeTokenHandler = (req: NextRequest, tokenId: string) => handleSessionRequest(req, (deps, principal) => revokeProvisioningToken(deps, principal, tokenId));
