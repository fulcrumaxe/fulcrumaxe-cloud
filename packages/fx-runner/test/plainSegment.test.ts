import { describe, expect, it } from "vitest";
import { NotAPlainSegment, segmentUnder } from "../src/job/plainSegment.js";

describe("segmentUnder: one plain segment under a root", () => {
  it("joins an ordinary name, with or without a trailing slash on the root", () => {
    expect(segmentUnder("/r/jobs", "rn-1.a_b")).toBe("/r/jobs/rn-1.a_b");
    expect(segmentUnder("/r/jobs/", "x")).toBe("/r/jobs/x");
  });

  it.each(["", ".", "..", "../x", "x/..", "a/b", "/abs", "a\\b", ".hidden", "x..y", "a b", "a\0b", "a".repeat(129)])("refuses %j with a coded error that does not carry the name", (name) => {
    let caught: unknown;
    try {
      segmentUnder("/r/jobs", name);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotAPlainSegment);
    expect((caught as NotAPlainSegment).code).toBe("bad_segment");
    expect((caught as Error).message).toBe("bad_segment");
  });
});
