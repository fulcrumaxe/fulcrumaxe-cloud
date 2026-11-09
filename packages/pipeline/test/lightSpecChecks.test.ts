import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { LIGHT_SPEC_REFUSAL_CODES } from "@fx/core/src/work-items/activity.js";
import { LIGHT_SPEC_RETRY_CODES, buildLightSpecPrompt, isLightRetryCode, publishLightSpec } from "../src/advance/lightSpec.js";
import { expectOneGenuineEnvelope } from "./plan/helpers/panelFixtures.js";

/**
 * The short Spec's answer checks, each with its own refusal code. Every one of these answers is refused before the store is touched, so no pool is needed
 * (a pool that is touched throws, which would fail the test loudly).
 */
const NO_POOL = new Proxy({}, { get: () => { throw new Error("the store must not be reached"); } }) as unknown as Pool;
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const refuse = (output: unknown) => publishLightSpec(NO_POOL, ACCOUNT, ITEM, output);
const GOOD = { feasible: true, reason: "", split_proposed: false, summary: "Fix the year.", spec: "1. The footer shows the year.", acceptance_files: ["src/a.ts"] };

describe("which check refused the PM's answer", () => {
  it.each([
    ["no answer object at all (the run kept none)", null],
    ["an array where the object should be", []],
    ["a bare string", "done"],
    ["undefined", undefined],
  ])("%s: light_answer_missing", async (_name, output) => {
    expect(await refuse(output)).toEqual({ status: "refused", reason: "light_answer_missing" });
  });

  it("the marker the runner stores in place of an answer over its size cap: light_answer_too_large, not a vague invalid answer", async () => {
    expect(await refuse({ dropped: "too_large" })).toEqual({ status: "refused", reason: "light_answer_too_large" });
  });

  it("a dropped marker next to real answer keys is not the dropped marker (the answer is judged on its own keys)", async () => {
    expect(await refuse({ ...GOOD, spec: "", dropped: "x" })).toEqual({ status: "refused", reason: "light_spec_empty" });
  });

  it.each([
    ["spec missing", { ...GOOD, spec: undefined }],
    ["spec empty", { ...GOOD, spec: "" }],
    ["spec only whitespace", { ...GOOD, spec: " \n\t " }],
    ["spec not a string", { ...GOOD, spec: 3 }],
  ])("%s: light_spec_empty", async (_name, output) => {
    expect(await refuse(output)).toEqual({ status: "refused", reason: "light_spec_empty" });
  });

  it.each([
    ["split_proposed missing", (() => { const { split_proposed: _s, ...rest } = GOOD; return rest; })()],
    ["split_proposed a string", { ...GOOD, split_proposed: "false" }],
    ["split_proposed null", { ...GOOD, split_proposed: null }],
    ["split_proposed a number", { ...GOOD, split_proposed: 0 }],
  ])("%s: light_split_flag_missing", async (_name, output) => {
    expect(await refuse(output)).toEqual({ status: "refused", reason: "light_split_flag_missing" });
  });

  it("not feasible is still read before any of these (an empty spec is expected there)", async () => {
    expect(await refuse({ feasible: false, reason: "No.", spec: "" })).toMatchObject({ status: "not_feasible" });
  });

  it("an unreadable file list is still its own code, ahead of the split flag", async () => {
    expect(await refuse({ ...GOOD, acceptance_files: "src/a.ts", split_proposed: undefined })).toEqual({ status: "refused", reason: "invalid_file_scope" });
  });
});

describe("the second ask", () => {
  it("the retried codes are exactly the four answer checks, each a listed refusal code, and only those", () => {
    expect([...LIGHT_SPEC_RETRY_CODES].sort()).toEqual(["light_answer_missing", "light_answer_too_large", "light_spec_empty", "light_split_flag_missing"]);
    for (const code of LIGHT_SPEC_RETRY_CODES) {
      expect(LIGHT_SPEC_REFUSAL_CODES).toContain(code);
      expect(isLightRetryCode(code)).toBe(true);
    }
    for (const other of ["invalid_spec_output", "invalid_file_scope", "invalid_planned_prs", "planned_split_missing", "publish_failed", "", null, undefined, 7]) expect(isLightRetryCode(other)).toBe(false);
  });

  it.each(LIGHT_SPEC_RETRY_CODES)("%s: the prompt opens with a note that names the failed check, carries no model text, and still ends with exactly one envelope", (code) => {
    const first = buildLightSpecPrompt({ category: "bug", title: "T", body: "B" });
    const again = buildLightSpecPrompt({ category: "bug", title: "T", body: "B", retry: code });
    expect(first).not.toContain("Your previous answer");
    expect(again.startsWith("Your previous answer")).toBe(true);
    expect(again.endsWith(first.slice(first.indexOf("You are the project-manager")).slice(-200))).toBe(true);
    expectOneGenuineEnvelope(again);
  });

  it("each code has its own note", () => {
    const notes = new Set(LIGHT_SPEC_RETRY_CODES.map((code) => buildLightSpecPrompt({ category: "doc", title: "T", body: "B", retry: code }).split("\n")[0]));
    expect(notes.size).toBe(LIGHT_SPEC_RETRY_CODES.length);
  });
});
