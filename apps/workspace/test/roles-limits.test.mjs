// apps/workspace/test/roles-limits.test.mjs
//
// D#37 WS-F4c (C30, C38 section 1): the pure rules of the Roles app's Run
// limits view, against API-8d's committed fixture. The DOM behaviour is in
// e2e/roles-limits.spec.ts; the vitest environment here is node.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIELDS,
  NOT_ALLOWED,
  WHAT_HAPPENS,
  buildBody,
  check,
  failureFor,
  inheritsFrom,
  initialValues,
  refreshAction,
  sourceOf,
} from "../apps/roles/roles-limits.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "apps", "roles", "roles-limits.js");
const DATA = JSON.parse(readFileSync(join(HERE, "..", "..", "..", "packages", "api", "fixtures", "v1", "getRunLimits", "200-ok.json"), "utf8"));
const EXEC = DATA.roles[0];
const f = (key) => FIELDS.find((x) => x.key === key);
const allInherit = () => initialValues({ stored: Object.fromEntries(FIELDS.map((x) => [x.key, null])) });

describe("the fixed text and the absence of hard-coded bounds", () => {
  it("carries the 'What happens at a limit' text word for word", () => {
    expect(WHAT_HAPPENS).toBe(
      "When a run reaches a limit, its work isn't lost. If it's still making progress and your spend caps allow, it's extended, up to the extensions you set. Otherwise it stops with a checkpoint and continues in a new run: automatically, up to the automatic-continue count, or when you press Continue in Pipeline. Limits never go above your monthly budget or the platform ceilings."
    );
  });
  it("names no ceiling of its own (the response is the only source)", () => {
    expect(readFileSync(SRC, "utf8")).not.toMatch(/\b(240|1500)\b/);
  });
});

describe("where a value comes from", () => {
  it("says 'set for this role', 'account default' or 'platform default'", () => {
    expect(sourceOf(DATA, EXEC, "per_run_usd")).toBe("set for this role");
    expect(sourceOf(DATA, EXEC, "max_run_minutes")).toBe("account default"); // the default row stores 120
    expect(sourceOf(DATA, EXEC, "max_turns")).toBe("platform default");
    expect(sourceOf(DATA, DATA.default, "max_run_minutes")).toBe("account default");
    expect(sourceOf(DATA, DATA.default, "per_run_usd")).toBe("platform default");
  });
  it("tells what Inherit gives: the account default for a role, the platform default for the default row", () => {
    expect(inheritsFrom(DATA, EXEC, "max_run_minutes")).toEqual({ value: 120, source: "account default" });
    expect(inheritsFrom(DATA, EXEC, "max_turns")).toEqual({ value: 100, source: "platform default" });
    expect(inheritsFrom(DATA, DATA.default, "max_run_minutes")).toEqual({ value: 60, source: "platform default" });
  });
});

describe("check(): bounds come from the response", () => {
  const b = DATA.bounds;
  it("accepts a value inside, and both edges", () => {
    for (const v of [b.max_run_minutes.floor, 90, b.max_run_minutes.ceiling]) expect(check(f("max_run_minutes"), String(v), b.max_run_minutes)).toEqual({ value: v });
  });
  it("refuses a value outside, naming the bounds", () => {
    const over = String(b.max_run_minutes.ceiling + 1);
    expect(check(f("max_run_minutes"), over, b.max_run_minutes).error).toBe(`Between ${b.max_run_minutes.floor} and ${b.max_run_minutes.ceiling}.`);
    expect(check(f("silence_minutes"), "10", b.silence_minutes).error).toContain("Between 11");
  });
  it("refuses a non-integer where an integer is required, and more than 2 decimals for USD", () => {
    expect(check(f("max_turns"), "12.5", b.max_turns).error).toBe("Use a whole number.");
    expect(check(f("per_run_usd"), "10.999", b.per_run_usd).error).toBe("Use at most 2 decimals.");
    expect(check(f("per_run_usd"), "10.25", b.per_run_usd)).toEqual({ value: 10.25 });
  });
  it("refuses empty and non-numeric text", () => {
    for (const v of ["", "abc", "-5", "1e2"]) expect(check(f("max_turns"), v, b.max_turns).error).toBe("Enter a number.");
  });
});

describe("buildBody(): one PUT body with all eight keys", () => {
  it("sends null, never an omitted key, for every inherited field", () => {
    const { body, errors } = buildBody(allInherit(), DATA.bounds);
    expect(errors).toEqual({});
    expect(Object.keys(body).sort()).toEqual(FIELDS.map((x) => x.key).sort());
    expect(Object.values(body).every((v) => v === null)).toBe(true);
  });
  it("round-trips a role's stored values", () => {
    expect(buildBody(initialValues(EXEC), DATA.bounds)).toEqual({ body: EXEC.stored, errors: {} });
    expect(buildBody(initialValues(DATA.default), DATA.bounds).body).toEqual(DATA.default.stored);
  });
  it("maps the third state of 'Continue automatically'", () => {
    const v = allInherit();
    expect(buildBody({ ...v, auto_resume: "on" }, DATA.bounds).body.auto_resume).toBe(true);
    expect(buildBody({ ...v, auto_resume: "off" }, DATA.bounds).body.auto_resume).toBe(false);
  });
  it("flags each bad field and leaves no body to send", () => {
    const v = { ...allInherit(), max_run_minutes: { inherit: false, raw: "999" }, per_run_usd: { inherit: false, raw: "1.234" } };
    const { errors } = buildBody(v, DATA.bounds);
    expect(Object.keys(errors)).toEqual(["max_run_minutes", "per_run_usd"]);
  });
});

describe("failureFor(): a 422 goes to the field its path names", () => {
  const err = (status, details) => Object.assign(new Error("Run time is above the ceiling."), { status, details });
  it("names the field and keeps the server's message", () => {
    expect(failureFor(err(422, [{ path: "max_run_minutes" }]))).toEqual({ field: "max_run_minutes", text: "Run time is above the ceiling." });
  });
  it("shows an unknown path on the form, not on a field", () => {
    expect(failureFor(err(422, [{ path: "nope" }])).field).toBeNull();
    expect(failureFor(err(422, undefined)).field).toBeNull();
  });
  it("uses fixed sentences for 403 and 5xx, never the server's text", () => {
    expect(failureFor(err(403))).toEqual({ field: null, text: NOT_ALLOWED });
    expect(failureFor(err(500)).text).toBe("That change couldn't be saved. Try again.");
  });
});

describe("refreshAction()", () => {
  it("reloads a list and a clean form, but never overwrites unsaved edits or a save in flight", () => {
    expect(refreshAction({ editing: null, dirty: false, saving: false })).toBe("load");
    expect(refreshAction({ editing: "executor", dirty: false, saving: false })).toBe("load");
    expect(refreshAction({ editing: "executor", dirty: true, saving: false })).toBe("note");
    expect(refreshAction({ editing: "executor", dirty: true, saving: true })).toBe("later");
  });
});
