import { describe, expect, it } from "vitest";
import type { LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { engineFor, fixtureText, makeRig } from "./rig.js";

const assistant = (id: string, model: string, u: { i: number; o: number; r: number; w: number }, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    session_id: "sess-0001",
    ...extra,
    message: { id, model, role: "assistant", content: [{ type: "text", text: "step" }], usage: { input_tokens: u.i, cache_creation_input_tokens: u.w, cache_read_input_tokens: u.r, output_tokens: u.o } },
  });

/**
 * Through the real engine: a multi-turn stream where the result line's top-level usage is the LAST turn only (what a long session prints),
 * a message id that repeats while it streams, and a subagent turn on another model. The usage event must carry the whole run's total.
 */
describe("the engine's usage event over a multi-turn stream", () => {
  it("carries the summed total with every token class, not the result line's last turn", async () => {
    const init = fixtureText("stream.tooluse.synthetic.jsonl").split("\n").find((line) => line.includes('"subtype":"init"'));
    expect(init).toBeDefined();
    const lines = [
      init!,
      assistant("msg_1", "claude-sonnet-5-5", { i: 5, o: 400, r: 20_000, w: 30_000 }),
      assistant("msg_1", "claude-sonnet-5-5", { i: 5, o: 900, r: 20_000, w: 30_000 }),
      assistant("msg_2", "claude-sonnet-5-5", { i: 3, o: 1_200, r: 50_000, w: 2_000 }),
      assistant("msg_3", "claude-haiku-4-5-20251001", { i: 9, o: 300, r: 7_000, w: 1_000 }, { parent_tool_use_id: "toolu_1" }),
      assistant("msg_4", "claude-sonnet-5-5", { i: 329, o: 2_000, r: 90_000, w: 500 }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-0001",
        result: "Done.",
        total_cost_usd: 0.5,
        usage: { input_tokens: 329, cache_creation_input_tokens: 500, cache_read_input_tokens: 90_000, output_tokens: 2_000 },
      }),
    ];
    const local: LocalOnlyEvent[] = [];
    const rig = makeRig({ onLocalEvent: (event) => void local.push(event) });
    rig.fake.set("stream.jsonl", lines.join("\n") + "\n");
    const { handle } = await engineFor(rig).start(rig.startOptions());
    await outcomeOf(handle);
    const usage = local.filter((event) => event.type === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ usage: { input: 346, output: 4_400, cache_read: 167_000, cache_write: 33_500, usd: 0.5 } });
  });
});
