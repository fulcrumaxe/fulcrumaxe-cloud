import type { RunnerCapacity, RunnerRunning, RunnerState } from "./readModel.js";

/**
 * D#605 FL-9: what the fleet page needs beyond a runner's state, as pure functions of rows the read model already has. Nothing here reads the
 * database or decides a permission: `runner_settings_apply` (0790) re-derives the caller's role on every call, so these only decide what the
 * page offers, and a stale answer is a 403 on the click, never a hole.
 */

/** One fleet control as the caller sees it: whether it works, and why not when it does not (a fixed sentence, never the server's text). */
export interface FleetControl {
  allowed: boolean;
  reason: string | null;
}
export const FLEET_CONTROL_NAMES = ["pause", "drain", "resume", "rename", "remove"] as const;
export type FleetControls = Record<(typeof FLEET_CONTROL_NAMES)[number], FleetControl>;

export const NOT_YOUR_RUNNER_REASON = "Only the person who registered this runner, or an owner or admin, can do this.";
export const SET_BY_SOMEONE_ELSE_REASON = "Someone else set this. Only an owner or admin can change it.";
export const ALREADY_PAUSED_REASON = "Already paused.";
export const ALREADY_FINISHING_REASON = "Already finishing current work.";
export const NOT_HELD_REASON = "Not paused.";

/**
 * Pure. The registrant or an owner or admin may pause, drain, resume, rename and remove. A registrant who is not an admin may not take over, or
 * end, a pause or drain someone else set (FL-8 acceptance 2): only an owner or admin overwrites or clears another person's.
 */
export function fleetControlsOf(input: {
  role: "owner" | "admin" | "member";
  userId: string;
  registeredBy: string;
  paused: boolean;
  pausedBy: string | null;
  draining: boolean;
  drainedBy: string | null;
}): FleetControls {
  const admin = input.role === "owner" || input.role === "admin";
  const owns = admin || input.registeredBy === input.userId;
  const pauseMine = admin || !input.paused || input.pausedBy === input.userId;
  const drainMine = admin || !input.draining || input.drainedBy === input.userId;
  const no = (reason: string): FleetControl => ({ allowed: false, reason });
  const yes: FleetControl = { allowed: true, reason: null };
  const gate = (otherwise: FleetControl): FleetControl => (owns ? otherwise : no(NOT_YOUR_RUNNER_REASON));
  return {
    pause: gate(input.paused ? no(ALREADY_PAUSED_REASON) : pauseMine ? yes : no(SET_BY_SOMEONE_ELSE_REASON)),
    drain: gate(input.draining ? no(ALREADY_FINISHING_REASON) : drainMine ? yes : no(SET_BY_SOMEONE_ELSE_REASON)),
    resume: gate(!input.paused && !input.draining ? no(NOT_HELD_REASON) : pauseMine && drainMine ? yes : no(SET_BY_SOMEONE_ELSE_REASON)),
    rename: gate(yes),
    remove: gate(yes),
  };
}

/** The account line (R-605-2) and the runner count against the plan's most. */
export interface AccountLine {
  /** The account's concurrent runner-job limit (the runner plan's figure, or a hosted account's setting); null while the plan data cannot say. */
  limit: number | null;
  /** The summed capacity of the online, unpaused, undrained runners, held to the limit, so it never reads above it. */
  capacity: number;
  running: number;
  /** Runners that are not removed, and the plan's most; the most is null while the plan data cannot say. */
  runner_count: number;
  runner_limit: number | null;
}

/** Pure. A runner counts toward capacity when it takes work (online, idle or busy); one that has declared nothing holds one job, as the claim reckons it. */
export function accountLineOf(input: { limit: number | null; runnerLimit: number | null; runners: Array<{ state: RunnerState; capacity: RunnerCapacity | null; running: RunnerRunning }> }): AccountLine {
  const summed = input.runners
    .filter((r) => r.state === "online_idle" || r.state === "busy")
    .reduce((n, r) => n + (r.capacity === null ? 1 : r.capacity.total_limit), 0);
  return {
    limit: input.limit,
    capacity: input.limit === null ? summed : Math.min(summed, input.limit),
    running: input.runners.reduce((n, r) => n + r.running.light + r.running.heavy, 0),
    runner_count: input.runners.filter((r) => r.state !== "revoked").length,
    runner_limit: input.runnerLimit,
  };
}
