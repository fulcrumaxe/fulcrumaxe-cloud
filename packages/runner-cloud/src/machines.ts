import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { moveProject, readMachineCapacity } from "./placement.js";
import { configuredWakeKey } from "./wakeToken.js";

/**
 * D#845 MC-10a: the two session routes behind the Machines tab. Neither decides anything: eligibility, the owner-or-admin rule and every refusal come from
 * `placement.ts` (MC-9), and these only shape the request and the answer.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (): RunnerHttpError => new RunnerHttpError(400, "invalid_message", "the request does not match what this route takes");

/** GET /api/machines (any member of the account): every machine that is not removed, with its tier, the KVM fact it reported (or null), liveness, Claude readiness and the project placed on it. */
export async function listMachines(deps: RunnerCloudDeps, principal: SessionPrincipal): Promise<RunnerHttpResponse> {
  const now = (deps.now ?? (() => new Date()))();
  const machines = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    await requireMemberRole(client); // a user outside the account is 403, not an empty list
    return readMachineCapacity(client, principal.accountId, { now, wakeEnabled: configuredWakeKey(deps.wakeKey) !== null });
  });
  return {
    status: 200,
    body: {
      machines: machines.map((m) => ({ id: m.runner_id, name: m.name, tier: m.tier, kvm: m.kvm, live: m.live, claude: m.claude, running: m.running ? { repo_id: m.running.repo_id, name: m.running.name } : null })),
    },
    headers: { "cache-control": "no-store" },
  };
}

/**
 * POST /api/runners/repos/:id/move with exactly `{ to_runner_id, carry_state? }`. Owner or admin only (`moveProject` reads the role). A repo id or machine id that is not a
 * UUID, and any other body, is 400 `invalid_message`. MC-9's refusals pass through with their own codes: 403 `forbidden` or the plan-holder code, 404 `not_found`, 409
 * `project_not_placed`, `machine_not_eligible`, `machine_single_project` and `state_carry_unavailable`. Answers 200 with the machine it left and the one it reached.
 */
export async function moveProjectRoute(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string, input: unknown): Promise<RunnerHttpResponse> {
  if (!UUID.test(repoId)) throw invalid();
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid();
  const body = input as Record<string, unknown>;
  const keys = Object.keys(body);
  if (!keys.includes("to_runner_id") || keys.some((k) => k !== "to_runner_id" && k !== "carry_state")) throw invalid();
  const to = body.to_runner_id;
  if (typeof to !== "string" || !UUID.test(to)) throw invalid();
  if (body.carry_state !== undefined && typeof body.carry_state !== "boolean") throw invalid();
  const now = (deps.now ?? (() => new Date()))();
  const moved = await withTenant(deps.appUserPool, principal.accountId, principal.userId, (client) =>
    moveProject(client, { accountId: principal.accountId, userId: principal.userId }, { repoId, toRunnerId: to, carryState: body.carry_state === true, now, wakeEnabled: configuredWakeKey(deps.wakeKey) !== null }),
  );
  return { status: 200, body: { repo_id: repoId, from_runner_id: moved.from_runner_id, to_runner_id: moved.to_runner_id }, headers: { "cache-control": "no-store" } };
}
