import { describe, expect, it } from "vitest";
import { crossesAlertDepth } from "../src/advance/capacityQueue.js";

/** D#483 S5-k3b-h: the depth alert fires once at the crossing, read from the depth before and after the enqueue (C27-k3h-5). */
describe("crossesAlertDepth", () => {
  it("C27-k3h-5: 20 -> 22 in one step (two enqueues at once) fires; 21 -> 22 does not; 20 -> 21 fires", () => {
    expect(crossesAlertDepth(true, 22, 20, 20)).toBe(true);
    expect(crossesAlertDepth(true, 22, 20, 21)).toBe(false);
    expect(crossesAlertDepth(true, 21, 20, 20)).toBe(true);
  });

  it("over a run of enqueues each crossing fires once, however the steps fall", () => {
    for (const steps of [[1, 1, 1, 1], [2, 2], [3, 1], [1, 3], [4]]) {
      let depth = 18;
      let fired = 0;
      for (const step of steps) {
        if (crossesAlertDepth(true, depth + step, 20, depth)) fired++;
        depth += step;
      }
      expect(fired, steps.join(",")).toBe(1);
    }
  });

  it("never for an enqueue that made no new entry, and never below or at the setting", () => {
    expect(crossesAlertDepth(false, 22, 20, 20)).toBe(false);
    expect(crossesAlertDepth(true, 20, 20, 18)).toBe(false);
    expect(crossesAlertDepth(true, 25, 20, 23)).toBe(false);
  });
});
