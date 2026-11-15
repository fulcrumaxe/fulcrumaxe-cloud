import { describe, expect, it } from "vitest";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { engineFor, makeRig, streamWith } from "./rig.js";

// Linux caps ONE argument string at 128 KiB (MAX_ARG_STRLEN); a prompt past that passed as an argument fails the start with E2BIG.
const ARG_STRING_LIMIT = 128 * 1024;

describe("a prompt longer than one argument string may be", () => {
  it("reaches the agent whole on standard input, and no argument comes near the limit", async () => {
    const rig = makeRig({ credentials: { mode: "api_key", apiKey: "sk-test-config-key-value" } });
    rig.fake.set("auth.json", JSON.stringify({ authMethod: "api_key" }));
    rig.fake.set("stream.jsonl", streamWith("ANTHROPIC_API_KEY"));
    const prompt = `START-${"x".repeat(3 * ARG_STRING_LIMIT)}-END`;
    const { handle } = await engineFor(rig).start(rig.startOptions({ prompt }));
    expect((await outcomeOf(handle)).status).toBe("ok");
    const argv = rig.fake.argv();
    expect(Math.max(...argv.map((a) => a.length))).toBeLessThan(4096);
    expect(argv.join(" ")).not.toContain("START-");
    expect(rig.fake.stdin()).toBe(prompt);
  });
});
