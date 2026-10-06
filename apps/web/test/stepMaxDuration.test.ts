import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PM_TIMEOUT_MS, REPLAY_PANEL_TIMEOUT_MS, SEAT_ROUND_TIMEOUT_MS, STEP_LIMIT_MS } from "@fx/pipeline";

/**
 * D#483 P3: the workflow step's time limit is set, not assumed. The panel and Spec steps are sized against
 * STEP_LIMIT_MS (packages/pipeline/src/advance/specFlow.ts), so the platform's limit for the step function must be that
 * number. The Workflow builder generates the step route and asks the platform for its plan maximum ("max"); this entry
 * in vercel.json pins it. A deploy shows if the platform refuses the entry: remove it and the limit goes back to "max".
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(HERE, "..", "vercel.json"), "utf8")) as { functions?: Record<string, { maxDuration?: number }> };

describe("the workflow step function's time limit", () => {
  it("is set in vercel.json for the generated step route, to STEP_LIMIT_MS", () => {
    const entry = config.functions?.["app/.well-known/workflow/v1/step/route.js"];
    expect(entry).toBeDefined();
    expect(entry!.maxDuration! * 1000).toBe(STEP_LIMIT_MS);
  });

  it("no other function entry is an unreviewed guess: the only entry is the step route", () => {
    expect(Object.keys(config.functions ?? {})).toEqual(["app/.well-known/workflow/v1/step/route.js"]);
  });

  it("the steps are sized to fit it with room to spare (the same arithmetic the pipeline pins)", () => {
    expect(2 * SEAT_ROUND_TIMEOUT_MS).toBeLessThan(STEP_LIMIT_MS - 60_000);
    expect(REPLAY_PANEL_TIMEOUT_MS + PM_TIMEOUT_MS).toBeLessThan(STEP_LIMIT_MS - 60_000);
  });
});
