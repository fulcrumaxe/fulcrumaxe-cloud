import { describe, expect, it } from "vitest";
import { createFakeRuntime } from "../src/fake/index.js";
import type { NormalizedEvent, StartOptions } from "../src/types.js";

const FIXTURE_DIR = new URL("../fixtures/agent-outputs", import.meta.url).pathname;

function makeOpts(role: string): StartOptions & { collected: NormalizedEvent[] } {
  const collected: NormalizedEvent[] = [];
  return {
    runId: `run-${role}`,
    role,
    roleCard: "card",
    prompt: "go",
    model: "fake",
    capUsd: 1,
    onEvent: (event) => {
      collected.push(event);
    },
    collected,
  };
}

describe("fake runtime replay (Spec H04 pass/fail 5)", () => {
  it.each(["executor", "code-reviewer", "project-manager"] as const)(
    "replays the %s fixture and emits its final AGENT_OUTPUT envelope",
    async (role) => {
      const runtime = createFakeRuntime(FIXTURE_DIR);
      const opts = makeOpts(role);
      const { handle } = await runtime.start(opts);

      expect(opts.collected.length).toBeGreaterThan(0);
      expect(opts.collected.every((event) => event.role === role)).toBe(true);
      expect(opts.collected.every((event) => event.runId === opts.runId)).toBe(true);

      const final = opts.collected[opts.collected.length - 1];
      expect(final.type).toBe("result");
      expect(final.agentOutput).toBeDefined();
      expect(final.agentOutput?.agent).toBe(role);
      expect(handle.sessionId).toBe(final.sessionId);
    },
  );

  it("resume replays the same fixture again, reusing the original onEvent", async () => {
    const runtime = createFakeRuntime(FIXTURE_DIR);
    const opts = makeOpts("executor");
    const { handle } = await runtime.start(opts);
    const firstCount = opts.collected.length;

    await runtime.resume(handle, handle.sessionId ?? "unused", "keep going");
    expect(opts.collected.length).toBe(firstCount * 2);
  });

  it("stop is a no-op that never throws", async () => {
    const runtime = createFakeRuntime(FIXTURE_DIR);
    const opts = makeOpts("executor");
    const { handle } = await runtime.start(opts);
    await expect(runtime.stop(handle)).resolves.toBeUndefined();
  });
});
