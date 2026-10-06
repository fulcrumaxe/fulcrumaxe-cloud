import { describe, expect, it } from "vitest";
import { createTestConnectionStatusPort } from "../src/connectionStatusPort.js";

/**
 * D#2 H09 pass/fail 5 calls "H21's markBroken for 401/403" -- H21 is not
 * built (HOLD, per D#31). This is the narrow interface + test double
 * H09b/H21 will build against; this test just proves the double records
 * what it's told, so a later caller can assert against it with
 * confidence.
 *
 * H09 security review, "should fix" 5: `markBroken` takes a run id, never
 * a bare account id -- the real implementation derives the account
 * server-side from the run, rather than trusting a caller-supplied
 * account id directly.
 */
describe("ConnectionStatusPort test double", () => {
  it("records every markBroken call with its runId and code", async () => {
    const port = createTestConnectionStatusPort();
    await port.markBroken("run-1", 401);
    await port.markBroken("run-2", 403);
    expect(port.calls).toEqual([
      { runId: "run-1", code: 401 },
      { runId: "run-2", code: 403 },
    ]);
  });

  it("starts with no recorded calls", () => {
    const port = createTestConnectionStatusPort();
    expect(port.calls).toEqual([]);
  });
});
