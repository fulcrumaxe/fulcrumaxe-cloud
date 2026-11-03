// D#597 CC-6a-2: every code the accept and reject routes can answer has a fixed card sentence AND a telemetry allowlist entry, and the
// assistant route's three named answers (R-597-C3-4) have a panel sentence. The codes are read from the route source, so a code
// added there without a sentence fails here. (Peer of pipeline-resume-refusal-codes.test.mjs.)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSISTANT_COPY, CORRECTION_SENTENCES } from "../apps/pipeline/pipeline-actions.js";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages");
const read = (file) => readFileSync(join(PACKAGES, file), "utf8");
const words = (text) => [...text.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);
const ownErrorCodes = () => {
  const text = read("telemetry/src/errorCodes.ts");
  const at = text.indexOf("export const OWN_ERROR_CODES");
  return at === -1 ? [] : words(text.slice(at, text.indexOf("\n]", at)));
};

/** Codes the two decision routes can answer: the literals in corrections.ts, the codes of the ApiError classes it throws, and the gate's two 403s. */
function decisionCodes() {
  const route = read("api/src/routes/corrections.ts");
  const errors = read("api/src/errors.ts");
  const own = [...route.matchAll(/new ApiError\(\d+, "([a-z_]+)"/g)].map((m) => m[1]);
  const classes = [...new Set([...route.matchAll(/new ([A-Za-z]+Error)\(/g)].map((m) => m[1]))];
  const viaClass = classes.flatMap((name) => {
    const m = new RegExp(`class ${name} extends ApiError \\{[^}]*?super\\(\\d+, "([a-z_]+)"`).exec(errors);
    return m ? [m[1]] : name === "ForbiddenError" ? ["forbidden"] : [];
  });
  return [...new Set([...own, ...viaClass, "not_found", "session_required", "insufficient_role"])].sort();
}
// Codes with a card sentence only because a person can meet them (a request that failed validation, a draft gone): not thrown by name above.
// The dispatcher's own role gate answers insufficient_role before any route code runs; it is a plain 403, never reported, so it has no telemetry entry.
const NOT_REPORTED = ["insufficient_role"];
const OWN = ownErrorCodes();
const FOUND = decisionCodes();

describe("correction decision codes: a new code needs a card sentence and a telemetry entry", () => {
  it("finds the codes it should, so the scan cannot go quiet", () => {
    expect(OWN.length).toBeGreaterThan(50);
    expect(FOUND).toEqual(expect.arrayContaining(["already_decided", "content_changed", "apply_failed", "already_running", "action_not_available", "external_requires_human", "no_repo", "run_actions_unavailable", "validation_failed", "forbidden", "not_found", "session_required", "insufficient_role"]));
  });
  it("every code the routes answer has a sentence and an OWN_ERROR_CODES entry", () => {
    for (const code of FOUND) {
      expect(Object.hasOwn(CORRECTION_SENTENCES, code), `${code} has no card sentence`).toBe(true);
      if (!NOT_REPORTED.includes(code)) expect(OWN, `${code} missing from OWN_ERROR_CODES`).toContain(code);
    }
  });
  it("only codes the routes can answer have a sentence", () => {
    expect(Object.keys(CORRECTION_SENTENCES).filter((c) => !FOUND.includes(c))).toEqual([]);
  });
});

describe("assistant route answers (R-597-C3-4)", () => {
  it("the three named codes have a state sentence in the panel, and are in OWN_ERROR_CODES", () => {
    const route = read("api/src/assistant/turn.ts");
    const named = Object.entries(JSON.parse(/STATE_CODE[^=]*= (\{[^}]*\})/.exec(route)[1].replace(/(\w+):/g, '"$1":'))).map(([state, code]) => ({ state, code }));
    expect(named.map((n) => n.state).sort()).toEqual(["no_key", "unconfigured", "unpriced"]);
    for (const { state, code } of named) {
      expect(OWN, code).toContain(code);
      expect(ASSISTANT_COPY[state], state).toBeTypeOf("string");
    }
  });
  it("every state the route can end a turn in has a sentence in the panel (or is ok)", () => {
    const route = read("api/src/assistant/turn.ts");
    const states = words(/TURN_STATES = (\[[^\]]*\])/.exec(route)[1]);
    expect(states).toContain("budget_reached");
    for (const state of states.filter((s) => s !== "ok")) expect(ASSISTANT_COPY[state], state).toBeTypeOf("string");
  });
  it("the sentences the panel shows say the same as the route's own STATE_TEXT, so the dropped server sentence loses nothing", () => {
    const route = read("api/src/assistant/turn.ts");
    const block = /STATE_TEXT[^=]*= (\{[\s\S]*?\n\});/.exec(route)[1];
    const pairs = [...block.matchAll(/(\w+): "((?:[^"\\]|\\.)*)"/g)];
    expect(pairs.length).toBe(8);
    for (const [, state, text] of pairs) expect(ASSISTANT_COPY[state], state).toBe(text);
  });
});
