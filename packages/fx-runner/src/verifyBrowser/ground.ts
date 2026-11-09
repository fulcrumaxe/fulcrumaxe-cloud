import type { Trace } from "./trace.js";

/**
 * D#749 V2c-2a: the tester's answer, checked before it is written. Two checks, in order: the strict V1 envelope shape (a copy of the rules in the pipeline's
 * `parseEnvelope`, pinned to it by a test, because this public package ships on its own), then grounding: every step's `dom_fact` has to be text the server
 * handed the model, and every `number` a number that text held. The accepted JSON is what the runner reports; the model's final text is not.
 */
const MAX_ENVELOPE_BYTES = 1_048_576;
const MAX_JOURNEYS = 60;
const MAX_STEPS = 20;
const MAX_STEP_TEXT = 300;
const MAX_CONSOLE_ERRORS = 100_000;
const JOURNEY_ID = /^[a-z][a-z0-9_]{0,39}$/;
const RESULTS = ["pass", "fail", "blocked"];
const JOURNEY_KEYS = ["id", "result", "steps", "console_errors", "undo_checked", "reloaded"];

export type Verdict = { ok: true; json: string } | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean =>
  Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => Object.hasOwn(o, k));

/** Why a step is refused, or undefined when it is well formed and grounded. Names the journey and step, never repeats the quoted text. */
function stepProblem(journey: string, step: unknown, trace: Trace): string | undefined {
  if (!isObject(step) || !onlyKeys(step, ["did", "dom_fact", "number"], ["did", "dom_fact"])) return "bad_shape";
  const { did, dom_fact: fact, number } = step;
  if (typeof did !== "string" || typeof fact !== "string" || did.length > MAX_STEP_TEXT || fact.length > MAX_STEP_TEXT) return "bad_value";
  if (!trace.sawFact(journey, fact)) return "dom_fact_not_seen";
  if (Object.hasOwn(step, "number")) {
    if (typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > 1e12) return "bad_value";
    if (!trace.sawNumber(journey, number)) return "number_not_seen";
  }
  return undefined;
}

/** Checks an answer (an object, or JSON text) against the V1 shape and the trace. */
export function groundAnswer(raw: unknown, trace: Trace): Verdict {
  let value = raw;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_BYTES) return { ok: false, reason: "too_large" };
    try {
      value = JSON.parse(raw);
    } catch {
      // fx-swallow-ok: unreadable model output is refused with a closed word; its text is not echoed
      return { ok: false, reason: "not_json" };
    }
  }
  if (!isObject(value) || !onlyKeys(value, ["journeys"], ["journeys"]) || !Array.isArray(value.journeys) || value.journeys.length > MAX_JOURNEYS) return { ok: false, reason: "bad_shape" };
  const seen = new Set<string>();
  for (const [j, entry] of value.journeys.entries()) {
    if (!isObject(entry) || !onlyKeys(entry, JOURNEY_KEYS, JOURNEY_KEYS)) return { ok: false, reason: `journey ${j}: bad_shape` };
    const { id, result, steps, console_errors: errors } = entry;
    if (typeof id !== "string" || !JOURNEY_ID.test(id) || seen.has(id)) return { ok: false, reason: `journey ${j}: bad_id` };
    seen.add(id);
    if (typeof result !== "string" || !RESULTS.includes(result) || typeof entry.undo_checked !== "boolean" || typeof entry.reloaded !== "boolean") return { ok: false, reason: `journey ${id}: bad_value` };
    if (!Number.isInteger(errors) || (errors as number) < 0 || (errors as number) > MAX_CONSOLE_ERRORS) return { ok: false, reason: `journey ${id}: bad_value` };
    if (!Array.isArray(steps) || steps.length > MAX_STEPS) return { ok: false, reason: `journey ${id}: bad_shape` };
    for (const [s, step] of steps.entries()) {
      const problem = stepProblem(id, step, trace);
      if (problem !== undefined) return { ok: false, reason: `journey ${id} step ${s}: ${problem}` };
    }
  }
  return { ok: true, json: JSON.stringify(value) };
}
