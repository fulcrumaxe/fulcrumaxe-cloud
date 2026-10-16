import { describe, expect, it } from "vitest";
import { PLANE_PUSH_REPORT_CODES } from "@fx/runner-cloud";
import { PLANE_REFUSAL_CODES } from "@fx/pipeline";

/**
 * D#598 P1f-2: the refusal codes a runner's report may carry are the push route's fixed list. runner-cloud cannot import the pipeline, so it holds its own
 * copy; this is the one place that sees both, and it fails when they differ.
 */
describe("the report's refusal codes are the push route's", () => {
  it("are the same set", () => {
    expect([...PLANE_PUSH_REPORT_CODES].sort()).toEqual([...PLANE_REFUSAL_CODES].sort());
  });
});
