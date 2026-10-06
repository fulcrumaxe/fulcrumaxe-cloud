import { describe, expect, it } from "vitest";
import { detectModelFailure } from "../src/modelFailure.js";
import type { NormalizedEvent } from "../src/types.js";

function errorEvent(text: string): NormalizedEvent {
  return { runId: "r", role: "executor", seq: 1, type: "error", ts: "now", isError: true, text };
}

describe("detectModelFailure (D#2 H09b2, H09.5)", () => {
  it("returns undefined for a non-error event", () => {
    expect(detectModelFailure({ runId: "r", role: "executor", seq: 1, type: "assistant", ts: "now", text: "401" })).toBeUndefined();
  });

  it("returns undefined for an error event with no recognizable code", () => {
    expect(detectModelFailure(errorEvent("connection reset"))).toBeUndefined();
  });

  it("detects 401", () => {
    expect(detectModelFailure(errorEvent("model returned 401 unauthorized"))).toBe(401);
  });

  it("detects 403", () => {
    expect(detectModelFailure(errorEvent("403 forbidden"))).toBe(403);
  });

  it("detects 402 by numeric code", () => {
    expect(detectModelFailure(errorEvent("payment required (402)"))).toBe(402);
  });

  it("detects 402 by quota_for_entity_exceeded, case-insensitively", () => {
    expect(detectModelFailure(errorEvent("QUOTA_FOR_ENTITY_EXCEEDED"))).toBe(402);
  });

  it("never throws on a missing text field", () => {
    expect(detectModelFailure({ runId: "r", role: "executor", seq: 1, type: "error", ts: "now", isError: true })).toBeUndefined();
  });
});
