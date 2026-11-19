import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COLDSTART_CODES, COLDSTART_CODE_SUFFIX_PATTERN, COLDSTART_STATES, COLDSTART_STATUS_SCHEMA_SHA256, COLDSTART_STEPS, ColdstartCode, ColdstartState, ColdstartStep } from "../src/coldstartStatus.js";

const FILE = join(import.meta.dirname, "..", "schema", "coldstart-status.v1.json");
const bytes = readFileSync(FILE);
const file = JSON.parse(bytes.toString("utf8")) as { version: number; steps: string[]; states: string[]; codes: string[]; code_suffix: Record<string, string> };

/** The engine's coldstart status vocabulary is pinned by hash. If the engine changes it, `coldstart.sh --print-status-schema` prints a new hash and this suite fails until the file, the lists and the pin move together. */
describe("coldstart status vocabulary", () => {
  it("is the engine's file, byte for byte, and pinned by its sha256", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(COLDSTART_STATUS_SCHEMA_SHA256);
    expect(COLDSTART_STATUS_SCHEMA_SHA256).toBe("5d80fd0932de256dc131ea6526f243a4a5d169618070233420be81607f01482a");
    expect(file.version).toBe(1);
  });
  it("has the file's steps, states, codes and suffix rule, in the file's order, and no name more", () => {
    expect([...COLDSTART_STEPS]).toEqual(file.steps);
    expect([...COLDSTART_STATES]).toEqual(file.states);
    expect([...COLDSTART_CODES]).toEqual(file.codes);
    expect(Object.keys(file.code_suffix)).toEqual(["missing_topic"]);
    expect(COLDSTART_CODE_SUFFIX_PATTERN.source).toBe(file.code_suffix["missing_topic"]);
    expect(file.states).toContain("skipped");
  });
  it("accepts each name and refuses any other", () => {
    for (const step of file.steps) expect(ColdstartStep.safeParse(step).success, step).toBe(true);
    for (const state of file.states) expect(ColdstartState.safeParse(state).success, state).toBe(true);
    for (const code of file.codes.filter((c) => c !== "missing_topic")) expect(ColdstartCode.safeParse(code).success, code).toBe(true);
    expect(ColdstartCode.safeParse("missing_topic:vision_doc").success).toBe(true);
    for (const bad of ["missing_topic", "missing_topic:", "missing_topic:A", "missing_topic:a:b", "missing_topic:a b", "deps_failed:x", "unknown", "", "DEPS_FAILED"]) expect(ColdstartCode.safeParse(bad).success, bad).toBe(false);
    expect(ColdstartStep.safeParse("install").success).toBe(false);
    expect(ColdstartState.safeParse("running").success).toBe(false);
  });
});
