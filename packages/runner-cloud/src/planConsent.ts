import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/runners/:id/plan-consent (a session route) with `{ granted: boolean }` and nothing else (400 otherwise).
 *
 * The standing consent of a runner's registrant to let work on that runner's repos run on their Claude plan without a click for each
 * run (C31 section 2.3). `runner_plan_consent_set` (0767) decides who may: only the person who registered the runner, so an owner, an
 * admin and platform_ops get 403 like any other member (the definer refuses 42501). A revoked or unknown runner is 404. The caller is
 * always the session's user, never a field of the request. Each real change is a new version of an append-only record with who and when,
 * plus an audit row; granting what is on, or withdrawing what is off, changes nothing (`changed: false`). Nothing here makes a run
 * start: the claim reads the consent, and the repo's dial decides whether it counts.
 */
export async function setPlanConsent(deps: RunnerCloudDeps, principal: SessionPrincipal, runnerId: string, body: unknown): Promise<RunnerHttpResponse> {
  if (!UUID.test(runnerId)) throw new RunnerHttpError(404, "not_found", "no such runner");
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).join(",") !== "granted" || typeof (body as { granted?: unknown }).granted !== "boolean") {
    throw new RunnerHttpError(400, "invalid_message", "the request does not match what this route takes");
  }
  const granted = (body as { granted: boolean }).granted;
  try {
    const row = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      const { rows } = await client.query<{ changed: boolean; changed_at: Date | null }>("SELECT changed, changed_at FROM runner_plan_consent_set($1, $2)", [runnerId, granted]);
      return rows[0];
    });
    return {
      status: 200,
      body: { plan_consent: { granted, changed_at: row?.changed_at ? row.changed_at.toISOString() : null }, changed: row?.changed === true },
      headers: { "cache-control": "no-store" },
    };
  } catch (error) {
    switch (pgCode(error)) {
      case "42501":
        throw new RunnerHttpError(403, "forbidden", "only the person who registered this runner can change this");
      case "P0002":
        throw new RunnerHttpError(404, "not_found", "no such runner");
      default:
        throw error;
    }
  }
}
