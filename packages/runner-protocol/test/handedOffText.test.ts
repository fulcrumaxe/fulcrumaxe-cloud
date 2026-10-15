import { describe, expect, it } from "vitest";
import { HANDED_OFF_DETAILS, HANDED_OFF_FALLBACK_LINE, HANDED_OFF_LINES, handedOffText } from "../src/index.js";

/** D#599 HO-2b (R-599-HO1): the run view's words for a `run_ended handed_off` event, by detail, and for an event with none. */
describe("handedOffText", () => {
  it("has a line of its own for every detail HO-1 allows, and no line for anything else", () => {
    expect(Object.keys(HANDED_OFF_LINES).sort()).toEqual([...HANDED_OFF_DETAILS].sort());
    for (const detail of HANDED_OFF_DETAILS) {
      const text = handedOffText(detail);
      expect(text, detail).toBe(HANDED_OFF_LINES[detail]);
      expect(text, detail).not.toMatch(/ended|null|undefined/i);
    }
  });

  it("an event with no detail, or one this build does not know, still reads as a move in progress, never as an ended run", () => {
    for (const detail of [null, undefined, "", "other", "constructor", "__proto__"]) {
      expect(handedOffText(detail), String(detail)).toBe(HANDED_OFF_FALLBACK_LINE);
    }
    expect(HANDED_OFF_FALLBACK_LINE).not.toMatch(/ended/i);
  });
});
