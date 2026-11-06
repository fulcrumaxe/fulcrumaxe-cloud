import { describe, expect, it } from "vitest";
import { UNTRUSTED_DELIMITER_END, UNTRUSTED_DELIMITER_START } from "@fx/trust";
import { agentOutputBlock } from "../../src/plan/envelope.js";
import { assembleFixNotePrompt, assembleSeatPrompt, seatPrompt } from "../../src/build/continuation.js";
import { SAME_SIDE_NOTES_SENTENCE, SAME_SIDE_NO_NOTES_SENTENCE, buildFixPrompt, type FixPromptInput } from "../../src/review/reviewPrompts.js";

/**
 * D#600 CX-7: the note a fresh fix session is given is at most 4 KiB INSIDE the fence (the assembler folds text to NFKC, which can make a character many times longer, so the cap
 * has to come after the fold), through the helper the seat's checkpoint note shares; and the same-side prompt promises notes only when there are some.
 */
const PROMPT = ["You are the executor.", ...agentOutputBlock("{}")].join("\n");
/** U+FDFA is 3 bytes and folds to 33. */
const EXPANDING = "ﷺ";

/** The bytes between the first fence pair of a prompt. */
function fenced(prompt: string): string {
  const from = prompt.indexOf(UNTRUSTED_DELIMITER_START);
  const to = prompt.indexOf(UNTRUSTED_DELIMITER_END, from);
  if (from < 0 || to < 0) throw new Error("no fence in the prompt");
  return prompt.slice(from + UNTRUSTED_DELIMITER_START.length, to);
}
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

describe("the note is capped after the Unicode fold", () => {
  const big = EXPANDING.repeat(1400); // 4200 bytes before the fold, about 46 KB after

  it("an expanding fix-round note stays within 4 KiB inside the fence", () => {
    const out = assembleFixNotePrompt(PROMPT, big);
    expect(bytes(fenced(out.prompt))).toBeLessThanOrEqual(4096 + 2);
    expect(out.prompt.trimEnd().endsWith("<!-- /AGENT_OUTPUT -->")).toBe(true);
    expect(out.prompt.indexOf(UNTRUSTED_DELIMITER_START)).toBeLessThan(out.prompt.indexOf("<!-- AGENT_OUTPUT -->"));
  });

  it("the seat's checkpoint note, which shares the helper, is held to the same bound", () => {
    expect(bytes(fenced(assembleSeatPrompt(PROMPT, big).prompt))).toBeLessThanOrEqual(4096 + 2);
    expect(bytes(fenced(seatPrompt(PROMPT, big)))).toBeLessThanOrEqual(4096 + 2);
  });

  it("a plain long note is cut to 4 KiB as before, and a short one is kept whole", () => {
    expect(bytes(fenced(assembleFixNotePrompt(PROMPT, "x".repeat(10_000)).prompt))).toBeLessThanOrEqual(4096 + 2);
    expect(fenced(assembleFixNotePrompt(PROMPT, "I stopped after the parser.").prompt)).toContain("I stopped after the parser.");
    expect(fenced(assembleSeatPrompt(PROMPT, "halfway").prompt)).toContain("halfway");
  });

  it("the cut note is the start of the folded text, not a mid-character piece", () => {
    const text = fenced(assembleFixNotePrompt(PROMPT, big).prompt);
    expect(text).not.toContain("�");
    expect(text.trim().length).toBeGreaterThan(1000);
  });
});

const FIX: FixPromptInput = { owner: "acme", name: "widgets", issue: 7, pr: 41, headSha: "a".repeat(40), branch: "fx/issue-7", version: 1, spec: "s", findings: [{ role: "code-reviewer", verdict: "needs-fix", findings: ["a.ts:1 - bad"], summary: "x" }] };

describe("the same-side prompt promises notes only when there are some", () => {
  const same = buildFixPrompt(FIX);

  it("builds with the promise, and a note leaves it as it is", () => {
    expect(same).toContain(SAME_SIDE_NOTES_SENTENCE);
    const out = assembleFixNotePrompt(same, "left off in src/a.ts");
    expect(out.prompt).toContain(SAME_SIDE_NOTES_SENTENCE);
    expect(out.prompt).not.toContain(SAME_SIDE_NO_NOTES_SENTENCE);
  });

  it.each([["no note", undefined], ["an empty note", ""], ["blanks", "  \n "], ["only zero-width and control characters", "​‮\u0007"]])("%s: the prompt says there are none, adds no fence, and keeps the rest", (_n, note) => {
    const out = assembleFixNotePrompt(same, note);
    expect(out.prompt).toContain(SAME_SIDE_NO_NOTES_SENTENCE);
    expect(out.prompt).not.toContain(SAME_SIDE_NOTES_SENTENCE);
    expect(out.prompt).not.toContain("Your earlier session on this work has ended");
    expect(out.prompt).toContain("Bring your checkout to the pull request's branch");
    expect(out.sections.map((s) => s.code)).not.toContain("note");
  });

  it("the cross-side prompt, which never made the promise, is not touched", () => {
    const cross = buildFixPrompt({ ...FIX, crossSide: true, branch: "fx/run-abc" });
    expect(cross).not.toContain(SAME_SIDE_NOTES_SENTENCE);
    expect(assembleFixNotePrompt(cross, undefined).prompt).toBe(cross);
  });
});
