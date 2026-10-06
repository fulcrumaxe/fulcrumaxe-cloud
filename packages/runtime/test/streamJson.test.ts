import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isKnownStreamJsonType, isMalformedAssistant, normalizeMessage } from "../src/streamJson.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

describe("streamJson (EV-MAP)", () => {
  it("imports no SDK: its source names no @anthropic-ai module", () => {
    const src = readFileSync(path.join(dir, "..", "src", "streamJson.ts"), "utf8");
    expect(src).not.toMatch(/@anthropic-ai/);
    expect(src).not.toMatch(/from "\.\/local/);
  });

  it("maps a result with is_error onto an error event and takes identity from the caller", () => {
    const event = normalizeMessage(
      { runId: "run-A", role: "reviewer" },
      { type: "result", is_error: true, runId: "run-B", role: "executor", seq: -4, result: "boom" },
      7,
    );
    expect(event).toMatchObject({ type: "error", isError: true, runId: "run-A", role: "reviewer", seq: 7, text: "boom" });
  });

  it("knows the four stream-json types and nothing else", () => {
    for (const type of ["system", "assistant", "user", "result"]) expect(isKnownStreamJsonType({ type })).toBe(true);
    for (const type of ["error", "stream_event", 7, undefined]) expect(isKnownStreamJsonType({ type })).toBe(false);
  });

  it("the fixture .jsonl is parseable, one JSON object per line", () => {
    const lines = readFileSync(path.join(dir, "fixtures", "stream-json-run.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(JSON.parse(line)).toBeTypeOf("object");
  });
});

describe("streamJson assistant messages (H14c-5b-1: 1-a, MP-MSG)", () => {
  const opts = { runId: "run-A", role: "reviewer" };
  const line = (message: unknown) => ({ type: "assistant", message });

  it("keeps message.id and usage on an assistant event, and has neither when the line has none", () => {
    const usage = { input_tokens: 7, output_tokens: 3 };
    const event = normalizeMessage(opts, line({ id: "msg_1", content: [{ type: "text", text: "hi" }], usage }), 0);
    expect(event).toMatchObject({ type: "assistant", text: "hi", messageId: "msg_1", usage: { inputTokens: 7, outputTokens: 3 } });
    expect(normalizeMessage(opts, line({ content: [] }), 1)).toMatchObject({ messageId: undefined, usage: undefined });
  });

  it.each([
    ["content is a string", { content: "hello" }],
    ["content is an object", { content: { type: "text", text: "x" } }],
    ["a block is null", { content: [null] }],
    ["a block is a string", { content: [{ type: "text", text: "x" }, "y"] }],
    ["message is a string", "oops"],
  ])("never throws when %s, and flags the line malformed", (_label, message) => {
    expect(() => normalizeMessage(opts, line(message), 0)).not.toThrow();
    expect(isMalformedAssistant(line(message))).toBe(true);
  });

  it("flags usage without a usable id, and only that, as malformed", () => {
    const usage = { input_tokens: 1 };
    for (const id of [undefined, "", 7, "x".repeat(201)]) expect(isMalformedAssistant(line({ id, content: [], usage }))).toBe(true);
    expect(isMalformedAssistant(line({ id: "msg_1", content: [], usage }))).toBe(false);
    expect(isMalformedAssistant(line({ content: [{ type: "text", text: "no usage" }] }))).toBe(false);
    expect(isMalformedAssistant({ type: "assistant" })).toBe(false);
  });
});

describe("streamJson message.model (H14c-5b-2b, C56 point 2)", () => {
  const opts = { runId: "run-A", role: "reviewer" };
  const model = (value: unknown) => normalizeMessage(opts, { type: "assistant", message: { id: "m", content: [], model: value } }, 0).messageModel;

  it("keeps a non-empty string of at most 128 characters", () => {
    expect(model("claude-opus-5")).toBe("claude-opus-5");
    expect(model("x".repeat(128))).toBe("x".repeat(128));
  });

  it.each([["empty", ""], ["too long", "x".repeat(129)], ["a number", 5], ["an object", { a: 1 }], ["missing", undefined]])(
    "omits it when it is %s, leaving the rest of the event unchanged",
    (_label, value) => {
      const event = normalizeMessage(opts, { type: "assistant", message: { id: "m", content: [{ type: "text", text: "hi" }], model: value } }, 0);
      expect(event.messageModel).toBeUndefined();
      expect(event).toMatchObject({ type: "assistant", text: "hi", messageId: "m" });
    },
  );
});
