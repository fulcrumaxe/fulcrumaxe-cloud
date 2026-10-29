import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "../src/types.js";
import { buildTerminalReport } from "../src/targets/sandboxTarget.js";

/** A run that ends cleanly with no AGENT_OUTPUT is a failure with a fixed code, never a success on an empty result. */
describe("buildTerminalReport: a clean end with no agent output", () => {
  const resultEvent = (agentOutput: unknown, extra: Partial<NormalizedEvent> = {}): NormalizedEvent =>
    ({ runId: "r", role: "project-manager", seq: 1, type: "result", ts: "t", agentOutput, ...extra }) as NormalizedEvent;

  it.each([["no agentOutput at all", undefined], ["a null agentOutput", null], ["a non-object agentOutput", "text"]])("%s ends failed with empty_agent_output", (_l, out) => {
    const report = buildTerminalReport(resultEvent(out), "cc-1", 0.25);
    expect(report).toMatchObject({ status: "failed", failureReason: "empty_agent_output", envelope: null, sessionId: "cc-1", usd: 0.25 });
  });

  it("a normal success is unchanged: succeeded, the envelope kept, no failure reason", () => {
    const report = buildTerminalReport(resultEvent({ verdict: "done", summary: "ok" }), "cc-1", 0.25);
    expect(report).toMatchObject({ status: "succeeded", envelope: { verdict: "done", summary: "ok" } });
    expect(report.failureReason).toBeUndefined();
  });

  it("an error event keeps its own failure shape (no empty_agent_output code)", () => {
    const report = buildTerminalReport(resultEvent(undefined, { type: "error", isError: true }), "cc-1", 0);
    expect(report.status).toBe("failed");
    expect(report.failureReason).toBeUndefined();
  });
});
