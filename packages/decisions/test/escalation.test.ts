import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deferToWorkingHours,
  isValidTimeZone,
  planEscalation,
  r5DefaultPlan,
  resolveAskRoute,
  validateRoute,
  type AskRoute,
  type AskRouteRow,
  type EscalationStep,
  type HoursWindow,
  type NotifiedPair,
  type RouteMember,
  type RouteSubject,
} from "../src/index.js";

/**
 * D#7 AAP-b1: the pure escalation module (C16 b1 and C18). Real time-zone data comes from Node's ICU, so the version is part of the test
 * name and a result that moves with a tzdata update is visible in the report.
 */
const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = ID(1);
const B = ID(2);
const C = ID(3);
const PLAIN = ID(9);
const MEMBERS: RouteMember[] = [
  { memberId: A, role: "admin" },
  { memberId: B, role: "owner" },
  { memberId: C, role: "admin" },
  { memberId: PLAIN, role: "member" },
];
const t = (iso: string): Date => new Date(iso);
const iso = (d: Date): string => d.toISOString();
const ALL = { type: "all_owners_admins" } as const;
const member = (memberId: string) => ({ type: "member", memberId }) as const;
const win = (timeZone: string, days: number[], start: string, end: string): HoursWindow => ({ timeZone, days, start, end });
const WEEKDAYS = [1, 2, 3, 4, 5];

/** L1 everyone after 10 min; L2 B after 30; L3 A after 60; L4 everyone after 120. */
const LADDER: AskRoute = {
  levels: [
    { target: ALL, escalateAfterMinutes: 10 },
    { target: member(B), escalateAfterMinutes: 30 },
    { target: member(A), escalateAfterMinutes: 60 },
    { target: ALL, escalateAfterMinutes: 120 },
  ],
  hours: [],
  repeat: 3,
};
const RAISED = t("2026-06-01T12:00:00Z"); // a Monday
const FAR_DUE = t("2026-06-08T12:00:00Z");

const view = (s: readonly EscalationStep[]) => s.map((x) => `${x.lap}/${x.level}/${x.memberId.slice(-1)}@${iso(x.at).slice(11, 16)}`);
const pairsOf = (s: readonly EscalationStep[]): NotifiedPair[] => s.map((x) => ({ memberId: x.memberId, level: x.level }));

describe(`validateRoute (Node ICU ${process.versions.icu})`, () => {
  const ok = (over: Record<string, unknown> = {}) => ({ levels: [{ target: ALL, escalateAfterMinutes: 15 }], hours: [], repeat: 0, ...over });
  const code = (raw: unknown, members = MEMBERS) => {
    const r = validateRoute(raw, members);
    return r.ok ? "ok" : r.code;
  };

  it("accepts a route within the limits and returns it normalised", () => {
    const r = validateRoute(
      { levels: [{ target: member(A), escalateAfterMinutes: 5 }, { target: ALL, escalateAfterMinutes: 10080 }], hours: [win("Asia/Kolkata", [1, 7], "00:00", "24:00")], repeat: 3 },
      MEMBERS,
    );
    expect(r.ok).toBe(true);
  });

  it.each<[string, unknown, string]>([
    ["not an object", 5, "route_invalid"],
    ["an unknown top-level field", { ...ok(), extra: 1 }, "route_invalid"],
    ["levels not an array", ok({ levels: "x" }), "route_invalid"],
    ["five levels", ok({ levels: Array.from({ length: 5 }, () => ({ target: ALL, escalateAfterMinutes: 10 })) }), "levels_too_many"],
    ["a level that is not an object", ok({ levels: [1] }), "level_invalid"],
    ["a level with an unknown field", ok({ levels: [{ target: ALL, escalateAfterMinutes: 10, x: 1 }] }), "level_invalid"],
    ["a target of an unknown type", ok({ levels: [{ target: { type: "team" }, escalateAfterMinutes: 10 }] }), "target_invalid"],
    ["a member target without an id", ok({ levels: [{ target: { type: "member" }, escalateAfterMinutes: 10 }] }), "target_invalid"],
    ["a member id that is not a uuid", ok({ levels: [{ target: member("nope"), escalateAfterMinutes: 10 }] }), "target_invalid"],
    ["a plain member as target", ok({ levels: [{ target: member(PLAIN), escalateAfterMinutes: 10 }] }), "target_not_answerer"],
    ["a person who is not in the account", ok({ levels: [{ target: member(ID(77)), escalateAfterMinutes: 10 }] }), "target_not_answerer"],
    ["a delay of 4 minutes", ok({ levels: [{ target: ALL, escalateAfterMinutes: 4 }] }), "escalate_after_out_of_range"],
    ["a delay over 7 days", ok({ levels: [{ target: ALL, escalateAfterMinutes: 10081 }] }), "escalate_after_out_of_range"],
    ["a fractional delay", ok({ levels: [{ target: ALL, escalateAfterMinutes: 10.5 }] }), "escalate_after_out_of_range"],
    ["repeat 4", ok({ repeat: 4 }), "repeat_out_of_range"],
    ["repeat -1", ok({ repeat: -1 }), "repeat_out_of_range"],
    ["hours not an array", ok({ hours: {} }), "hours_invalid"],
    ["15 windows", ok({ hours: Array.from({ length: 15 }, () => win("UTC", [1], "09:00", "10:00")) }), "hours_too_many"],
    ["a window with an unknown field", ok({ hours: [{ ...win("UTC", [1], "09:00", "10:00"), x: 1 }] }), "window_invalid"],
    ["a zone that does not exist", ok({ hours: [win("Mars/Olympus", [1], "09:00", "10:00")] }), "window_zone_invalid"],
    ["a zone in the wrong case", ok({ hours: [win("america/new_york", [1], "09:00", "10:00")] }), "window_zone_invalid"],
    ["a numeric offset as a zone", ok({ hours: [win("+05:00", [1], "09:00", "10:00")] }), "window_zone_invalid"],
    ["no days", ok({ hours: [win("UTC", [], "09:00", "10:00")] }), "window_days_invalid"],
    ["day 0", ok({ hours: [win("UTC", [0], "09:00", "10:00")] }), "window_days_invalid"],
    ["day 8", ok({ hours: [win("UTC", [8], "09:00", "10:00")] }), "window_days_invalid"],
    ["a repeated day", ok({ hours: [win("UTC", [2, 2], "09:00", "10:00")] }), "window_days_invalid"],
    ["a start that is not HH:MM", ok({ hours: [win("UTC", [1], "9:00", "10:00")] }), "window_time_invalid"],
    ["24:00 as a start", ok({ hours: [win("UTC", [1], "24:00", "24:00")] }), "window_time_invalid"],
    ["an end before the start", ok({ hours: [win("UTC", [1], "17:00", "09:00")] }), "window_time_invalid"],
    ["an end equal to the start", ok({ hours: [win("UTC", [1], "09:00", "09:00")] }), "window_time_invalid"],
    ["a tombstone with hours", { levels: [], hours: [win("UTC", [1], "09:00", "10:00")], repeat: 0 }, "tombstone_has_settings"],
    ["a tombstone with a repeat", { levels: [], hours: [], repeat: 1 }, "tombstone_has_settings"],
  ])("refuses %s with %s", (_name, raw, expected) => {
    expect(code(raw)).toBe(expected);
  });

  it("accepts a tombstone (no levels, no hours, repeat 0) and an overnight window written as two windows", () => {
    expect(code({ levels: [], hours: [], repeat: 0 })).toBe("ok");
    expect(code(ok({ hours: [win("UTC", [1], "22:00", "24:00"), win("UTC", [2], "00:00", "06:00")] }))).toBe("ok");
  });

  it("zone names are checked exactly as the platform spells them", () => {
    for (const z of ["America/New_York", "Europe/London", "Asia/Kolkata", "Australia/Lord_Howe", "UTC"]) expect(isValidTimeZone(z), z).toBe(true);
    for (const z of ["", "Nowhere/City", "europe/london", "America/new_york", "ASIA/KOLKATA", "+01:00", "UTC+1", "A".repeat(80), 5]) expect(isValidTimeZone(z), String(z)).toBe(false);
  });
});

describe("resolveAskRoute: repo + type, repo + '*', account + type, account + '*'", () => {
  const REPO = ID(500);
  const route = (levels: number): Pick<AskRoute, "levels" | "hours" | "repeat"> => ({
    levels: Array.from({ length: levels }, () => ({ target: ALL, escalateAfterMinutes: 10 })),
    hours: [],
    repeat: 0,
  });
  const row = (repoId: string | null, decisionType: string, levels: number, subject: RouteSubject = "decision"): AskRouteRow => ({
    repoId,
    subject,
    decisionType,
    ...route(levels),
  });
  const pick = (rows: AskRouteRow[], repoId: string | null = REPO, decisionType = "test_strategy_choice", subject: RouteSubject = "decision") => {
    const r = resolveAskRoute(rows, { repoId, subject, decisionType });
    return r ? `${r.repoId === null ? "acct" : "repo"}:${r.decisionType}` : null;
  };

  it("takes the most specific key that has a route", () => {
    const all = [row(REPO, "test_strategy_choice", 1), row(REPO, "*", 1), row(null, "test_strategy_choice", 1), row(null, "*", 1)];
    expect(pick(all)).toBe("repo:test_strategy_choice");
    expect(pick(all.slice(1))).toBe("repo:*");
    expect(pick(all.slice(2))).toBe("acct:test_strategy_choice");
    expect(pick(all.slice(3))).toBe("acct:*");
    expect(pick([])).toBeNull();
  });

  it("a tombstone at one step falls to the next, step by step, and past the last to the default (null)", () => {
    const all = [row(REPO, "test_strategy_choice", 0), row(REPO, "*", 0), row(null, "test_strategy_choice", 0), row(null, "*", 2)];
    expect(pick(all)).toBe("acct:*");
    expect(pick([...all.slice(0, 3)])).toBeNull();
    expect(pick([row(REPO, "test_strategy_choice", 0), row(REPO, "*", 3)])).toBe("repo:*");
  });

  it("ignores other repos, other subjects and other types; without a repo only account keys apply", () => {
    expect(pick([row(ID(501), "*", 1)])).toBeNull();
    expect(pick([row(null, "*", 1, "action")])).toBeNull();
    expect(pick([row(REPO, "other_type", 1)])).toBeNull();
    expect(pick([row(REPO, "*", 1), row(null, "*", 1)], null)).toBe("acct:*");
    expect(pick([row(null, "*", 1, "action")], null, "*", "action")).toBe("acct:*");
  });
});

describe("working hours: a table over four zones and both DST transitions", () => {
  const defer = (hours: HoursWindow[], from: string) => iso(new Date(deferToWorkingHours(hours, t(from).getTime())!));

  it.each<[string, HoursWindow, string, string]>([
    ["New York spring forward: 02:30 does not exist on 2026-03-08, so the start is the instant the clocks jump (03:00 EDT)", win("America/New_York", [1, 2, 3, 4, 5, 6, 7], "02:30", "04:00"), "2026-03-08T06:00:00Z", "2026-03-08T07:00:00.000Z"],
    ["New York fall back: 01:30 happens twice on 2026-11-01 and the first (EDT) is used", win("America/New_York", [1, 2, 3, 4, 5, 6, 7], "01:30", "03:00"), "2026-11-01T04:00:00Z", "2026-11-01T05:30:00.000Z"],
    ["London spring forward 2026-03-29: 01:30 does not exist, so 02:00 BST", win("Europe/London", [1, 2, 3, 4, 5, 6, 7], "01:30", "03:00"), "2026-03-29T00:00:00Z", "2026-03-29T01:00:00.000Z"],
    ["London fall back 2026-10-25: 01:30 happens twice and the first (BST) is used", win("Europe/London", [1, 2, 3, 4, 5, 6, 7], "01:30", "03:00"), "2026-10-25T00:00:00Z", "2026-10-25T00:30:00.000Z"],
    ["Kolkata (+05:30, no DST): Saturday afternoon waits for Monday 09:00", win("Asia/Kolkata", WEEKDAYS, "09:00", "17:00"), "2026-06-06T10:00:00Z", "2026-06-08T03:30:00.000Z"],
    ["Lord Howe start of DST 2026-10-04: a 30-minute jump, 02:15 does not exist, so 02:30 LHDT", win("Australia/Lord_Howe", [1, 2, 3, 4, 5, 6, 7], "02:15", "04:00"), "2026-10-03T15:00:00Z", "2026-10-03T15:30:00.000Z"],
    ["Lord Howe end of DST 2026-04-05: 01:45 happens twice and the first (LHDT) is used", win("Australia/Lord_Howe", [1, 2, 3, 4, 5, 6, 7], "01:45", "03:00"), "2026-04-04T14:00:00Z", "2026-04-04T14:45:00.000Z"],
  ])("%s", (_name, w, from, expected) => {
    expect(defer([w], from)).toBe(expected);
  });

  const NY = win("America/New_York", WEEKDAYS, "09:00", "17:00");

  it("an instant inside a window stays; the end is exclusive; the start is inclusive", () => {
    expect(defer([NY], "2026-06-03T13:00:00Z")).toBe("2026-06-03T13:00:00.000Z"); // Wed 09:00 EDT
    expect(defer([NY], "2026-06-03T20:59:59Z")).toBe("2026-06-03T20:59:59.000Z");
    expect(defer([NY], "2026-06-03T21:00:00Z")).toBe("2026-06-04T13:00:00.000Z"); // Wed 17:00 -> Thu 09:00
  });

  it("weekends defer to Monday, and Friday evening does too", () => {
    expect(defer([NY], "2026-06-05T21:30:00Z")).toBe("2026-06-08T13:00:00.000Z");
    expect(defer([NY], "2026-06-07T15:00:00Z")).toBe("2026-06-08T13:00:00.000Z");
  });

  it("an empty array is always working; it never means never", () => {
    expect(defer([], "2026-06-07T03:00:00Z")).toBe("2026-06-07T03:00:00.000Z");
  });

  it("windows overlap as a union and each uses its own zone", () => {
    const hours = [win("America/New_York", WEEKDAYS, "09:00", "12:00"), win("Europe/London", WEEKDAYS, "10:00", "13:00")];
    // 15:30Z Wed = 11:30 EDT (inside the New York window) and 16:30 BST (outside London's).
    expect(defer(hours, "2026-06-03T15:30:00Z")).toBe("2026-06-03T15:30:00.000Z");
    // 16:30Z Wed = 12:30 EDT (outside) and 17:30 BST (outside): next start is Thursday 10:00 BST = 09:00Z, before Thursday 09:00 EDT = 13:00Z.
    expect(defer(hours, "2026-06-03T16:30:00Z")).toBe("2026-06-04T09:00:00.000Z");
  });

  it("a window ending at 24:00 holds the last minute of the day, and a window starting at 00:00 holds the first", () => {
    const hours = [win("UTC", [1], "22:00", "24:00"), win("UTC", [2], "00:00", "06:00")];
    expect(defer(hours, "2026-06-01T23:59:59Z")).toBe("2026-06-01T23:59:59.000Z");
    expect(defer(hours, "2026-06-02T00:00:00Z")).toBe("2026-06-02T00:00:00.000Z");
    expect(defer(hours, "2026-06-02T06:00:00Z")).toBe("2026-06-08T22:00:00.000Z");
  });
});

describe("planEscalation", () => {
  it("plans each level at its own delay after the previous level's planned time, one step per person", () => {
    const plan = planEscalation({ ...LADDER, repeat: 0 }, RAISED, FAR_DUE, RAISED, MEMBERS);
    expect(view(plan.steps)).toEqual([
      "0/1/1@12:00", "0/1/2@12:00", "0/1/3@12:00", // level 1: every owner and admin, never the plain member
      "0/2/2@12:10", // level 2: B, 10 minutes after level 1
      "0/3/1@12:40", // level 3: A, 30 minutes after level 2
      "0/4/1@13:40", "0/4/2@13:40", "0/4/3@13:40", // level 4: 60 minutes after level 3
    ]);
    expect(view(plan.due)).toEqual(["0/1/1@12:00", "0/1/2@12:00", "0/1/3@12:00"]);
    expect(plan.routed).toBe(true);
    expect(iso(plan.exhaustedAt)).toBe("2026-06-01T15:40:00.000Z"); // last step 13:40 + the last level's 120 minutes
  });

  it("the base is the previous PLANNED time after the working-hours move, never when it was sent", () => {
    const route: AskRoute = {
      levels: [{ target: ALL, escalateAfterMinutes: 120 }, { target: ALL, escalateAfterMinutes: 30 }],
      hours: [win("America/New_York", WEEKDAYS, "09:00", "17:00")],
      repeat: 0,
    };
    // Friday 15:00 EDT: level 1 is inside; level 2 would be 17:00 EDT, which is outside, so it waits for Monday 09:00 EDT.
    const plan = planEscalation(route, t("2026-06-05T19:00:00Z"), t("2026-06-15T00:00:00Z"), t("2026-06-05T19:00:00Z"), MEMBERS);
    expect(plan.steps.filter((s) => s.level === 1).every((s) => iso(s.at) === "2026-06-05T19:00:00.000Z")).toBe(true);
    expect(plan.steps.filter((s) => s.level === 2).every((s) => iso(s.at) === "2026-06-08T13:00:00.000Z")).toBe(true);
    // Level 1 raised outside working time waits too.
    const night = planEscalation(route, t("2026-06-06T03:00:00Z"), t("2026-06-15T00:00:00Z"), t("2026-06-06T03:00:00Z"), MEMBERS);
    expect(iso(night.steps[0]!.at)).toBe("2026-06-08T13:00:00.000Z");
    expect(night.due).toEqual([]);
  });

  it("never plans a step at or after the due time, and stops there; the timeout outcome takes over after exhaustion", () => {
    const due = t("2026-06-01T12:40:00Z"); // level 3 would be exactly at due
    const plan = planEscalation(LADDER, RAISED, due, RAISED, MEMBERS);
    expect(view(plan.steps)).toEqual(["0/1/1@12:00", "0/1/2@12:00", "0/1/3@12:00", "0/2/2@12:10"]);
    expect(plan.steps.every((s) => s.at.getTime() < due.getTime())).toBe(true);
    expect(plan.exhaustedAt.getTime()).toBeLessThan(due.getTime());
    // A deferral that lands past the due time is not planned either.
    const hours = [win("America/New_York", WEEKDAYS, "09:00", "17:00")];
    const deferred = planEscalation({ ...LADDER, hours, repeat: 0 }, t("2026-06-05T20:30:00Z"), t("2026-06-06T12:00:00Z"), RAISED, MEMBERS);
    expect(deferred.steps.every((s) => s.at.getTime() < t("2026-06-06T12:00:00Z").getTime())).toBe(true);
    expect(deferred.exhaustedAt.getTime()).toBeLessThan(t("2026-06-06T12:00:00Z").getTime());
  });

  it("a target who is no longer an owner or admin is skipped, and that step goes to all owners and admins", () => {
    const route: AskRoute = { levels: [{ target: member(PLAIN), escalateAfterMinutes: 10 }, { target: member(ID(404)), escalateAfterMinutes: 10 }, { target: member(A), escalateAfterMinutes: 10 }], hours: [], repeat: 0 };
    const plan = planEscalation(route, RAISED, FAR_DUE, RAISED, MEMBERS);
    expect(view(plan.steps)).toEqual([
      "0/1/1@12:00", "0/1/2@12:00", "0/1/3@12:00",
      "0/2/1@12:10", "0/2/2@12:10", "0/2/3@12:10",
      "0/3/1@12:20",
    ]);
    expect(plan.steps.filter((s) => s.level < 3).every((s) => s.fellBack)).toBe(true);
    expect(plan.steps.filter((s) => s.level === 3).every((s) => !s.fellBack)).toBe(true);
  });

  it("is pure: the same input gives the same output and nothing is changed", () => {
    const route = JSON.parse(JSON.stringify(LADDER)) as AskRoute;
    const members = JSON.parse(JSON.stringify(MEMBERS)) as RouteMember[];
    const notified = [{ memberId: A, level: 1 }];
    const before = JSON.stringify([route, members, notified]);
    const one = planEscalation(route, RAISED, FAR_DUE, RAISED, members, notified);
    const two = planEscalation(route, RAISED, FAR_DUE, RAISED, members, notified);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(JSON.stringify([route, members, notified])).toBe(before);
  });

  it("the module never reads the clock or a random source", () => {
    for (const f of ["../src/escalation.ts", "../src/workingHours.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/Date\.now|Math\.random|new Date\(\s*\)|performance\.now|crypto\./);
    }
  });
});

describe("repeat: laps never re-notify the same person at the same level (C18)", () => {
  // L1 everyone, L2 B, L3 A, L4 everyone; delays 10/30/60/120; repeat 3. Lap 0's last step is 13:40; lap 1 starts 120 minutes later, at 15:40.
  const LAP0_LAST_STEP = t("2026-06-01T13:40:00Z");
  const resumeAt = (lap: number, prev: Date) => ({ lap, previousLapLastStepAt: prev });

  it("lap 0 plans every level; laps 1 to 3 plan nothing because everyone is already planned", () => {
    const plan = planEscalation(LADDER, RAISED, FAR_DUE, RAISED, MEMBERS);
    expect(new Set(plan.steps.map((s) => s.lap))).toEqual(new Set([0]));
    expect(plan.steps).toHaveLength(8);
  });

  it("a step that was skipped (not notified) is the only one planned in lap 1", () => {
    const sent = planEscalation(LADDER, RAISED, FAR_DUE, RAISED, MEMBERS).steps.filter((s) => !(s.level === 3 && s.memberId === A));
    const plan = planEscalation(LADDER, RAISED, FAR_DUE, t("2026-06-01T15:40:00Z"), MEMBERS, pairsOf(sent), resumeAt(1, LAP0_LAST_STEP));
    // Lap 1 starts 120 minutes after the last planned step (15:40); level 3 is 10 + 30 minutes after that.
    expect(view(plan.steps)).toEqual(["1/3/1@16:20"]);
    expect(iso(plan.exhaustedAt)).toBe("2026-06-01T18:20:00.000Z");
  });

  it("a person who became an admin after lap 0 is planned once per level in lap 1 and never again in laps 2 and 3", () => {
    const D = ID(4);
    const lap0 = planEscalation(LADDER, RAISED, FAR_DUE, RAISED, MEMBERS).steps;
    const later: RouteMember[] = [...MEMBERS, { memberId: D, role: "admin" }];
    const plan = planEscalation(LADDER, RAISED, FAR_DUE, RAISED, later, pairsOf(lap0), resumeAt(1, LAP0_LAST_STEP));
    // D is reached at levels 1 and 4 (the two "all owners and admins" levels); level 2 and 3 name B and A.
    expect(view(plan.steps)).toEqual(["1/1/4@15:40", "1/4/4@17:20"]);
    expect(plan.steps.filter((s) => s.lap >= 2)).toEqual([]);
  });

  it("the full notified set of a 4-level, repeat-3 route yields no steps and a defined exhaustion time", () => {
    const everything = planEscalation(LADDER, RAISED, FAR_DUE, RAISED, MEMBERS).steps;
    const plan = planEscalation(LADDER, RAISED, FAR_DUE, RAISED, MEMBERS, pairsOf(everything));
    expect(plan.steps).toEqual([]);
    expect(plan.due).toEqual([]);
    expect(iso(plan.exhaustedAt)).toBe("2026-06-01T15:40:00.000Z");
    const resumed = planEscalation(LADDER, RAISED, FAR_DUE, RAISED, MEMBERS, pairsOf(everything), resumeAt(1, LAP0_LAST_STEP));
    expect(resumed.steps).toEqual([]);
    expect(Number.isNaN(resumed.exhaustedAt.getTime())).toBe(false);
  });

  it("a resume past the last lap plans nothing", () => {
    const plan = planEscalation(LADDER, RAISED, FAR_DUE, RAISED, MEMBERS, [], resumeAt(4, LAP0_LAST_STEP));
    expect(plan.steps).toEqual([]);
  });

  it("over a whole run (sweep after sweep, some steps skipped) nobody is planned twice at one level, in any lap", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 25; run += 1) {
      const sent: NotifiedPair[] = [];
      const everPlanned: string[] = [];
      let members = MEMBERS;
      let prev: Date | null = null;
      let laps = 0;
      for (let lap = 0; lap <= 3; lap += 1) {
        if (lap === 2 && run % 2 === 0) members = [...MEMBERS, { memberId: ID(10 + run), role: "admin" }];
        const already = new Set(sent.map((p) => `${p.memberId}|${p.level}`));
        const plan: ReturnType<typeof planEscalation> = planEscalation(LADDER, RAISED, FAR_DUE, RAISED, members, sent, prev ? resumeAt(lap, prev) : undefined);
        const keys = plan.steps.map((s) => `${s.memberId}|${s.level}`);
        expect(new Set(keys).size).toBe(keys.length); // no pair twice within one plan
        for (const k of keys) expect(already.has(k)).toBe(false); // and none that was already sent
        for (const s of plan.steps) {
          everPlanned.push(`${s.memberId}|${s.level}`);
          if (rnd() < 0.7) sent.push({ memberId: s.memberId, level: s.level }); // the rest are "skipped" and not in notified
        }
        if (plan.steps.length > 0) {
          prev = plan.steps[plan.steps.length - 1]!.at;
          laps += 1;
        }
        prev ??= LAP0_LAST_STEP;
      }
      const sentKeys = sent.map((p) => `${p.memberId}|${p.level}`);
      expect(new Set(sentKeys).size).toBe(sentKeys.length); // at most one message per person per level over the whole run
      expect(laps).toBeLessThanOrEqual(4);
      expect(everPlanned.length).toBeGreaterThan(0);
    }
  });
});

describe("no route: the R5 default", () => {
  const DUE = t("2026-06-02T12:00:00Z");

  it("is all owners and admins at raise and one reminder when the ask goes overdue", () => {
    const plan = planEscalation(null, RAISED, DUE, RAISED, MEMBERS);
    expect(plan.routed).toBe(false);
    expect(plan.steps.map((s) => [s.kind, s.memberId.slice(-1), iso(s.at)])).toEqual([
      ["default_raise", "1", "2026-06-01T12:00:00.000Z"],
      ["default_raise", "2", "2026-06-01T12:00:00.000Z"],
      ["default_raise", "3", "2026-06-01T12:00:00.000Z"],
      ["default_overdue", "1", "2026-06-02T12:00:00.000Z"],
      ["default_overdue", "2", "2026-06-02T12:00:00.000Z"],
      ["default_overdue", "3", "2026-06-02T12:00:00.000Z"],
    ]);
    expect(plan.steps.every((s) => s.memberId !== PLAIN)).toBe(true);
    // Each person gets two messages at most: one at raise and one at overdue (R5).
    for (const m of [A, B, C]) expect(plan.steps.filter((s) => s.memberId === m)).toHaveLength(2);
  });

  it("a missing route, a route with no levels and an explicit default are the same plan", () => {
    const explicit = r5DefaultPlan(RAISED, DUE, RAISED, MEMBERS);
    expect(planEscalation(null, RAISED, DUE, RAISED, MEMBERS)).toEqual(explicit);
    expect(planEscalation({ levels: [], hours: [], repeat: 0 }, RAISED, DUE, RAISED, MEMBERS)).toEqual(explicit);
  });

  it("a route with no levels never means 'notify nobody', even with hours or a repeat handed to it", () => {
    const junk = { levels: [], hours: [win("UTC", [1], "09:00", "10:00")], repeat: 3 };
    const plan = planEscalation(junk, RAISED, DUE, RAISED, MEMBERS);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.routed).toBe(false);
  });
});
