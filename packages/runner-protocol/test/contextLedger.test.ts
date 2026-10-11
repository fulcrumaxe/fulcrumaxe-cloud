import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTEXT_SECTION_CODES, CONTEXT_TOOL_ENUM, ContextLedgerCapture, mergeContextLedgerMeasures } from "../src/contextLedger.js";

/**
 * D#600 CX-1a, acceptance 1 and 2: the capture's figures from stream-json.
 *
 * `context-ledger.recorded.jsonl` is a stream captured from the real CLI (2.1.289, redacted: every message id reads the same, so it is
 * one turn). The multi-turn and compact_boundary streams below are composed in that recorded line shape (the same usage keys); a
 * long enough real run to record a compaction is the gated live test in packages/runner (`contextLedger.live.test.ts`).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const recorded = readFileSync(path.join(here, "fixtures/context-ledger.recorded.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l !== "")
  .map((l) => JSON.parse(l) as unknown);

const usage = (input: number, write: number, read: number, output = 5) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output });
const assistant = (id: string, u: ReturnType<typeof usage>, ...blocks: unknown[]) => ({ type: "assistant", message: { id, role: "assistant", content: blocks, usage: u } });
const toolUse = (id: string, name: string) => ({ type: "tool_use", id, name, input: { file_path: "/work/SECRET-PATH.txt" } });
const toolResult = (id: string, content: unknown) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });
const measure = (lines: unknown[]) => {
  const c = new ContextLedgerCapture();
  for (const l of lines) c.observe(l);
  return c.snapshot();
};

describe("ContextLedgerCapture", () => {
  it("the recorded CLI stream: first turn and peak are input + cache read + cache write, counted once for the repeated message id", () => {
    const m = measure(recorded);
    expect(m).toEqual({
      basis: "measured",
      first_turn_input_tokens: 9 + 4875 + 7622,
      peak_context_tokens: 9 + 4875 + 7622,
      cache_read_tokens: 7622,
      cache_write_tokens: 4875,
      tool_output_bytes: {},
      compactions: 0,
    });
  });

  it("peak is the largest per-turn sum and first is the first turn's sum, over several turns whose blocks repeat the usage", () => {
    const m = measure([
      { type: "system", subtype: "init", session_id: "s" },
      assistant("msg_1", usage(9, 4875, 7622, 4), { type: "thinking", thinking: "" }),
      assistant("msg_1", usage(9, 4875, 7622, 60), toolUse("toolu_1", "Read")),
      toolResult("toolu_1", "a".repeat(2000)),
      assistant("msg_2", usage(3, 2100, 12506), toolUse("toolu_2", "Bash")),
      toolResult("toolu_2", [{ type: "text", text: "é".repeat(100) }]),
      assistant("msg_3", usage(2, 9000, 14609), { type: "text", text: "done" }),
      assistant("msg_4", usage(5, 300, 1000), { type: "text", text: "after" }),
    ]);
    expect(m.basis).toBe("measured");
    expect(m.first_turn_input_tokens).toBe(12506);
    expect(m.peak_context_tokens).toBe(2 + 9000 + 14609);
    expect(m.cache_read_tokens).toBe(7622 + 12506 + 14609 + 1000);
    expect(m.cache_write_tokens).toBe(4875 + 2100 + 9000 + 300);
    expect(m.tool_output_bytes).toEqual({ Read: 2000, Bash: 200 });
  });

  it("a tool result whose call was never seen, or whose tool is not in the enum, counts under other", () => {
    const m = measure([assistant("m", usage(1, 0, 0), toolUse("t1", "mcp__evil__tool")), toolResult("t1", "abc"), toolResult("ghost", "defg"), toolResult("t1", 42)]);
    expect(m.tool_output_bytes).toEqual({ other: 7 });
  });

  it("one compact_boundary event gives compactions = 1, two give 2, and other system events give 0", () => {
    const boundary = { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 150000 } };
    expect(measure([assistant("m", usage(1, 0, 0)), boundary]).compactions).toBe(1);
    expect(measure([boundary, assistant("m", usage(1, 0, 0)), boundary]).compactions).toBe(2);
    expect(measure([{ type: "system", subtype: "init" }, { type: "system", subtype: "status" }]).compactions).toBe(0);
  });

  it("a stream with no usage is partial with null figures, never zeros", () => {
    const m = measure([{ type: "system", subtype: "init" }, assistant("m", undefined as never, { type: "text", text: "x" }), { type: "result", subtype: "success" }]);
    expect(m).toEqual({ basis: "partial", first_turn_input_tokens: null, peak_context_tokens: null, cache_read_tokens: null, cache_write_tokens: null, tool_output_bytes: {}, compactions: 0 });
  });

  it("hostile lines are ignored: wrong types, negative, fractional or out-of-range numbers, missing or oversize ids, huge arrays", () => {
    const m = measure([
      null,
      "text",
      [],
      { type: "assistant", message: "no" },
      assistant("a", usage(-1, 0, 0)),
      assistant("b", usage(1.5, 0, 0)),
      assistant("c", usage(2e12, 0, 0)),
      assistant("", usage(1, 0, 0)),
      assistant("x".repeat(500), usage(1, 0, 0)),
      { type: "assistant", message: { id: "d", content: "not-an-array", usage: usage(7, 0, 0) } },
      { type: "user", message: { content: "not-an-array" } },
      { type: "user", message: { content: Array.from({ length: 1000 }, () => ({ type: "tool_result", tool_use_id: "q", content: "zz" })) } },
    ]);
    expect(m.basis).toBe("measured");
    expect(m.first_turn_input_tokens).toBe(7);
    expect(m.peak_context_tokens).toBe(7);
    expect(m.tool_output_bytes).toEqual({ other: 128 });
  });

  it("keeps integers only: no text, path, tool input or id from the stream appears in the measure", () => {
    const m = measure([
      assistant("msg_SECRET_ID", usage(1, 2, 3), toolUse("toolu_SECRET_ID", "Read"), { type: "text", text: "sk-ant-api03-PLANTED" }),
      toolResult("toolu_SECRET_ID", "PLANTED-TOOL-OUTPUT /work/SECRET-PATH.txt"),
    ]);
    const json = JSON.stringify(m);
    for (const needle of ["SECRET", "PLANTED", "/work", "sk-ant"]) expect(json).not.toContain(needle);
    expect(Object.keys(m.tool_output_bytes).every((k) => (CONTEXT_TOOL_ENUM as readonly string[]).includes(k))).toBe(true);
  });

  it("the closed vocabularies are exactly the Spec's", () => {
    expect([...CONTEXT_SECTION_CODES]).toEqual(["card", "boundary", "map", "memory_stable", "memory_item", "spec", "note", "corrections", "findings", "output", "repo_instructions"]);
  });
});

describe("mergeContextLedgerMeasures", () => {
  const a = measure([assistant("m1", usage(1, 10, 100), toolUse("t", "Read")), toolResult("t", "abcd")]);
  const b = measure([assistant("m2", usage(2, 20, 300), toolUse("t", "Read")), toolResult("t", "xy"), { type: "system", subtype: "compact_boundary" }]);

  it("keeps the first turn, takes the larger peak, adds the sums and merges tool bytes", () => {
    expect(mergeContextLedgerMeasures(a, b)).toEqual({
      basis: "measured",
      first_turn_input_tokens: 111,
      peak_context_tokens: 322,
      cache_read_tokens: 400,
      cache_write_tokens: 30,
      tool_output_bytes: { Read: 6 },
      compactions: 1,
    });
  });

  it("a partial part makes the whole partial but keeps the figures that were measured", () => {
    const partial = measure([]);
    const merged = mergeContextLedgerMeasures(a, partial);
    expect(merged.basis).toBe("partial");
    expect(merged.peak_context_tokens).toBe(111);
    expect(mergeContextLedgerMeasures(undefined, b)).toBe(b);
  });
});
