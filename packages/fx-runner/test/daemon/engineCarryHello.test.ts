import { describe, expect, it } from "vitest";
import { ENGINE_CARRY_CAPABILITY, HelloMessage, PLATFORM_FACT_HELLO_CAPABILITY, RUNNER_CAPABILITIES, TWIN_CAPABILITY, type HelloMessage as Hello } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey } from "../../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../../src/version.js";

// D#845 MC-9b2 (Ruling 128.1): `engine_carry_v1` is the second rung of the drop ladder: `platform_fact_v1` first, then this, then `twin_v1`. The build lists it only when it has both handlers (the runner change), so these hellos add it by hand.
const base: Hello = { protocol_version: RUNNER_PROTOCOL_VERSION, binary_version: RUNNER_VERSION, model_auth_present: false, isolation: "host_sandbox" };

function cloud(unknown: string[]) {
  const sent: string[][] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const caps = (JSON.parse(String(init.body)).capabilities ?? []) as string[];
    sent.push(caps);
    const refuse = caps.some((c) => unknown.includes(c));
    return new Response(JSON.stringify(refuse ? { error: { code: "invalid_message", message: "x" } } : {}), { status: refuse ? 400 : 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { client: createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn }), sent };
}
const caps = [...RUNNER_BUILD_CAPABILITIES, ENGINE_CARRY_CAPABILITY];

describe("engine_carry_v1 on the hello", () => {
  it("is the protocol's newest capability, and a hello that lists it is a valid one", () => {
    expect(RUNNER_CAPABILITIES.indexOf(ENGINE_CARRY_CAPABILITY)).toBe(RUNNER_CAPABILITIES.length - 1);
    expect(RUNNER_CAPABILITIES.indexOf(ENGINE_CARRY_CAPABILITY)).toBeGreaterThan(RUNNER_CAPABILITIES.indexOf(TWIN_CAPABILITY));
    expect(HelloMessage.safeParse({ ...base, capabilities: caps }).success).toBe(true);
  });

  it("a cloud that does not know it costs one retry that drops it alone and keeps twin_v1 and everything else", async () => {
    const { client, sent } = cloud([ENGINE_CARRY_CAPABILITY]);
    expect(await client.hello({ ...base, capabilities: caps })).toEqual({ kind: "ok", dropped: [ENGINE_CARRY_CAPABILITY] });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual([...RUNNER_BUILD_CAPABILITIES]);
    expect(sent[1]).toContain(TWIN_CAPABILITY);
  });

  it("a cloud that knows none of the three drops platform_fact_v1 first, engine_carry_v1 second and twin_v1 third (Ruling 128.1)", async () => {
    const { client } = cloud([PLATFORM_FACT_HELLO_CAPABILITY, ENGINE_CARRY_CAPABILITY, TWIN_CAPABILITY]);
    const answer = await client.hello({ ...base, capabilities: [...caps, PLATFORM_FACT_HELLO_CAPABILITY] });
    expect(answer.kind).toBe("ok");
    const dropped = (answer as { dropped?: string[] }).dropped ?? [];
    expect(dropped[0]).toBe(PLATFORM_FACT_HELLO_CAPABILITY);
    expect(dropped[1]).toBe(ENGINE_CARRY_CAPABILITY);
    expect(dropped[2]).toBe(TWIN_CAPABILITY);
  });

  it("a cloud that knows it keeps it: one hello, nothing dropped", async () => {
    const { client, sent } = cloud([]);
    expect(await client.hello({ ...base, capabilities: caps })).toEqual({ kind: "ok" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(ENGINE_CARRY_CAPABILITY);
  });
});
