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

/** D#6 R-CHK-3d: the run's end line for a check that did not pass names the approved check and, when the caller has it, the command. */
describe("run_ended check_failed in the run view", () => {
  const ended = { reason: "check_failed", detail: null, size_mb: null };
  it("says the approved check failed, naming the command when it is known", () => {
    expect(runEndedSentence(ended, { argv: ["pnpm", "run", "check"], result: { reason: null } })).toBe("The approved check (pnpm run check) failed, so this run ended without a pull request.");
    expect(runEndedSentence(ended)).toBe("The approved check failed, so this run ended without a pull request.");
  });
  it("says it could not run safely when the recorded result has a reason, and that the dev shell was missing for that detail", () => {
    expect(runEndedSentence(ended, { argv: ["pnpm", "run", "check"], result: { reason: "pin_failed" } })).toContain("could not run safely");
    expect(runEndedSentence({ ...ended, detail: "check_no_dev_shell" }, { argv: ["make"] })).toContain("needs the repository's dev shell");
    // The work item's activity has the reason but not the command: the sentence still reads "could not run safely", with no command named.
    expect(runEndedSentence(ended, { result: { reason: "protected_changed" } })).toBe("The approved check could not run safely, so this run ended without a pull request.");
    expect(runEndedSentence(ended, { result: { reason: null } })).toBe("The approved check failed, so this run ended without a pull request.");
  });
  it("shows the command as one plain line: control characters become spaces and a long command is cut", () => {
    const text = runEndedSentence(ended, { argv: ["sh", "-c", "a\nb\u0000c", "x".repeat(200)] })!;
    expect(text).not.toMatch(/[\u0000-\u001f]/);
    expect(text).toContain("a b c");
    expect(text).toContain("...");
    expect(text.length).toBeLessThan(200);
  });
  it("replaces the plain line of the event in withRunnerWords, and never reads \"The run ended\"", () => {
    const [line] = withRunnerWords([{ at: "2026-10-22T00:00:00.000Z", text: "The run ended", ended }], { argv: ["make", "check"] });
    expect(line!.text).toBe("The approved check (make check) failed, so this run ended without a pull request.");
  });
});
