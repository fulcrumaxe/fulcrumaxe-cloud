import type { PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { QUEUE_TTL_MS } from "@fx/runner";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { hasUsableKey } from "./executionMode.js";
import { auditPlacementChange, type Placement } from "./itemPlacement.js";
import { requireMemberRole } from "./memberRole.js";
import { readRunners } from "./readModel.js";
import { withRunnerSession, type VerifiedRunner } from "./verifyRunnerRequest.js";

/**
 * D#599 HO-2a: asking to move a RUNNING run to the other side (the cloud sandbox or the person's runner), taking the move back
 * while it has not begun, and answering the heartbeat that tells the runner to stop. Completion, the deadline sweep and the new
 * run are HO-2b; the runner's side of the stop is HO-3.
 */

/** How long the active side has to reach a safe point, push and say so. After it the cloud continues from the last pushed head (HO-2b). */
export const HANDOFF_DEADLINE_MS = 300_000;
/**
 * The first runner protocol version that can read `handoff` on a heartbeat reply (R-599-HO1). A runner parses replies strictly, so one
 * below this would fail its heartbeat; the cloud never sends it. HO-3 raises `CURRENT_PROTOCOL_VERSION` to this value in the same change
 * that ships a runner able to act on the field; raising it earlier would make every handoff run out its deadline.
 */
export const HANDOFF_PROTOCOL_VERSION = 2;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUNNER_MODES = new Set(["runner_local", "runner_verified"]);

/** The spend rows a cloud target holds for the run that will continue there: up to one for the model and one for compute, bound to no run yet. */
export interface HandoffReservations {
  modelId: string | null;
  computeId: string | null;
}

/**
 * The cloud target's admission, supplied by apps/web (it needs the seat resolver and the spend package, which this package does not
 * import). `seat` reads what a cloud run of the item would get (its own transaction, so it runs before ours) and answers a refusal word,
 * or a `reserve` that runs the same `admit` / `reserve()` inside the caller's transaction with NO run id: the reservations belong to the
 * move, not to the run being left. A spend refusal is `refused_spend` with the closed reason spend gave.
 */
export interface HandoffCloudTarget {
  seat(input: { accountId: string; workItemId: string; role: string }): Promise<
    | { ok: true; reserve: (client: PoolClient) => Promise<{ ok: true; reservations: HandoffReservations } | { ok: false; reason: string }> }
    | { ok: false; reason: string }
  >;
}

export interface HandoffDeps extends Pick<RunnerCloudDeps, "appUserPool" | "now" | "repoVisibility"> {
  /** Absent: a move to the cloud answers 503 `handoff_unavailable`. */
  cloudTarget?: HandoffCloudTarget | null;
  /** Whether a job to a runner can be signed (the job-signing key pair is set and valid). Absent or false: a move to a runner answers 503 `handoff_unavailable`. */
  runnerJobsConfigured?: () => boolean;
}

interface RunFacts {
  status: string;
  execution_mode: string;
  work_item_id: string | null;
  role: string;
  runner_id: string | null;
  repo_id: string | null;
}

const unavailable = () => new RunnerHttpError(503, "handoff_unavailable", "moving this run is not available");

/** What a definer's refusal is told as: a fixed status and code for the SQLSTATEs it raises on purpose, anything else untouched (a bare 500 upstream). */
function definerRefusal(error: unknown): unknown {
  switch (pgCode(error)) {
    case "42501":
      return new RunnerHttpError(403, "forbidden", "only an owner or admin can move a run");
    case "P0002":
      return new RunnerHttpError(404, "not_found", "no such run or handoff");
    case "55000":
      return new RunnerHttpError(409, "run_not_movable", "only a running run of a work item can be moved");
    case "23505":
      return new RunnerHttpError(409, "handoff_in_progress", "this run is already being moved");
    case "55006":
      return new RunnerHttpError(409, "handoff_committed", "the move has begun and completes");
    case "22023":
      return new RunnerHttpError(400, "invalid_message", "the request does not match what this route takes");
    default:
      return error;
  }
}

/** A runner of the account that could take the run now: live, not full, listed for the repo, and not the one the run is on. */
async function coveringRunnerExists(deps: HandoffDeps, principal: SessionPrincipal, repoId: string, sourceRunnerId: string | null): Promise<boolean> {
  const runners = await readRunners({ appUserPool: deps.appUserPool, now: deps.now }, principal.accountId, principal.userId);
  return runners.some((r) => {
    if (r.id === sourceRunnerId || !r.repos.some((g) => g.id === repoId)) return false;
    if (r.state === "online_idle") return true;
    return r.state === "busy" && (r.capacity === null || r.running.light + r.running.heavy < r.capacity.total_limit);
  });
}

async function readVisibility(deps: HandoffDeps, accountId: string, repoId: string): Promise<"private" | "public" | "unknown"> {
  try {
    return (await deps.repoVisibility?.(accountId, repoId)) ?? "unknown";
  } catch {
    // fx-swallow-ok: a failed read is "unknown", which refuses (409 repo_visibility_unknown)
    return "unknown";
  }
}

/**
 * POST /api/v1/runs/:id/handoff {to} (owner or admin). In order, and every refusal before the first write:
 *  1. the run is a running run of an item, not already on `to`, with no live handoff, and (a runner run) its runner's stored protocol version
 *     can read the signal, else 409 `runner_update_required`;
 *  2. the target is ready. A runner: the repo is on a runner mode and private, a live runner that lists the repo has room (the run's own
 *     runner does not count), and jobs can be signed. The cloud: a usable model key, then the same seat, `admit` and `reserve()` a cloud
 *     run of the item gets, reserving BEFORE any signal so a stopped run is never stranded by a refusal later;
 *  3. one definer inserts the row as `requested` (deadline = now + HANDOFF_DEADLINE_MS), sets the item's placement and audits it.
 * A refusal answers 409 with a named code and leaves the run running with no handoff row. `betweenRunners` (the fleet's drain) allows a
 * runner run to be asked onto the runner side again; the route never sets it.
 */
export async function requestHandoff(deps: HandoffDeps, principal: SessionPrincipal, runId: string, to: unknown, options: { betweenRunners?: boolean } = {}): Promise<RunnerHttpResponse> {
  if (!UUID.test(runId)) throw new RunnerHttpError(404, "not_found", "no such run");
  if (to !== "cloud" && to !== "runner") throw new RunnerHttpError(400, "invalid_message", "the request does not match what this route takes");
  const target: Placement = to;
  const between = options.betweenRunners === true;
  const now = (deps.now ?? (() => new Date()))();

  const facts = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    const role = await requireMemberRole(client);
    if (role !== "owner" && role !== "admin") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can move a run");
    const run = (
      await client.query<RunFacts>(
        `SELECT a.status, a.execution_mode, a.work_item_id, a.role, a.runner_id, w.repo_id
           FROM agent_runs a LEFT JOIN work_items w ON w.account_id = a.account_id AND w.id = a.work_item_id WHERE a.id = $1`,
        [runId],
      )
    ).rows[0];
    if (!run) throw new RunnerHttpError(404, "not_found", "no such run");
    if (run.status !== "running" || run.work_item_id === null) throw new RunnerHttpError(409, "run_not_movable", "only a running run of a work item can be moved");
    const from: Placement = run.execution_mode === "sandbox" ? "cloud" : "runner";
    if (target === from && !(between && from === "runner")) throw new RunnerHttpError(409, "already_on_that_side", "the run is already there");
    // R-599-HO1, up front: a runner that cannot read `handoff` would never be told, and the request and its spend hold would sit open to the deadline.
    if (from === "runner") {
      const seen = (await client.query<{ protocol_version: number | null }>("SELECT protocol_version FROM runners WHERE id = $1", [run.runner_id])).rows[0]?.protocol_version ?? null;
      if (seen === null || seen < HANDOFF_PROTOCOL_VERSION) throw new RunnerHttpError(409, "runner_update_required", "the runner holding this run must be updated before the run can be moved");
    }
    if ((await client.query("SELECT 1 FROM run_handoffs WHERE run_id = $1 AND state IN ('requested', 'checkpointing')", [runId])).rows.length > 0) {
      throw new RunnerHttpError(409, "handoff_in_progress", "this run is already being moved");
    }
    if (run.repo_id === null) throw new RunnerHttpError(409, "no_repo", "the work item has no repository");
    const repo = (await client.query<{ execution_mode: string }>("SELECT execution_mode FROM repos WHERE id = $1", [run.repo_id])).rows[0];
    if (!repo) throw new RunnerHttpError(409, "no_repo", "the work item has no repository");
    if (target === "cloud") {
      if (!deps.cloudTarget) throw unavailable();
      if (!(await hasUsableKey(client, principal.accountId))) throw new RunnerHttpError(409, "model_key_required", "connect a model API key to run in the cloud");
    } else {
      if (!deps.runnerJobsConfigured?.()) throw unavailable();
      // The repo's own mode is the allowance to run on a runner (its approved sandbox set only applies there); without it nothing may start.
      if (!RUNNER_MODES.has(repo.execution_mode)) throw new RunnerHttpError(409, "no_runner_mode", "this repository is not set up to run on a runner");
    }
    return { run, repoId: run.repo_id, workItemId: run.work_item_id };
  });

  if (target === "runner") {
    const seen = await readVisibility(deps, principal.accountId, facts.repoId);
    if (seen === "public") throw new RunnerHttpError(409, "public_repo", "a public repository cannot run on a runner");
    if (seen !== "private") throw new RunnerHttpError(409, "repo_visibility_unknown", "the repository's visibility could not be read");
    if (!(await coveringRunnerExists(deps, principal, facts.repoId, facts.run.runner_id))) throw new RunnerHttpError(409, "no_runner_online", "no runner is online with room for this repository");
  }

  let seat: Extract<Awaited<ReturnType<HandoffCloudTarget["seat"]>>, { ok: true }> | null = null;
  if (target === "cloud") {
    const seated = await deps.cloudTarget!.seat({ accountId: principal.accountId, workItemId: facts.workItemId, role: facts.run.role });
    if (!seated.ok) throw new RunnerHttpError(409, "target_not_ready", "the item cannot be run in the cloud", { reason: seated.reason });
    seat = seated;
  }
  const deadline = new Date(now.getTime() + HANDOFF_DEADLINE_MS);
  const reserveUntil = new Date(deadline.getTime() + QUEUE_TTL_MS);
  // A spend refusal is returned, not thrown, so the commit keeps what a refused reserve() recorded (the once-a-month budget event).
  const outcome = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    let reservations: HandoffReservations = { modelId: null, computeId: null };
    if (seat) {
      const taken = await seat.reserve(client);
      if (!taken.ok) return { refused: new RunnerHttpError(409, "refused_spend", "the account's spend refused this move", { reason: taken.reason }) };
      reservations = taken.reservations;
    }
    try {
      const { rows } = await client.query<{ handoff_id: string; from_side: Placement; prior_placement: Placement | null }>(
        "SELECT handoff_id, from_side, prior_placement FROM run_handoff_request($1, $2, $3, $4, $5, $6, $7)",
        [runId, target, deadline, reserveUntil, reservations.modelId, reservations.computeId, between],
      );
      const made = rows[0]!;
      // The placement is the item's new value; one audit row says so (the handoff's own row says the rest). A move that changes nothing writes none.
      if (made.prior_placement !== target) await auditPlacementChange(client, { itemId: facts.workItemId, from: made.prior_placement, to: target, cancelledRuns: 0 });
      return { made };
    } catch (error) {
      throw definerRefusal(error);
    }
  });
  if ("refused" in outcome) throw outcome.refused;
  return {
    status: 202,
    body: { handoff_id: outcome.made.handoff_id, run_id: runId, state: "requested", from: outcome.made.from_side, to: target, deadline: deadline.toISOString() },
    headers: { "cache-control": "no-store" },
  };
}

/**
 * POST /api/v1/runs/:id/handoff/cancel (owner or admin). Only a `requested` handoff: the reservation is released (its rows go to `released`, and the cancelled row keeps their ids),
 * the item's placement goes back if nobody changed it since, an audit row is written, and the run keeps running. Once the side has been
 * told (`checkpointing`) the move completes, and this answers 409 `handoff_committed`.
 */
export async function cancelHandoff(deps: Pick<HandoffDeps, "appUserPool">, principal: SessionPrincipal, runId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(runId)) throw new RunnerHttpError(404, "not_found", "no such run");
  const done = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    const role = await requireMemberRole(client);
    if (role !== "owner" && role !== "admin") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can move a run");
    try {
      const { rows } = await client.query<{ handoff_id: string; to_side: Placement; prior_placement: Placement | null; reverted: boolean }>("SELECT handoff_id, to_side, prior_placement, reverted FROM run_handoff_cancel($1)", [runId]);
      const row = rows[0]!;
      const itemId = (await client.query<{ item_id: string }>("SELECT item_id FROM run_handoffs WHERE id = $1", [row.handoff_id])).rows[0]!.item_id;
      if (row.reverted) await auditPlacementChange(client, { itemId, from: row.to_side, to: row.prior_placement, cancelledRuns: 0 });
      return row;
    } catch (error) {
      throw definerRefusal(error);
    }
  });
  return { status: 200, body: { handoff_id: done.handoff_id, run_id: runId, state: "cancelled", placement_restored: done.reverted }, headers: { "cache-control": "no-store" } };
}

/**
 * The heartbeat's part (R-599-HO1): the deadline of the run's live handoff, or null. The definer answers it only for a runner whose STORED
 * protocol version is at least `HANDOFF_PROTOCOL_VERSION`, read now, and moves `requested` to `checkpointing` in the same step. A runner
 * below that gets a plain reply: it would refuse a reply carrying `handoff`, and the move then runs out its deadline instead.
 */
export async function handoffDeadlineFor(pool: RunnerCloudDeps["appUserPool"], runner: VerifiedRunner, runId: string): Promise<Date | null> {
  return withRunnerSession(pool, runner, async (client) => {
    const { rows } = await client.query<{ deadline: Date | null }>("SELECT run_handoff_signal($1, $2) AS deadline", [runId, HANDOFF_PROTOCOL_VERSION]);
    return rows[0]?.deadline ?? null;
  });
}
