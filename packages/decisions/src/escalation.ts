/**
 * Escalation routes (D#7 AAP-b1; semantics fixed by C16 and C18). Pure (C1): no I/O, and the clock is an input. This module owns four things.
 *
 *  1. The shape of a route and its validation (`validateRoute`): at most 4 levels, each with an owner/admin target and a delay of 5 minutes
 *     to 7 days; working-hours windows; a repeat of 0 to 3. A route with no levels is a TOMBSTONE ("this scope has no route of its own") and
 *     must carry no hours and no repeat.
 *  2. The lookup (`resolveAskRoute`): repo + type, repo + '*', account + type, account + '*'. A tombstone at one step falls to the next, and
 *     past the last the caller uses the R5 default. The resolver, not the planner, interprets a tombstone.
 *  3. The plan (`planEscalation`): which person is told at which level, and when.
 *  4. The R5 default plan (`r5DefaultPlan`), used when there is no route (or only a tombstone): every owner and admin at raise, and one
 *     reminder when the ask goes overdue.
 *
 * The safety property is the cap: one message per person per level, for the whole life of one ask or approval, however large `repeat` is.
 * `repeat` is the number of extra laps over the ladder, and a lap plans a (person, level) pair only if that person has not been sent a
 * message at that level (the `notified` input) and has not already been planned for it in this plan. So a repeat re-notifies only people not
 * yet notified at a level: a step that never went out (skipped, cancelled), and people who became owners or admins after the first lap.
 */
import { HOURS_MAX_WINDOWS, deferToWorkingHours, isValidTimeZone, parseClock, type HoursWindow } from "./workingHours.js";

export { HOURS_MAX_WINDOWS, deferToWorkingHours, isValidTimeZone } from "./workingHours.js";
export type { HoursWindow } from "./workingHours.js";

export const ROUTE_MAX_LEVELS = 4;
export const ROUTE_ESCALATE_MIN_MINUTES = 5;
export const ROUTE_ESCALATE_MAX_MINUTES = 7 * 24 * 60;
export const ROUTE_REPEAT_MAX = 3;

export type RouteSubject = "decision" | "action";
export type MemberRole = "owner" | "admin" | "member";

export type RouteTarget = { readonly type: "all_owners_admins" } | { readonly type: "member"; readonly memberId: string };

export interface RouteLevel {
  readonly target: RouteTarget;
  /** The time after this level's step is planned before the next level starts: 5 minutes to 7 days. */
  readonly escalateAfterMinutes: number;
}

export interface AskRoute {
  /** 1 to 4 levels, or none for a tombstone. */
  readonly levels: readonly RouteLevel[];
  /** Working-hours windows; empty means always working. */
  readonly hours: readonly HoursWindow[];
  /** Extra laps after the first, 0 to 3. */
  readonly repeat: number;
}

/** One current route row: the highest version of one key. `decisionType` is '*' for every type. */
export interface AskRouteRow extends AskRoute {
  readonly repoId: string | null;
  readonly subject: RouteSubject;
  readonly decisionType: string;
}

export interface RouteMember {
  readonly memberId: string;
  readonly role: MemberRole;
}

export type RouteErrorCode =
  | "route_invalid"
  | "levels_too_many"
  | "level_invalid"
  | "target_invalid"
  | "target_not_answerer"
  | "escalate_after_out_of_range"
  | "repeat_out_of_range"
  | "hours_invalid"
  | "hours_too_many"
  | "window_invalid"
  | "window_days_invalid"
  | "window_time_invalid"
  | "window_zone_invalid"
  | "tombstone_has_settings";

export type RouteValidation = { readonly ok: true; readonly route: AskRoute } | { readonly ok: false; readonly code: RouteErrorCode };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasOnly = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const fail = (code: RouteErrorCode): RouteValidation => ({ ok: false, code });

const isAnswerer = (members: readonly RouteMember[], memberId: string): boolean =>
  members.some((m) => m.memberId === memberId && (m.role === "owner" || m.role === "admin"));

function validateWindow(raw: unknown): RouteErrorCode | HoursWindow {
  if (!isObject(raw) || !hasOnly(raw, ["timeZone", "days", "start", "end"])) return "window_invalid";
  const { timeZone, days, start, end } = raw;
  if (!isValidTimeZone(timeZone)) return "window_zone_invalid";
  if (!Array.isArray(days) || days.length === 0 || days.length > 7) return "window_days_invalid";
  const seen = new Set<unknown>();
  for (const d of days) {
    if (!Number.isInteger(d) || (d as number) < 1 || (d as number) > 7 || seen.has(d)) return "window_days_invalid";
    seen.add(d);
  }
  const startMin = parseClock(start, false);
  const endMin = parseClock(end, true);
  if (startMin === null || endMin === null || startMin >= endMin) return "window_time_invalid";
  return { timeZone, days: [...(days as number[])], start: start as string, end: end as string };
}

/**
 * Checks a route as a person submits it. `members` is the account's current membership: a named member target must be an owner or admin
 * of the account right now (owner ruling 4: no reviewer role, so a plain member who cannot answer is never a target). Unknown fields are
 * refused. The first problem found is returned as a named code.
 */
export function validateRoute(raw: unknown, members: readonly RouteMember[]): RouteValidation {
  if (!isObject(raw) || !hasOnly(raw, ["levels", "hours", "repeat"])) return fail("route_invalid");
  const { levels, hours, repeat } = raw;
  if (!Array.isArray(levels)) return fail("route_invalid");
  if (levels.length > ROUTE_MAX_LEVELS) return fail("levels_too_many");
  if (!Array.isArray(hours)) return fail("hours_invalid");
  if (hours.length > HOURS_MAX_WINDOWS) return fail("hours_too_many");
  if (!Number.isInteger(repeat) || (repeat as number) < 0 || (repeat as number) > ROUTE_REPEAT_MAX) return fail("repeat_out_of_range");

  const outLevels: RouteLevel[] = [];
  for (const l of levels) {
    if (!isObject(l) || !hasOnly(l, ["target", "escalateAfterMinutes"])) return fail("level_invalid");
    const { target, escalateAfterMinutes } = l;
    if (!isObject(target)) return fail("target_invalid");
    let t: RouteTarget;
    if (target.type === "all_owners_admins" && hasOnly(target, ["type"])) {
      t = { type: "all_owners_admins" };
    } else if (target.type === "member" && hasOnly(target, ["type", "memberId"]) && typeof target.memberId === "string" && UUID_RE.test(target.memberId)) {
      if (!isAnswerer(members, target.memberId)) return fail("target_not_answerer");
      t = { type: "member", memberId: target.memberId };
    } else {
      return fail("target_invalid");
    }
    if (
      !Number.isInteger(escalateAfterMinutes) ||
      (escalateAfterMinutes as number) < ROUTE_ESCALATE_MIN_MINUTES ||
      (escalateAfterMinutes as number) > ROUTE_ESCALATE_MAX_MINUTES
    ) {
      return fail("escalate_after_out_of_range");
    }
    outLevels.push({ target: t, escalateAfterMinutes: escalateAfterMinutes as number });
  }

  const outHours: HoursWindow[] = [];
  for (const h of hours) {
    const w = validateWindow(h);
    if (typeof w === "string") return fail(w);
    outHours.push(w);
  }

  if (outLevels.length === 0 && (outHours.length > 0 || repeat !== 0)) return fail("tombstone_has_settings");
  return { ok: true, route: { levels: outLevels, hours: outHours, repeat: repeat as number } };
}

/** True for a tombstone: a route version with no levels. */
export const isTombstone = (route: Pick<AskRoute, "levels">): boolean => route.levels.length === 0;

export interface RouteLookup {
  readonly repoId: string | null;
  readonly subject: RouteSubject;
  readonly decisionType: string;
}

/**
 * The route for one ask or approval. `rows` is the CURRENT row (highest version) of each key the account has written. The lookup order is
 * repo + type, repo + '*', account + type, account + '*'; a tombstone at one step falls to the next. Null means no route applies, and the
 * caller plans the R5 default.
 */
export function resolveAskRoute(rows: readonly AskRouteRow[], lookup: RouteLookup): AskRouteRow | null {
  const steps: { repoId: string | null; decisionType: string }[] = [];
  if (lookup.repoId !== null) {
    steps.push({ repoId: lookup.repoId, decisionType: lookup.decisionType });
    if (lookup.decisionType !== "*") steps.push({ repoId: lookup.repoId, decisionType: "*" });
  }
  steps.push({ repoId: null, decisionType: lookup.decisionType });
  if (lookup.decisionType !== "*") steps.push({ repoId: null, decisionType: "*" });
  for (const s of steps) {
    const row = rows.find((r) => r.repoId === s.repoId && r.subject === lookup.subject && r.decisionType === s.decisionType);
    if (row && !isTombstone(row)) return row;
  }
  return null;
}

/** One (person, level) pair that has been sent a message for this ask or approval. */
export interface NotifiedPair {
  readonly memberId: string;
  /** 1-based level. */
  readonly level: number;
}

export type StepKind = "ladder" | "default_raise" | "default_overdue";

export interface EscalationStep {
  readonly kind: StepKind;
  /** 0 for the first pass over the ladder, up to `repeat`. */
  readonly lap: number;
  /** 1-based level. The R5 default steps are level 1. */
  readonly level: number;
  readonly memberId: string;
  readonly at: Date;
  /** True when a named member was no longer an owner or admin and this person was reached as one of all owners and admins. */
  readonly fellBack: boolean;
}

export interface EscalationPlan {
  /** Every planned step, in time order, then lap, level and member id. */
  readonly steps: readonly EscalationStep[];
  /** The planned steps that are due at `now`. */
  readonly due: readonly EscalationStep[];
  /** When the plan runs out. Always defined, and strictly before the due time, which is when the frozen timeout outcome takes over. */
  readonly exhaustedAt: Date;
  /** False when the R5 default was planned instead of a route. */
  readonly routed: boolean;
}

/** Where a later lap resumes: the sweep passes this once the earlier lap's steps are all terminal. */
export interface PlanResume {
  /** The lap to plan next, 1 or more. */
  readonly lap: number;
  /** The time of the last step planned in the laps before it. */
  readonly previousLapLastStepAt: Date;
}

const MINUTE_MS = 60_000;
const byTime = (a: EscalationStep, b: EscalationStep): number =>
  a.at.getTime() - b.at.getTime() || a.lap - b.lap || a.level - b.level || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0);

function answerers(members: readonly RouteMember[]): string[] {
  return [...new Set(members.filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.memberId))].sort();
}

/**
 * The plan when no route applies: all owners and admins at raise, and one reminder when the ask goes overdue (R5). Nothing is planned
 * before `raisedAt` or after `dueAt`. A `proceed_recommended` timeout sends nothing; that is the sender's rule, not the plan's.
 */
export function r5DefaultPlan(raisedAt: Date, dueAt: Date, now: Date, members: readonly RouteMember[]): EscalationPlan {
  const people = answerers(members);
  const mk = (kind: StepKind, at: Date): EscalationStep[] => people.map((memberId) => ({ kind, lap: 0, level: 1, memberId, at, fellBack: false }));
  const steps = [...mk("default_raise", raisedAt), ...mk("default_overdue", dueAt)].sort(byTime);
  return { steps, due: steps.filter((s) => s.at.getTime() <= now.getTime()), exhaustedAt: dueAt, routed: false };
}

const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Number.isFinite(v) ? Math.trunc(v) : lo));

/**
 * Plans the steps of one ask or approval. `route` is the route already resolved (and frozen at raise) or null; a route with no levels is
 * treated as null, which is the R5 default (it never means "notify nobody"). `members` is the account's membership now; `notified` is every
 * (person, level) already sent for this subject. `resume` is absent at raise (lap 0 onward) and present when the sweep plans later laps.
 *
 * Time: level 1 of a lap is planned at the lap's start, moved to working time. Level i+1 is planned `escalateAfterMinutes` of level i after
 * level i's PLANNED time (after the move to working time, never the time it was actually sent). The first lap starts at `raisedAt`. A later
 * lap starts the last level's delay after the last step planned so far; a lap that emits nothing takes no time of its own. A level occupies its
 * time slot even when everyone at it was already notified, so the ladder keeps its shape.
 *
 * Nothing is planned at or after `dueAt`, and planning stops at the first slot that would be. `exhaustedAt` is the last planned step plus the
 * last level's delay (or, with no step at all, the last slot of the first lap planned plus that delay), and never reaches `dueAt`.
 */
export function planEscalation(
  route: AskRoute | null,
  raisedAt: Date,
  dueAt: Date,
  now: Date,
  members: readonly RouteMember[],
  notified: readonly NotifiedPair[] = [],
  resume?: PlanResume,
): EscalationPlan {
  if (!route || !Array.isArray(route.levels) || route.levels.length === 0) return r5DefaultPlan(raisedAt, dueAt, now, members);
  const levels = route.levels.slice(0, ROUTE_MAX_LEVELS);
  const hours = Array.isArray(route.hours) ? route.hours : [];
  const repeat = clampInt(route.repeat, 0, ROUTE_REPEAT_MAX);
  const delayMs = (l: RouteLevel): number => clampInt(l.escalateAfterMinutes, ROUTE_ESCALATE_MIN_MINUTES, ROUTE_ESCALATE_MAX_MINUTES) * MINUTE_MS;
  const lastDelay = delayMs(levels[levels.length - 1]!);
  const raisedMs = raisedAt.getTime();
  const dueMs = dueAt.getTime();

  const taken = new Set(notified.map((p) => `${p.memberId}|${p.level}`));
  const everyone = answerers(members);
  const steps: EscalationStep[] = [];
  let lastStepMs: number | null = resume ? resume.previousLapLastStepAt.getTime() : null;
  let firstLapLastSlot: number | null = null;
  let cut = false;

  for (let lap = resume ? Math.max(1, Math.trunc(resume.lap)) : 0; lap <= repeat && !cut; lap += 1) {
    const base = lastStepMs === null ? raisedMs : lastStepMs + lastDelay;
    let prevSlot: number | null = null;
    let lapLast: number | null = null;
    for (let i = 0; i < levels.length; i += 1) {
      const level = levels[i]!;
      const raw = prevSlot === null ? base : prevSlot + delayMs(levels[i - 1]!);
      const slot = deferToWorkingHours(hours, raw);
      if (slot === null || slot >= dueMs) {
        cut = true;
        break;
      }
      prevSlot = slot;
      const target = level.target;
      const named = target.type === "member" && everyone.includes(target.memberId);
      const people = target.type === "member" && named ? [target.memberId] : everyone;
      const fellBack = target.type === "member" && !named;
      for (const memberId of people) {
        const key = `${memberId}|${i + 1}`;
        if (taken.has(key)) continue;
        taken.add(key);
        steps.push({ kind: "ladder", lap, level: i + 1, memberId, at: new Date(slot), fellBack });
        lapLast = slot;
      }
    }
    if (firstLapLastSlot === null) firstLapLastSlot = prevSlot;
    if (lapLast !== null) lastStepMs = lapLast;
  }

  const anchor = lastStepMs ?? firstLapLastSlot ?? raisedMs;
  const exhaustedMs = Math.min(anchor + lastDelay, dueMs - 1);
  steps.sort(byTime);
  return { steps, due: steps.filter((s) => s.at.getTime() <= now.getTime()), exhaustedAt: new Date(exhaustedMs), routed: true };
}
