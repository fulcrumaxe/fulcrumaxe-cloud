import { describe, expect, it } from "vitest";
import { CONTEXT_MAX_COUNT, ContextLedgerCapture, NOT_RECORDED_MEASURE, contextLedgerFromWire, contextLedgerToWire } from "../src/contextLedger.js";
import { ContextLedgerBody, DoneMessage } from "../src/messages.js";

/** D#600 CX-1b, acceptance 1: the `done.context_ledger` schema is strict, closed and free of text; the CX-1a follow-ups on the capture. */
const RUN = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(64);
const ok = {
  basis: "measured",
  sections: [{ code: "spec", bytes: 10, sha256: sha, trimmed_bytes: 0 }],
  first_turn_input: 5,
  peak_context: 9,
  cache_read: 3,
  cache_write: 2,
  memory: 1,
  tool_output_bytes: { Read: 4, other: 1 },
  compactions: 1,
};

describe("ContextLedgerBody", () => {
  it("D#600 CX-4a: a section may carry one trimmed_reason from the closed list and nothing else; pinned is a known code", () => {
    for (const reason of ["findings_cap", "memory_slot", "over_budget"]) expect(ContextLedgerBody.safeParse({ ...ok, sections: [{ ...ok.sections[0], trimmed_reason: reason }, { ...ok.sections[0], code: "pinned" }] }).success, reason).toBe(true);
    for (const bad of ["too_big", "", 3, null, "OVER_BUDGET"]) expect(ContextLedgerBody.safeParse({ ...ok, sections: [{ ...ok.sections[0], trimmed_reason: bad }] }).success, String(bad)).toBe(false);
  });

  it("accepts a full ledger and a partial one with nothing measured", () => {
    expect(ContextLedgerBody.safeParse(ok).success).toBe(true);
    expect(ContextLedgerBody.safeParse({ basis: "partial", sections: [], tool_output_bytes: {}, compactions: 0 }).success).toBe(true);
  });

  it.each([
    ["a key outside the schema", { ...ok, note: "hello" }],
    ["a free-text field", { ...ok, path: "/home/me/secret.txt" }],
    ["an unknown section code", { ...ok, sections: [{ ...ok.sections[0], code: "secrets" }] }],
    ["a section with a free-text key", { ...ok, sections: [{ ...ok.sections[0], text: "x" }] }],
    ["a section digest that is not 64 hex characters", { ...ok, sections: [{ ...ok.sections[0], sha256: "/etc/passwd" }] }],
    ["a tool outside the enum", { ...ok, tool_output_bytes: { "/etc/passwd": 3 } }],
    ["a string where an integer goes", { ...ok, peak_context: "9" }],
    ["a negative count", { ...ok, compactions: -1 }],
    ["a count past the cap", { ...ok, cache_read: CONTEXT_MAX_COUNT + 1 }],
    ["a fractional count", { ...ok, first_turn_input: 1.5 }],
    ["a measured ledger with no peak", { ...ok, peak_context: undefined }],
    ["a peak below the first turn", { ...ok, peak_context: 4 }],
    ["more than 64 sections", { ...ok, sections: Array.from({ length: 65 }, () => ok.sections[0]) }],
    ["a basis outside the enum", { ...ok, basis: "exact" }],
  ])("refuses %s", (_name, body) => {
    expect(ContextLedgerBody.safeParse(body).success).toBe(false);
    expect(DoneMessage.safeParse({ run_id: RUN, lease_generation: 1, context_ledger: body }).success).toBe(false);
  });

  it("a done with no context_ledger (an older runner) still parses, and the field is the only addition", () => {
    expect(DoneMessage.safeParse({ run_id: RUN, lease_generation: 1 }).success).toBe(true);
    expect(DoneMessage.safeParse({ run_id: RUN, lease_generation: 1, context_ledger: ok }).success).toBe(true);
  });

  it("every string a valid ledger can hold is an enum member or a 64-character digest", () => {
    const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : v !== null && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
    const parsed = ContextLedgerBody.parse(ok);
    for (const s of strings(parsed)) expect(s === "measured" || s === "spec" || s === sha).toBe(true);
  });
});

describe("the wire mapping", () => {
  it("a measure maps to a wire body the schema accepts and back to the same measure; a figure not measured is absent, never 0", () => {
    const c = new ContextLedgerCapture();
    c.observe({ type: "assistant", message: { id: "m", content: [], usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } });
    const measure = c.snapshot();
    const wire = contextLedgerToWire(measure);
    expect(ContextLedgerBody.safeParse(wire).success).toBe(true);
    expect(contextLedgerFromWire(wire).measure).toEqual(measure);
    const none = contextLedgerToWire(NOT_RECORDED_MEASURE);
    expect(ContextLedgerBody.safeParse(none).success).toBe(true);
    expect(Object.keys(none)).not.toContain("peak_context");
    expect(contextLedgerFromWire(none).measure).toEqual(NOT_RECORDED_MEASURE);
  });

  it("D#600 CX-5b: the count of refused calls is a sandbox figure. It is not on the wire (no wire change), and a body that sends one is refused", () => {
    const wire = contextLedgerToWire({ ...NOT_RECORDED_MEASURE, denied_tool_calls: 3 });
    expect(Object.keys(wire)).not.toContain("denied_tool_calls");
    expect(ContextLedgerBody.safeParse({ ...wire, denied_tool_calls: 3 }).success).toBe(false);
    expect(Object.keys(contextLedgerFromWire(wire).measure)).not.toContain("denied_tool_calls");
  });
});

describe("ContextLedgerCapture follow-ups from the CX-1a review", () => {
  const usage = (input: number, write: number, read: number) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read });
  const turn = (id: string, u: ReturnType<typeof usage>, extra: Record<string, unknown> = {}) => ({ type: "assistant", message: { id, content: [], usage: u }, ...extra });

  it("three fields each at the cap sum past it: the turn is clamped, the run stays measured, and the figure fits the store's range", () => {
    const c = new ContextLedgerCapture();
    c.observe(turn("m", usage(CONTEXT_MAX_COUNT, CONTEXT_MAX_COUNT, CONTEXT_MAX_COUNT)));
    const m = c.snapshot();
    expect(m.basis).toBe("measured");
    expect(m.first_turn_input_tokens).toBe(CONTEXT_MAX_COUNT);
    expect(m.peak_context_tokens).toBe(CONTEXT_MAX_COUNT);
    expect(ContextLedgerBody.safeParse(contextLedgerToWire(m)).success).toBe(true);
  });

  it("a subagent turn (parent_tool_use_id) is left out of the first turn and the peak, but its cache figures are still summed", () => {
    const c = new ContextLedgerCapture();
    c.observe(turn("sub0", usage(1, 1, 500000), { parent_tool_use_id: "toolu_task" }));
    c.observe(turn("main1", usage(10, 20, 30)));
    c.observe(turn("sub1", usage(1, 1, 900000), { parent_tool_use_id: "toolu_task" }));
    c.observe(turn("main2", usage(5, 5, 100)));
    const m = c.snapshot();
    expect(m.first_turn_input_tokens).toBe(60);
    expect(m.peak_context_tokens).toBe(110);
    expect(m.cache_read_tokens).toBe(500000 + 30 + 900000 + 100);
    expect(m.cache_write_tokens).toBe(1 + 20 + 1 + 5);
  });

  it("a run with only subagent usage has no main-thread figures: partial, not a subagent's numbers", () => {
    const c = new ContextLedgerCapture();
    c.observe(turn("sub", usage(1, 1, 5), { parent_tool_use_id: "toolu_task" }));
    expect(c.snapshot()).toMatchObject({ basis: "partial", first_turn_input_tokens: null, peak_context_tokens: null });
  });
});
