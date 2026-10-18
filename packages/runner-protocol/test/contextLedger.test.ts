import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTEXT_SECTION_CODES, CONTEXT_TOOL_ENUM, CONTEXT_TRIMMED_REASONS, ContextLedgerCapture, mergeContextLedgerMeasures, type ContextTool } from "../src/contextLedger.js";

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
    expect([...CONTEXT_SECTION_CODES]).toEqual(["card", "boundary", "map", "memory_stable", "memory_item", "spec", "note", "corrections", "findings", "output", "repo_instructions", "pinned"]);
    expect([...CONTEXT_TRIMMED_REASONS]).toEqual(["findings_cap", "memory_slot", "over_budget", "pin_missing", "pins_over_budget", "pin_too_large", "pin_excluded"]);
  });
});

/** D#600 CX-5b: the count of tool calls the CLI refused for a permission rule. The recorded shape of a refusal is in the opt-in live test (contextLedger.live.test.ts). */
describe("ContextLedgerCapture denied tool calls", () => {
  const errorResult = (id: string, text: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] } });
  const denied = (lines: unknown[]) => {
    const c = new ContextLedgerCapture();
    for (const l of lines) c.observe(l);
    return c.deniedToolCalls();
  };

  it("a stream with no refusal counts 0", () => {
    expect(denied([assistant("m", usage(1, 0, 0), toolUse("t1", "Read")), toolResult("t1", "file text")])).toBe(0);
    expect(denied([])).toBe(0);
  });

  it("a Read, Grep, Glob or LS result that is an error saying the call was denied counts once each", () => {
    expect(
      denied([
        assistant("m", usage(1, 0, 0), toolUse("t1", "Read"), toolUse("t2", "Grep"), toolUse("t3", "Glob"), toolUse("t4", "LS")),
        errorResult("t1", "Permission to use Read has been denied."),
        errorResult("t2", "Permission to use Grep has been denied because Claude Code is running in don't ask mode."),
        errorResult("t3", "File is in a directory that is denied by your permission settings."),
        errorResult("t4", "Claude requested permissions to use LS, but you haven't granted it yet."),
      ]),
    ).toBe(4);
  });

  it("a filesystem or shell error that merely says permission denied is not a refusal by a rule, and neither is an error from another tool", () => {
    expect(
      denied([
        assistant("m", usage(1, 0, 0), toolUse("t1", "Read"), toolUse("t2", "Bash")),
        errorResult("t1", "EACCES: permission denied, open '/work/x'"),
        errorResult("t2", "Permission to use Bash has been denied."),
      ]),
    ).toBe(0);
  });

  it("an ordinary result that quotes the words is not an error, so it is not counted", () => {
    expect(denied([assistant("m", usage(1, 0, 0), toolUse("t1", "Read")), toolResult("t1", "the docs say Permission to use Read has been denied")])).toBe(0);
  });

  it("the final result's permission_denials count too, and a call seen both ways counts once", () => {
    expect(
      denied([
        assistant("m", usage(1, 0, 0), toolUse("t1", "Read"), toolUse("t2", "Read")),
        errorResult("t1", "Permission to use Read has been denied."),
        { type: "result", subtype: "success", permission_denials: [{ tool_name: "Read", tool_use_id: "t1", tool_input: { file_path: "/work/SECRET-PATH.txt" } }, { tool_name: "Read", tool_use_id: "t2", tool_input: {} }] },
      ]),
    ).toBe(2);
  });

  it("with no excludes, refusals of WebFetch, WebSearch, Task and Bash count 0 on both paths (the tool result and the final permission_denials)", () => {
    const tools = ["WebFetch", "WebSearch", "Task", "Bash"];
    const lines: unknown[] = [assistant("m", usage(1, 0, 0), ...tools.map((t, i) => toolUse(`u${i}`, t)))];
    tools.forEach((t, i) => lines.push(errorResult(`u${i}`, `Permission to use ${t} has been denied because Claude Code is running in don't ask mode.`)));
    lines.push({ type: "result", permission_denials: tools.map((t, i) => ({ tool_name: t, tool_use_id: `u${i}`, tool_input: {} })) });
    expect(denied(lines)).toBe(0);
  });

  it("only the file tools count from permission_denials: WebFetch, Bash and Task refusals under dontAsk are not exclude refusals", () => {
    const entry = (tool_name: string, tool_use_id: string) => ({ tool_name, tool_use_id, tool_input: {} });
    expect(denied([{ type: "result", permission_denials: [entry("WebFetch", "a"), entry("Bash", "b"), entry("Task", "c"), entry("mcp__x__y", "d"), entry("WebSearch", "e")] }])).toBe(0);
    expect(denied([{ type: "result", permission_denials: [entry("WebFetch", "a"), entry("Read", "r"), entry("Grep", "g"), entry("Glob", "l"), entry("LS", "s"), entry("Bash", "b")] }])).toBe(4);
    expect(denied([{ type: "result", permission_denials: [{ tool_use_id: "x" }, { tool_name: 5, tool_use_id: "y" }] }])).toBe(0);
  });

  it("hostile permission_denials (wrong shapes, no id, oversize id, a huge array) are ignored or bounded", () => {
    const n = denied([
      { type: "result", permission_denials: "no" },
      { type: "result", permission_denials: [null, 3, {}, { tool_use_id: 5 }, { tool_use_id: "" }, { tool_use_id: "x".repeat(500) }] },
      { type: "result", permission_denials: Array.from({ length: 50_000 }, (_, i) => ({ tool_name: "Read", tool_use_id: `t${i}` })) },
    ]);
    expect(n).toBe(20_000);
  });

  it("keeps a number only: the planted path and id are in no snapshot field", () => {
    const c = new ContextLedgerCapture();
    for (const l of [assistant("m", usage(1, 0, 0), toolUse("toolu_SECRET_ID", "Read")), errorResult("toolu_SECRET_ID", "Permission to use Read has been denied: /work/SECRET-PATH.txt")]) c.observe(l);
    expect(JSON.stringify({ ...c.snapshot(), denied: c.deniedToolCalls() })).not.toMatch(/SECRET|\/work/);
  });

  it("the snapshot itself is unchanged, so a runner's measure (and its wire body) never carries the count", () => {
    const c = new ContextLedgerCapture();
    c.observe(errorResult("t1", "Permission to use Read has been denied."));
    expect(Object.keys(c.snapshot())).not.toContain("denied_tool_calls");
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

  it("refused calls add across commands; a measure that carries none leaves the other's figure, and two that carry none stay without one", () => {
    expect(mergeContextLedgerMeasures({ ...a, denied_tool_calls: 2 }, { ...b, denied_tool_calls: 3 }).denied_tool_calls).toBe(5);
    expect(mergeContextLedgerMeasures({ ...a, denied_tool_calls: 2 }, b).denied_tool_calls).toBe(2);
    expect(mergeContextLedgerMeasures(a, { ...b, denied_tool_calls: 0 }).denied_tool_calls).toBe(0);
    expect(Object.keys(mergeContextLedgerMeasures(a, b))).not.toContain("denied_tool_calls");
  });

  it("a partial part makes the whole partial but keeps the figures that were measured", () => {
    const partial = measure([]);
    const merged = mergeContextLedgerMeasures(a, partial);
    expect(merged.basis).toBe("partial");
    expect(merged.peak_context_tokens).toBe(111);
    expect(mergeContextLedgerMeasures(undefined, b)).toBe(b);
  });
});

/** D#600 CX-5b: the exact answers CLI 2.1.302 gave in the live run (contextRules.live.test.ts). */
describe("ContextLedgerCapture: refusals as the real CLI words them", () => {
  const errorResult = (id: string, text: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] } });
  const DIRECTORY = "<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>";
  const NO_GREP = "<tool_use_error>Error: No such tool available: Grep. Grep is not available in this session — search file contents with `grep` via the Bash tool instead.</tool_use_error>";
  const NO_GLOB = "<tool_use_error>Error: No such tool available: Glob. Glob is not available in this session — find files with `find` via the Bash tool instead.</tool_use_error>";
  const count = (disabled: ContextTool[], lines: unknown[]) => {
    const c = new ContextLedgerCapture(disabled);
    for (const l of lines) c.observe(l);
    return c.deniedToolCalls();
  };
  const calls = assistant("m", usage(1, 0, 0), toolUse("r", "Read"), toolUse("g", "Grep"), toolUse("b", "Glob"));

  it("a Read refused by a rule, and Grep and Glob answered 'No such tool available' while we disabled them, are all counted", () => {
    expect(count(["Grep", "Glob"], [calls, errorResult("r", DIRECTORY), errorResult("g", NO_GREP), errorResult("b", NO_GLOB)])).toBe(3);
  });

  it("a 'No such tool available' answer for a tool we did NOT disable is not counted", () => {
    expect(count([], [calls, errorResult("g", NO_GREP), errorResult("b", NO_GLOB)])).toBe(0);
    expect(count(["Grep"], [calls, errorResult("g", NO_GREP), errorResult("b", NO_GLOB)])).toBe(1);
  });

  it("the phrase must name the disabled tool itself: another tool's answer on a Grep call is not counted", () => {
    expect(count(["Grep", "Glob"], [calls, errorResult("g", NO_GLOB), errorResult("b", NO_GREP)])).toBe(0);
    expect(count(["Grep"], [calls, errorResult("g", "Error: No such tool available: Grepper. nope")])).toBe(0);
  });

  it("the phrase on a result that is not an error, or on a tool outside Read, Grep, Glob and LS, is not counted", () => {
    const plain = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "g", content: NO_GREP }] } };
    expect(count(["Grep"], [calls, plain])).toBe(0);
    expect(count(["Bash"], [assistant("m", usage(1, 0, 0), toolUse("x", "Bash")), errorResult("x", "No such tool available: Bash")])).toBe(0);
  });

  it("EACCES and not-found errors are not counted, with or without disabled tools", () => {
    expect(count(["Grep", "Glob"], [calls, errorResult("r", "EACCES: permission denied, open '/work/x'"), errorResult("g", "ENOENT: no such file or directory"), errorResult("b", "File does not exist.")])).toBe(0);
  });
});
