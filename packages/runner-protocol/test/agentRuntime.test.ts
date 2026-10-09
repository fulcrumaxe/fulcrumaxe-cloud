import { describe, expect, expectTypeOf, it } from "vitest";
import * as protocol from "../src/index.js";
import { LocalRunnerRefused, SubscriptionCredentialsRefused, type AgentRuntime, type NormalizedEvent, type StartOptions } from "../src/agentRuntime.js";

describe("agent-runtime types and errors", () => {
  it("the two refusal errors are Errors with their own names and messages", () => {
    const local = new LocalRunnerRefused("not the owner's machine");
    const sub = new SubscriptionCredentialsRefused("subscription only");
    expect([local.name, local.message, local instanceof Error]).toEqual(["LocalRunnerRefused", "not the owner's machine", true]);
    expect([sub.name, sub instanceof Error, sub instanceof LocalRunnerRefused]).toEqual(["SubscriptionCredentialsRefused", true, false]);
  });

  it("an engine only has to implement start, stop and resume", async () => {
    const fake: AgentRuntime = {
      start: async (opts: StartOptions) => ({ handle: { runId: opts.runId } }),
      stop: async () => {},
      resume: async (handle) => ({ handle }),
    };
    expect((await fake.start({ runId: "r1" } as StartOptions)).handle.runId).toBe("r1");
    expectTypeOf<NormalizedEvent>().toHaveProperty("agentOutput");
  });

  it("the package index re-exports the runtime errors, the envelope reader, redaction and the protocol", () => {
    expect(protocol.LocalRunnerRefused).toBe(LocalRunnerRefused);
    for (const name of ["extractAgentOutputEnvelope", "redactText", "verifyJob", "verifyRunnerRequest"] as const) expect(typeof protocol[name], name).toBe("function");
    expect(Object.keys(protocol.RUNNER_MESSAGES)).toHaveLength(9);
  });
});
