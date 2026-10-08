import { describe, expect, it } from "vitest";
import type { LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { readSessionIndex } from "../../../src/engines/claude/session.js";
import { authText, engineFor, makeFake, makeRig, streamWith } from "./rig.js";

describe("init-line credential check, through the engine", () => {
  async function runWith(mode: "subscription" | "api_key", source: string, hang = true) {
    const local: LocalOnlyEvent[] = [];
    const fake = makeFake({ stream: streamWith(source), auth: authText(mode === "subscription" ? "auth.claude_ai.json" : "auth.api_key.json") });
    if (hang) fake.set("hang", "1");
    const rig = makeRig({ fake, credentials: mode === "subscription" ? { mode } : { mode, apiKey: "config-key-value-0001" }, onLocalEvent: (event) => void local.push(event) });
    const opts = rig.startOptions();
    const { handle } = await engineFor(rig).start(opts);
    return { outcome: await outcomeOf(handle), local, opts };
  }

  it.each([["api_key", ["/login", "managed key"].join(" ")], ["api_key", "apiKeyHelper"], ["api_key", "oauth"], ["subscription", "ANTHROPIC_API_KEY"]] as const)(
    "%s mode with init source %s: the process is signalled, nothing is processed, one credential_mismatch is reported",
    async (mode, source) => {
      const { outcome, local, opts } = await runWith(mode, source);
      expect(outcome).toEqual({ status: "failed", failureReason: "credential_mismatch", engineVersion: "2.1.294" });
      expect(opts.events).toEqual([]);
      expect(local.map((event) => event.type)).toEqual(["engine_version", "credential_mismatch"]);
    },
  );

  it("a stream whose first line is not the init line stops the run as no_init_line, not as a credential problem, with nothing processed", async () => {
    const local: LocalOnlyEvent[] = [];
    const fake = makeFake({ stream: streamWith("none").split("\n").slice(1).join("\n") });
    fake.set("hang", "1");
    const rig = makeRig({ fake, onLocalEvent: (event) => void local.push(event) });
    const opts = rig.startOptions();
    const { handle } = await engineFor(rig).start(opts);
    expect(await outcomeOf(handle)).toEqual({ status: "failed", failureReason: "no_init_line", engineVersion: "2.1.294" });
    expect(opts.events).toEqual([]);
    expect(local.map((event) => event.type)).toEqual(["engine_version"]);
  });

  it("an early error result as the first line is no_init_line too, and the result is not processed", async () => {
    const early = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "sess-0009" });
    const fake = makeFake({ stream: `${early}\n` });
    fake.set("hang", "1");
    const rig = makeRig({ fake });
    const opts = rig.startOptions();
    const { handle } = await engineFor(rig).start(opts);
    expect(await outcomeOf(handle)).toEqual({ status: "failed", failureReason: "no_init_line", engineVersion: "2.1.294" });
    expect(opts.events).toEqual([]);
    expect(Object.keys(readSessionIndex(rig.config.sessionsFile))).toEqual([]);
  });

  it("the matching source runs the job to its end", async () => {
    const { outcome, local } = await runWith("subscription", "none", false);
    expect(outcome.status).toBe("ok");
    expect(local.length).toBeGreaterThan(0);
  });
});
