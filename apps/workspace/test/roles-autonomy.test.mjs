// apps/workspace/test/roles-autonomy.test.mjs
//
// D#7 DP10b: the pure rules of the Roles app's Autonomy view, against the committed API fixtures (which packages/api/test/contract.test.ts
// validates against the real response schemas). The DOM behaviour is in e2e/roles-autonomy.spec.ts; the vitest environment here is node.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COPY, DISPOSITION_TEXT, NOTIFY_TEXT, OUTCOME_TEXT, failureText, parseWindow, sourceText, word } from "../apps/roles/roles-autonomy.js";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const DIALS = fx("getDecisionSettings", "200-ok.json");
const ASK = fx("getAskSettings", "200-ok.json");

describe("wording covers every value the API can send", () => {
  it("has customer wording for each disposition, outcome and notify value in the fixtures, and none reads as an id", () => {
    for (const d of DIALS.dials) for (const v of d.allowed_dispositions) expect(DISPOSITION_TEXT[v], v).toMatch(/\S/);
    for (const r of ASK.rows) for (const v of r.allowed_outcomes) expect(OUTCOME_TEXT[v], v).toMatch(/\S/);
    for (const v of ASK.notify_values) expect(NOTIFY_TEXT[v], v).toMatch(/\S/);
    for (const text of [...Object.values(DISPOSITION_TEXT), ...Object.values(OUTCOME_TEXT), ...Object.values(NOTIFY_TEXT)]) expect(text).not.toMatch(/_/);
  });

  it("word() passes an unknown value through instead of printing undefined", () => {
    expect(word(DISPOSITION_TEXT, "ask")).toBe("Ask me first");
    expect(word(DISPOSITION_TEXT, "something_new")).toBe("something_new");
    expect(word(DISPOSITION_TEXT, "constructor")).toBe("constructor");
  });

  it("states the two oversight levels: monitored and approved", () => {
    expect(COPY.levels).toMatch(/monitor/);
    expect(COPY.levels).toMatch(/approval/);
  });

  it("points to the Roles tab for per-role modes, in plain words", () => {
    expect(COPY.rolesPointer).toBe("To set the mode for each role, use the Roles tab.");
  });
});

describe("parseWindow", () => {
  const bounds = ASK.bounds;
  it("empty means use the default", () => {
    expect(parseWindow("", bounds)).toEqual({ value: null });
    expect(parseWindow("   ", bounds)).toEqual({ value: null });
  });
  it("accepts whole minutes at and inside the server's bounds", () => {
    expect(parseWindow("15", bounds)).toEqual({ value: 15 });
    expect(parseWindow(" 1440 ", bounds)).toEqual({ value: 1440 });
    expect(parseWindow("20160", bounds)).toEqual({ value: 20160 });
  });
  it("refuses everything else, naming the bounds the server sent", () => {
    for (const bad of ["14", "20161", "0", "-5", "1.5", "1e3", "abc", "15 min", "0x20"]) {
      expect(parseWindow(bad, bounds), bad).toEqual({ error: "Enter whole minutes from 15 to 20160, or leave it empty." });
    }
  });
});

describe("failureText", () => {
  it("shows the server's own words for a 422 only, and a fixed sentence otherwise", () => {
    expect(failureText({ status: 422, message: "the answer window must be a whole number of minutes" })).toBe("the answer window must be a whole number of minutes");
    expect(failureText({ status: 403, message: "secret" })).toBe("Only owners and admins can change these settings.");
    expect(failureText({ status: 409, message: "secret" })).toBe("That changed while you were saving. The latest settings are shown.");
    expect(failureText({ status: 500, message: "secret" })).toBe("That change couldn't be saved. Try again.");
    expect(failureText(null)).toBe("That change couldn't be saved. Try again.");
  });
});

describe("sourceText", () => {
  it("says where a dial's value came from, by the preset's name", () => {
    expect(sourceText({ source: "default", preset: null }, DIALS.presets)).toBe("Default");
    expect(sourceText({ source: "override", preset: null }, DIALS.presets)).toBe("Changed by you");
    expect(sourceText({ source: "preset", preset: "balanced" }, DIALS.presets)).toBe("From the Balanced preset");
    expect(sourceText({ source: "preset", preset: "gone" }, DIALS.presets)).toBe("From a preset");
  });
});
