import type { PoolClient } from "pg";
import { markRunnerWork } from "@fx/core/src/pendingWork.js";
import { DIAL_DEFAULT_MARKER, getCurrentDialSetting, writeDialSetting } from "@fx/db/src/decisions.js";
import { RUNNER_RUN_DECISION_TYPE, defaultDisposition, dispositionForPreset, isPresetName, readRunnerPlanDial, type RunnerPlanDial } from "@fx/db/src/runnerPlanDial.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISPOSITIONS = ["ask", "announce", "act"] as const;

const body = (repoId: string, dial: RunnerPlanDial, canChange: boolean): RunnerHttpResponse => ({
  status: 200,
  body: { repo_id: repoId, decision_type: RUNNER_RUN_DECISION_TYPE, disposition: dial.disposition, source: dial.source, preset: dial.preset, version: dial.version, can_change: canChange },
  headers: { "cache-control": "no-store" },
});

async function requireRepo(client: PoolClient, repoId: string): Promise<void> {
  if ((await client.query("SELECT 1 FROM repos WHERE id = $1", [repoId])).rowCount === 0) throw new RunnerHttpError(404, "not_found", "no such repository");
}

/**
 * GET /api/runners/repos/:id/plan-approval-dial (a session route, any member). The repo's current disposition for the decision "a runner run
 * uses a member's Claude plan" (D#7's `runner_run_on_member_plan`): `ask` (each run waits for a click), `announce` (approved at claim, with a
 * notice) or `act` (approved at claim). `source` is where it comes from: a `preset` the last write adopted, an `override`, or the `default`
 * when no row exists (the catalogue's, `announce`); `version` is the current dial version or null for the default. `can_change` says whether
 * the caller may PUT (an owner or admin).
 */
export async function getPlanApprovalDial(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(repoId)) throw new RunnerHttpError(404, "not_found", "no such repository");
  const { dial, role } = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    const role = await requireMemberRole(client);
    await requireRepo(client, repoId);
    return { dial: await readRunnerPlanDial(client, repoId), role };
  });
  return body(repoId, dial, role === "owner" || role === "admin");
}

/**
 * PUT /api/runners/repos/:id/plan-approval-dial (a session route, owner or admin only; a member gets 403 and nothing is written). The body is
 * exactly `{ disposition: "ask" | "announce" | "act" }` (an override), `{ preset: "cautious" | "balanced" | "autonomous" }` (the preset's
 * disposition for this decision, recorded with its name) or `{ reset: true }` (use the default again: `source` reads `default`; a repo with no
 * version, or already on the default, writes nothing); anything else is 400. It goes through `writeDialSetting`, so the write is a new
 * append-only version attributed to the signed-in user (never a field of the request), with the dial audit row, in one transaction. A pending
 * run is not touched: it is re-read at the next claim, so lowering the dial applies from there.
 */
export async function setPlanApprovalDial(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string, input: unknown): Promise<RunnerHttpResponse> {
  if (!UUID.test(repoId)) throw new RunnerHttpError(404, "not_found", "no such repository");
  const invalid = (): never => {
    throw new RunnerHttpError(400, "invalid_message", "the request does not match what this route takes");
  };
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid();
  const keys = Object.keys(input).join(",");
  const given = input as { disposition?: unknown; preset?: unknown };
  let disposition: (typeof DISPOSITIONS)[number];
  let preset: string | null = null;
  let reset = false;
  if (keys === "reset" && (input as { reset?: unknown }).reset === true) {
    reset = true;
    disposition = defaultDisposition();
    preset = DIAL_DEFAULT_MARKER;
  } else if (keys === "disposition" && typeof given.disposition === "string" && (DISPOSITIONS as readonly string[]).includes(given.disposition)) {
    disposition = given.disposition as (typeof DISPOSITIONS)[number];
  } else if (keys === "preset" && isPresetName(given.preset)) {
    preset = given.preset;
    disposition = dispositionForPreset(given.preset);
  } else {
    return invalid();
  }
  try {
    await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      const role = await requireMemberRole(client);
      if (role !== "owner" && role !== "admin") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can change this");
      await requireRepo(client, repoId);
    });
    if (reset) {
      // Nothing to undo when no version exists or the current one already is the default: no version, no audit row.
      const current = await withTenant(deps.appUserPool, principal.accountId, principal.userId, (client) => getCurrentDialSetting(client, repoId, RUNNER_RUN_DECISION_TYPE));
      if (current === null || current.preset === DIAL_DEFAULT_MARKER) return getPlanApprovalDial(deps, principal, repoId);
    }
    await writeDialSetting({ pool: deps.appUserPool, principal: principal.userId }, { accountId: principal.accountId, repoId, decisionType: RUNNER_RUN_DECISION_TYPE, disposition, preset });
    // The new dial version has committed: a repository moved off "ask" can have its waiting runs auto-approved.
    if (disposition !== "ask") void markRunnerWork(principal.accountId);
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    switch (pgCode(error)) {
      case "42501":
        throw new RunnerHttpError(403, "forbidden", "only an owner or admin can change this");
      case "23505":
      case "23514":
        throw new RunnerHttpError(409, "dial_changed", "the setting changed while you saved; reload and try again");
      default:
        throw error;
    }
  }
  return getPlanApprovalDial(deps, principal, repoId);
}
