import type { NextRequest } from "next/server";
import { draftRoute } from "@fx/runner-cloud";
import { handleSessionRequest } from "../../../../../../lib/runnerRoutes";

/** D#845 ON-11a: the plan draft of a setup. GET reads it (any member); PUT edits it and POST .../draft/{approve,discard,blank,restart} act on it (an owner or admin). A session only: no API token, no runner signature. */
export const draftHandler = (req: NextRequest, setupId: string, action: string | null) =>
  handleSessionRequest(req, (deps, principal, body) => draftRoute(deps, principal, req.method as "GET" | "PUT" | "POST", setupId, action, body), { json: req.method !== "GET" });
