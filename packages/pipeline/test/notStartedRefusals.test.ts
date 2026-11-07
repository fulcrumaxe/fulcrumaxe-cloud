import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REVIEW_SELF_CLEARING_WAIT_CODES } from "@fx/core/src/work-items/activity.js";
import { STOP_WORDS } from "@fx/core/src/work-items/stalled.js";
import {
  NOT_STARTED_CLASS,
  SELF_CLEARING_MAX_PARKS,
  SELF_CLEARING_REVIEW_WAITS,
  SELF_CLEARING_WAIT_SENTENCES,
  classifyNotStarted,
  isSelfClearingReviewWait,
} from "../src/advance/notStartedRefusals.js";
import { CAPACITY_WAIT } from "../src/advance/reservationPauses.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), "utf8");

const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`source markers moved: ${from} .. ${to}`);
  return src.slice(a, b);
};
const quoted = (src: string): string[] => [...src.matchAll(/"([a-z][a-z_]*)"/g)].map((m) => m[1]!);
const unionOf = (src: string, name: string): string[] => {
  const m = new RegExp(`export type ${name} =([^;]+);`).exec(src);
  if (m === null) throw new Error(`type ${name} moved`);
  return quoted(m[1]!);
};

/**
 * Every literal code a reviewer's start can come back refused with, read from the sources that produce them (nothing copied by hand): startReviewerBody, the worker's
 * startRun, the seat's refusals, and the execution target's admit and precheck reasons (with the spend check's denials the admit set includes).
 */
function sourceCodes(): { codes: Set<string>; bySource: Record<string, number> } {
  const reviewSteps = between(read("../../../apps/web/lib/advanceReviewSteps.ts"), "export async function startReviewerBody(", "export interface ReviewerOutcome");
  const startRun = between(read("../../worker/src/advance.ts"), "async function startRun(req: AdvanceRunRequest)", "How a run stands, following the run");
  const target = read("../../runner/src/executionTarget.ts");
  const bySource: Record<string, string[]> = {
    startReviewerBody: [...reviewSteps.matchAll(/reason: "([a-z_]+)"/g)].map((m) => m[1]!),
    startRun: [...startRun.matchAll(/reason: "([a-z_]+)"/g)].map((m) => m[1]!),
    seat: unionOf(read("../../worker/src/seat.ts"), "SeatRefusal"),
    admit: unionOf(target, "AdmitDenyReason"),
    precheck: [...unionOf(target, "PrecheckDenyReason"), ...unionOf(target, "TargetPrecheckReason")],
    spend: unionOf(read("../../spend/src/types.ts").replace(/'/g, '"'), "DenyReason"),
  };
  // The capacity wait is returned through its constant, not a literal.
  expect(startRun).toContain("reason: CAPACITY_WAIT");
  const codes = new Set(Object.values(bySource).flat());
  codes.add(CAPACITY_WAIT);
  return { codes, bySource: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, v.length])) };
}

describe("every not-started refusal is classified once", () => {
  const { codes, bySource } = sourceCodes();

  it("reads a real set from each source (a moved marker or an emptied union fails here, not silently)", () => {
    expect(bySource.startReviewerBody).toBeGreaterThanOrEqual(3);
    expect(bySource.startRun).toBeGreaterThanOrEqual(8);
    expect(bySource.seat).toBe(9);
    expect(bySource.admit).toBeGreaterThanOrEqual(7);
    expect(bySource.spend).toBe(8);
    expect(codes.has("sandbox_reaping")).toBe(true);
    expect(codes.has("verified_consent_stale")).toBe(true);
    expect(codes.has("runner_daily_limit")).toBe(true);
    // The job issuer refuses a job whose claim reply is over the hosted budget: the start answers it, so the table has to.
    expect(codes.has("job_too_large")).toBe(true);
  });

  it("every code the sources can produce is in the table (a new code cannot go unclassified)", () => {
    expect([...codes].filter((c) => !Object.hasOwn(NOT_STARTED_CLASS, c))).toEqual([]);
  });

  it("every table entry is a code a source still produces (no dead rows)", () => {
    expect(Object.keys(NOT_STARTED_CLASS).filter((c) => !codes.has(c))).toEqual([]);
  });

  it("a dynamic bad_<field> and any unlisted code are permanent; a listed one is its class", () => {
    expect(read("../../../apps/web/lib/advanceReviewSteps.ts")).toContain("reason: `bad_${err.field.toLowerCase()}`");
    for (const c of ["bad_spec", "bad_owner", "bad_head", "brand_new_code", "", null, undefined, 3, "toString", "__proto__"]) expect(classifyNotStarted(c)).toBe("permanent");
    expect(classifyNotStarted("sandbox_reaping")).toBe("self_clearing");
    expect(classifyNotStarted("model_budget_unset")).toBe("person_fixable");
    expect(classifyNotStarted("public_repo")).toBe("person_fixable");
    expect(classifyNotStarted("job_too_large")).toBe("person_fixable");
    expect(classifyNotStarted("invalid_input")).toBe("permanent");
  });

  it("the five codes the review round parks on are exactly the self-clearing ones no earlier wait handles", () => {
    expect([...SELF_CLEARING_REVIEW_WAITS]).toEqual(["sandbox_reaping", "repo_visibility_unknown", "execution_mode_changed", "worker_unavailable", "starter_unavailable"]);
    for (const c of SELF_CLEARING_REVIEW_WAITS) expect(NOT_STARTED_CLASS[c]).toBe("self_clearing");
    const earlier = new Set(["runner_daily_limit", CAPACITY_WAIT, "model_credits_exhausted", "per_spawn_cap_exceeded", "work_item_cap_exceeded", "envelope_exceeded", "model_budget_exceeded", "compute_cap_exceeded"]);
    const selfClearing = Object.entries(NOT_STARTED_CLASS).filter(([, k]) => k === "self_clearing").map(([c]) => c);
    expect(selfClearing.filter((c) => !earlier.has(c)).sort()).toEqual([...SELF_CLEARING_REVIEW_WAITS].sort());
  });
});

describe("the words for each class", () => {
  it("every parked cause has one fixed sentence that names no placeholder", () => {
    expect(Object.keys(SELF_CLEARING_WAIT_SENTENCES).sort()).toEqual([...SELF_CLEARING_REVIEW_WAITS].sort());
    for (const c of SELF_CLEARING_REVIEW_WAITS) {
      expect(SELF_CLEARING_WAIT_SENTENCES[c]).toMatch(/^This review is waiting .* starts again on its own/);
      expect(SELF_CLEARING_WAIT_SENTENCES[c]).not.toMatch(/undefined|null|\{|_/);
    }
  });

  it("every person-fixable code has its own stop sentence naming what the person does (not the generic fallback)", () => {
    const fixable = Object.entries(NOT_STARTED_CLASS).filter(([, k]) => k === "person_fixable").map(([c]) => c);
    expect(fixable.length).toBeGreaterThanOrEqual(10);
    for (const c of fixable) {
      const words = STOP_WORDS[`not_started_${c}`];
      expect(words, `${c} has no stop words`).toBeDefined();
      expect(words).toMatch(/continue the review from this card/);
      expect(words).not.toMatch(/undefined|null|\{/);
    }
  });

  it("a self-clearing cause that never cleared stops with words that name it and do not promise a retry", () => {
    for (const c of SELF_CLEARING_REVIEW_WAITS) {
      expect(STOP_WORDS[`not_started_${c}`]).toMatch(/about four hours/);
      expect(STOP_WORDS[`not_started_${c}`]).not.toMatch(/on its own|automatically|by itself/);
    }
  });
});

describe("the copies other packages repeat are the same list", () => {
  it("the workflow bundle, the worker and the activity read repeat the five codes and the park bound", () => {
    const list = JSON.stringify([...SELF_CLEARING_REVIEW_WAITS]).replace(/,/g, ", ");
    expect(read("../../../apps/web/workflows/workItemAdvance.ts")).toContain(`const SELF_CLEARING_REVIEW_WAITS: readonly string[] = ${list};`);
    expect(read("../../worker/src/stageResume.ts")).toContain(`export const SELF_CLEARING_MAX_PARKS = ${SELF_CLEARING_MAX_PARKS};`);
    expect(read("../../worker/src/stageResume.ts")).toContain(`SELF_CLEARING_REVIEW_WAITS: readonly string[] = Object.freeze(${list});`);
    expect([...REVIEW_SELF_CLEARING_WAIT_CODES]).toEqual([...SELF_CLEARING_REVIEW_WAITS]);
  });

  it("the park bound is four hours of 15-minute passes", () => {
    expect(SELF_CLEARING_MAX_PARKS * 15).toBe(240);
    expect(isSelfClearingReviewWait("sandbox_reaping")).toBe(true);
    expect(isSelfClearingReviewWait("runner_daily_limit")).toBe(false);
    expect(isSelfClearingReviewWait(undefined)).toBe(false);
  });
});
