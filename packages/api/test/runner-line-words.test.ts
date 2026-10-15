import { describe, expect, it } from "vitest";
import { HANDED_OFF_FALLBACK_LINE, HANDED_OFF_LINES } from "@fulcrumaxe/runner-protocol";
import { runEndedSentence, withRunnerWords } from "../src/routes/runnerLineWords.js";

/** D#599 HO-2b (R-599-HO1): a handed-off run's line is the protocol's, by detail, and an event with no detail has one too. */
describe("run_ended handed_off in the run view", () => {
  it("words each detail with the protocol's sentence and an event with no detail with the fallback", () => {
    expect(runEndedSentence({ reason: "handed_off", detail: "pushed", size_mb: null })).toBe(HANDED_OFF_LINES.pushed);
    expect(runEndedSentence({ reason: "handed_off", detail: "push_failed", size_mb: null })).toBe(HANDED_OFF_LINES.push_failed);
    expect(runEndedSentence({ reason: "handed_off", detail: "deadline", size_mb: null })).toBe(HANDED_OFF_LINES.deadline);
    expect(runEndedSentence({ reason: "handed_off", detail: null, size_mb: null })).toBe(HANDED_OFF_FALLBACK_LINE);
  });

  it("replaces the plain line of a handed-off event, and never reads \"The run ended\"", () => {
    const [line] = withRunnerWords([{ at: "2026-10-11T00:00:00.000Z", text: "Handing the work over to the other side", ended: { reason: "handed_off", detail: null, size_mb: null } }]);
    expect(line!.text).toBe(HANDED_OFF_FALLBACK_LINE);
    expect(line!.text).not.toMatch(/The run ended/);
  });
});
