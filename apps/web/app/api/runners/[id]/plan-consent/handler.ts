import type { NextRequest } from "next/server";
import { setPlanConsent } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../lib/runnerRoutes";

/** D#6 R2b-4a: POST /api/runners/:id/plan-consent. The person who registered a runner turns its "run work without asking each time" consent on or off. */
export const planConsentHandler = (req: NextRequest, runnerId: string) =>
  handleSessionRequest(req, (deps, principal, body) => setPlanConsent(deps, principal, runnerId, body), { json: true });
