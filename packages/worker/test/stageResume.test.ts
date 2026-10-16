import { describe, expect, it } from "vitest";
import { ADVANCE_TERMINAL_STATUSES } from "../src/advance.js";
import { STAGE_RESUME_TERMINAL_STATUSES } from "../src/stageResume.js";

/** D#483 S5-k1b: the list the sweep repeats (advance.ts imports the sweep, so it cannot import the list). */
describe("the parked-stage sweep's repeated lists", () => {
  it("the terminal run statuses equal the stage driver's", () => {
    expect([...STAGE_RESUME_TERMINAL_STATUSES]).toEqual([...ADVANCE_TERMINAL_STATUSES]);
  });
});
