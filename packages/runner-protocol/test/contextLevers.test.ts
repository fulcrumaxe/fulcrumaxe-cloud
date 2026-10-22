import { describe, expect, it } from "vitest";
import { BASH_MAX_OUTPUT_LENGTH, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, CONTEXT_LEVER_ENV, CONTEXT_WARNING_CODE, CONTEXT_WARNING_TEXT, CONTEXT_WARN_PCT, contextNoteLine, contextPct } from "../src/contextLevers.js";
import { ContextLedgerCapture } from "../src/contextLedger.js";

describe("D#600 CX-6a: context levers", () => {
  it("the constants are the owner's: 30000, 85, and the warning starts at 70", () => {
    expect(BASH_MAX_OUTPUT_LENGTH).toBe(30000);
    expect(CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe(85);
    expect(CONTEXT_WARN_PCT).toBe(70);
    expect(CONTEXT_LEVER_ENV).toEqual({ BASH_MAX_OUTPUT_LENGTH: "30000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "85" });
    expect(Object.isFrozen(CONTEXT_LEVER_ENV)).toBe(true);
  });

  it("contextPct rounds down, caps at 100, and refuses anything that is not a count over a positive window", () => {
    expect(contextPct(140_000, 200_000)).toBe(70);
    expect(contextPct(139_999, 200_000)).toBe(69);
    expect(contextPct(0, 200_000)).toBe(0);
    expect(contextPct(200_000, 200_000)).toBe(100);
    expect(contextPct(9_000_000, 200_000)).toBe(100);
    for (const [t, w] of [[-1, 200_000], [1.5, 200_000], [Number.NaN, 200_000], [Infinity, 200_000], [10, 0], [10, -5], [10, Number.NaN], [10, 0.5]] as const) {
      expect(contextPct(t, w), `${t}/${w}`).toBeUndefined();
    }
  });
});

describe("D#600 CX-6a: ContextLedgerCapture.lastContextTokens", () => {
  const turn = (id: string, input: number, read: number, write: number, parent?: string) => ({
    type: "assistant",
    ...(parent === undefined ? {} : { parent_tool_use_id: parent }),
    message: { id, content: [], usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write } },
  });

  it("is 0 before any turn, then the latest main-thread turn's input + cache read + cache write (not the peak), ignoring a subagent's turn", () => {
    const c = new ContextLedgerCapture();
    expect(c.lastContextTokens()).toBe(0);
    c.observe(turn("m1", 10, 20, 30));
    expect(c.lastContextTokens()).toBe(60);
    c.observe(turn("m2", 100, 1_000, 0));
    expect(c.lastContextTokens()).toBe(1_100);
    c.observe(turn("s1", 50_000, 0, 0, "toolu_1"));
    expect(c.lastContextTokens()).toBe(1_100);
    c.observe(turn("m3", 5, 5, 5)); // a compaction: the context falls, the peak does not
    expect(c.lastContextTokens()).toBe(15);
    expect(c.snapshot().peak_context_tokens).toBe(1_100);
  });

  it("a malformed line changes nothing", () => {
    const c = new ContextLedgerCapture();
    c.observe(turn("m1", 7, 0, 0));
    c.observe({ type: "assistant", message: { id: "m2", usage: { input_tokens: "x" } } });
    c.observe("junk");
    expect(c.lastContextTokens()).toBe(7);
  });

  it("D#600 CX-6b: the context note is the warning text with one whole number, closed by a full stop, and holds nothing the hook's shell script could not print", () => {
    expect(CONTEXT_WARNING_CODE).toBe("context_warning");
    expect(contextNoteLine(72)).toBe("Context is at 72% of the window: finish, or end with a checkpoint envelope.");
    expect(contextNoteLine(100)).toContain("100%");
    expect(CONTEXT_WARNING_TEXT).not.toMatch(/["'\\$`]/);
  });
});
