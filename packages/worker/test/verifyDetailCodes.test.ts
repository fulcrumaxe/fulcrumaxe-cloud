import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNNER_SETUP_DETAILS } from "@fulcrumaxe/runner-protocol";
import { VERIFY_DETAIL_CODES } from "@fx/core/src/verify/rows.js";

/**
 * D#749: the verify row's detail codes are exactly the pipeline's envelope rejections (plus `unknown_journey`) and the runner's named ends of a deploy verifier job. Core cannot import
 * either package, so its list is a copy; this keeps the three in step (a rejection or a runner end added without a detail code would be dropped from the card without a word).
 */
const ENVELOPE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pipeline", "src", "verify", "envelope.ts"), "utf8");

describe("VERIFY_DETAIL_CODES", () => {
  it("holds every envelope rejection and unknown_journey", () => {
    const union = /export type EnvelopeRejection = ([^;]+);/.exec(ENVELOPE)?.[1] ?? "";
    const rejections = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(rejections.length).toBeGreaterThan(0);
    expect(VERIFY_DETAIL_CODES.slice(0, rejections.length + 1)).toEqual([...rejections, "unknown_journey"]);
  });

  it("holds the runner's browser-job ends, each of which is a real runner_setup detail", () => {
    const runnerEnds = VERIFY_DETAIL_CODES.slice(VERIFY_DETAIL_CODES.indexOf("unknown_journey") + 1);
    expect(runnerEnds).toEqual(["browser_not_connected", "verify_signin_missing", "verify_browser_unavailable", "verify_answer_missing"]);
    for (const code of runnerEnds) expect(RUNNER_SETUP_DETAILS, code).toContain(code);
    expect(RUNNER_SETUP_DETAILS.filter((d) => d.startsWith("verify_"))).toEqual(runnerEnds.filter((d) => d.startsWith("verify_")));
  });
});
