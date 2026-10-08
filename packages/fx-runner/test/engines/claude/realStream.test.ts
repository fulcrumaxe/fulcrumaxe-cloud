import { describe, expect, it } from "vitest";
import { isKnownStreamJsonType, isMalformedAssistant, type LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import { baseToolNames } from "../../../src/engines/claude/argv.js";
import { initCredentialMatches } from "../../../src/engines/claude/credentialCheck.js";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { roleToolsFor } from "../../../src/job/roleTools.js";
import { engineFor, fixtureText, makeRig } from "./rig.js";

const lines = fixtureText("stream.subscription.jsonl").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
const init = lines[0]!;

describe("the captured 2.1.289 run (init, two assistant lines, a rate-limit line, result)", () => {
  it("the stream fixtures carry their status: the capture is dated and redacted, the tool-use scenario says it is synthetic", () => {
    const head = (name: string): unknown => (JSON.parse(fixtureText(name, true).split("\n")[0]!) as { _fixture: unknown })._fixture;
    expect(head("stream.subscription.jsonl")).toEqual({ binary_version: "2.1.289", capture_date: "2026-10-06", status: "captured, redacted" });
    expect(String((head("stream.tooluse.synthetic.jsonl") as { status: string }).status)).toMatch(/^synthetic, not captured/);
    expect(fixtureText("stream.subscription.jsonl")).not.toMatch(/@|\/home\/|\/Users\//);
  });

  it("the init line says apiKeySource none: accepted in subscription mode, refused in API-key mode", () => {
    expect(init).toMatchObject({ type: "system", subtype: "init", apiKeySource: "none", claude_code_version: "2.1.289", mcp_servers: [], slash_commands: [] });
    expect(initCredentialMatches("subscription", init)).toBe(true);
    expect(initCredentialMatches("api_key", init)).toBe(false);
  });

  it("the init tools are a subset of the role's base names, and hold no web or platform tool", () => {
    const tools = init.tools as string[];
    expect(tools.length).toBeGreaterThan(0);
    const requested = baseToolNames(roleToolsFor("code-reviewer"));
    for (const tool of tools) expect(requested).toContain(tool);
    expect(tools.filter((tool) => /^(WebFetch|WebSearch)$|^mcp__/.test(tool))).toEqual([]);
    // `LS` was requested and is not a tool of this build: the binary drops unknown names without a word.
    expect(requested).toContain("LS");
    expect(tools).not.toContain("LS");
  });

  it("the rate-limit line is not a known type and not malformed, and no line is a malformed assistant", () => {
    const limit = lines.find((line) => line.type === "rate_limit_event")!;
    expect(isKnownStreamJsonType(limit)).toBe(false);
    expect(isMalformedAssistant(limit)).toBe(false);
    for (const line of lines) expect(isMalformedAssistant(line)).toBe(false);
  });

  it("runs through the engine: every line is kept in order, the rate-limit line as a plain system event, and only metadata is uploaded", async () => {
    const local: LocalOnlyEvent[] = [];
    const rig = makeRig({ onLocalEvent: (event) => void local.push(event) });
    const opts = rig.startOptions();
    const { handle } = await engineFor(rig).start(opts);
    expect(await outcomeOf(handle)).toEqual({ status: "ok", engineVersion: "2.1.294", sessionId: "REDACTED-session_id" });
    expect((opts.events as Array<{ type: string }>).map((event) => event.type)).toEqual(["system", "assistant", "assistant", "system", "result"]);
    expect(local.map((event) => event.type)).toEqual(["engine_version", "usage"]);
    expect(local[1]).toMatchObject({ usage: { input: 9, output: 56 } });
  });
});
