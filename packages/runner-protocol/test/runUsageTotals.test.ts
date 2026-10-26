import { describe, expect, it } from "vitest";
import { createUsageMeter, normalizeMessage, resultUsageOf } from "../src/index.js";

/**
 * A multi-turn, two-model Claude Code stream in the shape the installed CLI prints (field names as in the recorded
 * stream.subscription fixture: usage.input_tokens / cache_creation_input_tokens / cache_read_input_tokens / output_tokens, and the
 * result line's modelUsage with inputTokens / outputTokens / cacheReadInputTokens / cacheCreationInputTokens / costUSD). Counts are invented.
 * The result line's top-level `usage` describes the LAST turn only, which is what a multi-turn session prints.
 */
const assistant = (id: string, model: string, u: { i: number; o: number; r: number; w: number }, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  ...extra,
  message: { id, model, role: "assistant", content: [{ type: "text", text: "x" }], usage: { input_tokens: u.i, cache_creation_input_tokens: u.w, cache_read_input_tokens: u.r, output_tokens: u.o } },
});

const STREAM = [
  assistant("msg_1", "claude-sonnet-5-5", { i: 5, o: 400, r: 20_000, w: 30_000 }),
  // The same message repeated while it streams: counted once.
  assistant("msg_1", "claude-sonnet-5-5", { i: 5, o: 900, r: 20_000, w: 30_000 }),
  assistant("msg_2", "claude-sonnet-5-5", { i: 3, o: 1_200, r: 50_000, w: 2_000 }),
  // A subagent turn on another model.
  assistant("msg_3", "claude-haiku-4-5-20251001", { i: 9, o: 300, r: 7_000, w: 1_000 }, { parent_tool_use_id: "toolu_1" }),
  assistant("msg_4", "claude-sonnet-5-5", { i: 329, o: 2_000, r: 90_000, w: 500 }),
];

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.5,
  num_turns: 4,
  usage: { input_tokens: 329, cache_creation_input_tokens: 500, cache_read_input_tokens: 90_000, output_tokens: 2_000 },
  modelUsage: {
    "claude-sonnet-5-5": { inputTokens: 337, outputTokens: 4_100, cacheReadInputTokens: 160_000, cacheCreationInputTokens: 32_500, costUSD: 0.4 },
    "claude-haiku-4-5-20251001": { inputTokens: 9, outputTokens: 300, cacheReadInputTokens: 7_000, cacheCreationInputTokens: 1_000, costUSD: 0.1 },
  },
};

const ctx = { runId: "r", role: "executor" } as const;

describe("a run's token total", () => {
  it("counts every assistant message once, all token classes, subagent models included", () => {
    const meter = createUsageMeter();
    STREAM.forEach((m, i) => meter.observe(normalizeMessage(ctx, m, i)));
    expect(meter.total()).toEqual({ inputTokens: 346, outputTokens: 4_400, cacheWriteTokens: 33_500, cacheReadTokens: 167_000 });
  });

  it("takes the result line's per-model totals over its last-turn usage, never lowering a figure", () => {
    expect(resultUsageOf(RESULT)).toEqual({ input_tokens: 346, output_tokens: 4_400, cache_creation_input_tokens: 33_500, cache_read_input_tokens: 167_000 });
    // No modelUsage: the top-level figure is all there is.
    expect(resultUsageOf({ usage: RESULT.usage })).toEqual(RESULT.usage);
    // A modelUsage smaller than the top-level figure does not lower it.
    expect(resultUsageOf({ usage: RESULT.usage, modelUsage: { m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1 } } })).toEqual(RESULT.usage);
  });

  it("the final total carries the cache classes and is not the last turn's", () => {
    const meter = createUsageMeter();
    STREAM.forEach((m, i) => meter.observe(normalizeMessage(ctx, m, i)));
    meter.observe(normalizeMessage(ctx, RESULT, 9));
    const t = meter.total();
    expect(t.cacheReadTokens).toBe(167_000);
    expect(t.cacheWriteTokens).toBe(33_500);
    expect(t.inputTokens).toBe(346);
    expect(t.outputTokens).toBe(4_400);
    // The last turn alone would have been 329 in / 2,000 out / 90,000 read.
    expect(t.cacheReadTokens).toBeGreaterThan(RESULT.usage.cache_read_input_tokens);
  });
});
